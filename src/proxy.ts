import { NextResponse, type NextRequest } from 'next/server';
import { AuthError, identify } from '@/lib/auth/access';

/**
 * Next 16's middleware, on the Node runtime because the JWKS verification uses
 * Node crypto.
 *
 * Authentication happens here so no route can forget it. The app and database
 * containers publish no ports and sit behind the tunnel; the tunnel is defence
 * in depth and replay resistance, NOT the thing that makes the header
 * trustworthy -- a forged header fails signature verification either way.
 */
/**
 * The print route is reached over localhost by headless Chromium from inside
 * the container, so it never passes through Cloudflare and carries no Access
 * JWT. It authenticates with its own secret instead.
 */
function renderSecretOk(request: NextRequest): boolean {
  const expected = process.env.INTERNAL_RENDER_SECRET;
  if (!expected) return false;
  return request.headers.get('x-render-secret') === expected;
}

/**
 * Static assets are skipped here rather than through a matcher export: Next 16
 * refuses route segment config in a proxy file, since a proxy always runs on
 * the Node runtime.
 */
const PUBLIC_PREFIXES = [
  '/_next/static',
  '/_next/image',
  '/favicon.ico',
  // The container healthcheck carries no Access token and no render secret.
  // The route answers with a bare ok/not-ok and no tenant data.
  '/api/health',
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/print/')) {
    if (renderSecretOk(request)) return NextResponse.next();
    // No fallthrough to Access here: a print URL is a document, and a
    // mis-set secret must fail rather than quietly serve one.
    return new NextResponse('Not authorised', { status: 401 });
  }

  try {
    const identity = await identify(request.headers);
    const headers = new Headers(request.headers);
    // Routes read the identity from here rather than re-verifying. The header
    // is stripped and rewritten on every request, so an inbound copy of it
    // cannot survive to be trusted downstream.
    headers.set('x-identity-email', identity.email);
    return NextResponse.next({ request: { headers } });
  } catch (error) {
    if (error instanceof AuthError) {
      return new NextResponse(`Not authorised: ${error.message}`, { status: 401 });
    }
    return new NextResponse('Not authorised', { status: 401 });
  }
}
