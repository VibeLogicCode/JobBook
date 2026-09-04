import { and, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { refused, type ActionResult } from '@/app/settings/result';

/**
 * Who is asking, and what their role permits.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS TEMPORARY. It moves to `src/lib/auth/permissions.ts`, which is
 * being written concurrently and which the SSO design (section 10.3) makes the
 * one place the capability matrix lives, exporting a single
 * `require(capability)`. Nothing here imports that module yet because it may
 * not exist; when it lands, delete `CAPABILITIES` and `can()` below and call
 * it instead. The checks are inline rather than deferred because a settings
 * screen shipped without them is not an incomplete feature, it is an open
 * door.
 * ---------------------------------------------------------------------------
 *
 * Two rules from that design are load-bearing here:
 *
 * 1. Authentication establishes an identity; authorization is a separate
 *    lookup against `users`, performed on every request. No permission is ever
 *    read from a token, a form field, or a client component's props -- a
 *    provider can be reconfigured by somebody who has never seen this
 *    application, and a role in a form field is a role the browser can edit.
 * 2. Deny by default. An identity with no `users` row, or a request that
 *    arrives without one, gets nothing.
 */

export type Role = 'owner' | 'admin' | 'bookkeeper';

export interface Actor {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export type ActorState = { actor: Actor; reason: null } | { actor: null; reason: string };

/**
 * The capability matrix, from the SSO design section 10.2.
 *
 * The five capabilities reserved to `owner` are the ones whose blast radius is
 * the whole deployment rather than one job: the tax rate every future quote
 * inherits, and the company's own identity on every document it sends.
 */
export const CAPABILITIES = {
  /** Read the settings screens at all. */
  'settings.read': ['owner', 'admin', 'bookkeeper'],
  /** Identity, branding, contact, locale, financial terms and document text. */
  'organization.edit': ['owner'],
  /** Tax rates and their effective dates. */
  'taxRates.edit': ['owner'],
  /** Add, deactivate, set role. Four further guardrails apply per row. */
  'users.manage': ['owner', 'admin'],
  /** Rate items, cost codes, scope templates. */
  'scopeTemplates.edit': ['owner', 'admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: Role, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly Role[]).includes(role);
}

/**
 * The signed-in user's row, or the reason there is not one.
 *
 * The email comes from `x-identity-email`, which `proxy.ts` strips from the
 * inbound request and rewrites after verifying the Access JWT. Reading the
 * header rather than re-verifying is the seam that file documents; reading any
 * OTHER identity header would be trusting something a client can set.
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

  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), eq(users.isActive, true)));

  if (!row) {
    // Named, not hidden: an administrator reading this needs to know which
    // address has no account. The address is the signed-in person's own, so
    // there is nothing to leak to them.
    return {
      actor: null,
      reason: `There is no active user account for ${email}, so nothing on this screen can be changed.`,
    };
  }

  return {
    actor: {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
    },
    reason: null,
  };
}

/**
 * The guard every action in this area opens with, before it reads a single
 * argument. A route whose check sits further down is a route somebody can add
 * a branch to that never reaches it.
 */
export async function requireCapability(
  capability: Capability,
): Promise<{ ok: true; actor: Actor } | { ok: false; result: ActionResult }> {
  const state = await resolveActor();
  if (!state.actor) return { ok: false, result: refused(state.reason) };
  if (!can(state.actor.role, capability)) {
    return {
      ok: false,
      result: refused(
        `A ${state.actor.role} cannot change this. Ask an owner.`,
      ),
    };
  }
  return { ok: true, actor: state.actor };
}
