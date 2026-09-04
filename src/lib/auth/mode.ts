/**
 * Which of the three authentication modes this deployment runs.
 *
 * Mutually exclusive, and `AUTH_MODE` is mandatory: with three options an
 * unset default is a guess, and guessing wrong means either locking the owner
 * out or treating every visitor as him. The old behaviour -- unset meant
 * Cloudflare Access -- is deliberately gone.
 */
export type AuthMode = 'access' | 'sso' | 'local';

export class AuthModeError extends Error {}

export function authMode(): AuthMode {
  const value = process.env.AUTH_MODE;
  if (value !== 'access' && value !== 'sso' && value !== 'local') {
    throw new AuthModeError(
      'AUTH_MODE must be set to "access", "sso" or "local". It has no default, ' +
        'because every possible default is wrong for two of the three deployments.',
    );
  }
  return value;
}

/**
 * The interlock. Two modes configured at once is a misconfiguration that fails
 * in the worst possible direction -- a half-configured tunnel quietly treating
 * strangers as the owner -- so it refuses to run instead.
 */
export function assertModeIsCoherent(): void {
  const mode = authMode();
  const hasAccess = Boolean(process.env.CF_ACCESS_TEAM_DOMAIN || process.env.CF_ACCESS_AUD);
  const hasSso = Boolean(
    process.env.GOOGLE_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID || process.env.APPLE_CLIENT_ID,
  );

  if (mode === 'local' && (hasAccess || hasSso)) {
    throw new AuthModeError(
      'AUTH_MODE=local cannot be combined with Cloudflare Access or SSO configuration',
    );
  }
  if (mode === 'access' && hasSso) {
    throw new AuthModeError(
      'AUTH_MODE=access cannot be combined with SSO provider configuration: ' +
        'sign-in methods belong in the Access policy, not in two places that can disagree',
    );
  }
  if (mode === 'sso' && hasAccess) {
    throw new AuthModeError('AUTH_MODE=sso cannot be combined with Cloudflare Access configuration');
  }
  if (mode === 'sso' && !hasSso) {
    throw new AuthModeError('AUTH_MODE=sso requires at least one provider to be configured');
  }
}
