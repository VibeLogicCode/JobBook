import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-identity-email': 'owner@example.invalid' }),
}));

import { db } from '@/db/client';
import { companies, organization, users } from '@/db/schema';
import { saveContact, saveFinancial, saveIdentity, saveLocale } from '@/app/settings/actions';
import { loadSettings } from '@/app/settings/load';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
// After the mocks above, deliberately: this pulls in the database client.
import { ensureCompany, ensureOrganization } from '../support/organization';

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

/**
 * Each company keeps its own letterhead.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ASSERTIONS ARE ACTUALLY ABOUT
 * ---------------------------------------------------------------------------
 *
 * One thing: a save landing on the wrong corporation. The HST registration
 * number is the sharp end -- the Input Tax Credit Information Regulations put
 * the SUPPLIER's own number on an invoice of $30 and up, so the wrong one
 * makes the customer's credit defective on a return they have already filed.
 * The legal name and the holdback terms are the same class of error on paper
 * somebody signs.
 *
 * So every test here is either "the write went where the form said" or "the
 * write was refused rather than guessed".
 */

let secondId: string;

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, users, organization, companies restart identity cascade
  `);
  await ensureOrganization();
  await ensureCompany();
  await db.insert(users).values({
    email: 'owner@example.invalid',
    displayName: 'Test Owner',
    role: 'owner',
    isActive: true,
  });

  const [second] = await db
    .insert(companies)
    .values({
      legalName: 'Northgate Home Services Ltd.',
      displayName: 'Home Services',
      documentPrefix: 'SVC',
      sortOrder: 20,
    })
    .returning({ id: companies.id });
  secondId = second!.id;
});

const IDENTITY = {
  legalName: 'Renamed Ltd.',
  displayName: 'Renamed',
  operatingName: '',
  tagline: '',
  ownerName: '',
  ownerTitle: '',
  brandColor: '',
};

describe('a save lands on the company the form named', () => {
  it('writes to the second company and leaves the first alone', async () => {
    const result = await saveIdentity(null, form({ ...IDENTITY, companyId: secondId }));
    expect(result.ok).toBe(true);

    const [first] = await db.select().from(companies).where(eq(companies.id, FIRST_COMPANY_ID));
    const [second] = await db.select().from(companies).where(eq(companies.id, secondId));
    expect(second!.legalName).toBe('Renamed Ltd.');
    // The whole point. Before the company field existed this write went to
    // whichever company `primaryOf` resolved, which with two is nothing -- and
    // an earlier version would have picked the first.
    expect(first!.legalName).toBe('Sample Contracting Ltd');
  });

  it('keeps two HST registration numbers apart', async () => {
    await saveContact(null, form({
      addressLine1: '84 Foundry Lane', addressLine2: '', city: 'Burlington',
      province: 'ON', postalCode: 'L7R 2K9', country: 'Canada',
      phone: '', altPhone: '', email: '', website: '',
      companyId: secondId,
    }));
    await db.update(companies)
      .set({ taxRegistrationNumber: '111111111RT0001' })
      .where(eq(companies.id, FIRST_COMPANY_ID));

    const [first] = await db.select().from(companies).where(eq(companies.id, FIRST_COMPANY_ID));
    const [second] = await db.select().from(companies).where(eq(companies.id, secondId));
    expect(first!.taxRegistrationNumber).toBe('111111111RT0001');
    expect(second!.city).toBe('Burlington');
    // The first company's address was never touched by a save aimed at the
    // second.
    expect(first!.city).toBeNull();
  });

  it('refuses a save that names no company while there are two', async () => {
    const result = await saveIdentity(null, form(IDENTITY));
    expect(result.ok).toBe(false);
    // Guessing here puts a legal name on the wrong corporation's paper.
    expect(result.ok ? '' : result.error).toContain('more than one company');

    const [first] = await db.select().from(companies).where(eq(companies.id, FIRST_COMPANY_ID));
    expect(first!.legalName).toBe('Sample Contracting Ltd');
  });

  it('refuses a company that has since been retired', async () => {
    // A stale tab holds the id. Re-validated against the live list rather than
    // trusted from the form, because this is a `'use server'` endpoint.
    await db.update(companies).set({ isActive: false }).where(eq(companies.id, secondId));

    const result = await saveIdentity(null, form({ ...IDENTITY, companyId: secondId }));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('not one this deployment issues');
  });

  it('refuses an id that never existed', async () => {
    const result = await saveIdentity(null, form({
      ...IDENTITY, companyId: '11111111-1111-1111-1111-111111111111',
    }));
    expect(result.ok).toBe(false);
  });
});

describe('the split within one save', () => {
  it('sends the holdback to the company and the mileage rate to the deployment', async () => {
    /**
     * `/settings/financial` writes to BOTH tables in one submit: the holdback
     * fields and the tax registration are the company's, the mileage rate is
     * the deployment's. One call splits them by which table owns each key, so
     * there is one place that decision is made rather than one per field.
     */
    const result = await saveFinancial(null, form({
      taxRegistrationNumber: '222222222RT0001',
      taxRegistrationLabel: 'HST Number',
      businessNumber: '',
      fiscalYearEndMonth: '12',
      fiscalYearEndDay: '31',
      taxFilingFrequency: 'quarterly',
      taxDeferredOnHoldback: 'on',
      defaultHoldbackPct: '10',
      holdbackLabel: 'Statutory holdback',
      holdbackTermsText: '',
      holdbackReleaseDays: '60',
      paymentTermsDays: '15',
      paymentTermsText: '',
      insuranceStatement: '',
      mileageRatePerKm: '0.72',
      targetMargin: '25',
      companyId: secondId,
    }));
    expect(result.ok).toBe(true);

    const [second] = await db.select().from(companies).where(eq(companies.id, secondId));
    const [deployment] = await db.select().from(organization).where(eq(organization.id, 1));

    expect(second!.taxRegistrationNumber).toBe('222222222RT0001');
    // 10% is 1000n: ten-thousandths of the FRACTION, per `db/columns.ts`
    // -- 13% is 1300n. Not ten-thousandths of a percentage point.
    expect(second!.defaultHoldbackPctTenThou).toBe(1000n);
    // The deployment's, because it is what the vehicle in the yard costs to
    // run and both companies drive it.
    expect(deployment!.mileageRatePerKmTenThou).toBe(7200n);

    // And the first company kept its own.
    const [first] = await db.select().from(companies).where(eq(companies.id, FIRST_COMPANY_ID));
    expect(first!.taxRegistrationNumber).toBeNull();
  });

  it('lets the locale screen save with no company named at all', async () => {
    /**
     * `/settings/locale` has no company selector and needs none: currency,
     * timezone and area unit are the deployment's, and two companies sharing
     * one office cannot disagree about what day it is. If this refused, the
     * split would have leaked into a screen it has no business in.
     */
    const result = await saveLocale(null, form({
      currency: 'CAD', locale: 'en-CA', timezone: 'America/Vancouver', areaUnit: 'sqft',
    }));
    expect(result.ok).toBe(true);
    const [deployment] = await db.select().from(organization).where(eq(organization.id, 1));
    expect(deployment!.timezone).toBe('America/Vancouver');
  });
});

describe('what the screens read', () => {
  it('offers no selector while there is one company', async () => {
    await db.update(companies).set({ isActive: false }).where(eq(companies.id, secondId));
    const context = await loadSettings('organization.edit');
    // One entry means the picker renders nothing: a single-company install has
    // no such concept, which is the rule everywhere companies appear here.
    expect(context.companies).toHaveLength(1);
    expect(context.companyId).toBe(FIRST_COMPANY_ID);
  });

  it('chooses nothing until asked, once there are two', async () => {
    const context = await loadSettings('organization.edit');
    expect(context.companies).toHaveLength(2);
    // Rather than silently showing one company's letterhead under a heading
    // that does not say which.
    expect(context.companyId).toBeNull();
  });

  it('fills the form from the company the URL names', async () => {
    await db.update(companies)
      .set({ legalName: 'Northgate Home Services Ltd.', city: 'Oakville' })
      .where(eq(companies.id, secondId));

    const context = await loadSettings('organization.edit', secondId);
    expect(context.companyId).toBe(secondId);
    expect(context.org?.legalName).toBe('Northgate Home Services Ltd.');
    expect(context.org?.city).toBe('Oakville');
    // And the deployment's half is still there, from `organization`.
    expect(context.org?.timezone).toBeTruthy();
  });

  it('falls back to nothing when the URL names a retired company', async () => {
    await db.update(companies).set({ isActive: false }).where(eq(companies.id, secondId));
    const context = await loadSettings('organization.edit', secondId);
    /**
     * Null rather than the primary. Swapping which letterhead is on the form
     * under somebody's cursor -- while the URL still says otherwise -- is how
     * a save lands on a company nobody chose.
     */
    expect(context.companyId).toBeNull();
  });
});
