import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { authMode } from '@/lib/auth/mode';
import { beginSignIn, stateCookieOptions } from '@/lib/auth/oidc/flow';
import { isProviderName } from '@/lib/auth/oidc/providers';
import { rateLimit } from '@/lib/auth/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Starts a sign-in.
 *
 * A GET, because it is where a button leads and it changes nothing on the
 * server beyond a transient cookie. The state it sets is what makes the
 * callback verifiable.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  // In access and local mode this path does not exist. A deployment behind
  // Cloudflare Access exposes no sign-in surface it does not use.
  if (authMode() !== 'sso') {
    return new Response('Not found', { status: 404 });
  }

  const { provider } = await params;
  if (!isProviderName(provider)) return new Response('Unknown provider', { status: 404 });

  const limited = rateLimit(request, 'auth-start');
  if (limited) return limited;

  const url = new URL(request.url);
  const returnTo = url.searchParams.get('return_to') ?? '/';

  try {
    const { url: authorizationUrl, cookie } = await beginSignIn(provider, returnTo);
    const jar = await cookies();
    jar.set(cookie.name, cookie.value, stateCookieOptions());
    redirect(authorizationUrl);
  } catch (error) {
    // A provider that is not configured is an operator mistake, not a user
    // one, so it says so rather than showing a broken provider screen.
    if (isRedirectError(error)) throw error;
    const message = error instanceof Error ? error.message : 'sign-in could not be started';
    return new Response(message, { status: 503 });
  }
}

/** `redirect()` works by throwing; rethrowing it is how the redirect happens. */
function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest?: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}
