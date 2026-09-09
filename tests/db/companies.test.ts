import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { companies, organization } from '@/db/schema';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { primaryOf, readCompanies } from '@/lib/company/load';
import { ensureCompany, ensureOrganization } from '../support/organization';

/**
 * The issuer table, before anything reads it.
 *
 * These assertions are about the SHAPE of the split -- what is a fact about a
 * legal person and what is a fact about the deployment. They are worth
 * asserting rather than reading off the schema because getting the line wrong
 * is silent: a column on the wrong table only misbehaves once a second company
 * exists, which is months after the migration that put it there.
 */
describe('companies', () => {
  beforeEach(async () => {
    // TRUNCATE, not DELETE. The application role has no DELETE grant at all --
    // `tests/db/expenses.test.ts` asserts that as an invariant -- because the
    // no-delete rule is enforced by the database rather than by convention.
    await db.execute(sql`
      truncate table audit_log, tax_rates, organization, companies, document_sequences
      restart identity cascade
    `);
    await ensureOrganization();
    await ensureCompany();
  });

  it('carries what appears on a document', async () => {
    const [row] = await db.select().from(companies).where(eq(companies.id, FIRST_COMPANY_ID));
    expect(row).toBeDefined();
    expect(row!.legalName).toBe('Sample Contracting Ltd');
    // Ten-thousandths as bigint, never a decimal string. 10% is 100000n.
    expect(row!.defaultHoldbackPctTenThou).toBeNull();
    expect(row!.holdbackReleaseDays).toBe(60);
  });

  it('does not carry the deployment facts', async () => {
    const [row] = await db.select().from(companies).where(eq(companies.id, FIRST_COMPANY_ID));
    // Two companies sharing one office cannot disagree about these without one
    // of them being wrong, so they stay on `organization`. Asserted as absence
    // because the failure mode is a well-meaning later edit ADDING one here.
    for (const deploymentFact of ['timezone', 'currency', 'locale', 'areaUnit', 'mileageRatePerKmTenThou']) {
      expect(row as Record<string, unknown>).not.toHaveProperty(deploymentFact);
    }
  });

  it('keeps its own display name, because organization keeps one too', async () => {
    // Not duplication to clean up later. The sign-in screen renders before
    // authentication, so it has no session, no project and no way to choose
    // between two companies -- the deployment's name answers there, and this
    // one prints on paper.
    const [company] = await db.select().from(companies).where(eq(companies.id, FIRST_COMPANY_ID));
    const [deployment] = await db.select().from(organization).where(eq(organization.id, 1));
    expect(company!.displayName).toBeTypeOf('string');
    expect(deployment!.displayName).toBeTypeOf('string');
  });

  it('leaves organization single-row', async () => {
    await expect(
      db.insert(organization).values({ id: 2, displayName: 'Second' }),
    ).rejects.toThrow();
  });

  it('starts every company at both, which is today behaviour', async () => {
    const [row] = await db.select().from(companies).where(eq(companies.id, FIRST_COMPANY_ID));
    expect(row!.workPosture).toBe('both');
  });

  it('reads back as the primary company while there is one', async () => {
    // `readCompanies` and not `loadCompanies`: the cached export is scoped to
    // a request, and there is no request here -- every test file shares one
    // fork, so the memoised reader would hand this file whichever rows ran
    // first in the suite. That is what made these tests pass alone and fail
    // together.
    const rows = await readCompanies();
    expect(rows.map((row) => row.id)).toEqual([FIRST_COMPANY_ID]);
    expect(primaryOf(rows)?.id).toBe(FIRST_COMPANY_ID);
  });

  it('has no primary company once there are two', async () => {
    await db.insert(companies).values({ legalName: 'Second Co Ltd', displayName: 'Second Co' });
    // Null on ambiguity rather than "the first one". Guessing which of two
    // registrants issued a document would put the wrong HST number on it and
    // make the customer's tax credit defective.
    expect(primaryOf(await readCompanies())).toBeNull();
  });

  it('retires rather than deletes', async () => {
    const [second] = await db
      .insert(companies)
      .values({ legalName: 'Second Co Ltd', displayName: 'Second Co', isActive: false })
      .returning({ id: companies.id, isActive: companies.isActive });
    // A retired company still resolves, so every document it issued keeps the
    // letterhead it was legally issued under. That is what makes merging two
    // companies back into one free.
    expect(second!.isActive).toBe(false);
    const rows = await readCompanies();
    expect(rows.map((row) => row.id)).toContain(second!.id);
    // Retired, so it is not a candidate: one ACTIVE company is still
    // unambiguous, which is what makes merging two back into one free.
    expect(primaryOf(rows)?.id).toBe(FIRST_COMPANY_ID);
  });
});
