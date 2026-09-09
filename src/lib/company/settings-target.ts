import { type Company, primaryOf, readCompanies } from '@/lib/company/load';

/**
 * Which company a settings write is for.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `primaryOf` AT THE CALL SITE
 * ---------------------------------------------------------------------------
 *
 * Four settings screens edit fields that belong to a company: the legal name,
 * the address, the HST registration number, the holdback terms, the quote
 * footer. Every one of them prints on a document, so writing to the wrong
 * company is a wrong statement on a customer's paper -- and in the HST number's
 * case, a defective input tax credit the customer has already filed.
 *
 * So the company is NAMED by the form that rendered those values, and this
 * function is the one place that decides whether that name is acceptable. Three
 * rules, in one place because they have to agree:
 *
 * 1. A named company must exist and still be issuing. A stale tab holds an id
 *    that may since have been retired.
 * 2. No name falls back to the single active company -- the common case, where
 *    there is nothing to choose.
 * 3. No name with more than one company REFUSES. Guessing is the failure this
 *    whole split exists to prevent.
 *
 * Re-read from the database rather than trusted from the form, because these
 * are `'use server'` endpoints: every export is callable by anything that can
 * reach the route, which is why `tests/ops/action-guards.test.ts` exists.
 */
export async function resolveSettingsCompany(
  named: string | null,
): Promise<{ company: Company } | { problem: string }> {
  const rows = await readCompanies();
  const active = rows.filter((row) => row.isActive);

  if (named) {
    const chosen = active.find((row) => row.id === named);
    if (!chosen) {
      return {
        problem:
          'That company is not one this deployment issues documents under any more. ' +
          'Reload the page and pick one from the list.',
      };
    }
    return { company: chosen };
  }

  const only = primaryOf(rows);
  if (only) return { company: only };

  return {
    problem:
      'This deployment has more than one company, so these fields have to say which one they ' +
      'belong to. Reload the page and pick a company first.',
  };
}
