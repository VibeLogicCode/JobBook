import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { AuthError, type Identity } from '@/lib/auth/access';

/**
 * Who a request is, in local mode, when nothing names them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * `LOCAL_USER_EMAIL` used to be mandatory, and it had to name a `users` row
 * before anybody could sign in -- so a fresh install could not bootstrap
 * itself, and every customer needed a compose file with his own address in it.
 * The owner put the consequence plainly: *"if i have to deploy this from git
 * to 100 people i need to have 100 diff compose files with their emails?"*
 *
 * A product ships one file. So the variable is optional, and when it is absent
 * this module answers the question from the database instead.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR BRANCHES
 * ---------------------------------------------------------------------------
 *
 * 1. **Set.** Used as given, by `localIdentity`. This module is not consulted.
 *    An operator who names an address still gets exactly what he asked for,
 *    including the existing refusal when it matches no active row.
 * 2. **Unset, no accounts.** No identity. Every guarded action refuses, and
 *    the setup wizard runs anyway because it sits outside the permission
 *    guard -- which is the whole reason a fresh install can create its first
 *    user with no identity in existence.
 * 3. **Unset, exactly one active account.** That account. There is nobody else
 *    it could be.
 * 4. **Unset, two or more active accounts.** REFUSED, loudly, naming the fix.
 *
 * Branch 4 is the one that must never be guessed. Local mode has no password
 * and no session: the identity IS the configuration. With two accounts and
 * nothing selecting between them, choosing either means silently acting as a
 * person who is not asking, and acting as the wrong person is worse than not
 * running.
 *
 * ---------------------------------------------------------------------------
 * WHY ROLE IS NOT CONSIDERED
 * ---------------------------------------------------------------------------
 *
 * Branch 3 does not require the sole account to be an owner. Authentication
 * establishes WHO; `requireCapability` decides what they may do, from the row.
 * A deployment whose only account is a bookkeeper should arrive as that
 * bookkeeper and be refused the things a bookkeeper is refused -- not be
 * promoted, and not be locked out.
 */

/**
 * The decision, given the active accounts. Pure, so all four branches are
 * assertable without a database.
 *
 * Throws rather than returning a variant for branch 4 because there is no
 * caller that could do anything useful with "ambiguous" other than refuse,
 * and a returned error is one somebody forgets to check.
 */
export function soleOwnerFrom(activeEmails: readonly string[]): Identity | null {
  if (activeEmails.length === 0) return null;

  if (activeEmails.length > 1) {
    throw new AuthError(
      `AUTH_MODE=local with no LOCAL_USER_EMAIL, and this deployment has ` +
        `${activeEmails.length} active accounts. Local mode signs every request in as one ` +
        `person and there is nothing here to say which. Set LOCAL_USER_EMAIL to the address ` +
        `that should be signed in, or deactivate the accounts that should not be.`,
    );
  }

  return { email: activeEmails[0]!, local: true };
}

/**
 * The resolved identity, cached in process.
 *
 * Modelled on `session.ts`, and carrying the same warning: **a latency
 * optimisation, never a correctness mechanism.** The standalone server is a
 * single Node process, so a synchronous invalidation in the same call that
 * writes a user is coherent by construction. Run more than one process and
 * this cache must be dropped; every request then pays one indexed read, which
 * is slower and still correct.
 *
 * Only a POSITIVE answer is cached. Branch 2 -- no accounts -- is the
 * bootstrap state, and caching it would make the installer wait out a TTL
 * between finishing the first-user step and being able to use the product he
 * just set up. A count over an empty table is not worth that.
 */
const TTL_MS = 60 * 1000;

let cached: { identity: Identity; until: number } | null = null;

/**
 * Drops the cached answer.
 *
 * Called by every path that creates, deactivates or reactivates a user, so the
 * transition into branch 4 is immediate rather than delayed by up to a minute.
 * That ordering matters in one direction especially: the owner who adds a
 * second account should meet the refusal on his next request, while he still
 * remembers adding it, rather than a minute later while doing something else.
 */
export function forgetSoleOwner(): void {
  cached = null;
}

export async function resolveSoleOwner(): Promise<Identity | null> {
  if (cached && cached.until > Date.now()) return cached.identity;

  // Every active row, not a `limit(2)`. Two rows would be enough to DECIDE,
  // but the refusal names a count, and a message reading "2 active accounts"
  // to somebody who has five is a message that gets distrusted -- after which
  // the sentence naming the fix is distrusted with it. The table is small by
  // the nature of the product (an owner and a few staff), the read is indexed,
  // and the answer is cached, so precision costs nothing worth having.
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.isActive, true));

  const identity = soleOwnerFrom(rows.map((row) => row.email));
  cached = identity ? { identity, until: Date.now() + TTL_MS } : null;
  return identity;
}
