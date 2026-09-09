import { eq, ne } from 'drizzle-orm';
import { companies, organization } from '@/db/schema';
import { db } from '@/db/client';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';

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
      // The deployment's label only. The legal name went to `companies` --
      // that is what prints on a document, and this is what shows in a browser
      // tab and on the sign-in screen.
      displayName: 'Sample Contracting',
    })
    .onConflictDoNothing();
}

/**
 * The `companies` row a test needs in order to issue a document.
 *
 * Same reasoning as `ensureOrganization` above, and the same
 * `onConflictDoNothing`. In this file rather than a new one because a test
 * that needs a company almost always needs the deployment row too, and two
 * imports for one precondition is how one of them gets forgotten -- which is
 * the §9 incident this file exists because of.
 *
 * Deliberately does NOT call `ensureOrganization` for the caller. The two rows
 * answer different questions and a helper that quietly created a second table's
 * row would hide which one a test actually depends on.
 */
export async function ensureCompany(
  executor: Pick<typeof db, 'insert'> = db,
): Promise<void> {
  await executor
    .insert(companies)
    .values({
      id: FIRST_COMPANY_ID,
      legalName: 'Sample Contracting Ltd',
      displayName: 'Sample Contracting',
    })
    .onConflictDoNothing();
}

/**
 * Everything a test may want to state about the deployment and its company,
 * in the flat shape the tables used to share.
 *
 * `organization` gave up thirty-six columns to `companies`, and a test that
 * says `legalName: 'Acme Ltd', timezone: 'America/Toronto'` in one literal is
 * saying something true about the installation regardless of which table each
 * half landed in. Routing them is this helper's job, not the test author's.
 */
export type DeploymentValues =
  Omit<Partial<typeof organization.$inferInsert>, 'id'>
  & Omit<Partial<typeof companies.$inferInsert>, 'id'>
  & { legalName: string; displayName: string };

/**
 * Seeds a deployment AND its first company from one set of values.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS NOT SEVENTEEN LITERALS
 * ---------------------------------------------------------------------------
 *
 * Seventeen test files wrote `db.insert(organization).values({ ... })` with
 * their own literal, and every one of them now also needs the `companies` row
 * that the same values describe -- because holdback percentages, quote terms,
 * payment terms and validity windows are read from the COMPANY now, not from
 * the deployment.
 *
 * Adding a second literal to each file would put the same letterhead in two
 * places in seventeen files, and the first test to update one and not the
 * other would pass while asserting something the product does not do. So the
 * split is applied HERE, once, deriving the company's half from the same
 * object -- exactly the argument `ensureOrganization` above makes for its own
 * existence, and the §9 lesson applied a second time.
 *
 * The filter is against the `companies` table object rather than a list of
 * names, so a column added to it later is picked up for free and a deployment
 * fact -- `timezone`, `currency` -- cannot be smuggled across by a typo.
 *
 * NO `id`. There is one deployment row and one first company, and this helper
 * owns both keys -- `organization.id` is the integer 1 and the company's is
 * `FIRST_COMPANY_ID`. Accepting an id would also make the type useless: the
 * two tables key differently, so `id` intersects to `never`.
 */
export async function seedDeployment(
  values: DeploymentValues,
  companyOnly: Partial<typeof companies.$inferInsert> = {},
): Promise<void> {
  const deployment = Object.fromEntries(
    Object.entries(values).filter(([key]) => key in organization),
  ) as typeof organization.$inferInsert;

  const company = Object.fromEntries(
    Object.entries(values).filter(([key]) => key !== 'id' && key in companies),
  ) as typeof companies.$inferInsert;

  await db.insert(organization).values({ ...deployment, id: 1 });

  const row = {
    ...company,
    ...companyOnly,
    id: FIRST_COMPANY_ID,
    legalName: values.legalName,
    displayName: values.displayName,
  } as typeof companies.$inferInsert;

  /**
   * Upsert, not insert.
   *
   * A file may have called `ensureCompany()` in its `beforeEach` -- because
   * tax rates and document sequences cannot be written before a company exists
   * -- and then call this inside a test to state the letterhead it actually
   * wants to assert against. A plain insert makes those two mutually
   * exclusive, and the order they run in is not something a test author should
   * have to reason about.
   *
   * Update rather than ignore, because the caller is DECLARING the letterhead:
   * `onConflictDoNothing` would silently leave the placeholder in place and
   * the test would assert against 'Sample Contracting' while its own literal
   * said 'Acme Ltd'.
   */
  await db.insert(companies).values(row).onConflictDoUpdate({ target: companies.id, set: row });

  /**
   * Leaves `FIRST_COMPANY_ID` as the ONLY active company.
   *
   * ---------------------------------------------------------------------------
   * WHY THE HELPER ENFORCES ITS OWN POSTCONDITION
   * ---------------------------------------------------------------------------
   *
   * This is the §9 lesson a third time. `tests/integration/add-company.test.ts`
   * adds a second company and does not remove it, so the next file to run got
   * a deployment with two -- and `primaryOf` then CORRECTLY refuses to guess
   * which one issues a document, so the logo tests failed with a refusal that
   * was right about a state they never asked for.
   *
   * Those files passed alone and failed together, which is the most expensive
   * shape of failure to read: it looks like the feature is broken rather than
   * like the fixture is.
   *
   * Fixing it here rather than adding `truncate companies` to each file,
   * because "seed the deployment" means ONE deployment with one company, and a
   * helper that leaves that ambiguous is a helper every future file has to
   * remember something about. A file that genuinely wants two companies adds
   * the second AFTER calling this.
   *
   * RETIRED, not deleted: `projects.company_id` and `tax_rates.company_id` are
   * NOT NULL foreign keys, so a delete would either fail or cascade, and the
   * application role has no DELETE grant at all.
   */
  await db
    .update(companies)
    .set({ isActive: false })
    .where(ne(companies.id, FIRST_COMPANY_ID));
}

/**
 * The deployment and its first company, read back as ONE row.
 *
 * The mirror of `seedDeployment`: a test that states a letterhead in one
 * literal should read it back in one object, whichever table each half landed
 * in. Without this, thirty assertions across two files would each have to know
 * that `legalName` moved and `timezone` did not -- and the ones that got it
 * wrong would not fail loudly, they would read `undefined` and compare it to
 * `undefined`.
 *
 * Null unless BOTH rows exist, because that is the only state the product can
 * be in after setup: every wizard step writes them together.
 */
export async function readDeployment(): Promise<
  (typeof organization.$inferSelect & Omit<typeof companies.$inferSelect, 'id'>) | null
> {
  const [row] = await db.select().from(organization).where(eq(organization.id, 1));
  const [company] = await db.select().from(companies).where(eq(companies.id, FIRST_COMPANY_ID));
  if (!row || !company) return null;
  const { id: _id, ...fields } = company;
  return { ...row, ...fields };
}
