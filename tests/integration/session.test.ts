import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { sessions, users } from '@/db/schema';
import {
  clearSessionCache,
  createSession,
  readSession,
  revokeAllSessions,
  revokeSession,
} from '@/lib/auth/session';

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, sessions, user_identities, users restart identity cascade
  `);
  clearSessionCache();
});

async function seedUser(over: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db
    .insert(users)
    .values({
      email: 'jane@example.com',
      displayName: 'Jane Okafor',
      role: 'admin',
      ...over,
    })
    .returning();
  return row!;
}

/** Moves a session's clock without waiting for it. */
async function ageSession(token: string, patch: Partial<typeof sessions.$inferInsert>) {
  const [row] = await db.select().from(sessions);
  await db.update(sessions).set(patch).where(eq(sessions.id, row!.id));
  clearSessionCache();
  return token;
}

describe('createSession', () => {
  it('stores only a hash, never the cookie value', async () => {
    const user = await seedUser();
    const { token } = await createSession({ userId: user.id });
    const [row] = await db.select().from(sessions);

    expect(row?.tokenHash).toBeTruthy();
    // A database dump must not yield a cookie anybody can present.
    expect(row?.tokenHash).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('bounds the user agent and address, which are client-supplied', async () => {
    const user = await seedUser();
    await createSession({ userId: user.id, userAgent: 'x'.repeat(4000), ip: 'y'.repeat(4000) });
    const [row] = await db.select().from(sessions);
    expect(row?.userAgent?.length).toBe(255);
    expect(row?.ip?.length).toBe(255);
  });
});

describe('readSession', () => {
  it('resolves a live session to the person and their role', async () => {
    const user = await seedUser({ role: 'owner' });
    const { token } = await createSession({ userId: user.id });

    expect(await readSession(token)).toEqual({
      userId: user.id,
      email: 'jane@example.com',
      role: 'owner',
      displayName: 'Jane Okafor',
    });
  });

  it('returns null for an unknown token', async () => {
    expect(await readSession('not-a-real-token')).toBeNull();
    expect(await readSession(undefined)).toBeNull();
  });

  it('refuses a session past its absolute expiry', async () => {
    const user = await seedUser();
    const { token } = await createSession({ userId: user.id });
    await ageSession(token, { expiresAt: new Date(Date.now() - 1000) });
    expect(await readSession(token)).toBeNull();
  });

  it('refuses a session past the idle window even when the absolute limit holds', async () => {
    const user = await seedUser();
    const { token } = await createSession({ userId: user.id });
    // Eight days idle, inside the thirty-day absolute lifetime.
    await ageSession(token, { lastSeenAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) });
    expect(await readSession(token)).toBeNull();
  });

  it('refuses a session whose user has been deactivated', async () => {
    // The person keeps their cookie and loses their access, which is the whole
    // reason these sessions are rows rather than a signed token.
    const user = await seedUser();
    const { token } = await createSession({ userId: user.id });
    expect(await readSession(token)).not.toBeNull();

    await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));
    clearSessionCache();
    expect(await readSession(token)).toBeNull();
  });

  it('refuses a session whose user has been voided', async () => {
    const user = await seedUser();
    const { token } = await createSession({ userId: user.id });
    await db
      .update(users)
      .set({ recordStatus: 'void', voidReason: 'left the company' })
      .where(eq(users.id, user.id));
    clearSessionCache();
    expect(await readSession(token)).toBeNull();
  });

  it('advances last_seen_at at most once an hour', async () => {
    const user = await seedUser();
    const { token } = await createSession({ userId: user.id });

    // Fresh: reading must not write.
    const [before] = await db.select().from(sessions);
    clearSessionCache();
    await readSession(token);
    const [unchanged] = await db.select().from(sessions);
    expect(unchanged?.lastSeenAt.getTime()).toBe(before?.lastSeenAt.getTime());

    // Two hours stale: the next read touches it, so a busy afternoon on the
    // worksheet costs one write rather than one per request.
    await ageSession(token, { lastSeenAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
    await readSession(token);
    const [touched] = await db.select().from(sessions);
    expect(touched!.lastSeenAt.getTime()).toBeGreaterThan(
      Date.now() - 2 * 60 * 60 * 1000 + 1000,
    );
  });
});

describe('revocation', () => {
  it('takes effect immediately, without waiting for the cache to expire', async () => {
    const user = await seedUser();
    const { token } = await createSession({ userId: user.id });
    // Warm the cache, so this proves revocation drops the entry rather than
    // relying on the sixty-second TTL.
    expect(await readSession(token)).not.toBeNull();

    await revokeSession(token, 'signed out');
    expect(await readSession(token)).toBeNull();
  });

  it('records why a session ended rather than deleting the row', async () => {
    const user = await seedUser();
    const { token } = await createSession({ userId: user.id });
    await revokeSession(token, 'signed out');

    const [row] = await db.select().from(sessions);
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.revokeReason).toBe('signed out');
  });

  it('revokes every session for a user, which is Sign out everywhere', async () => {
    const user = await seedUser();
    const first = await createSession({ userId: user.id, userAgent: 'phone' });
    const second = await createSession({ userId: user.id, userAgent: 'laptop' });
    expect(await readSession(first.token)).not.toBeNull();

    await revokeAllSessions(user.id, 'method changed');

    expect(await readSession(first.token)).toBeNull();
    expect(await readSession(second.token)).toBeNull();
    const rows = await db.select().from(sessions);
    expect(rows.every((row) => row.revokeReason === 'method changed')).toBe(true);
  });

  it('leaves the other user sessions alone', async () => {
    const jane = await seedUser();
    const sam = await seedUser({ email: 'sam@example.com', displayName: 'Sam Reyes' });
    const janeSession = await createSession({ userId: jane.id });
    const samSession = await createSession({ userId: sam.id });

    await revokeAllSessions(jane.id, 'deactivated');

    expect(await readSession(janeSession.token)).toBeNull();
    expect(await readSession(samSession.token)).not.toBeNull();
  });
});
