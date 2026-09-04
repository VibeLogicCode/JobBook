import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { refused, type ActionResult } from '@/app/settings/result';
import {
  PermissionError,
  can,
  resolveActor as resolveCanonicalActor,
  type Actor as CanonicalActor,
  type Capability as CanonicalCapability,
  type Role,
} from '@/lib/auth/permissions';

/**
 * Who is asking, for the settings screens.
 *
 * The capability matrix used to be duplicated here, because this area was
 * built while `src/lib/auth/permissions.ts` was being written and a settings
 * screen shipped without a check is not an incomplete feature but an open
 * door. That module now exists and is the single place the matrix lives (SSO
 * design, section 10.3), so this file is nothing but the mapping from the
 * names these screens use to the canonical capabilities, plus the identity
 * lookup.
 *
 * Two rules from that design stay load-bearing here:
 *
 * 1. Authentication establishes an identity; authorization is a separate
 *    lookup against `users`, on every request. No permission is read from a
 *    token, a form field, or a client component's props -- a provider can be
 *    reconfigured by somebody who has never seen this application, and a role
 *    in a form field is a role the browser can edit.
 * 2. Deny by default. An identity with no active `users` row gets nothing.
 */

export type { Role };

export interface Actor {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export type ActorState = { actor: Actor; reason: null } | { actor: null; reason: string };

/**
 * The names these screens ask in, mapped to the canonical capabilities.
 *
 * `settings.read` maps to `worksheet:read`, which every active role holds: the
 * matrix has no separate read-settings capability, and reading the company's
 * own address is not a privilege worth inventing one for. Editing is where the
 * distinctions live.
 */
const SETTINGS_CAPABILITIES = {
  'settings.read': 'worksheet:read',
  'organization.edit': 'organization:edit',
  'taxRates.edit': 'tax:edit',
  'users.manage': 'user:manage',
  'scopeTemplates.edit': 'rates:edit',
  // Owner only, and on that list because its blast radius is the whole
  // deployment: it decides whether this company's records leave the box for a
  // Microsoft tenant.
  'sync.configure': 'sync:configure',
} as const satisfies Record<string, CanonicalCapability>;

export type SettingsCapability = keyof typeof SETTINGS_CAPABILITIES;

/** Whether a role holds one of the settings capabilities. */
export function canSettings(role: Role, capability: SettingsCapability): boolean {
  return can(role, SETTINGS_CAPABILITIES[capability]);
}

// The names the screens in this area were written against. Kept as aliases
// rather than renamed across thirty files, so the mapping above stays the only
// thing that had to change when the canonical matrix landed.
export type Capability = SettingsCapability;
export { canSettings as can };

/**
 * The signed-in user's row, or the reason there is not one.
 *
 * The email comes from `x-identity-email`, which `proxy.ts` deletes from the
 * inbound request and rewrites after verifying the Access JWT or reading the
 * session. Reading the header rather than re-verifying is the seam that file
 * documents; reading any OTHER identity header would be trusting something a
 * client can set.
 */
export async function resolveActor(): Promise<ActorState> {
  const email = (await headers()).get('x-identity-email');
  if (!email) {
    return {
      actor: null,
      reason:
        'This request carries no verified identity, so nothing on this screen can be changed.',
    };
  }

  try {
    // The canonical Actor carries only what authorization reads -- id, email,
    // role -- deliberately, so a display name cannot become an input to a
    // permission decision. These screens greet the person, so they read it
    // separately.
    const canonical: CanonicalActor = await resolveCanonicalActor({ email, local: false });
    const [row] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, canonical.id));

    return {
      actor: {
        id: canonical.id,
        email: canonical.email,
        displayName: row?.displayName ?? canonical.email,
        role: canonical.role,
      },
      reason: null,
    };
  } catch (error) {
    if (error instanceof PermissionError) {
      // Named rather than hidden: the address is the signed-in person's own,
      // so there is nothing to leak to them, and an administrator reading it
      // needs to know which address has no account.
      return {
        actor: null,
        reason:
          error.reason === 'no-account'
            ? `There is no user account for ${email}, so nothing on this screen can be changed.`
            : `The account for ${email} is not active, so nothing on this screen can be changed.`,
      };
    }
    throw error;
  }
}

/**
 * The guard every action in this area opens with, before it reads a single
 * argument. A check further down is a check somebody can add a branch above.
 */
export async function requireCapability(
  capability: SettingsCapability,
): Promise<{ ok: true; actor: Actor } | { ok: false; result: ActionResult }> {
  const state = await resolveActor();
  if (!state.actor) return { ok: false, result: refused(state.reason) };
  if (!canSettings(state.actor.role, capability)) {
    return {
      ok: false,
      result: refused(`A ${state.actor.role} cannot change this. Ask an owner.`),
    };
  }
  return { ok: true, actor: state.actor };
}
