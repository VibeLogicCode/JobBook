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
 * Opt-in and loud: it requires AUTH_MODE=local, and it refuses to run
 * alongside Access configuration, because a half-configured tunnel silently
 * falling back to "everyone is the owner" is the failure this guards against.
 *
 * **Returns null when LOCAL_USER_EMAIL is unset**, which used to be a refusal.
 * It stopped being one so that one image and one compose file can serve every
 * customer -- see `lib/auth/sole-owner.ts` for the reasoning and the other
 * three branches. Null means "the environment does not say; ask the database",
 * NOT "anonymous": nothing downstream treats a null as permission for
 * anything, because `identify` is the only caller and it resolves the null
 * before returning.
 *
 * Still synchronous, and still purely a function of the environment. The
 * database branch is a separate module so that these three refusals stay
 * assertable without one.
 */
export function localIdentity(): Identity | null {
  if (process.env.AUTH_MODE !== 'local') {
    throw new AuthError('AUTH_MODE is not local');
  }
  if (teamDomain() || audience()) {
    throw new AuthError(
      'AUTH_MODE=local cannot be combined with CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD',
    );
  }
  const email = process.env.LOCAL_USER_EMAIL;
  return email ? { email, local: true } : null;
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

/**
 * The identity for a request, by whichever mode this deployment is running.
 *
 * In local mode the environment is asked first and the database only if the
 * environment declines to say. That order is deliberate: an operator who names
 * an address gets exactly the address he named, and no amount of data in the
 * `users` table can override it. The database is the fallback, never the
 * authority.
 *
 * Returns null only in local mode with no accounts at all -- the bootstrap
 * state, where the honest answer is that nobody has claimed this deployment
 * yet. `proxy.ts` passes no identity header in that case, and `guard()`
 * refuses every action for want of one while the setup wizard, which sits
 * outside that guard, still runs.
 */
export async function identify(headers: Headers): Promise<Identity | null> {
  if (process.env.AUTH_MODE === 'local') {
    const named = localIdentity();
    if (named) return named;
    // Imported here rather than at module scope: this module is the pure
    // environment half, imported by tests that have no database, and a
    // top-level import of the query would drag `db/client` into every one of
    // them.
    const { resolveSoleOwner } = await import('@/lib/auth/sole-owner');
    return resolveSoleOwner();
  }

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
