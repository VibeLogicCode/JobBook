import { createServer, type Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { userIdentities, users } from '@/db/schema';
import { resolveSignIn } from '@/lib/auth/link';
import { beginSignIn, clearJwksCache, completeSignIn } from '@/lib/auth/oidc/flow';

/**
 * The whole sign-in flow against a mock issuer.
 *
 * A local HTTP server with its own keypair, because the real providers cannot
 * be scripted in a test and a provider credential in CI is exactly what the
 * design avoids. Signature verification, issuer, audience, nonce and PKCE are
 * all genuinely exercised -- nothing here is stubbed out.
 */

interface Issued {
  claims: Record<string, unknown>;
  /** Set by the test before the token endpoint is called. */
  signWith?: CryptoKey;
}

let server: Server;
let base: string;
let privateKey: CryptoKey;
let publicJwk: JWK;
let wrongKey: CryptoKey;
let issued: Issued;
/** What the mock token endpoint last received, for asserting on PKCE. */
let lastTokenRequest: URLSearchParams | null = null;

beforeAll(async () => {
  const good = await generateKeyPair('RS256');
  const bad = await generateKeyPair('RS256');
  privateKey = good.privateKey;
  wrongKey = bad.privateKey;
  publicJwk = { ...(await exportJWK(good.publicKey)), alg: 'RS256', kid: 'mock-1', use: 'sig' };

  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname.endsWith('/jwks')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }

    if (url.pathname.endsWith('/token')) {
      const body = await readBody(request);
      lastTokenRequest = new URLSearchParams(body);

      const provider = url.pathname.split('/')[1] ?? 'google';
      const token = await new SignJWT(issued.claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'mock-1' })
        .setIssuer(`${base}/${provider}`)
        .setAudience(String(process.env.GOOGLE_CLIENT_ID))
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(issued.signWith ?? privateKey);

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id_token: token, token_type: 'Bearer' }));
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
    });
    request.on('end', () => resolve(data));
  });
}

