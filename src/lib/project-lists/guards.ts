import { eq } from 'drizzle-orm';
import type { db } from '@/db/client';
import { projectTypes } from '@/db/schema';

/**
 * Whether a chosen project type may be written, asked in the one place.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN AN ACTIONS FILE
 * ---------------------------------------------------------------------------
 *
 * It was, and being there made it a security hole rather than a helper. **In
 * Next.js every export from a `'use server'` file is a callable endpoint**, so
 * exporting a validation predicate from `app/templates/actions.ts` published
 * it: reachable from a browser, taking a database handle, and running before
 * any `guard()` because it was never an action anybody thought to guard.
 * `tests/ops/action-guards.test.ts` is the test that says so, and it caught
 * this rather than a person.
 *
 * A plain module has no such property. Nothing here is an action; the actions
 * import it.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE COPY
 * ---------------------------------------------------------------------------
 *
 * There were three -- in `app/projects/actions.ts`, in
 * `app/templates/actions.ts`, and inline in `app/templates/schedule/actions.ts`
 * with a comment explaining that it had been copied deliberately. They had
 * drifted into three different refusal sentences for the same fact, which is
 * how a person comes to believe two screens mean different things by the same
 * word.
 *
 * ---------------------------------------------------------------------------
 * WHY RETIRED IS ALLOWED AND VOID IS NOT
 * ---------------------------------------------------------------------------
 *
 * Retiring means "stop offering this on new work", not "refuse it outright".
 * The picker does not offer a retired type on a new record, but nothing stops
 * a stale tab from submitting one, and refusing it there would be refusing
 * something the owner deliberately kept. A voided type is different: it should
 * never have existed, so nothing new may be filed under it.
 *
 * Read inside the writing transaction rather than trusted from the form,
 * because the picker was rendered before this type might have been voided --
 * the same reasoning `resolveChoices` in `app/vendors/actions.ts` states for
 * its own re-reads.
 */

/** Whatever can run a select: the request's `db`, or a transaction. */
type Reader = Pick<typeof db, 'select'>;

export async function projectTypeProblem(
  reader: Reader,
  projectTypeId: string,
): Promise<string | null> {
  const [row] = await reader
    .select({ recordStatus: projectTypes.recordStatus })
    .from(projectTypes)
    .where(eq(projectTypes.id, projectTypeId));

  if (!row) return 'That project type is not on the list.';
  if (row.recordStatus === 'void') {
    return 'That project type is void, so nothing new can be filed under it. Choose one that still stands.';
  }
  return null;
}
