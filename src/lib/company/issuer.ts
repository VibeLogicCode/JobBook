import { type Company, primaryOf, readCompanies } from '@/lib/company/load';

/**
 * The company a creation form should file under, given what the form sent.
 *
 * One place, because two forms create projects -- `app/projects/actions.ts`
 * and `app/quotes/new/actions.ts` -- and "which company" must not be answered
 * differently by each. Returns the ROW or a refusal sentence, matching the
 * shape of every other guard here.
 *
 * The whole row rather than an id, because both callers immediately need its
 * `documentPrefix` to allocate a number -- and `allocateDocumentNumber` must
 * not read it back itself: doing that inside the writing transaction deadlocks
 * against the foreign key's own lock on the same row.
 */
export async function resolveIssuingCompany(
  submitted: string | null,
): Promise<{ company: Company } | { problem: string }> {
  const rows = await readCompanies();
  const offered = rows.filter((row) => row.isActive);

  if (submitted) {
    const chosen = offered.find((row) => row.id === submitted);
    if (!chosen) {
      // Names both refusals in one sentence because the form cannot tell them
      // apart and the person only needs to know to pick again.
      return {
        problem:
          'That company is not one this deployment issues documents under any more. ' +
          'Pick one from the list.',
      };
    }
    return { company: chosen };
  }

  const only = primaryOf(rows);
  if (only) return { company: only };

  return {
    problem:
      'This deployment has more than one company, so a new job has to say which one it is for.',
  };
}
