import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * No network. Nothing here reaches Cloudflare's JWKS endpoint, because every
 * case under test is refused before the signature is ever checked -- which is
 * itself the property worth pinning down: a misconfigured deployment must fail
 * on its own configuration, not on a fetch.
 *
 * The module is imported fresh per test. `access.ts` memoises the remote key
 * set in module scope, and `AuthError` must be the class from the same module
 * instance for an `instanceof` assertion to mean anything.
 */
async function load() {
  vi.resetModules();
  return import('@/lib/auth/access');
}

const OWNER = 'owner@example.com';
const TEAM_DOMAIN = 'https://acme.cloudflareaccess.com';
const AUD = '0'.repeat(64);

/** The suite runs against a real `.env`, so every variable a case depends on is
 * stated, including the ones it depends on being absent. */
function env(vars: Partial<Record<
  'AUTH_MODE' | 'LOCAL_USER_EMAIL' | 'CF_ACCESS_TEAM_DOMAIN' | 'CF_ACCESS_AUD',
  string
>>) {
  for (const key of ['AUTH_MODE', 'LOCAL_USER_EMAIL', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD'] as const) {
    vi.stubEnv(key, vars[key]);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('localIdentity', () => {
  it('refuses to run when AUTH_MODE is not local', async () => {
    env({ LOCAL_USER_EMAIL: OWNER });
    const { localIdentity, AuthError } = await load();
    expect(() => localIdentity()).toThrow(AuthError);
    expect(() => localIdentity()).toThrow(/AUTH_MODE is not local/);
  });

  it('refuses an AUTH_MODE it does not recognise', async () => {
    env({ AUTH_MODE: 'access', LOCAL_USER_EMAIL: OWNER });
    const { localIdentity } = await load();
    expect(() => localIdentity()).toThrow(/AUTH_MODE is not local/);
  });

  it('defers to the database when no user is named', async () => {
    // CONTRACT CHANGED 2026-09-09. This used to throw
    // "AUTH_MODE=local requires LOCAL_USER_EMAIL", which meant a fresh
    // install could not bootstrap itself and every customer needed a compose
    // file carrying his own address. Null now means "the environment does not
    // say; ask the users table" -- it does NOT mean anonymous, and nothing
    // downstream treats it as permission for anything. The four branches and
    // the refusals live in `lib/auth/sole-owner.ts`.
    env({ AUTH_MODE: 'local' });
    const { localIdentity } = await load();
    expect(localIdentity()).toBeNull();
  });

  it('still refuses an empty LOCAL_USER_EMAIL by deferring rather than trusting it', async () => {
    // An empty string is not an address. It must not be handed on as one --
    // `guard()` would look up '' and refuse with a sentence naming nobody.
    env({ AUTH_MODE: 'local', LOCAL_USER_EMAIL: '' });
    const { localIdentity } = await load();
    expect(localIdentity()).toBeNull();
  });

  it('refuses the Access conflict BEFORE considering whether a user is named', async () => {
    // Ordering, asserted deliberately. With the email now optional, a
    // half-configured tunnel plus no named user must still hit the conflict
    // refusal rather than falling through to the database and resolving
    // somebody -- which would be the "silently falls back to LAN mode"
    // failure this refusal exists to prevent.
    env({ AUTH_MODE: 'local', CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN });
    const { localIdentity } = await load();
    expect(() => localIdentity()).toThrow(/cannot be combined/);
  });

  it('refuses to run alongside CF_ACCESS_TEAM_DOMAIN', async () => {
    // A half-configured tunnel must not silently fall back to LAN mode, where
    // every request would resolve to the owner.
    env({ AUTH_MODE: 'local', LOCAL_USER_EMAIL: OWNER, CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN });
    const { localIdentity, AuthError } = await load();
    expect(() => localIdentity()).toThrow(AuthError);
    expect(() => localIdentity()).toThrow(/cannot be combined/);
  });

  it('refuses to run alongside CF_ACCESS_AUD', async () => {
    env({ AUTH_MODE: 'local', LOCAL_USER_EMAIL: OWNER, CF_ACCESS_AUD: AUD });
    const { localIdentity } = await load();
    expect(() => localIdentity()).toThrow(/cannot be combined/);
  });

  it('returns the named user when it is the only mode configured', async () => {
    env({ AUTH_MODE: 'local', LOCAL_USER_EMAIL: OWNER });
    const { localIdentity } = await load();
    expect(localIdentity()).toEqual({ email: OWNER, local: true });
  });
});

describe('verifyAccessJwt', () => {
  it('rejects a request carrying no token', async () => {
    env({ CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD });
    const { verifyAccessJwt, AuthError } = await load();
    await expect(verifyAccessJwt(undefined)).rejects.toThrow(AuthError);
    await expect(verifyAccessJwt(undefined)).rejects.toThrow(/no Access token/);
  });

  it('rejects an empty token rather than treating it as absent-but-fine', async () => {
    env({ CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD });
    const { verifyAccessJwt } = await load();
    await expect(verifyAccessJwt('')).rejects.toThrow(/no Access token/);
  });

  it('rejects a token when CF_ACCESS_AUD is not configured', async () => {
    // Without the audience, a JWT minted for any other application in the same
    // Cloudflare team would verify, so this must fail closed and fail early.
    env({ CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN });
    const { verifyAccessJwt, AuthError } = await load();
    await expect(verifyAccessJwt('header.payload.signature')).rejects.toThrow(AuthError);
    await expect(verifyAccessJwt('header.payload.signature')).rejects.toThrow(/CF_ACCESS_AUD/);
  });
});

describe('identify', () => {
  it('returns the local identity in local mode, ignoring the headers', async () => {
    env({ AUTH_MODE: 'local', LOCAL_USER_EMAIL: OWNER });
    const { identify } = await load();
    await expect(identify(new Headers())).resolves.toEqual({ email: OWNER, local: true });
  });

  it('never reads the unsigned Cloudflare email header', async () => {
    env({ CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD });
    const { identify } = await load();
    const headers = new Headers({ 'cf-access-authenticated-user-email': 'attacker@example.com' });
    await expect(identify(headers)).rejects.toThrow(/no Access token/);
  });

  it('rejects a request with no token and no local mode', async () => {
    env({ CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD });
    const { identify, AuthError } = await load();
    await expect(identify(new Headers())).rejects.toThrow(AuthError);
  });
});
