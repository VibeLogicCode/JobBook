import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { sessions, users } from '@/db/schema';

/**
 * Sessions: rows in PostgreSQL, read through an in-process cache.
 *
 * Stateful because the whole administrative story is revocation. A signed
 * stateless cookie cannot be revoked, only expired, and an administrator who
 * deactivates somebody means now rather than within seven days.
 *
 * PostgreSQL rather than Redis because it is already running, and a session
 * that survives the unattended 3am container update is one fewer thing the
 * owner notices.
 */

export const SESSION_COOKIE = '__Host-session';

/** Idle window. Crossed, the row is treated as expired. */
const IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** Absolute lifetime, fixed at creation. There is no renewal past it. */
const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** `last_seen_at` advances at most this often, so an afternoon costs one write. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;

export interface SessionUser {
  userId: string;
  email: string;
  role: 'owner' | 'admin' | 'bookkeeper';
  displayName: string;
}

interface CacheEntry {
  user: SessionUser;
  /** Absolute expiry of the row, not of the cache entry. */
  expiresAt: number;
  lastSeenAt: number;
  cachedUntil: number;
}

/**
 * Coherent by construction, because the standalone server is a single Node
 * process: revocation deletes the entry synchronously in the same call that
 * writes the row, so no second process can hold a stale copy.
 *
 * This is a latency optimisation, never a correctness mechanism. Run the app as
 * more than one process and the cache must be dropped; every request then pays
 * one indexed read, which is slower and still correct.
 */
const cache = new Map<string, CacheEntry>();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Creates a session and returns the cookie value, which is never stored. */
export async function createSession(args: {
  userId: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ABSOLUTE_MS);

  await db.insert(sessions).values({
    userId: args.userId,
    tokenHash: hashToken(token),
    expiresAt,
    // Bounded because these are headers, and a header is whatever the client
    // decided to send.
    userAgent: args.userAgent?.slice(0, 255) ?? null,
    ip: args.ip?.slice(0, 255) ?? null,
  });

  return { token, expiresAt };
}

/**
 * Resolves a cookie value to the person it belongs to, or null.
 *
 * Returns null for every failure — unknown, revoked, idle-expired, absolutely
 * expired, or belonging to a user who is now inactive or void. The caller
 * cannot distinguish them, and should not: a sign-in page that says "that
 * session was revoked" tells an attacker their guess was once real.
 */
export async function readSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const now = Date.now();

  const cached = cache.get(tokenHash);
  if (cached && cached.cachedUntil > now) {
    if (cached.expiresAt < now || now - cached.lastSeenAt > IDLE_MS) {
      cache.delete(tokenHash);
      return null;
    }
    return cached.user;
  }

  const [row] = await db
    .select({
      session: sessions,
      userId: users.id,
      email: users.email,
      role: users.role,
      displayName: users.displayName,
      isActive: users.isActive,
      recordStatus: users.recordStatus,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));

  if (!row) return null;
  if (row.session.expiresAt.getTime() < now) return null;
  if (now - row.session.lastSeenAt.getTime() > IDLE_MS) return null;
  // A deactivated or voided person keeps their cookie and loses their access.
  if (!row.isActive || row.recordStatus !== 'active') return null;

  const user: SessionUser = {
    userId: row.userId,
    email: row.email,
    role: row.role,
    displayName: row.displayName,
  };

  if (now - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(sessions.id, row.session.id));
  }

  cache.set(tokenHash, {
    user,
    expiresAt: row.session.expiresAt.getTime(),
    lastSeenAt: now,
    cachedUntil: now + CACHE_TTL_MS,
  });

  return user;
}

/** Revokes one session. Nothing is deleted; the row records why it ended. */
export async function revokeSession(token: string, reason: string): Promise<void> {
  const tokenHash = hashToken(token);
  cache.delete(tokenHash);
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
}

/**
 * Revokes every active session for a user: sign out everywhere, a login-method
 * change, a role change, or a deactivation.
 *
 * The cache is cleared entirely rather than per token. Finding this user's
 * entries would mean reading the rows back to learn their hashes, and a cache
 * of at most a handful of entries costs nothing to rebuild.
 */
export async function revokeAllSessions(userId: string, reason: string): Promise<void> {
  cache.clear();
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/** Testing seam. Never call this from application code. */
export function clearSessionCache(): void {
  cache.clear();
}

/**
 * The session cookie.
 *
 * `__Host-` makes the browser refuse the cookie unless it is Secure, Path=/,
 * and carries no Domain — so a cookie set by any other host, or over plain
 * HTTP, is rejected before the app ever sees it.
 *
 * `SameSite=Lax` rather than Strict: Strict drops the cookie when somebody
 * follows a quote link out of an email or a Teams message, and they would be
 * sent to sign in while already signed in. Lax still withholds it from
 * cross-site POSTs, which is the part that matters for CSRF.
 *
 * No Max-Age, so it is a browser-session cookie; the row governs lifetime.
 */
export function sessionCookie(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
  };
}

export function clearedSessionCookie() {
  return { ...sessionCookie(''), maxAge: 0 };
}
