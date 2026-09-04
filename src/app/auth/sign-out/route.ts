import { cookies } from 'next/headers';
import { appReturnUrl } from '@/lib/auth/oidc/flow';
import { SESSION_COOKIE, revokeSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Sign out.
 *
 * A POST, never a link: an `<img src="/auth/sign-out">` on any other page
 * would otherwise sign a person out of this application from across the web.
 *
 * There is deliberately no provider-side sign-out. RP-initiated logout is
 * available for two of the three providers and would sign the person out of
 * their entire Microsoft 365 or Google Workspace session because they left a
 * quoting tool.
 */
export async function POST() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;

  if (token) await revokeSession(token, 'signed out');
  jar.delete(SESSION_COOKIE);

  return Response.redirect(appReturnUrl('/auth/sign-in'), 303);
}
