import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import type { Identity } from '@/lib/auth/access';
import {
  assertNotLastOwner,
  CAPABILITIES,
  can,
  canGrantRole,
  canManageUser,
  type Capability,
  type Role,
  PermissionError,
  refuseSelfRoleChange,
  requireCapability,
  resolveActor,
} from '@/lib/auth/permissions';

/**
 * The guardrails against the real database.
 *
 * The matrix itself is covered exhaustively and purely in
 * tests/unit/permissions.test.ts. What needs a database is everything that
 * depends on a row: that the role comes from `users` and not from the identity
 * that arrived, that a deactivated or voided row is refused, and that the last
 * active owner is counted rather than assumed.
 *
 * Section 10.4 also asks for the last-owner rule in the database. That half is
 * a trigger in a migration, so it is not asserted here.
 */

const PEOPLE = {
  owner: { email: 'ada.fenwick@example.com', displayName: 'Ada Fenwick', role: 'owner' },
  admin: { email: 'bram.halloway@example.com', displayName: 'Bram Halloway', role: 'admin' },
  bookkeeper: {
    email: 'cora.nightingale@example.com',
    displayName: 'Cora Nightingale',
    role: 'bookkeeper',
  },
} as const satisfies Record<Role, { email: string; displayName: string; role: Role }>;

const SECOND_OWNER = {
  email: 'devi.marchetti@example.com',
  displayName: 'Devi Marchetti',
  role: 'owner',
} as const;

const ROLES: Role[] = ['owner', 'admin', 'bookkeeper'];

/** No account exists for this address in any test. */
const STRANGER = 'ines.okafor@example.com';

const ids: Record<Role, string> = { owner: '', admin: '', bookkeeper: '' };

/** An identity is only ever an email and how it arrived; the role comes from the row. */
const identity = (email: string, local = false): Identity => ({ email, local });

async function addUser(person: {
  email: string;
  displayName: string;
  role: Role;
}): Promise<string> {
  // An explicit projection rather than a bare `returning()`: this suite is
  // about four columns of `users`, and a fixture that reads the whole row
  // breaks on every column the table gains.
  const [row] = await db.insert(users).values(person).returning({ id: users.id });
  return row!.id;
}

/**
 * The refusal reason, or the string 'allowed' when there was none.
 *
 * Collapsing both outcomes to one value keeps every assertion a single
 * `toBe`, and asserting on `reason` rather than on the message is the point of
 * the field: a caller choosing a message must not have to match on one.
 */
function outcomeOf(run: () => Promise<unknown>): Promise<string> {
  return run().then(
    () => 'allowed',
    (error: unknown) => (error instanceof PermissionError ? error.reason : `unexpected: ${error}`),
  );
}

beforeEach(async () => {
  // audit_log first: the trigger on `users` writes a row per insert and per
  // update, and cascade would not reach it -- there is no foreign key.
  await db.execute(sql`truncate table audit_log, users restart identity cascade`);
  for (const role of ROLES) {
    ids[role] = await addUser(PEOPLE[role]);
  }
});

describe('resolveActor', () => {
  it('reads the role from the row rather than from the identity', async () => {
    const actor = await resolveActor(identity(PEOPLE.bookkeeper.email));
    expect(actor).toEqual({
      id: ids.bookkeeper,
      email: PEOPLE.bookkeeper.email,
      role: 'bookkeeper',
    });
  });

  it('treats a local-mode identity exactly like one from a provider', async () => {
    // Section 10.1: a mode decides how identity arrives, never what it may do.
    const actor = await resolveActor(identity(PEOPLE.bookkeeper.email, true));
    expect(actor.role).toBe('bookkeeper');
    expect(await outcomeOf(() => requireCapability(identity(PEOPLE.bookkeeper.email, true), 'quote:write'))).toBe(
      'not-permitted',
    );
  });

  it('matches the email lowercased and trimmed, as every write boundary stores it', async () => {
    const actor = await resolveActor(identity('  Ada.Fenwick@Example.COM  '));
    expect(actor.id).toBe(ids.owner);
  });

  it('refuses an email with no users row', async () => {
    expect(await outcomeOf(() => resolveActor(identity(STRANGER)))).toBe('no-account');
  });
});

describe('a role change takes effect at once', () => {
  it('refuses the next request after a demotion, with no cached role in the way', async () => {
    // Section 10.1's third consequence. Authorization is a lookup per request,
    // so the demotion needs nothing else to take hold. The session half of
    // this -- revoking the cookie the demoted user still holds -- belongs to
    // the sessions module.
    const before = await requireCapability(identity(PEOPLE.admin.email), 'quote:write');
    expect(before.role).toBe('admin');

    await db.update(users).set({ role: 'bookkeeper' }).where(eq(users.id, ids.admin));

    expect(await outcomeOf(() => requireCapability(identity(PEOPLE.admin.email), 'quote:write'))).toBe(
      'not-permitted',
    );
  });
});

