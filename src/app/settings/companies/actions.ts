'use server';

import { count, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { companies, projects } from '@/db/schema';
import { requireCapability } from '@/app/settings/actor';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid, optionalText, requiredText } from '@/app/settings/validate';
import { normalizePrefix, prefixProblem } from '@/lib/company/prefix';

/**
 * The second company, added from Settings and never asked for at setup.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT IN THE WIZARD
 * ---------------------------------------------------------------------------
 *
 * The owner asked for the question at first run and it is the one question
 * that must not be asked there: he did not know his own legal structure yet --
 * he said so -- and a contractor looking at a NAS in a browser at 11pm knows
 * less. Any answer given at first run is wrong often enough to matter, and the
 * wrong answer in the "two companies" direction burdens every single-company
 * customer forever with a picker they never wanted.
 *
 * So a second company is added HERE, later, by somebody who has since spoken
 * to an accountant. Until one exists, nothing in the interface mentions
 * companies at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It creates the row with a name and a document code and stops. The address,
 * the HST registration number, the holdback terms and the footer are edited
 * on the settings screens that already exist for exactly those fields -- a
 * second set of forty inputs here would be a second place for them to
 * disagree, which is the whole reason `patchOrganization` funnels every
 * section through one function.
 *
 * It also creates no tax rates. A company charges tax because it has a
 * registration and rate rows, never because a toggle says so -- and the
 * small-supplier threshold aggregates associated corporations under Excise Tax
 * Act s.148, so whether the new company registers at all is a question for the
 * owner's accountant rather than a default this screen can pick.
 */

const addLabels = {
  legalName: 'Legal name',
  displayName: 'Display name',
  documentPrefix: 'Document code',
};

const addSchema = z.object({
  legalName: requiredText(200),
  displayName: requiredText(200),
  documentPrefix: optionalText(6),
});

export async function addCompany(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('organization.edit');
  if (!guard.ok) return guard.result;

  const parsed = addSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, addLabels);
  const { legalName, displayName, documentPrefix } = parsed.data;

  type AddOutcome = { problem: string } | { id: string };

  const created: AddOutcome = await db.transaction(async (tx): Promise<AddOutcome> => {
    /**
     * The codes in use, read INSIDE the writing transaction.
     *
     * The form was rendered before this submit, so another tab may have taken
     * the code since -- the same reasoning `addTaxRate` gives for re-reading
     * what is in force. The unique index on `document_sequences` would catch
     * the clash eventually, but not until somebody issued a document, and the
     * error it produces names an index rather than a decision.
     */
    const taken = await tx
      .select({ displayName: companies.displayName, prefix: companies.documentPrefix })
      .from(companies);

    const problem = prefixProblem(documentPrefix ?? '', taken.flatMap((row) =>
      row.prefix ? [{ displayName: row.displayName, prefix: row.prefix }] : []));
    if (problem !== null) return { problem };

    /**
     * The FIRST company also needs a code once a second exists.
     *
     * Without one its documents stay `INV-2026-0001` while the new company's
     * read `RENO_INV-2026-0001`, which is legal and consistent -- the numbers
     * cannot collide -- but it reads as though one of them is unlabelled. Said
     * as a note rather than enforced, because renaming the existing company's
     * series mid-year is the owner's decision and `document_sequences` keeps
     * this year's numbers whatever he chooses.
     */
    const [row] = await tx
      .insert(companies)
      .values({
        legalName,
        displayName,
        documentPrefix: documentPrefix ? normalizePrefix(documentPrefix) : null,
        // Where it sits in the picker, after whatever is already there.
        sortOrder: (taken.length + 1) * 10,
        createdBy: guard.actor.id,
      })
      .returning({ id: companies.id });

    return { id: row!.id };
  });

  if ('problem' in created) return refused(created.problem);


  // Every screen gains a company picker the moment a second row exists, and
  // the shell reads companies for its accent colour, so this invalidates the
  // layout rather than one section.
  revalidatePath('/', 'layout');
  return saved(
    `${displayName} added. Fill in its address, tax registration and terms under the company ` +
    `settings, and pick it when you create a job.`,
  );
}

const retireSchema = z.object({ id: z.string().uuid() });

/**
 * "No new jobs under this company."
 *
 * Retiring, never deleting, and this is the one that matters most: every
 * document the company issued keeps the letterhead it was legally issued
 * under, and an auditor may ask for any of them years later. Deleting the row
 * would rewrite history on paper a customer is holding.
 *
 * It is also how two companies merge back into one, which is what makes the
 * whole feature safe to try: mark the second inactive, and the deployment
 * behaves as it did before it existed.
 */
export async function retireCompany(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('organization.edit');
  if (!guard.ok) return guard.result;

  const parsed = retireSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, { id: 'Company' });

  /**
   * `{ ok, message }`, not a sentence the caller re-reads.
   *
   * This was `message.includes('retired.')`, which is wrong: "X is already
   * retired." contains that substring and would have been reported as a
   * success. Deciding an outcome by grepping the text written for a human is
   * how a refusal gets shown in the colour of a save.
   */
  const outcome = await db.transaction(async (tx) => {
    const [company] = await tx
      .select({ displayName: companies.displayName, isActive: companies.isActive })
      .from(companies)
      .where(eq(companies.id, parsed.data.id));
    if (!company) return { ok: false, message: 'That company no longer exists.' };
    if (!company.isActive) {
      return { ok: false, message: `${company.displayName} is already retired.` };
    }

    /**
     * The LAST active company cannot be retired.
     *
     * Not a courtesy: `primaryCompany` returns the single active company, and
     * with none the new-job form has nothing to file under, the settings
     * screens have no letterhead to edit, and the wizard has already closed.
     * A deployment with no company that can issue anything is not a state to
     * recover from through this screen.
     */
    const active = await tx
      .select({ n: count() })
      .from(companies)
      .where(eq(companies.isActive, true));
    if (Number(active[0]?.n ?? 0) <= 1) {
      return {
        ok: false,
        message:
          `${company.displayName} is the only company still issuing documents, so retiring it ` +
          `would leave nothing to file a job under. Add another company first.`,
      };
    }

    await tx
      .update(companies)
      .set({ isActive: false })
      .where(eq(companies.id, parsed.data.id));

    const [jobs] = await tx
      .select({ n: count() })
      .from(projects)
      .where(eq(projects.companyId, parsed.data.id));

    // Names the jobs deliberately: they are unaffected, and somebody retiring
    // a company wants to know that before they wonder.
    const held = Number(jobs?.n ?? 0);
    return {
      ok: true,
      message: held === 0
        ? `${company.displayName} retired. No new jobs can be filed under it.`
        : `${company.displayName} retired. Its ${held} existing ${held === 1 ? 'job' : 'jobs'} ` +
          `keep their numbers and their letterhead; only new work is affected.`,
    };
  });

  if (!outcome.ok) return refused(outcome.message);

  revalidatePath('/', 'layout');
  return saved(outcome.message);
}

