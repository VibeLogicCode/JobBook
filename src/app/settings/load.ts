import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organization } from '@/db/schema';
import { type Capability, type Actor, can, resolveActor } from '@/app/settings/actor';
import { type Company, companyFields, primaryOf, readCompanies } from '@/lib/company/load';

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
export type Organization = typeof organization.$inferSelect & Partial<Omit<Company, 'id'>>;

export interface SettingsContext {
  /** Null before first-run setup has written the single row. */
  org: Organization | null;
  /**
   * How many companies this deployment issues documents as.
   *
   * `1` for every installation until somebody deliberately adds a second, and
   * the four screens that edit COMPANY fields -- identity, contact, financial,
   * documents -- say so when it is more, because with two companies the fields
   * they show belong to neither. `patchOrganization` refuses those writes for
   * the same reason, so the notice is what stops somebody typing into a form
   * that will refuse them.
   *
   * `/settings/locale` deliberately does NOT check it: currency, timezone and
   * area unit are the deployment's, and two companies sharing one office
   * cannot disagree about them.
   */
  companyCount: number;
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

  const all = await readCompanies();

  return {
    /**
     * The deployment row, merged with the company's fields when there is one
     * unambiguous company.
     *
     * NOT null merely because the company is ambiguous: `/settings/locale`
     * edits deployment facts and has to keep working with two companies. The
     * company-owned fields come back undefined in that case, which is why the
     * four company screens read `companyCount` and say so rather than
     * presenting blank inputs as if nothing had been set.
     */
    org: row ? { ...row, ...(company ? companyFields(company) : {}) } : null,
    companyCount: all.filter((entry) => entry.isActive).length,
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