/** Section 10.4, case 1. */
describe('an admin editing an owner row', () => {
  it('is refused, while an owner is permitted', async () => {
    const admin = await requireCapability(identity(PEOPLE.admin.email), 'user:manage');
    const owner = await requireCapability(identity(PEOPLE.owner.email), 'user:manage');
    const ownerRow = { id: ids.owner, role: 'owner' as Role };

    expect(canManageUser(admin, ownerRow)).toBe(false);
    expect(canManageUser(owner, ownerRow)).toBe(true);
  });

  it('leaves the admin free to manage every other row', async () => {
    const admin = await requireCapability(identity(PEOPLE.admin.email), 'user:manage');
    expect(canManageUser(admin, { id: ids.admin, role: 'admin' })).toBe(true);
    expect(canManageUser(admin, { id: ids.bookkeeper, role: 'bookkeeper' })).toBe(true);
  });

  it('refuses a bookkeeper the users screen before any row is considered', async () => {
    expect(await outcomeOf(() => requireCapability(identity(PEOPLE.bookkeeper.email), 'user:manage'))).toBe(
      'not-permitted',
    );
    const bookkeeper = await resolveActor(identity(PEOPLE.bookkeeper.email));
    expect(canManageUser(bookkeeper, { id: ids.bookkeeper, role: 'bookkeeper' })).toBe(false);
  });

  it('also refuses an admin resetting an owner link or signing an owner out', async () => {
    // The second users-screen row in section 10.2 carries the same exception.
    const admin = await requireCapability(identity(PEOPLE.admin.email), 'user:reset-link');
    expect(canManageUser(admin, { id: ids.owner, role: 'owner' })).toBe(false);
  });
});

/** Section 10.4, case 2. */
describe('an admin granting owner', () => {
  it('is refused, to anyone, themselves included', async () => {
    const admin = await requireCapability(identity(PEOPLE.admin.email), 'user:manage');
    expect(canGrantRole(admin, 'owner')).toBe(false);
    // The target does not matter: it is the role being handed out that is
    // reserved, so promoting the bookkeeper is refused for the same reason as
    // self-promotion.
    expect(canManageUser(admin, { id: ids.bookkeeper, role: 'bookkeeper' })).toBe(true);
    expect(canGrantRole(admin, 'admin')).toBe(true);
    expect(canGrantRole(admin, 'bookkeeper')).toBe(true);
  });

  it('is permitted to an owner', async () => {
    const owner = await requireCapability(identity(PEOPLE.owner.email), 'user:manage');
    expect(canGrantRole(owner, 'owner')).toBe(true);
  });
});

/** Section 10.4, case 3. */
describe('changing your own role', () => {
  it.each(ROLES)('is refused for %s', async (role) => {
    const actor = await resolveActor(identity(PEOPLE[role].email));
    expect(() => refuseSelfRoleChange(actor, actor.id)).toThrow(PermissionError);
  });

  it('is refused for an owner too, who has every other capability', async () => {
    // Guardrail 3 is the one guardrail no role escapes. An owner holds
    // `user:manage` and may grant `owner`, and still may not do it to
    // themselves.
    const owner = await requireCapability(identity(PEOPLE.owner.email), 'user:manage');
    expect(canGrantRole(owner, 'owner')).toBe(true);
    expect(() => refuseSelfRoleChange(owner, ids.owner)).toThrow(/their own role/);
  });

  it('permits an owner changing somebody else', async () => {
    const owner = await resolveActor(identity(PEOPLE.owner.email));
    expect(() => refuseSelfRoleChange(owner, ids.admin)).not.toThrow();
  });
});

