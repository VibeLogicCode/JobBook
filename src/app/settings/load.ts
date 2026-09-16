import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organization } from '@/db/schema';
import { type Capability, type Actor, can, resolveActor } from '@/app/settings/actor';
import { type Company, companyFields, loadCompanies, primaryOf } from '@/lib/company/load';

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
   * The companies a company-scoped screen may edit, active only, in picker
   * order.
   *
   * Empty or one entry means there is nothing to choose and no selector is
   * rendered -- a single-company installation has no such concept, which is
   * the rule every appearance of companies in this product follows.
   *
   * `/settings/locale` ignores this entirely: currency, timezone and area unit
   * are the deployment's, and two companies sharing one office cannot disagree
   * about what day it is.
   */
  companies: Company[];
  /**
   * WHICH company `org`'s letterhead half came from, and which one a save will
   * write to. Null before setup, or when a screen asked for one that has since
   * been retired.
   *
   * The four company screens put this in a hidden field, so the record being
   * saved is the record that was rendered -- not whatever `primaryOf` happens
   * to resolve at submit time, which is a different question asked seconds
   * later.
   */
  companyId: string | null;
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
/**
 * What every settings page needs before it renders.
 *
 * `companyId` names which company's letterhead to show, and comes from the
 * screen's own `?company=` parameter. Absent -- the ordinary case -- it is the
 * single active company, or nothing when there is more than one and the screen
 * has not chosen yet.
 */
export async function loadSettings(
  capability: Capability,
  companyId?: string | null,
): Promise<SettingsContext> {
  const [row] = await db.select().from(organization).where(eq(organization.id, 1));
  // Cached: every settings screen reads this during its render.
  const all = await loadCompanies();
  const active = all.filter((entry) => entry.isActive);

  /**
   * The named company when the screen asked for one and it is still issuing,
   * otherwise the single active one, otherwise nothing.
   *
   * A named-but-retired company resolves to null rather than to the primary,
   * so the screen shows its "pick a company" state instead of silently
   * swapping which letterhead is on the form under somebody's cursor.
   */
  const company = companyId
    ? (active.find((entry) => entry.id === companyId) ?? null)
    : primaryOf(all);

  const state = await resolveActor();

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
    companies: active,
    companyId: company?.id ?? null,
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

  /**
   * The ROLE first, then the missing company.
   *
   * Both can be true at once -- the form is disabled when either is -- and the
   * order decides which sentence somebody reads. Somebody whose role cannot
   * edit this screen must read that, because choosing a company will not
   * unblock them and "choose a company first" invites them to try and be
   * refused anyway.
   *
   * The other way round matters too: "pick a company" is not a permission
   * problem, and phrasing it as one would send somebody to ask an
   * administrator for access they already have.
   */
  if (!context.allowed) {
    return `Your role (${context.actor.role}) can read this but not change it. ${whatItTakes}`;
  }

  if (context.companyId === null && context.companies.length > 1) {
    return 'Choose which company these details belong to before saving.';
  }

  return `Your role (${context.actor.role}) can read this but not change it. ${whatItTakes}`;
}
