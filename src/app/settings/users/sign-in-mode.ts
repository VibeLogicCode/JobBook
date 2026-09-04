/**
 * What this deployment's sign-in looks like, read from the environment.
 *
 * The users screen has to describe a mode it does not own: identity arrives
 * through Cloudflare Access, through the application's own OpenID Connect, or
 * from a named environment variable on a LAN, and exactly one of those is
 * active. Offering a sign-in method a deployment cannot honour is a support
 * call, so the picker is built from what is actually configured.
 *
 * Credentials are environment variables and never database rows: a mirrored
 * table ends up in SharePoint and in every backup, and a secret must not be
 * anywhere near either.
 */

export type AuthMode = 'access' | 'sso' | 'local' | 'unset';

export type Provider = 'google' | 'microsoft' | 'apple';

export function authMode(): AuthMode {
  const mode = process.env.AUTH_MODE;
  return mode === 'access' || mode === 'sso' || mode === 'local' ? mode : 'unset';
}

/**
 * A provider is configured when its client id is present. That is the rule the
 * boot check applies, so this cannot offer a method the application would then
 * refuse to start with.
 */
export function configuredProviders(): Provider[] {
  const providers: Provider[] = [];
  // Unprefixed, matching what the runtime actually reads in
  // src/lib/auth/oidc/providers.ts. These were SSO_-prefixed, following the SSO
  // design document, and the consequence was silent: a correctly configured
  // deployment offered no sign-in method at all and this screen showed "no
  // provider is configured" while sign-in worked perfectly.
  if (process.env.GOOGLE_CLIENT_ID) providers.push('google');
  if (process.env.MICROSOFT_CLIENT_ID) providers.push('microsoft');
  if (process.env.APPLE_CLIENT_ID) providers.push('apple');
  return providers;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  apple: 'Apple',
};

/** Named on screen so the owner knows where sign-in is actually decided. */
export function accessTeamDomain(): string | null {
  return process.env.CF_ACCESS_TEAM_DOMAIN?.replace(/\/+$/, '') ?? null;
}

/** The address the LAN mode signs every request in as. */
export function localUserEmail(): string | null {
  return process.env.LOCAL_USER_EMAIL ?? null;
}
