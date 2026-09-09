import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { companies, taxRates } from '@/db/schema';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { loadTaxRatesFor } from '@/lib/quote/rates';
import { allocateDocumentNumber } from '@/lib/quote/numbering';
import { overlapProblem } from '@/lib/quote/tax-overlap';
import { seedDeployment } from '../support/organization';

/**
 * Two registrants under one owner.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS SEPARATELY FROM `tests/db/companies.test.ts`
 * ---------------------------------------------------------------------------
 *
 * That file asserts the SHAPE of the split -- which column lives on which
 * table. This one asserts the three things that shape was for, each of which
 * was a silent wrong number on a customer-facing document before the split:
 *
 *   - double tax, because `loadTaxRatesFor` had no company filter;
 *   - a shared invoice series across two registrants;
 *   - one company's HST refused as a duplicate of the other's.
 *
 * All three are the same failure class: correct arithmetic over rows nobody
 * scoped.
 */

let secondId: string;
const first = { id: FIRST_COMPANY_ID, documentPrefix: null };
let second: { id: string; documentPrefix: string | null };

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, tax_rates, users, organization, companies, document_sequences
    restart identity cascade
  `);

  await seedDeployment({
    legalName: 'Northgate Building Group Inc.',
    displayName: 'Northgate Building Group',
    timezone: 'America/Toronto',
    taxRegistrationNumber: '111111111RT0001',
  });

  const [created] = await db
    .insert(companies)
    .values({
      legalName: 'Northgate Home Services Ltd.',
      displayName: 'Northgate Home Services',
      taxRegistrationNumber: '222222222RT0001',
      // What keeps its numbers apart from the builder's. Without it the two
      // would both want (invoice, 2026, 'INV'), which `document_sequences`
      // refuses -- because the invoices themselves are globally unique and
      // carry no company.
      documentPrefix: 'SVC',
      sortOrder: 20,
    })
    .returning({ id: companies.id });
  secondId = created!.id;
  second = { id: created!.id, documentPrefix: 'SVC' };

  // Both registered, both charging 13%, both in force from the same day. This
  // is the ordinary case, not a contrived one: two Ontario corporations under
  // common control each have their own HST account and each charges HST.
  await db.insert(taxRates).values([
    {
      companyId: FIRST_COMPANY_ID,
      label: 'HST',
      rateTenThou: 130000n,
      effectiveFrom: '2010-07-01',
      registrationNumber: '111111111RT0001',
      sortOrder: 1,
    },
    {
      companyId: secondId,
      label: 'HST',
      rateTenThou: 130000n,
      effectiveFrom: '2010-07-01',
      registrationNumber: '222222222RT0001',
      sortOrder: 1,
    },
  ]);
});

describe('tax is charged once, by the company issuing the document', () => {
  it('returns one company its own single rate', async () => {
    const rates = await db.transaction((tx) => loadTaxRatesFor(tx, FIRST_COMPANY_ID));
    // ONE row, not two. Unscoped this returned both, `computeTaxes` applied
    // both in force, and every quote in the deployment charged 26% -- on a
    // document a customer signs, with the arithmetic entirely innocent.
    expect(rates).toHaveLength(1);
    expect(rates[0]!.registrationNumber).toBe('111111111RT0001');
  });

  it('gives the second company its own registration number', async () => {
    const rates = await db.transaction((tx) => loadTaxRatesFor(tx, secondId));
    expect(rates).toHaveLength(1);
    // The Input Tax Credit Information Regulations require the SUPPLIER's own
    // number on an invoice of $30 and up. The wrong one makes the customer's
    // credit defective.
    expect(rates[0]!.registrationNumber).toBe('222222222RT0001');
  });

  it('still stacks two genuinely different taxes for one company', async () => {
    // The behaviour the filter must NOT break: a GST+PST province needs every
    // rate in force applied, which is why the company filter belongs in the
    // query rather than in the engine.
    await db.insert(taxRates).values({
      companyId: FIRST_COMPANY_ID,
      label: 'PST',
      rateTenThou: 70000n,
      effectiveFrom: '2010-07-01',
      sortOrder: 2,
    });
    const rates = await db.transaction((tx) => loadTaxRatesFor(tx, FIRST_COMPANY_ID));
    expect(rates.map((rate) => rate.label)).toEqual(['HST', 'PST']);
  });
});

describe('the overlap guard reads one company', () => {
  it('does not call the other company HST a duplicate', async () => {
    const scoped = await db
      .select({
        label: taxRates.label,
        effectiveFrom: taxRates.effectiveFrom,
        effectiveTo: taxRates.effectiveTo,
      })
      .from(taxRates)
      .where(and(eq(taxRates.companyId, secondId), eq(taxRates.isActive, true)));

    // Company two adding a rate sees only company two's rows, so its own HST
    // is the only thing it can clash with. Before the scoping this refusal
    // told the owner to supersede a row belonging to a different corporation.
    expect(scoped).toHaveLength(1);
    expect(
      overlapProblem(scoped, { label: 'GST', effectiveFrom: '2010-07-01', effectiveTo: null }),
    ).toBeNull();
  });

  it('still refuses a real duplicate within one company', async () => {
    const scoped = await db
      .select({
        label: taxRates.label,
        effectiveFrom: taxRates.effectiveFrom,
        effectiveTo: taxRates.effectiveTo,
      })
      .from(taxRates)
      .where(and(eq(taxRates.companyId, secondId), eq(taxRates.isActive, true)));

    const problem = overlapProblem(scoped, {
      label: 'HST',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    });
    expect(problem).toContain('supersede');
  });
});

describe('each company numbers its own documents', () => {
  it('starts the second company at 0001 and leaves the first where it is', async () => {
    await db.transaction(async (tx) => {
      expect(await allocateDocumentNumber(tx, 'invoice', first, 2026))
        .toBe('INV-2026-0001');
      expect(await allocateDocumentNumber(tx, 'invoice', first, 2026))
        .toBe('INV-2026-0002');
      // A different registrant's series, from 0001, under its own code. An
      // auditor asks each corporation for its own sequential run, and nothing
      // is ever renumbered.
      expect(await allocateDocumentNumber(tx, 'invoice', second, 2026))
        .toBe('SVC_INV-2026-0001');
      // And the first company's counter was not touched by the second's.
      expect(await allocateDocumentNumber(tx, 'invoice', first, 2026))
        .toBe('INV-2026-0003');
    });
  });

  it('keeps the kind in the number, so a quote and a change order differ', async () => {
    // A flat per-company code would number both `SVC_-2026-0001`, and they
    // share the `quotes.quote_number` unique index. This is why the company
    // prefix is prepended to the kind code rather than replacing it.
    await db.transaction(async (tx) => {
      expect(await allocateDocumentNumber(tx, 'quote', second, 2026))
        .toBe('SVC_QT-2026-0001');
      expect(await allocateDocumentNumber(tx, 'change_order', second, 2026))
        .toBe('SVC_CO-2026-0001');
    });
  });

  it('leaves a company with no code numbering exactly as before', async () => {
    // Every existing installation and every single-company one. With one
    // company there is nothing to distinguish, and `QT-2026-0001` is shorter
    // and says as much.
    expect(await db.transaction((tx) => allocateDocumentNumber(tx, 'quote', first, 2026)))
      .toBe('QT-2026-0001');
  });

  it('refuses two companies the same code, rather than colliding on an invoice', async () => {
    // The constraint that makes the suffix necessary. Without it, the second
    // company's first invoice would be numbered INV-2026-0001 and fail on
    // `customer_invoices.invoice_number` -- a unique violation on a table that
    // has nothing to do with the cause.
    const [clashing] = await db
      .insert(companies)
      .values({ legalName: 'Third Co Ltd', displayName: 'Third Co' })
      .returning({ id: companies.id });

    await db.transaction((tx) => allocateDocumentNumber(tx, 'invoice', first, 2026));
    await expect(
      db.transaction((tx) => allocateDocumentNumber(tx, 'invoice', { id: clashing!.id, documentPrefix: null }, 2026)),
    ).rejects.toThrow();
  });

  it('keeps a gap per company, because a gap is the record of a void', async () => {
    await db.transaction((tx) => allocateDocumentNumber(tx, 'quote', second, 2026));
    await expect(
      db.transaction(async (tx) => {
        await allocateDocumentNumber(tx, 'quote', second, 2026);
        throw new Error('abandoned');
      }),
    ).rejects.toThrow('abandoned');
    // The rolled-back allocation burned nothing, exactly as it does for a
    // single company: the counter is inside the transaction that writes.
    expect(await db.transaction((tx) => allocateDocumentNumber(tx, 'quote', second, 2026)))
      .toBe('SVC_QT-2026-0002');
  });
});
