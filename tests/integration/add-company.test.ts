import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `revalidatePath` and `headers` are request-scoped Next APIs, mocked before
 * the actions under test are imported.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-identity-email': 'owner@example.invalid' }),
}));

import { db } from '@/db/client';
import { companies, customers, organization, projects, users } from '@/db/schema';
import { addCompany, retireCompany } from '@/app/settings/companies/actions';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { readCompanies } from '@/lib/company/load';
import { resolveIssuingCompany } from '@/lib/company/issuer';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
// After the mocks above, deliberately: this pulls in the database client.
import { ensureCompany, ensureOrganization } from '../support/organization';

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

/**
 * Adding the second company, and the rules that make it safe to try.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE PARTICULAR ASSERTIONS
 * ---------------------------------------------------------------------------
 *
 * Every one of them is about a state somebody could get the deployment into
 * and not be able to get out of, or a wrong number on a customer-facing
 * document:
 *
 *   - two companies sharing a document code, which collides on an invoice
 *     index a long way from the cause;
 *   - the last company retired, leaving nothing to file a job under;
 *   - a job filed under a retired company;
 *   - a job filed under whichever company sorted first, because the form
 *     named none and something guessed.
 */
beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, stage_history, quote_taxes, quote_lines, quotes,
      tax_rates, projects, customers, users, organization, companies, document_sequences
    restart identity cascade
  `);
  await ensureOrganization();
  await ensureCompany();
  await db.insert(users).values({
    email: 'owner@example.invalid',
    displayName: 'Test Owner',
    role: 'owner',
    isActive: true,
  });
});

describe('adding a company', () => {
  it('adds one with a document code', async () => {
    const result = await addCompany(null, form({
      legalName: 'Northgate Home Services Ltd.',
      displayName: 'Home Services',
      documentPrefix: 'svc',
    }));
    expect(result.ok).toBe(true);

    const rows = await readCompanies();
    expect(rows).toHaveLength(2);
    const added = rows.find((row) => row.displayName === 'Home Services');
    // Normalised to upper case on the way in, so two rows cannot differ by
    // case and the composed prefix is predictable.
    expect(added?.documentPrefix).toBe('SVC');
  });

  it('allows no code at all', async () => {
    // Legal and consistent: the numbers still cannot collide, because the
    // first company has no code either and only one of them can hold
    // (kind, year, 'INV').
    const result = await addCompany(null, form({
      legalName: 'Second Co Ltd', displayName: 'Second Co', documentPrefix: '',
    }));
    expect(result.ok).toBe(true);
    const rows = await readCompanies();
    expect(rows.find((row) => row.displayName === 'Second Co')?.documentPrefix).toBeNull();
  });

  it('refuses a code another company already issues, and names it', async () => {
    await db.update(companies).set({ documentPrefix: 'RENO' })
      .where(eq(companies.id, FIRST_COMPANY_ID));

    const result = await addCompany(null, form({
      legalName: 'Other Ltd', displayName: 'Other', documentPrefix: 'reno',
    }));
    expect(result.ok).toBe(false);
    // Refused at the moment somebody CHOOSES the code, not at the moment
    // somebody issues a document -- and naming the company means they already
    // know which one to ask about.
    expect(result.ok ? '' : result.error).toContain('Sample Contracting');
    expect(await readCompanies()).toHaveLength(1);
  });

  it('refuses a code with a separator the format already owns', async () => {
    const result = await addCompany(null, form({
      legalName: 'Other Ltd', displayName: 'Other', documentPrefix: 'RE-NO',
    }));
    expect(result.ok).toBe(false);
    expect(await readCompanies()).toHaveLength(1);
  });
});

describe('retiring a company', () => {
  it('refuses the last company still issuing', async () => {
    const result = await retireCompany(null, form({ id: FIRST_COMPANY_ID }));
    // Not a courtesy: with no active company the new-job form has nothing to
    // file under and the wizard has already closed. There is no way back
    // through this screen.
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('only company');
  });

  it('retires the second and leaves its jobs alone', async () => {
    await addCompany(null, form({
      legalName: 'Second Co Ltd', displayName: 'Second Co', documentPrefix: 'SEC',
    }));
    const second = (await readCompanies()).find((row) => row.displayName === 'Second Co')!;

    const [customer] = await db.insert(customers)
      .values({ name: 'Sample Client', customerType: 'residential' })
      .returning({ id: customers.id });
    await db.insert(projects).values({
      name: 'Work under the second company',
      projectNumber: 'SEC_P-2026-0001',
      customerId: customer!.id,
      companyId: second.id,
      projectTypeId: PROJECT_TYPE_IDS.basement,
    });

    const result = await retireCompany(null, form({ id: second.id }));
    expect(result.ok).toBe(true);
    // Names the jobs, because somebody retiring a company wants to know they
    // are unaffected before they wonder.
    expect(result.ok ? result.message : '').toContain('1 existing job');

    // Retired, not deleted: the document it issued keeps the letterhead it was
    // legally issued under, and an auditor may ask for it years later.
    const [row] = await db.select().from(companies).where(eq(companies.id, second.id));
    expect(row?.isActive).toBe(false);
    expect(row?.recordStatus).toBe('active');
    expect(await db.select().from(projects)).toHaveLength(1);
  });

  it('refuses one already retired, rather than reporting a save', async () => {
    await addCompany(null, form({
      legalName: 'Second Co Ltd', displayName: 'Second Co', documentPrefix: 'SEC',
    }));
    const second = (await readCompanies()).find((row) => row.displayName === 'Second Co')!;
    expect((await retireCompany(null, form({ id: second.id }))).ok).toBe(true);

    // The outcome is a discriminated value, not a substring of the message.
    // "X is already retired." contains "retired." and was reported as a save
    // when this decided by grepping the sentence written for a human.
    const again = await retireCompany(null, form({ id: second.id }));
    expect(again.ok).toBe(false);
    expect(again.ok ? '' : again.error).toContain('already retired');
  });
});

describe('which company a new job is filed under', () => {
  it('resolves the only company without being told', async () => {
    // With one company the form has no picker, so the action resolves it.
    const resolved = await resolveIssuingCompany(null);
    // The whole ROW, not just an id: both callers need its `documentPrefix`
    // to allocate a number, and the allocator must not read it back itself --
    // doing that inside the writing transaction deadlocks against the foreign
    // key's own lock on the same row.
    expect('company' in resolved && resolved.company.id).toBe(FIRST_COMPANY_ID);
  });

  it('refuses to guess once there are two', async () => {
    await addCompany(null, form({
      legalName: 'Second Co Ltd', displayName: 'Second Co', documentPrefix: 'SEC',
    }));
    const resolved = await resolveIssuingCompany(null);
    // A job filed under the wrong company carries the wrong legal name and the
    // wrong HST registration number on every document it ever produces.
    expect('problem' in resolved).toBe(true);
  });

  it('refuses a retired company even when the form names it', async () => {
    await addCompany(null, form({
      legalName: 'Second Co Ltd', displayName: 'Second Co', documentPrefix: 'SEC',
    }));
    const second = (await readCompanies()).find((row) => row.displayName === 'Second Co')!;
    await db.update(companies).set({ isActive: false }).where(eq(companies.id, second.id));

    const resolved = await resolveIssuingCompany(second.id);
    // A retired company still resolves for documents it already issued, and
    // must not take new work. Checked at the ACTION rather than trusted to the
    // picker: a stale tab still holds the option.
    expect('problem' in resolved).toBe(true);
  });

  it('accepts the company the form actually named', async () => {
    await addCompany(null, form({
      legalName: 'Second Co Ltd', displayName: 'Second Co', documentPrefix: 'SEC',
    }));
    const second = (await readCompanies()).find((row) => row.displayName === 'Second Co')!;
    const resolved = await resolveIssuingCompany(second.id);
    expect('company' in resolved && resolved.company.id).toBe(second.id);
    // And it carries the code, which is what the number is built from.
    expect('company' in resolved && resolved.company.documentPrefix).toBe('SEC');
  });
});

describe('the deployment label is not a company name', () => {
  it('leaves organization.displayName alone when a company is added', async () => {
    const before = await db.select({ name: organization.displayName }).from(organization);
    await addCompany(null, form({
      legalName: 'Second Co Ltd', displayName: 'Second Co', documentPrefix: 'SEC',
    }));
    const after = await db.select({ name: organization.displayName }).from(organization);
    // The sign-in screen and the browser tab read this, and both render
    // without knowing which company the reader is looking at. Adding a company
    // must not rename the deployment.
    expect(after).toEqual(before);
  });
});
