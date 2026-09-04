import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organization } from '@/db/schema';
import { type Capability, type Actor, can, resolveActor } from '@/app/settings/actor';

export type Organization = typeof organization.$inferSelect;

export interface SettingsContext {
  /** Null before first-run setup has written the single row. */
  org: Organization | null;
  actor: Actor | null;
  /** Why there is no actor, for a screen that must say so rather than 500. */
  reason: string | null;
  allowed: boolean;
}

/**
 * What every settings page needs before it renders: the row, who is asking,
 * and whether they may change it.
 *
 * `allowed` is computed on the server for the SAME capability the action
 * checks. It drives whether the controls are disabled -- which is a courtesy,
 * not a control. The action re-checks, because a disabled attribute is a
 * property of one browser's DOM and nothing else.
 */
export async function loadSettings(capability: Capability): Promise<SettingsContext> {
  const [row] = await db.select().from(organization).where(eq(organization.id, 1));
  const state = await resolveActor();

  return {
    org: row ?? null,
    actor: state.actor,
    reason: state.reason,
    allowed: state.actor ? can(state.actor.role, capability) : false,
  };
}

/**
 * The sentence a read-only screen shows in place of a save button. It names
 * the role, because "you cannot do this" without saying who you are read as
 * a bug more often than as a permission.
 */
export function readOnlyNote(context: SettingsContext, whatItTakes: string): string {
  if (!context.actor) return context.reason ?? 'This screen is read-only.';
  return `Your role (${context.actor.role}) can read this but not change it. ${whatItTakes}`;
}
