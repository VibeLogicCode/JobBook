import { cookies } from 'next/headers';
import { resolveSignIn, refusalMessage } from '@/lib/auth/link';
import { authMode } from '@/lib/auth/mode';
import { STATE_COOKIE_NAME, appReturnUrl, completeSignIn, readState } from '@/lib/auth/oidc/flow';
import { isProviderName } from '@/lib/auth/oidc/providers';
import { rateLimit } from '@/lib/auth/rate-limit';
import { createSession, sessionCookie } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * The provider's callback.
 *
 * GET for Google and Microsoft. POST exists because Apple returns the
 * authorisation as a cross-site form post, which is also why the state cookie
 * is SameSite=None; nothing else about the two paths differs.
 */
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const url = new URL(request.url);
  return handle(request, context, {
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    error: url.searchParams.get('error'),
  });
}

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  const form = await request.formData();
  return handle(request, context, {
    code: asString(form.get('code')),
    state: asString(form.get('state')),
    error: asString(form.get('error')),
  });
}

function asString(value: FormDataEntryValue | null): string | null {
  return typeof value === 'string' ? value : null;
}

async function handle(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
  input: { code: string | null; state: string | null; error: string | null },
): Promise<Response> {
  if (authMode() !== 'sso') return new Response('Not found', { status: 404 });

  const { provider } = await params;
  if (!isProviderName(provider)) return new Response('Unknown provider', { status: 404 });

  const limited = rateLimit(request, 'auth-callback');
  if (limited) return limited;

  const jar = await cookies();
  const stateCookie = jar.get(STATE_COOKIE_NAME)?.value;

  // Consumed on arrival, whatever happens next: a state cookie that outlives
  // its attempt is a replayable one.
  jar.delete(STATE_COOKIE_NAME);

  if (input.error) {
    // The person pressed cancel, or the provider refused. Neither is an error
    // of ours, and the provider's text is not shown back to them.
    return signInAgain('Sign-in was not completed.');
  }
  if (!input.code || !input.state) return signInAgain('That sign-in link was incomplete.');

  let returnTo = '/';
  try {
    returnTo = (await readState(stateCookie)).returnTo;
  } catch {
    // Falls through to the flow below, which reports the expiry properly.
  }

  try {
    const identity = await completeSignIn({
      provider,
      code: input.code,
      state: input.state,
      stateCookie,
    });

    const outcome = await resolveSignIn(identity);
    if (!outcome.ok) return signInAgain(refusalMessage(outcome.refusal));

    const { token } = await createSession({
      userId: outcome.userId,
      userAgent: request.headers.get('user-agent'),
      ip: request.headers.get('cf-connecting-ip') ?? null,
    });

    const cookie = sessionCookie(token);
    jar.set(cookie.name, cookie.value, {
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      path: cookie.path,
    });

    return Response.redirect(appReturnUrl(returnTo), 303);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sign-in failed.';
    return signInAgain(message);
  }
}

/**
 * Sends the person back to the sign-in page with a reason.
 *
 * The reason travels in the query string rather than a cookie because it is
 * not a secret and a cookie would outlive the attempt.
 */
function signInAgain(reason: string): Response {
  const url = new URL(appReturnUrl('/auth/sign-in'));
  url.searchParams.set('reason', reason);
  return Response.redirect(url.toString(), 303);
}
