import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Cloudflare Access authentication.
 *
 * The JWT signature is verified against Cloudflare's JWKS, together with the
 * issuer, the audience and expiry. `Cf-Access-Authenticated-User-Email` is
 * never read: it is an unsigned header, so anything reaching the app directly
 * could set it.
 *
 * Failure is always closed. There is no fallback path that admits a request
 * whose token did not verify.
 */

export interface Identity {
  email: string;
  /** True when the request arrived through the LAN bypass rather than Access. */
  local: boolean;
}

export class AuthError extends Error {}

const teamDomain = () => process.env.CF_ACCESS_TEAM_DOMAIN?.replace(/\/+$/, '');
const audience = () => process.env.CF_ACCESS_AUD;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function keySet() {
  const domain = teamDomain();
  if (!domain) throw new AuthError('CF_ACCESS_TEAM_DOMAIN is not set');
  jwks ??= createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`));
  return jwks;
}

/**
 * LAN mode, for a deployment with no tunnel in front of it -- the mini PC on
 * the office network, or a laptop under test.
 *
 * Opt-in and loud: it requires AUTH_MODE=local AND a named user, and it
 * refuses to run alongside Access configuration, because a half-configured
 * tunnel silently falling back to "everyone is the owner" is the failure this
 * guards against.
 */
export function localIdentity(): Identity {
  if (process.env.AUTH_MODE !== 'local') {
    throw new AuthError('AUTH_MODE is not local');
  }
  const email = process.env.LOCAL_USER_EMAIL;
  if (!email) {
    throw new AuthError('AUTH_MODE=local requires LOCAL_USER_EMAIL');
  }
  if (teamDomain() || audience()) {
    throw new AuthError(
      'AUTH_MODE=local cannot be combined with CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD',
    );
  }
  return { email, local: true };
}

/** Verifies an Access JWT and returns the identity it carries. */
export async function verifyAccessJwt(token: string | undefined): Promise<Identity> {
  if (!token) throw new AuthError('no Access token on the request');

  const aud = audience();
  if (!aud) throw new AuthError('CF_ACCESS_AUD is not set');

  const domain = teamDomain();
  const { payload } = await jwtVerify(token, keySet(), {
    issuer: domain,
    audience: aud,
  });

  const email = typeof payload.email === 'string' ? payload.email : null;
  if (!email) {
    // A service-token JWT verifies correctly and carries no email. Machine
    // credentials must not resolve to a person's role.
    throw new AuthError('token carries no email; service tokens are not accepted');
  }

  return { email, local: false };
}

/** The identity for a request, by whichever mode this deployment is running. */
export async function identify(headers: Headers): Promise<Identity> {
  if (process.env.AUTH_MODE === 'local') return localIdentity();
  const token =
    headers.get('cf-access-jwt-assertion') ??
    parseCookie(headers.get('cookie'), 'CF_Authorization');
  return verifyAccessJwt(token ?? undefined);
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}
