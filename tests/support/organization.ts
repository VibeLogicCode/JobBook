import { organization } from '@/db/schema';
import { db } from '@/db/client';

/**
 * The `organization` row a test needs in order to read one.
 *
 * ---------------------------------------------------------------------------
 * WHY A SHARED HELPER AND NOT 25 INSERTS
 * ---------------------------------------------------------------------------
 *
 * This exists because of the incident recorded in §9 of
 * `docs/superpowers/plans/2026-09-05-backlog.md`, and the incident matters
 * more than the duplication.
 *
 * `tests/db/expenses.test.ts` read `organization` without creating one, and
 * passed for as long as it happened to run after a file that left one behind.
 * When the order changed, its setup THREW rather than an assertion failing:
 * ninety-eight tests silently never ran, and the suite reported fewer passes
 * instead of one failure. **A green suite that quietly shrank is worse than a
 * red one**, because nothing in the output says a test was lost.
 *
 * The fix each file applied was to seed its own row, which is right. This is
 * the next step: one function, so a file that needs the row asks for it rather
 * than copying a values literal — and so the day `organization` gains a NOT
 * NULL column, one edit fixes every suite instead of twenty-five.
 *
 * `onConflictDoNothing`, so a file may call it in `beforeEach` without caring
 * whether a previous test truncated. Idempotent by construction rather than by
 * the caller remembering.
 */
export async function ensureOrganization(
  executor: Pick<typeof db, 'insert'> = db,
): Promise<void> {
  await executor
    .insert(organization)
    .values({
      id: 1,
      legalName: 'Sample Contracting Ltd',
      displayName: 'Sample Contracting',
    })
    .onConflictDoNothing();
}