/** Section 10.4, case 4. */
describe('the last active owner', () => {
  it('cannot be deactivated or demoted', async () => {
    expect(await outcomeOf(() => assertNotLastOwner(ids.owner))).toBe('not-permitted');
  });

  it('can be, once a second owner exists', async () => {
    await addUser(SECOND_OWNER);
    expect(await outcomeOf(() => assertNotLastOwner(ids.owner))).toBe('allowed');
  });

  it('does not count a deactivated second owner', async () => {
    const secondId = await addUser(SECOND_OWNER);
    await db.update(users).set({ isActive: false }).where(eq(users.id, secondId));
    expect(await outcomeOf(() => assertNotLastOwner(ids.owner))).toBe('not-permitted');
  });

  it('does not count a voided second owner', async () => {
    const secondId = await addUser(SECOND_OWNER);
    await db
      .update(users)
      .set({ recordStatus: 'void', voidedAt: new Date(), voidReason: 'added in error' })
      .where(eq(users.id, secondId));
    expect(await outcomeOf(() => assertNotLastOwner(ids.owner))).toBe('not-permitted');
  });

  it('does not count an admin, however many there are', async () => {
    // The rule is about owners. An office full of admins is still a lockout.
    await addUser({ email: 'eli.brandt@example.com', displayName: 'Eli Brandt', role: 'admin' });
    expect(await outcomeOf(() => assertNotLastOwner(ids.owner))).toBe('not-permitted');
  });

  it('does not stand in the way of deactivating anybody who is not an owner', async () => {
    expect(await outcomeOf(() => assertNotLastOwner(ids.admin))).toBe('allowed');
    expect(await outcomeOf(() => assertNotLastOwner(ids.bookkeeper))).toBe('allowed');
  });

  it('does not stand in the way of deactivating an owner who is already inactive', async () => {
    // Two owners, one already deactivated: the rule protects the last ACTIVE
    // owner, and a row that is already inactive is not it.
    const secondId = await addUser(SECOND_OWNER);
    await db.update(users).set({ isActive: false }).where(eq(users.id, secondId));
    expect(await outcomeOf(() => assertNotLastOwner(secondId))).toBe('allowed');
  });
});

/** Section 10.4, case 5. */
describe('an account that is inactive or voided', () => {
  /**
   * A second owner, because the database refuses to leave a deployment with no
   * active owner at all (migration 0006). Deactivating the only owner is not a
   * state the application can reach, so a fixture that assumed it was testing
   * against a database that does not exist.
   */
  let spareOwnerId: string;

  beforeEach(async () => {
    const [row] = await db
      .insert(users)
      .values({
        email: 'second.owner@example.com',
        displayName: 'Rosalind Adeyemi',
        role: 'owner',
      })
      .returning();
    spareOwnerId = row!.id;
  });

  it.each([...CAPABILITIES])('refuses an owner deactivated in the row: %s', async (capability) => {
    await db.update(users).set({ isActive: false }).where(eq(users.id, ids.owner));
    expect(await outcomeOf(() => requireCapability(identity(PEOPLE.owner.email), capability))).toBe(
      'inactive',
    );
  });

  it.each([...CAPABILITIES])('refuses an owner whose row is void: %s', async (capability) => {
    await db
      .update(users)
      .set({ recordStatus: 'void', voidedAt: new Date(), voidReason: 'left the company' })
      .where(eq(users.id, ids.owner));
    expect(await outcomeOf(() => requireCapability(identity(PEOPLE.owner.email), capability))).toBe(
      'inactive',
    );
  });

  it.each([...CAPABILITIES])('refuses an address with no row at all: %s', async (capability) => {
    expect(await outcomeOf(() => requireCapability(identity(STRANGER), capability))).toBe(
      'no-account',
    );
  });

  it('cannot deactivate the last active owner at all, which is why a spare exists', async () => {
    // The database half of guardrail 4. With the spare removed, the remaining
    // owner cannot be deactivated by anybody, through any code path.
    await db.update(users).set({ isActive: false }).where(eq(users.id, spareOwnerId));
    await expect(
      db.update(users).set({ isActive: false }).where(eq(users.id, ids.owner)),
    ).rejects.toThrow();
  });

  it('refuses an inactive owner even the capabilities the matrix grants everyone', async () => {
    // Named separately because these are the ones a "read is harmless" reading
    // of the matrix would let through.
    await db.update(users).set({ isActive: false }).where(eq(users.id, ids.owner));
    for (const capability of ['audit:read', 'worksheet:read', 'export:read'] satisfies Capability[]) {
      expect(await outcomeOf(() => requireCapability(identity(PEOPLE.owner.email), capability))).toBe(
        'inactive',
      );
    }
  });
});

describe('requireCapability against a live row', () => {
  it.each(ROLES)('gives %s exactly what the matrix gives them', async (role) => {
    // The positive control for the refusals above: with an active row, the
    // outcome is the matrix and nothing else.
    for (const capability of CAPABILITIES) {
      const expected = can(role, capability) ? 'allowed' : 'not-permitted';
      expect(
        await outcomeOf(() => requireCapability(identity(PEOPLE[role].email), capability)),
      ).toBe(expected);
    }
  });

  it('returns the actor so the caller does not look the row up twice', async () => {
    const actor = await requireCapability(identity(PEOPLE.admin.email), 'quote:write');
    expect(actor).toEqual({ id: ids.admin, email: PEOPLE.admin.email, role: 'admin' });
  });

  it('refuses a capability it has never heard of, whatever the role', async () => {
    // Deny by default reaches the database path too, not only `can`.
    for (const role of ROLES) {
      expect(
        await outcomeOf(() =>
          requireCapability(identity(PEOPLE[role].email), 'quote:delete' as Capability),
        ),
      ).toBe('not-permitted');
    }
  });
});
