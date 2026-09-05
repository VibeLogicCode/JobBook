'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { type Actor, type Role, requireCapability } from '@/app/settings/actor';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid, requiredText } from '@/app/settings/validate';
import { authMode, configuredProviders } from '@/app/settings/users/sign-in-mode';

/**
 * User management.
 *
 * ---------------------------------------------------------------------------
 * The four guardrails below MOVE TO `src/lib/auth/permissions.ts`, alongside
 * the capability matrix, once that module lands -- the SSO design makes it the
 * single place a permission decision is written, tested exhaustively against
 * the matrix, and read against the document. They are written out here rather
 * than deferred because handing an `admin` the users screen without them turns
 * a lockout into a takeover, which is the objection the guardrails answer.
 * ---------------------------------------------------------------------------
 *
 * The rules, from the SSO design section 3.1:
 *
 * 1. An `admin` may not create, edit or deactivate a user whose role is
 *    `owner`. Owner rows are visible to an `admin` and read-only.
 * 2. An `admin` may not grant `owner` to anyone, themselves included.
 * 3. Nobody, at any role, changes their own role. Self-elevation is refused
 *    even for an `owner`; a second owner or the recovery script does it.
 * 4. The last active `owner` cannot be deactivated or demoted, by anyone.
 *
 * Rule 4 is the one whose failure leaves no route back in through the
 * interface, which is why the design also asks for it in the database. This
 * check does not replace that constraint; it produces a sentence instead of a
 * constraint violation.
 */

type UserRow = typeof users.$inferSelect;

interface Intent {
  nextRole?: Role;
  nextActive?: boolean;
}

/** The refusal a change would earn, or null when it is permitted. */
async function guardrailBreach(
  actor: Actor,
  target: UserRow,
  intent: Intent,
): Promise<string | null> {
  if (target.role === 'owner' && actor.role !== 'owner') {
    return 'An admin cannot change an owner’s account. Owner rows are visible here but read-only.';
  }

  if (intent.nextRole === 'owner' && actor.role !== 'owner') {
    return 'Only an owner can grant the owner role.';
  }

  const roleChanging = intent.nextRole !== undefined && intent.nextRole !== target.role;
  if (roleChanging && target.id === actor.id) {
    return 'Nobody changes their own role, including an owner. Another owner does it, or the recovery script on the box.';
  }

  const demoting = roleChanging && target.role === 'owner';
  const deactivating = intent.nextActive === false && target.isActive;
  if (target.role === 'owner' && (demoting || deactivating)) {
    const owners = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'owner'), eq(users.isActive, true)));
    if (owners.length <= 1) {
      return 'This is the last active owner. Promote a second owner first — otherwise nobody can grant the role back through this screen.';
    }
  }

  return null;
}

/**
 * Ends every live session for a user.
 *
 * A role change has to take effect at once. A demoted person carrying a
 * cached role for another week is the entire reason these sessions are
 * stateful rather than a signed cookie -- a signed cookie cannot be revoked,
 * only expired.
 *
 * Inlined here for the same reason as the guardrails: it belongs to the
 * session module being written alongside this screen, and a role change that
 * silently leaves the old session valid is not a smaller bug for being
 * somebody else's file.
 */
async function revokeSessions(userId: string, reason: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

function isDuplicateEmail(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('users_email_unique') || message.includes('duplicate key');
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

const addLabels = {
  displayName: 'Name',
  email: 'Email',
  role: 'Role',
  loginMethod: 'Sign-in method',
};

const addSchema = z.object({
  displayName: requiredText(200),
  email: requiredText(200)
    .transform((value) => value.toLowerCase())
    .refine(
      (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
      'must be an email address',
    ),
  role: z.enum(['owner', 'admin', 'bookkeeper']),
  loginMethod: z
    .enum(['google', 'microsoft', 'apple'])
    .or(z.literal(''))
    .transform((value) => (value === '' ? null : value)),
});

/**
 * There is no invitation email, because the application sends no mail at all.
 * The administrator tells the person the address; the person opens it and
 * signs in, and the row moves from "not yet signed in" to linked.
 */
export async function addUser(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('users.manage');
  if (!guard.ok) return guard.result;

  const parsed = addSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, addLabels);
  const { displayName, email, role, loginMethod } = parsed.data;

  if (role === 'owner' && guard.actor.role !== 'owner') {
    return refused('Only an owner can grant the owner role.');
  }

  // A method is only meaningful where the application itself does the signing
  // in. Under Access the policy decides, and on a LAN nobody does.
  let method = loginMethod;
  if (method !== null) {
    if (authMode() !== 'sso') {
      method = null;
    } else if (!configuredProviders().includes(method)) {
      return refused(`${method} is not configured on this installation.`);
    }
  }

  try {
    await db.insert(users).values({
      displayName,
      email,
      role,
      loginMethod: method,
      createdBy: guard.actor.id,
    });
  } catch (error) {
    if (isDuplicateEmail(error)) {
      // The email is UNIQUE and a user row is never voided, so an existing
      // row may simply be deactivated. Say so: adding "again" will not work,
      // and reactivating is what the person actually wants.
      return refused(
        'That email address already has an account. It may be deactivated — show inactive users and bring it back instead of adding a second one.',
      );
    }
    return refused('That user could not be added.');
  }

  revalidatePath('/settings/users');
  return saved(`${displayName} added as ${role}.`);
}

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

const roleSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['owner', 'admin', 'bookkeeper']),
});

export async function setUserRole(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('users.manage');
  if (!guard.ok) return guard.result;

  const parsed = roleSchema.safeParse(formValues(formData));
  if (!parsed.success) return refused('That role change did not make sense.');
  const { id, role } = parsed.data;

  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) return refused('That user no longer exists.');
  if (target.role === role) return saved(`${target.displayName} is already ${role}.`);

  const breach = await guardrailBreach(guard.actor, target, { nextRole: role });
  if (breach) return refused(breach);

  await db.update(users).set({ role }).where(eq(users.id, id));
  await revokeSessions(id, 'role changed');

  revalidatePath('/settings/users');
  return saved(`${target.displayName} is now ${role}. Sessions revoked.`);
}

// ---------------------------------------------------------------------------
// Active
// ---------------------------------------------------------------------------

const activeSchema = z.object({
  id: z.string().uuid(),
  isActive: z.stringbool(),
});

/**
 * Users are deactivated, never voided.
 *
 * Every other table in this product replaces deletion with a void. Users are
 * the exception: `email` is UNIQUE, and a voided row would permanently block
 * re-adding the same person.
 */
export async function setUserActive(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('users.manage');
  if (!guard.ok) return guard.result;

  const parsed = activeSchema.safeParse(formValues(formData));
  if (!parsed.success) return refused('That request did not make sense.');
  const { id, isActive } = parsed.data;

  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) return refused('That user no longer exists.');
  if (target.isActive === isActive) {
    return saved(`${target.displayName} is already ${isActive ? 'active' : 'inactive'}.`);
  }

  const breach = await guardrailBreach(guard.actor, target, { nextActive: isActive });
  if (breach) return refused(breach);

  await db.update(users).set({ isActive }).where(eq(users.id, id));
  if (!isActive) await revokeSessions(id, 'deactivated');

  revalidatePath('/settings/users');
  return saved(
    isActive ? `${target.displayName} can sign in again.` : `${target.displayName} is deactivated. Sessions ended.`,
  );
}
