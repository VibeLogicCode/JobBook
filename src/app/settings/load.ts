import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organization } from '@/db/schema';
import { type Capability, type Actor, can, resolveActor } from '@/app/settings/actor';
import { type Company, primaryOf, readCompanies } from '@/lib/company/load';

/**
 * The configuration a settings screen reads, as ONE object.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS MERGED RATHER THAN TWO FIELDS
 * ---------------------------------------------------------------------------
 *
 * The fields on these screens belong to two rows now -- the deployment's
 * `timezone` and `currency`, and the issuing company's legal name, HST
 * registration number, holdback terms and quote footer. Eleven settings
 * screens read them by name.
 *
 * Handing those screens two objects would mean editing all eleven to ask the
 * right one, and every future field would be a fresh chance to ask the wrong
 * one -- with the failure being an undefined that renders as a blank field
 * rather than an error. So the split is a fact about where things are STORED,
 * and this type is what they are FOR.
 *
 * The company half is the primary company's, and absent when there are two:
 * `patchOrganization` refuses to write those fields in that case for the same
 * reason, so a screen showing one company's values and saving to neither is
 * not a state that can arise.
 */
export type Organization = typeof organization.$inferSelect & Omit<Partial<Company>, 'id'>;

/**
 * The company's half of the merged view.
 *
 * Only the fields BOTH tables still carry -- which is exactly the set on its
 * way from `organization` to `companies` -- and never `id`, because each row's
 * identity is its own and they are not even the same type: the deployment's is
 * an integer and a company's is a uuid. Spreading the whole company row
 * replaced one with the other, and the first thing to break was a settings
 * screen that writes `where organization.id = 1`.
 *
 * Derived from the two table objects rather than listed, so the day a column
 * finishes moving this stops overlaying it without an edit here. Audit columns
 * and `isActive` fall out for free: they exist on both, and the merged view
 * wants the deployment's -- but nothing reads them off this object, which is
 * why sharing that behaviour with the letterhead fields costs nothing.
 */
function letterheadOf(company: Company | null): Omit<Partial<Company>, 'id'> {
  if (!company) return {};
  return Object.fromEntries(
    Object.entries(company).filter(([key]) => key !== 'id' && key in organization),
  ) as Omit<Partial<Company>, 'id'>;
}

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
  const company = primaryOf(await readCompanies());
  const state = await resolveActor();

  return {
    org: row ? { ...row, ...letterheadOf(company) } : null,
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
