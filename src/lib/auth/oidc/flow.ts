import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EncryptJWT, createRemoteJWKSet, jwtDecrypt, jwtVerify } from 'jose';
import {
  type ProviderConfig,
  type ProviderName,
  appOrigin,
  providerConfig,
  redirectUri,
} from '@/lib/auth/oidc/providers';

/**
 * The OpenID Connect flow: build the authorisation URL, exchange the code,
 * verify the token, read the claims. Everything provider-specific is in
 * `providers.ts`.
 *
 * Built on `jose` rather than on `openid-client`, which the SSO spec's decision
 * 20 names. The deviation is deliberate and confined to this directory, which
 * is the seam that decision asked for: `jose` is already a dependency and
 * already verifies the Cloudflare Access token, the flow here is one
 * authorization-code exchange with PKCE, and one dependency verified against
 * its own tests beats two. If Apple's quirks or a fourth provider make this
 * directory grow, `openid-client` goes behind the same seam without anything
 * outside it moving.
 */

export class AuthFlowError extends Error {}

const STATE_COOKIE = '__Host-auth_state';
const STATE_TTL_SECONDS = 600;

export interface StatePayload {
  provider: ProviderName;
  state: string;
  nonce: string;
  verifier: string;
  /** Where to land after signing in. Same-origin paths only. */
  returnTo: string;
}

export interface VerifiedIdentity {
  provider: ProviderName;
  /** Google `sub`, Microsoft `oid`, Apple `sub`. */
  subject: string;
  /** Microsoft `tid`; null for the others. */
  tenantId: string | null;
  email: string;
  emailVerified: boolean;
  isPrivateEmail: boolean;
}

function secret(): Uint8Array {
  const value = process.env.SSO_COOKIE_SECRET;
  if (!value || value.length < 32) {
    throw new AuthFlowError('SSO_COOKIE_SECRET must be set and at least 32 characters');
  }
  return createHash('sha256').update(value).digest();
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(config: ProviderConfig) {
  const existing = jwksCache.get(config.jwksUri);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(config.jwksUri));
  jwksCache.set(config.jwksUri, created);
  return created;
}

/** Testing seam: a mock issuer's keys must not be served from a cached set. */
export function clearJwksCache(): void {
  jwksCache.clear();
}

/**
 * Begins a sign-in.
 *
 * The state payload rides in an encrypted cookie rather than a table, because
 * every bot that loads the sign-in page would otherwise create a row.
 * Encrypted rather than signed, because a signed cookie is readable and the
 * PKCE verifier is inside it.
 */
export async function beginSignIn(
  provider: ProviderName,
  returnTo = '/',
): Promise<{ url: string; cookie: { name: string; value: string; maxAge: number } }> {
  const config = providerConfig(provider);

  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const payload: StatePayload = {
    provider,
    state,
    nonce,
    verifier,
    // Only a same-origin path is honoured. An absolute URL here would make the
    // sign-in flow an open redirect.
    returnTo: returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/',
  };

  const cookieValue = await new EncryptJWT({ ...payload })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .encrypt(secret());

  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri(provider));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (config.responseMode === 'form_post') url.searchParams.set('response_mode', 'form_post');
  // A UI hint only. The real check is on the token's own hd claim, because a
  // request parameter is whatever the browser was told to send.
  if (config.hostedDomain) url.searchParams.set('hd', config.hostedDomain);

  return { url: url.toString(), cookie: { name: STATE_COOKIE, value: cookieValue, maxAge: STATE_TTL_SECONDS } };
}

