import { NextResponse, type NextRequest } from 'next/server';
import { AuthError, identify } from '@/lib/auth/access';
import { AuthModeError, authMode } from '@/lib/auth/mode';
import { SESSION_COOKIE, readSession } from '@/lib/auth/session';

/**
 * Next 16's proxy -- what earlier versions called middleware -- on the Node
 * runtime, because both the Access JWKS verification and the session lookup
 * use Node APIs.
 *
 * Authentication happens here so that no route can forget it. Behind
 * Cloudflare Tunnel the app and database publish no ports; the tunnel is
 * defence in depth and replay resistance, NOT what makes the header
 * trustworthy -- a forged Access header fails signature verification either
 * way, and believing otherwise is how the verification gets skipped.
 *
 * Authorization is a separate matter and is not decided here. This establishes
 * who is asking; the permissions module decides what they may do, per request,
 * from the user's role.
 */

/**
 * Paths served without authentication, and each one is a decision.
 *
 * Static assets carry nothing. The healthcheck answers a bare ok or not-ok
 * with no tenant data, and has to be reachable by a container probe that holds
 * no credential.
 */
const PUBLIC_PREFIXES = ['/_next/static', '/_next/image', '/favicon.ico', '/api/health'];

/** The sign-in surface exists only in `sso` mode. */
const AUTH_PREFIX = '/auth/';

/**
 * The print route is reached over localhost by headless Chromium from inside
 * the container, so it never passes through Cloudflare, carries no Access JWT
 * and no session cookie, and never will. It authenticates on its own secret in
 * every mode; a session-based fallback here would be exactly the hole that
 * secret exists to close.
 */
function renderSecretOk(request: NextRequest): boolean {
  const expected = process.env.INTERNAL_RENDER_SECRET;
  if (!expected) return false;
  return request.headers.get('x-render-secret') === expected;
}

/**
 * CSRF, in two layers and with no synchroniser token.
 *
 * The session cookie is SameSite=Lax, so a cross-site form post arrives
 * without it and is anonymous. On top of that, an unsafe method must look
 * same-origin. Next's server actions already do an equivalent check; this
 * extends it to route handlers so that no handler can forget.
 *
 * The comparison is against APP_PUBLIC_URL rather than the Host header, and
 * deliberately: every provider redirect URI is built from the same value, and
 * a URL derived from Host is the classic route to an open redirect through
 * host-header injection. The tunnel does not protect against that.
 */
function csrfRefusal(request: NextRequest): NextResponse | null {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;

  // Apple's callback is a cross-site POST by design and is protected by the
  // state parameter instead.
  if (request.nextUrl.pathname === '/auth/callback/apple') return null;

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return new NextResponse('Cross-site request refused', { status: 403 });
  }

  const origin = request.headers.get('origin');
  const expected = process.env.APP_PUBLIC_URL?.replace(/\/+$/, '');
  if (origin && expected) {
    try {
      if (new URL(origin).origin !== new URL(expected).origin) {
        return new NextResponse('Cross-origin request refused', { status: 403 });
      }
    } catch {
      return new NextResponse('Cross-origin request refused', { status: 403 });
    }
  }

  return null;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/print/')) {
    if (renderSecretOk(request)) return NextResponse.next();
    // No fallthrough to any other mechanism: a print URL renders a document,
    // and a mis-set secret must fail rather than quietly serve one.
    return new NextResponse('Not authorised', { status: 401 });
  }

  let mode;
  try {
    mode = authMode();
  } catch (error) {
    // A deployment with no AUTH_MODE serves nothing. Refusing to run in an
    // ambiguous auth posture is the whole reason the variable is mandatory.
    const message =
      error instanceof AuthModeError ? error.message : 'Authentication is not configured';
    return new NextResponse(message, { status: 503 });
  }

  const csrf = csrfRefusal(request);
  if (csrf) return csrf;

  if (pathname.startsWith(AUTH_PREFIX)) {
    // Public in sso mode, absent in the others, so a deployment behind Access
    // exposes no sign-in routes it does not use.
    return mode === 'sso' ? NextResponse.next() : new NextResponse('Not found', { status: 404 });
  }

  if (mode === 'sso') {
    const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) {
      // A page gets sent to sign in and returns where it started; an API call
      // gets a status, because redirecting a fetch to an HTML page turns one
      // failure into a confusing second one.
      if (pathname.startsWith('/api/')) {
        return new NextResponse('Not authorised', { status: 401 });
      }
      const url = request.nextUrl.clone();
      url.pathname = '/auth/sign-in';
      url.search = `?return_to=${encodeURIComponent(pathname)}`;
      return NextResponse.redirect(url);
    }
    return withIdentity(request, session.email);
  }

  try {
    const identity = await identify(request.headers);
    return withIdentity(request, identity.email);
  } catch (error) {
    if (error instanceof AuthError) {
      return new NextResponse(`Not authorised: ${error.message}`, { status: 401 });
    }
    return new NextResponse('Not authorised', { status: 401 });
  }
}

/**
 * Passes the resolved email downstream.
 *
 * The header is deleted before being set, so an inbound copy from a client
 * cannot survive to be trusted by a route handler.
 */
function withIdentity(request: NextRequest, email: string): NextResponse {
  const headers = new Headers(request.headers);
  headers.delete('x-identity-email');
  headers.set('x-identity-email', email);
  return NextResponse.next({ request: { headers } });
}
