import { and, eq, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { roleEnum } from '@/db/enums';
import { users } from '@/db/schema';
import type { Identity } from '@/lib/auth/access';

/**
 * Authorization: what a role may do (SSO design, section 10).
 *
 * Authentication and authorization are two separate lookups. `access.ts`
 * answers who is asking; this module answers what that answer entitles them
 * to, by reading `users.role` from the database on every request. A valid
 * session is never sufficient on its own, and no permission is ever read from
 * a token: a provider console can be reconfigured by somebody who has never
 * seen this application, and a claim-driven permission would change with it,
 * silently.
 *
 * `AUTH_MODE=local` is not an exception. Local mode supplies one identity from
 * the environment, and that identity is then subject to the same lookup: if
 * the `users` row says `bookkeeper`, the LAN session is a bookkeeper. A mode
 * decides how identity arrives, never what it may do.
 */

/** Derived from the enum, so a fourth role fails to compile against the matrix below. */
export type Role = (typeof roleEnum.enumValues)[number];

/**
 * Every row of the section 10.2 matrix, and the runtime list of them.
 *
 * The array is the source of truth rather than a hand-written union, because
 * the exhaustiveness test needs the names at runtime and a type does not
 * survive to runtime. Adding a name here without a matrix entry below is a
 * compile error; adding a matrix entry that is not here is also a compile
 * error.
 */
export const CAPABILITIES = [
  'quote:write',
  'quote:transition',
  'record:void',
  'worksheet:read',
  'document:generate',
  'user:manage',
  'user:reset-link',
  'rates:edit',
  'tax:edit',
  'organization:edit',
  'sync:configure',
  'backup:configure',
  'audit:read',
  'export:read',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The matrix, in one table, in the order section 10.2 prints it.
 *
 * One table and not scattered `role === 'owner'` comparisons: the spec is a
 * table, and a table belongs in one place where it can be read against the
 * document and tested exhaustively. `satisfies` is what makes that promise
 * enforceable -- a missing or misspelled capability in any role's column is a
 * type error, not a silent `undefined` that `can` would then refuse for
 * reasons nobody could find.
 *
 * `bookkeeper` holding `worksheet:read` is deliberate. The role exists for
 * whoever prepares the year end, and a set of books carrying the revenue but
 * not the cost is not a set of books. What the role cannot do is change a
 * priced record, which is `quote:write`, `quote:transition` and `record:void`
 * being false.
 *
 * The five owner-only capabilities are the ones whose blast radius is the
 * whole deployment rather than one job: the tax rate every future quote
 * inherits, the company's own identity on every document it sends, whether
 * data leaves the box for SharePoint, and whether the backups exist at all.
 */
export const CAPABILITY_MATRIX = {
  owner: {
    'quote:write': true,
    'quote:transition': true,
    'record:void': true,
    'worksheet:read': true,
    'document:generate': true,
    'user:manage': true,
    'user:reset-link': true,
    'rates:edit': true,
    'tax:edit': true,
    'organization:edit': true,
    'sync:configure': true,
    'backup:configure': true,
    'audit:read': true,
    'export:read': true,
  },
  admin: {
    'quote:write': true,
    'quote:transition': true,
    'record:void': true,
    'worksheet:read': true,
    'document:generate': true,
    // "Yes, except `owner` rows and except granting `owner`". Those exceptions
    // are not degrees of this boolean -- they are the guardrails at the foot of
    // this file, because they depend on the target row and on the role being
    // handed out, neither of which the actor's role alone can decide.
    'user:manage': true,
    'user:reset-link': true,
    'rates:edit': true,
    'tax:edit': false,
    'organization:edit': false,
    'sync:configure': false,
    'backup:configure': false,
    'audit:read': true,
    'export:read': true,
  },
  bookkeeper: {
    'quote:write': false,
    'quote:transition': false,
    'record:void': false,
    'worksheet:read': true,
    'document:generate': true,
    'user:manage': false,
    'user:reset-link': false,
    'rates:edit': false,
    'tax:edit': false,
    'organization:edit': false,
    'sync:configure': false,
    'backup:configure': false,
    'audit:read': true,
    'export:read': true,
  },
} as const satisfies Record<Role, Record<Capability, boolean>>;

/** Why a request was refused, so a caller can pick a message without matching on one. */
export type RefusalReason = 'no-account' | 'inactive' | 'not-permitted';

export class PermissionError extends Error {
  constructor(readonly reason: RefusalReason, message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

/** The only fields authorization reads. A role from anywhere else is a role the browser can edit. */
export interface UserRef {
  id: string;
  role: Role;
}

export interface Actor extends UserRef {
  email: string;
}

/**
 * Whether a role holds a capability. Pure, and the only reader of the matrix.
 *
 * Indexed and compared to `true` rather than coerced: an unknown role, an
 * unknown capability, or an inherited name like `toString` each yield
 * something that is not `true`, so each is refused. Deny by default is the
 * second consequence in section 10.1, and it has to hold for whatever a
 * hand-written `as Capability` cast lets through.
 */
export function can(role: Role, capability: Capability): boolean {
  return CAPABILITY_MATRIX[role]?.[capability] === true;
}

/**
 * The `users` row behind an identity.
 *
 * The email is lowercased and trimmed to match, because that is the form every
 * write boundary stores (section 2.2) and the form the first-link comparison
 * uses. Comparing against the stored column rather than against
 * `lower(email)` keeps the unique index usable, which is the reason no
 * functional index was added.
 *
 * Void and inactive are separate states and both refuse. A voided `users` row
 * is not supposed to exist -- deactivation is `is_active`, because `email` is
 * UNIQUE and a voided row would permanently block re-adding the person -- but
 * `record_status` is on the table, so it is checked rather than assumed.
 */
export async function resolveActor(identity: Identity): Promise<Actor> {
  const email = identity.email.trim().toLowerCase();

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      recordStatus: users.recordStatus,
    })
    .from(users)
    .where(eq(users.email, email));

  if (!row) {
    throw new PermissionError('no-account', `no users row for ${email}`);
  }
  if (row.recordStatus !== 'active') {
    throw new PermissionError('inactive', `the users row for ${email} is void`);
  }
  if (!row.isActive) {
    throw new PermissionError('inactive', `the account for ${email} has been deactivated`);
  }

  return { id: row.id, email: row.email, role: row.role };
}

/**
 * Refuses unless the identity's row holds the capability.
 *
 * Called at the top of every server action and route handler, before any
 * argument is read, so that adding a route without one is a visible omission
 * instead of an open door. It returns the row it resolved because the caller
 * almost always needs the actor's id -- for `created_by`, and for the
 * self-role guardrail -- and a second lookup would be a second answer.
 *
 * Named `requireCapability` rather than the spec's `require`: `require` is the
 * CommonJS global, and shadowing it in a module Next.js may transpile is a
 * debugging session nobody needs.
 */
export async function requireCapability(
  identity: Identity,
  capability: Capability,
): Promise<Actor> {
  const actor = await resolveActor(identity);
  if (!can(actor.role, capability)) {
    throw new PermissionError('not-permitted', `${actor.role} may not ${capability}`);
  }
  return actor;
}

/**
 * Guardrail 1 (section 3.1): an `admin` may not create, edit, deactivate, or
 * change the sign-in method of a user whose role is `owner`. Owner rows are
 * visible to an `admin` and read-only to one.
 *
 * Written as "the actor is not an owner" rather than "the actor is an admin"
 * so a role added to the matrix later cannot inherit the exemption by
 * omission. The users screen calls this to decide whether to render a row's
 * controls at all, which is why it answers rather than throws.
 */
export function canManageUser(actor: UserRef, target: UserRef): boolean {
  if (!can(actor.role, 'user:manage')) return false;
  return target.role !== 'owner' || actor.role === 'owner';
}

/**
 * Guardrail 2: an `admin` may not grant `owner` to anyone, themselves
 * included. Only an `owner` promotes an `owner`.
 *
 * Separate from `canManageUser` because the target of a promotion is an
 * ordinary row an `admin` may otherwise edit. It is the role being handed out
 * that is reserved, not the row receiving it.
 */
export function canGrantRole(actor: UserRef, role: Role): boolean {
  if (!can(actor.role, 'user:manage')) return false;
  return role !== 'owner' || actor.role === 'owner';
}

/**
 * Guardrail 3: nobody, at any role, changes their own role.
 *
 * Self-elevation is refused even for an `owner` -- a second owner or the
 * recovery script in section 3.5 does it. Throws rather than answers because
 * there is no interface state to render: the screen never offers a role picker
 * on the signed-in user's own row, so reaching here is a crafted request or a
 * bug.
 */
export function refuseSelfRoleChange(actor: UserRef, targetId: string): void {
  if (actor.id === targetId) {
    throw new PermissionError(
      'not-permitted',
      'nobody changes their own role; another owner or the recovery script does it',
    );
  }
}

/**
 * Guardrail 4: the last active `owner` cannot be demoted or deactivated, by
 * anyone.
 *
 * This is the application half. Section 10.4 asks for it in the database as
 * well, which is a trigger in a migration, because this is the only guardrail
 * whose failure leaves no route back in through the interface.
 *
 * One query and not two: "is this user an owner" and "is there another active
 * owner" have to be answered from the same snapshot, or a concurrent
 * deactivation landing between two reads lets both of them pass.
 */
export async function assertNotLastOwner(userId: string): Promise<void> {
  const activeOwner = and(
    eq(users.role, 'owner'),
    eq(users.isActive, true),
    eq(users.recordStatus, 'active'),
  );

  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      isActive: users.isActive,
      recordStatus: users.recordStatus,
    })
    .from(users)
    .where(or(eq(users.id, userId), activeOwner));

  const target = rows.find((row) => row.id === userId);
  // Not an owner, so not the last one. Deactivating a bookkeeper locks nobody out.
  if (!target || target.role !== 'owner') return;

  const anotherOwner = rows.some(
    (row) => row.id !== userId && row.role === 'owner' && row.isActive && row.recordStatus === 'active',
  );
  if (!anotherOwner) {
    throw new PermissionError(
      'not-permitted',
      'this is the last active owner; promote another owner first',
    );
  }
}