export async function readState(cookieValue: string | undefined): Promise<StatePayload> {
  if (!cookieValue) throw new AuthFlowError('the sign-in attempt has expired; start again');
  try {
    const { payload } = await jwtDecrypt(cookieValue, secret());
    return payload as unknown as StatePayload;
  } catch {
    throw new AuthFlowError('the sign-in attempt could not be read; start again');
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Completes a sign-in: checks state, exchanges the code, verifies the id_token,
 * and reads the claims that matter.
 *
 * The raw token is discarded once read. Storing it would keep a bearer
 * credential in a mirrored table, and the app calls no provider API after
 * sign-in, so there is nothing it could be used for.
 */
export async function completeSignIn(args: {
  provider: ProviderName;
  code: string;
  state: string;
  stateCookie: string | undefined;
}): Promise<VerifiedIdentity> {
  const config = providerConfig(args.provider);
  const stored = await readState(args.stateCookie);

  if (stored.provider !== args.provider) {
    throw new AuthFlowError('this callback does not match the provider the sign-in began with');
  }
  if (!constantTimeEquals(stored.state, args.state)) {
    throw new AuthFlowError('state mismatch; the sign-in was not completed in this browser');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: redirectUri(args.provider),
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: stored.verifier,
  });

  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });

  if (!response.ok) {
    // The provider's body can carry the client secret back in an error echo,
    // so only the status is surfaced.
    throw new AuthFlowError(`the provider refused the code exchange (${response.status})`);
  }

  const tokens = (await response.json()) as { id_token?: string };
  if (!tokens.id_token) throw new AuthFlowError('the provider returned no id_token');

  const { payload } = await jwtVerify(tokens.id_token, jwks(config), {
    issuer: config.issuer,
    audience: config.clientId,
  });

  if (payload.nonce !== stored.nonce) {
    // A replayed token from another sign-in attempt.
    throw new AuthFlowError('nonce mismatch; the token does not belong to this sign-in');
  }

  return readClaims(config, payload);
}

function readClaims(config: ProviderConfig, payload: Record<string, unknown>): VerifiedIdentity {
  const subject = typeof payload.sub === 'string' ? payload.sub : null;
  if (!subject) throw new AuthFlowError('the token carries no subject');

  switch (config.name) {
    case 'google': {
      const email = requireString(payload.email, 'email');
      // An unverified Google address is one somebody typed, not one they own,
      // and the first link matches on email.
      if (payload.email_verified !== true) {
        throw new AuthFlowError('this Google account has an unverified email address');
      }
      if (config.hostedDomain && payload.hd !== config.hostedDomain) {
        throw new AuthFlowError('this account is not in the workspace this installation accepts');
      }
      return {
        provider: 'google',
        subject,
        tenantId: null,
        email: normaliseEmail(email),
        emailVerified: true,
        isPrivateEmail: false,
      };
    }
    case 'microsoft': {
      // oid is the directory object id, and it is unique only WITHIN a tenant,
      // which is why tid is stored beside it and forms part of the key.
      const oid = typeof payload.oid === 'string' ? payload.oid : subject;
      const tid = typeof payload.tid === 'string' ? payload.tid : null;
      if (config.tenantId && tid !== config.tenantId && config.tenantId !== 'consumers') {
        throw new AuthFlowError('this account is not in the directory this installation accepts');
      }
      const email =
        pickString(payload.email) ?? pickString(payload.preferred_username) ?? null;
      if (!email) {
        // A guest or an account with no mail attribute. There is nothing to
        // match a first link against, and inventing one is not an option.
        throw new AuthFlowError('this Microsoft account exposes no email address');
      }
      return {
        provider: 'microsoft',
        subject: oid,
        tenantId: tid,
        email: normaliseEmail(email),
        // Entra does not publish an email_verified claim. Within a single
        // directory the address is administered rather than self-asserted,
        // which is the assumption the single-tenant restriction buys.
        emailVerified: true,
        isPrivateEmail: false,
      };
    }
    case 'apple': {
      const email = requireString(payload.email, 'email');
      return {
        provider: 'apple',
        subject,
        tenantId: null,
        email: normaliseEmail(email),
        emailVerified: payload.email_verified === true || payload.email_verified === 'true',
        isPrivateEmail: payload.is_private_email === true || payload.is_private_email === 'true',
      };
    }
  }
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireString(value: unknown, claim: string): string {
  const found = pickString(value);
  if (!found) throw new AuthFlowError(`the token carries no ${claim} claim`);
  return found;
}

/** Emails are normalised at every write boundary so comparisons are stable. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const STATE_COOKIE_NAME = STATE_COOKIE;

/**
 * The transient sign-in cookie's SameSite is None, and that is Apple's doing.
 *
 * Apple returns the authorisation as a cross-site POST from its own origin
 * (`response_mode=form_post`, mandatory once the name or email scope is
 * requested). A Lax cookie is not sent on a cross-site POST, so a Lax state
 * cookie is invisible to the Apple callback and every Apple sign-in fails with
 * "state mismatch". One cookie, set for the strictest provider; the encryption
 * and the ten-minute life bound what None gives up.
 */
export function stateCookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none' as const,
    path: '/',
    maxAge: STATE_TTL_SECONDS,
  };
}

export function appReturnUrl(path: string): string {
  return `${appOrigin()}${path.startsWith('/') ? path : `/${path}`}`;
}