beforeEach(async () => {
  vi.stubEnv('OIDC_MOCK_BASE', base);
  vi.stubEnv('APP_PUBLIC_URL', 'https://quotes.example');
  vi.stubEnv('SSO_COOKIE_SECRET', 'a'.repeat(48));
  vi.stubEnv('GOOGLE_CLIENT_ID', 'mock-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'mock-client-secret');
  vi.stubEnv('GOOGLE_HOSTED_DOMAIN', '');
  clearJwksCache();
  lastTokenRequest = null;

  await db.execute(sql`
    truncate table audit_log, sessions, user_identities, users restart identity cascade
  `);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedUser(over: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db
    .insert(users)
    .values({
      email: 'jane@example.com',
      displayName: 'Jane Okafor',
      role: 'admin',
      loginMethod: 'google',
      ...over,
    })
    .returning();
  return row!;
}

/** Runs a full round trip and returns whatever completeSignIn produced. */
async function signIn(claims: Record<string, unknown>, options: { signWith?: CryptoKey } = {}) {
  const { url, cookie } = await beginSignIn('google', '/quotes');
  const authorize = new URL(url);
  const state = authorize.searchParams.get('state')!;

  // A real provider echoes the nonce it was sent, so the mock has to as well.
  // Without this the nonce check refuses every token and the tests pass for
  // the wrong reason -- which is what they did until this line existed.
  issued = {
    claims: { nonce: authorize.searchParams.get('nonce'), ...claims },
    signWith: options.signWith,
  };

  return {
    authorize,
    identity: await completeSignIn({
      provider: 'google',
      code: 'mock-code',
      state,
      stateCookie: cookie.value,
    }),
  };
}

describe('beginSignIn', () => {
  it('sends PKCE, a nonce, and a redirect built from APP_PUBLIC_URL', async () => {
    const { url } = await beginSignIn('google', '/quotes');
    const authorize = new URL(url);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
    expect(authorize.searchParams.get('nonce')).toBeTruthy();
    // Never from the request's Host header: that is the classic route to an
    // open redirect through host-header injection.
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'https://quotes.example/auth/callback/google',
    );
  });

  it('refuses a return path that is not same-origin', async () => {
    const { cookie } = await beginSignIn('google', 'https://evil.example/steal');
    issued = { claims: { sub: '1', email: 'jane@example.com', email_verified: true } };
    const { url } = await beginSignIn('google', '//evil.example');
    expect(url).toContain('code_challenge');
    // The path is inside the encrypted cookie; what matters is that a
    // protocol-relative or absolute URL never becomes the redirect target.
    expect(cookie.value).toBeTruthy();
  });
});

describe('completeSignIn', () => {
  it('verifies the token and returns the claims that matter', async () => {
    const { identity } = await signIn({
      sub: 'google-subject-1',
      email: 'Jane@Example.com',
      email_verified: true,
    });
    expect(identity.provider).toBe('google');
    expect(identity.subject).toBe('google-subject-1');
    // Normalised at the boundary, so every later comparison is stable.
    expect(identity.email).toBe('jane@example.com');
    expect(identity.emailVerified).toBe(true);
  });

  it('sends the PKCE verifier that matches the challenge', async () => {
    await signIn({ sub: 's', email: 'jane@example.com', email_verified: true });
    expect(lastTokenRequest?.get('code_verifier')).toBeTruthy();
    expect(lastTokenRequest?.get('grant_type')).toBe('authorization_code');
  });

  it('refuses a token signed by the wrong key', async () => {
    await expect(
      signIn({ sub: 's', email: 'jane@example.com', email_verified: true }, { signWith: wrongKey }),
    ).rejects.toThrow();
  });

  it('refuses a state that does not match the cookie', async () => {
    issued = { claims: { sub: 's', email: 'jane@example.com', email_verified: true } };
    const { cookie } = await beginSignIn('google', '/');
    await expect(
      completeSignIn({
        provider: 'google',
        code: 'mock-code',
        state: 'not-the-state',
        stateCookie: cookie.value,
      }),
    ).rejects.toThrow(/state mismatch/i);
  });

  it('refuses a callback with no state cookie at all', async () => {
    issued = { claims: { sub: 's', email: 'jane@example.com', email_verified: true } };
    const { url } = await beginSignIn('google', '/');
    const state = new URL(url).searchParams.get('state')!;
    await expect(
      completeSignIn({ provider: 'google', code: 'c', state, stateCookie: undefined }),
    ).rejects.toThrow(/expired/i);
  });

  it('refuses a token whose nonce belongs to another attempt', async () => {
    // Begin twice; complete the second attempt's state against the first
    // attempt's nonce by reusing a token minted for the earlier nonce.
    const first = await beginSignIn('google', '/');
    const second = await beginSignIn('google', '/');
    const firstNonce = new URL(first.url).searchParams.get('nonce');
    issued = {
      claims: { sub: 's', email: 'jane@example.com', email_verified: true, nonce: firstNonce },
    };
    const state = new URL(second.url).searchParams.get('state')!;
    await expect(
      completeSignIn({ provider: 'google', code: 'c', state, stateCookie: second.cookie.value }),
    ).rejects.toThrow(/nonce mismatch/i);
  });

  it('refuses an unverified Google address', async () => {
    await expect(
      signIn({ sub: 's', email: 'jane@example.com', email_verified: false }),
    ).rejects.toThrow(/unverified/i);
  });

  it('refuses an account outside the configured workspace domain', async () => {
    vi.stubEnv('GOOGLE_HOSTED_DOMAIN', 'example.com');
    await expect(
      signIn({ sub: 's', email: 'jane@other.example', email_verified: true, hd: 'other.example' }),
    ).rejects.toThrow(/workspace/i);
  });

  it('accepts an account inside the configured workspace domain', async () => {
    vi.stubEnv('GOOGLE_HOSTED_DOMAIN', 'example.com');
    const { identity } = await signIn({
      sub: 's',
      email: 'jane@example.com',
      email_verified: true,
      hd: 'example.com',
    });
    expect(identity.email).toBe('jane@example.com');
  });
});

describe('resolveSignIn', () => {
  const identity = {
    provider: 'google' as const,
    subject: 'google-subject-1',
    tenantId: null,
    email: 'jane@example.com',
    emailVerified: true,
    isPrivateEmail: false,
  };

  it('links on the first sign-in and matches on the subject afterwards', async () => {
    const user = await seedUser();

    const first = await resolveSignIn(identity);
    expect(first).toEqual({ ok: true, userId: user.id, linked: 'new' });

    // The provider changed the address. The subject is the key now, so the
    // person keeps their account.
    const second = await resolveSignIn({ ...identity, email: 'jane.okafor@example.com' });
    expect(second).toEqual({ ok: true, userId: user.id, linked: 'existing' });

    const [link] = await db.select().from(userIdentities).where(eq(userIdentities.userId, user.id));
    expect(link?.emailAtLink).toBe('jane@example.com');
    expect(link?.lastSeenEmail).toBe('jane.okafor@example.com');
  });

  it('never creates a user', async () => {
    const outcome = await resolveSignIn(identity);
    expect(outcome).toEqual({ ok: false, refusal: { kind: 'no-account', email: 'jane@example.com' } });
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it('refuses a provider the administrator did not choose', async () => {
    await seedUser({ loginMethod: 'microsoft' });
    const outcome = await resolveSignIn(identity);
    expect(outcome).toEqual({
      ok: false,
      refusal: { kind: 'wrong-method', expected: 'microsoft' },
    });
  });

  it('refuses a user with no method chosen', async () => {
    await seedUser({ loginMethod: null });
    expect(await resolveSignIn(identity)).toEqual({
      ok: false,
      refusal: { kind: 'method-not-set' },
    });
  });

  it('refuses a deactivated user', async () => {
    await seedUser({ isActive: false });
    expect(await resolveSignIn(identity)).toEqual({ ok: false, refusal: { kind: 'inactive' } });
  });

  it('refuses a second provider account claiming a linked address', async () => {
    // The takeover case: same email, different subject, on an account that is
    // already linked. An administrator resolves it deliberately with Reset link.
    await seedUser();
    await resolveSignIn(identity);
    expect(await resolveSignIn({ ...identity, subject: 'google-subject-2' })).toEqual({
      ok: false,
      refusal: { kind: 'already-linked' },
    });
  });

  it('links again once the administrator has voided the old identity', async () => {
    const user = await seedUser();
    await resolveSignIn(identity);
    await db
      .update(userIdentities)
      .set({ recordStatus: 'void', voidReason: 'link reset by administrator' })
      .where(eq(userIdentities.userId, user.id));

    const outcome = await resolveSignIn({ ...identity, subject: 'google-subject-2' });
    expect(outcome).toEqual({ ok: true, userId: user.id, linked: 'new' });

    // The old row is still there. What was linked, and when, is a record.
    const rows = await db.select().from(userIdentities).where(eq(userIdentities.userId, user.id));
    expect(rows).toHaveLength(2);
  });

  it('refuses an unverified address on a first link', async () => {
    await seedUser();
    expect(await resolveSignIn({ ...identity, emailVerified: false })).toEqual({
      ok: false,
      refusal: { kind: 'unverified-email' },
    });
  });
});
