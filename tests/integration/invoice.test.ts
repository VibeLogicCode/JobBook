import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { db } from '@/db/client';
import {
  companies, customerInvoiceTaxes, customerInvoices, customers, holdbackLedger, organization, projects, quotes, taxRates,
} from '@/db/schema';
import {
  issueInvoice, jobBillingState, listProjectInvoices, loadInvoice, voidInvoice,
} from '@/lib/invoice/repository';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { seedDeployment } from '../support/organization';

/**
 * The figures divide cleanly, so a wrong answer is obvious rather than
 * plausible: a $100,000 pre-tax contract, 10% holdback, 13% sales tax. Every
 * draw, its withholding and its tax are whole cents with nothing to round, and
 * the schedule below has to land on $100,000 of work and $13,000 of tax exactly.
 *
 * The contract is a quote row inserted directly. What this module reads from a
 * quote is its accepted pre-tax subtotal and its holdback rate; building one
 * through the quote repository would add a template, four rate items and an
 * acceptance to a fixture that is about invoicing.
 */
const CONTRACT_CENTS = 10_000_000;
const HOLDBACK_10 = 1000n;
const TAX_13 = 1300n;
const ISSUE = '2026-09-01';

let projectId: string;
let customerId: string;

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, stage_history, holdback_ledger, customer_invoice_taxes,
    customer_invoice_lines, customer_invoices, quote_taxes, quote_lines, quotes,
    scope_template_items, scope_templates, rate_items, cost_codes, tax_rates,
    projects, customers, users, organization, companies, document_sequences
    restart identity cascade
  `);

  await seedDeployment({
    legalName: 'Test Company Ltd',
    displayName: 'Test Company',
    timezone: 'America/Toronto',
    defaultHoldbackPctTenThou: HOLDBACK_10,
    // Excise Tax Act s.168(7). Flipped off in its own describe block, because a
    // jurisdiction without the deferral must still bill correctly.
    taxDeferredOnHoldback: true,
    holdbackReleaseDays: 60,
    paymentTermsDays: 28,
  });
  await db.insert(taxRates).values({ companyId: FIRST_COMPANY_ID,
    label: 'Sales tax',
    rateTenThou: TAX_13,
    effectiveFrom: '2010-07-01',
    sortOrder: 1,
  });

  const [customer] = await db
    .insert(customers)
    .values({ name: 'Test Customer', customerType: 'residential' })
    .returning();
  customerId = customer!.id;

  const [project] = await db
    .insert(projects)
    .values({ companyId: FIRST_COMPANY_ID,
      customerId: customerId,
      projectNumber: 'P-0001',
      name: 'Lower level fit-out',
      projectTypeId: PROJECT_TYPE_IDS.basement,
      stage: 'in_progress',
    })
    .returning();
  projectId = project!.id;
});

/** An accepted quote, which is what makes a contract exist to bill against. */
async function acceptContract(
  subtotalCents = CONTRACT_CENTS,
  holdbackPctTenThou: bigint | null = HOLDBACK_10,
  sequence = 1,
): Promise<string> {
  const [quote] = await db
    .insert(quotes)
    .values({
      projectId,
      quoteNumber: `QT-2026-000${sequence}`,
      kind: 'estimate',
      sequence,
      version: 1,
      status: 'accepted',
      quoteDate: '2026-08-01',
      validUntil: '2026-09-30',
      subtotalCents,
      taxTotalCents: 0,
      totalCents: subtotalCents,
      holdbackPctTenThou,
    })
    .returning();
  return quote!.id;
}

const issue = (over: Partial<Parameters<typeof issueInvoice>[0]> = {}) =>
  issueInvoice({ projectId, kind: 'progress', issueDate: ISSUE, ...over } as Parameters<
    typeof issueInvoice
  >[0]);

/**
 * Drizzle wraps a driver error as `Failed query: ...` and hangs the real
 * PostgresError off `cause`, so asserting on the top-level message alone would
 * pass for any failure at all -- including a typo in the SQL.
 */
async function rejectionText(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the statement to be refused, but it succeeded');
}

async function ledgerRows() {
  return db
    .select()
    .from(holdbackLedger)
    .where(and(eq(holdbackLedger.projectId, projectId), eq(holdbackLedger.recordStatus, 'active')))
    .orderBy(asc(holdbackLedger.createdAt));
}

async function headerOf(invoiceId: string) {
  const [row] = await db.select().from(customerInvoices).where(eq(customerInvoices.id, invoiceId));
  return row!;
}

describe('a whole billing schedule', () => {
  /**
   * The property every other decision in this module exists to protect: a
   * deposit, three draws and a release bill the contract exactly once, and
   * collect the tax on it exactly once.
   */
  it('bills the contract and the tax on it exactly, and withholds nothing at the end', async () => {
    await acceptContract();

    const deposit = await issue({ kind: 'deposit', amountCents: 1_000_000 });
    const first = await issue({ percentCompleteTenThou: 2500n, depositApplyCents: 1_000_000 });
    const second = await issue({ percentCompleteTenThou: 6000n });
    const final = await issue({ kind: 'final', percentCompleteTenThou: 10000n });
    const release = await issue({ kind: 'holdback_release' });

    const issued = [deposit, first, second, final, release];

    // What the customer is asked to pay, across the whole job: the contract and
    // the tax on it, once. The deposit appears at its full value on its own
    // invoice and is drawn back off the draw that absorbs it, so a deposit
    // counted as revenue as well as drawn down would show up here as $10,000
    // too much.
    const dueCents = issued.reduce((sum, row) => sum + row.computed.amountDueCents, 0);
    expect(dueCents).toBe(CONTRACT_CENTS + 1_300_000);

    // The work billed, gross of holdback: the contract, once. The deposit is
    // absent because an advance is not a measurement of work.
    const billedCents = [first, second, final].reduce(
      (sum, row) => sum + row.computed.subtotalCents,
      0,
    );
    expect(billedCents).toBe(CONTRACT_CENTS);

    // Withheld and then paid back out, so the signed column sums to zero.
    expect(issued.reduce((sum, row) => sum + row.computed.holdbackCents, 0)).toBe(0);

    // 13% of $100,000, collected across five invoices and no more than once.
    expect(issued.reduce((sum, row) => sum + row.computed.taxTotalCents, 0)).toBe(1_300_000);

    const state = await jobBillingState(projectId);
    expect(state).toEqual({
      contractValueCents: CONTRACT_CENTS,
      previouslyBilledCents: CONTRACT_CENTS,
      holdbackAccruedCents: 1_000_000,
      holdbackReleasedCents: 1_000_000,
      depositHeldCents: 0,
    });
  });

  it('leaves the derived state equal to what the engine predicted, after every issue', async () => {
    // The two halves that must never disagree: the engine's `nextState` and the
    // sum of the stored rows. If they can drift, every figure downstream of
    // either one is unreliable and nothing else in this file proves anything.
    await acceptContract();

    for (const step of [
      { kind: 'deposit' as const, amountCents: 1_000_000 },
      { kind: 'progress' as const, percentCompleteTenThou: 2500n, depositApplyCents: 1_000_000 },
      { kind: 'progress' as const, percentCompleteTenThou: 6000n },
      { kind: 'final' as const, percentCompleteTenThou: 10000n },
      { kind: 'holdback_release' as const },
    ]) {
      const result = await issue(step);
      expect(await jobBillingState(projectId)).toEqual(result.computed.nextState);
    }
  });

  it('taxes progress less holdback, and the deferred tax on the release', async () => {
    await acceptContract();

    const draw = await issue({ percentCompleteTenThou: 2500n });
    // $25,000 earned, $2,500 withheld, so 13% falls on $22,500.
    expect(draw.computed.subtotalCents).toBe(2_500_000);
    expect(draw.computed.holdbackCents).toBe(250_000);
    expect(draw.computed.taxableBaseCents).toBe(2_250_000);
    expect(draw.computed.taxTotalCents).toBe(292_500);
    expect(draw.computed.totalCents).toBe(2_542_500);

    await issue({ kind: 'final', percentCompleteTenThou: 10000n });
    const release = await issue({ kind: 'holdback_release' });

    // The release bills no work and pays out $10,000 as a negative holdback,
    // and the tax deferred off every draw arrives here: 13% of $10,000.
    expect(release.computed.subtotalCents).toBe(0);
    expect(release.computed.holdbackCents).toBe(-1_000_000);
    expect(release.computed.holdbackReleasedCents).toBe(1_000_000);
    expect(release.computed.taxableBaseCents).toBe(1_000_000);
    expect(release.computed.taxTotalCents).toBe(130_000);
    expect(release.computed.totalCents).toBe(1_130_000);
  });

  it('puts the released amount in the holdback column and not in the subtotal', async () => {
    // In the subtotal it would report 110% of the contract as revenue on the
    // WIP schedule, and the extra 10% would look like a real draw.
    await acceptContract();
    await issue({ kind: 'final', percentCompleteTenThou: 10000n });
    const release = await issue({ kind: 'holdback_release' });

    const row = await headerOf(release.invoiceId);
    expect(row.subtotalCents).toBe(0);
    expect(row.holdbackCents).toBe(-1_000_000);
    expect((await jobBillingState(projectId)).previouslyBilledCents).toBe(CONTRACT_CENTS);
  });
});

describe('the deposit', () => {
  it('draws down against a later draw without taxing the same dollar twice', async () => {
    await acceptContract();
    const deposit = await issue({ kind: 'deposit', amountCents: 1_000_000 });
    // Tax charged at issue, per spec 4.3: an advance is invoiced, not received.
    expect(deposit.computed.taxableBaseCents).toBe(1_000_000);
    expect(deposit.computed.taxTotalCents).toBe(130_000);

    const draw = await issue({ percentCompleteTenThou: 2500n, depositApplyCents: 1_000_000 });

    // The drawdown comes off the taxable base BEFORE the tax is computed:
    // $25,000 earned, less $2,500 withheld, less the $10,000 advance already
    // taxed. Subtracting it from the tax or from the total instead both look
    // right on the invoice and are both wrong on the return.
    expect(draw.computed.depositAppliedCents).toBe(1_000_000);
    expect(draw.computed.taxableBaseCents).toBe(1_250_000);
    expect(draw.computed.taxTotalCents).toBe(162_500);
    // The advance reduces what is payable today, not the value of the work.
    expect(draw.computed.totalCents).toBe(2_412_500);
    expect(draw.computed.amountDueCents).toBe(1_412_500);

    const tax = deposit.computed.taxTotalCents + draw.computed.taxTotalCents;
    // 13% of $22,500 of net billing, not of $32,500.
    expect(tax).toBe(292_500);
  });

  it('does not count an advance as work billed', async () => {
    await acceptContract();
    await issue({ kind: 'deposit', amountCents: 1_000_000 });

    const state = await jobBillingState(projectId);
    expect(state.previouslyBilledCents).toBe(0);
    expect(state.depositHeldCents).toBe(1_000_000);
    // No work measured, so nothing was withheld from it.
    expect(state.holdbackAccruedCents).toBe(0);
  });

  it('carries the unabsorbed part of an advance forward', async () => {
    // Clamped, not refused: a $10,000 advance against a $2,500 draw cannot be
    // applied in full without pushing the taxable base negative, which is a
    // credit note rather than a progress invoice.
    await acceptContract();
    await issue({ kind: 'deposit', amountCents: 1_000_000 });
    const draw = await issue({ percentCompleteTenThou: 250n, depositApplyCents: 1_000_000 });

    // 2.5% of $100,000 is $2,500, less the $250 withheld from it.
    expect(draw.computed.subtotalCents).toBe(250_000);
    expect(draw.computed.depositAppliedCents).toBe(225_000);
    expect(draw.computed.taxableBaseCents).toBe(0);
    expect((await jobBillingState(projectId)).depositHeldCents).toBe(775_000);
  });
});

describe('a jurisdiction without the holdback deferral', () => {
  beforeEach(async () => {
      // On the COMPANY, not the deployment. The deferral under Excise Tax Act
      // s.168(7) is a property of the registrant issuing the invoice, and two
      // corporations under one owner can be in different positions on it.
    await db
      .update(companies)
      .set({ taxDeferredOnHoldback: false })
      .where(eq(companies.id, FIRST_COMPANY_ID));
  });

  it('taxes the whole progress amount and leaves the release untaxed', async () => {
    await acceptContract();
    const draw = await issue({ percentCompleteTenThou: 2500n });

    // 13% of the full $25,000, because nothing is deferred.
    expect(draw.computed.taxableBaseCents).toBe(2_500_000);
    expect(draw.computed.taxTotalCents).toBe(325_000);
    expect(draw.computed.totalCents).toBe(2_575_000);

    await issue({ kind: 'final', percentCompleteTenThou: 10000n });
    const release = await issue({ kind: 'holdback_release' });

    // The holdback was taxed as it was withheld, so the release carries none.
    expect(release.computed.taxableBaseCents).toBe(0);
    expect(release.computed.taxTotalCents).toBe(0);
    expect(release.computed.totalCents).toBe(1_000_000);
  });

  it('still collects the tax on the contract exactly once', async () => {
    await acceptContract();
    const draws = [
      await issue({ percentCompleteTenThou: 2500n }),
      await issue({ percentCompleteTenThou: 6000n }),
      await issue({ kind: 'final', percentCompleteTenThou: 10000n }),
      await issue({ kind: 'holdback_release' }),
    ];
    expect(draws.reduce((sum, row) => sum + row.computed.taxTotalCents, 0)).toBe(1_300_000);
  });

  it('snapshots the setting, so flipping it cannot retax an invoice already sent', async () => {
    await acceptContract();
    const draw = await issue({ percentCompleteTenThou: 2500n });
    await db
      .update(companies)
      .set({ taxDeferredOnHoldback: true })
      .where(eq(companies.id, FIRST_COMPANY_ID));

    const row = await headerOf(draw.invoiceId);
    expect(row.taxDeferredOnHoldback).toBe(false);
    expect(row.taxTotalCents).toBe(325_000);
  });
});

describe('the tax snapshot', () => {
  it('does not re-resolve a rate change onto an invoice already issued', async () => {
    await acceptContract();
    const draw = await issue({ percentCompleteTenThou: 2500n });

    await db.update(taxRates).set({ effectiveTo: '2026-09-30' }).where(eq(taxRates.rateTenThou, TAX_13));
    await db.insert(taxRates).values({ companyId: FIRST_COMPANY_ID,
      label: 'Sales tax',
      rateTenThou: 1500n,
      effectiveFrom: '2026-10-01',
      sortOrder: 1,
    });

    const loaded = await loadInvoice(draw.invoiceId);
    expect(loaded?.taxes).toHaveLength(1);
    expect(loaded?.taxes[0]?.rateTenThou).toBe(TAX_13);
    expect(loaded?.taxes[0]?.taxAmountCents).toBe(292_500);
    expect(loaded?.invoice.taxTotalCents).toBe(292_500);
  });

  it('charges the rate in force on the issue date, not the rate configured today', async () => {
    await acceptContract();
    await db.update(taxRates).set({ effectiveTo: '2026-09-30' }).where(eq(taxRates.rateTenThou, TAX_13));
    await db.insert(taxRates).values({ companyId: FIRST_COMPANY_ID,
      label: 'Sales tax',
      rateTenThou: 1500n,
      effectiveFrom: '2026-10-01',
      sortOrder: 1,
    });

    const later = await issue({ percentCompleteTenThou: 2500n, issueDate: '2026-11-01' });
    // 15% of $22,500.
    expect(later.computed.taxTotalCents).toBe(337_500);
    const rows = await db
      .select()
      .from(customerInvoiceTaxes)
      .where(eq(customerInvoiceTaxes.invoiceId, later.invoiceId));
    expect(rows[0]?.rateTenThou).toBe(1500n);
  });

  it('stores the base even for an exempt customer, who gets no tax rows at all', async () => {
    await db.update(customers).set({ isTaxExempt: true }).where(eq(customers.id, customerId));
    await acceptContract();

    const draw = await issue({ percentCompleteTenThou: 2500n });
    expect(draw.computed.taxTotalCents).toBe(0);

    const loaded = await loadInvoice(draw.invoiceId);
    expect(loaded?.taxes).toEqual([]);
    // Without this column the invoice could not say what it did not tax.
    expect(loaded?.invoice.taxableBaseCents).toBe(2_250_000);
  });
});

describe('the holdback ledger', () => {
  it('records an accrual per draw and a release naming its own invoice', async () => {
    // The reason the spec's single `invoice_id` on a balance row cannot work: a
    // holdback accrues across many progress invoices and is released by one, so
    // one row with one foreign key can name at most one of the two sides.
    await db
      .update(projects)
      .set({ substantialPerformanceDate: '2026-11-01' })
      .where(eq(projects.id, projectId));
    await acceptContract();

    const first = await issue({ percentCompleteTenThou: 2500n });
    const second = await issue({ percentCompleteTenThou: 6000n });
    const final = await issue({ kind: 'final', percentCompleteTenThou: 10000n });
    const release = await issue({ kind: 'holdback_release' });

    const rows = await ledgerRows();
    expect(rows.map((row) => [row.entryKind, row.accruedCents, row.releasedCents])).toEqual([
      ['accrual', 250_000, 0],
      ['accrual', 350_000, 0],
      ['accrual', 400_000, 0],
      ['release', 0, 1_000_000],
    ]);
    expect(rows.map((row) => row.invoiceId)).toEqual([
      first.invoiceId,
      second.invoiceId,
      final.invoiceId,
      release.invoiceId,
    ]);
    expect(rows.every((row) => row.direction === 'receivable')).toBe(true);
    expect(rows.every((row) => row.counterpartyId === customerId)).toBe(true);
    // Substantial performance plus the configured statutory period.
    expect(rows.every((row) => row.releaseEligibleDate === '2026-12-31')).toBe(true);
    expect(rows.at(-1)?.releasedAt).not.toBeNull();
  });

  it('writes no accrual for an invoice that measures no work', async () => {
    await acceptContract();
    await issue({ kind: 'deposit', amountCents: 1_000_000 });
    expect(await ledgerRows()).toEqual([]);
  });

  it('records a corrective draw as a negative accrual, not as a release', async () => {
    // No money moved, so calling it a release would report a payout that never
    // happened.
    await acceptContract();
    await issue({ percentCompleteTenThou: 6000n });
    await issue({ percentCompleteTenThou: 4500n });

    const rows = await ledgerRows();
    expect(rows.map((row) => [row.entryKind, row.accruedCents])).toEqual([
      ['accrual', 600_000],
      ['accrual', -150_000],
    ]);
    expect((await jobBillingState(projectId)).holdbackAccruedCents).toBe(450_000);
  });

  it('permits an outstanding balance below zero after a correction', async () => {
    // Deliberate: a percent that goes backwards after the holdback was paid out
    // leaves money genuinely owed back, and refusing the correction would only
    // hide it. No constraint stands in the way.
    await acceptContract();
    await issue({ percentCompleteTenThou: 10000n });
    await issue({ kind: 'holdback_release' });

    const correction = await issue({ percentCompleteTenThou: 5000n });
    // A credit: half the contract un-billed, and half the withholding reversed.
    expect(correction.computed.subtotalCents).toBe(-5_000_000);
    expect(correction.computed.holdbackCents).toBe(-500_000);

    const state = await jobBillingState(projectId);
    expect(state.holdbackAccruedCents).toBe(500_000);
    expect(state.holdbackReleasedCents).toBe(1_000_000);
    expect(state.holdbackAccruedCents - state.holdbackReleasedCents).toBe(-500_000);
  });
});

describe('voiding', () => {
  it('restores the billing state the job had before the invoice', async () => {
    await acceptContract();
    await issue({ kind: 'deposit', amountCents: 1_000_000 });
    const before = await jobBillingState(projectId);

    const draw = await issue({ percentCompleteTenThou: 2500n, depositApplyCents: 1_000_000 });
    expect(await jobBillingState(projectId)).toEqual(draw.computed.nextState);

    const { state } = await voidInvoice({ invoiceId: draw.invoiceId, reason: 'Billed the wrong period' });
    // Including the drawdown: the advance is unabsorbed again, because the
    // invoice that absorbed it no longer bills anything.
    expect(state).toEqual(before);
    expect(await jobBillingState(projectId)).toEqual(before);
  });

  it('lets the next draw re-bill the work the voided one had billed', async () => {
    await acceptContract();
    const first = await issue({ percentCompleteTenThou: 2500n });
    await voidInvoice({ invoiceId: first.invoiceId, reason: 'Percent was wrong' });

    const replacement = await issue({ percentCompleteTenThou: 2500n });
    expect(replacement.computed.subtotalCents).toBe(2_500_000);
    expect(replacement.computed.holdbackCents).toBe(250_000);
  });

  it('keeps the row, its reason and its number, and voids its children', async () => {
    await acceptContract();
    const draw = await issue({ percentCompleteTenThou: 2500n, lines: [
      { description: 'Framing to date', calcMode: 'flat', qtyMilli: 1000n, unitPriceTenThou: 25_000_000n },
    ] });
    await voidInvoice({ invoiceId: draw.invoiceId, reason: 'Billed the wrong period' });

    const row = await headerOf(draw.invoiceId);
    expect(row.recordStatus).toBe('void');
    expect(row.voidReason).toBe('Billed the wrong period');
    expect(row.voidedAt).not.toBeNull();
    // The stored figures are untouched: the document still says what it said.
    expect(row.subtotalCents).toBe(2_500_000);

    const loaded = await loadInvoice(draw.invoiceId);
    expect(loaded?.lines).toEqual([]);
    expect(loaded?.taxes).toEqual([]);
    expect(loaded?.holdback).toEqual([]);
    expect(await ledgerRows()).toEqual([]);
  });

  it('lists the voided invoice, so a gap in the number series is explainable', async () => {
    await acceptContract();
    const first = await issue({ percentCompleteTenThou: 2500n });
    await voidInvoice({ invoiceId: first.invoiceId, reason: 'Percent was wrong' });
    const second = await issue({ percentCompleteTenThou: 2500n });

    const rows = await listProjectInvoices(projectId);
    expect(rows.map((row) => [row.invoiceNumber, row.recordStatus])).toEqual(
      expect.arrayContaining([
        ['INV-2026-0001', 'void'],
        ['INV-2026-0002', 'active'],
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(second.invoiceNumber).toBe('INV-2026-0002');
  });

  it('refuses a second void, which would overwrite the first reason', async () => {
    await acceptContract();
    const draw = await issue({ percentCompleteTenThou: 2500n });
    await voidInvoice({ invoiceId: draw.invoiceId, reason: 'Percent was wrong' });

    await expect(
      voidInvoice({ invoiceId: draw.invoiceId, reason: 'Changed my mind' }),
    ).rejects.toThrow(/already void/i);
  });

  it('refuses a void with no reason given', async () => {
    await acceptContract();
    const draw = await issue({ percentCompleteTenThou: 2500n });
    await expect(
      voidInvoice({ invoiceId: draw.invoiceId, reason: '   ' }),
    ).rejects.toThrow(/void reason is required/i);
  });
});

describe('numbering', () => {
  it('runs one series per year, from the tenant document code', async () => {
    await acceptContract();
    const first = await issue({ percentCompleteTenThou: 1000n });
    const second = await issue({ percentCompleteTenThou: 2000n });
    expect([first.invoiceNumber, second.invoiceNumber]).toEqual([
      'INV-2026-0001',
      'INV-2026-0002',
    ]);
  });

  it('burns no number on an invoice that is refused', async () => {
    await acceptContract();
    await expect(issue({ percentCompleteTenThou: 11000n })).rejects.toThrow();
    const first = await issue({ percentCompleteTenThou: 2500n });
    expect(first.invoiceNumber).toBe('INV-2026-0001');
  });
});

describe('refusals', () => {
  it('refuses a job with no accepted quote, because there is no contract', async () => {
    await expect(issue({ percentCompleteTenThou: 2500n })).rejects.toThrow(/no accepted quote/i);
  });

  it('refuses a draw past the contract, which is a change order', async () => {
    // computeInvoice does not bound the completion percentage -- it calls
    // earnedToDateCents directly and the range assertion lives in
    // progressAmountCents, which is not on its path -- so this refusal has to
    // happen here or a 110% draw prices and stores cleanly.
    await acceptContract();
    await expect(issue({ percentCompleteTenThou: 11000n })).rejects.toThrow(
      /between 0% and 100%/i,
    );
  });

  it('refuses a change order billed past the contract', async () => {
    await acceptContract();
    await expect(
      issue({ kind: 'change_order', amountCents: CONTRACT_CENTS + 1 }),
    ).rejects.toThrow(/accept the change order first/i);
  });

  it('bills a change order that the contract already covers', async () => {
    // The contract was raised by an accepted change order, so its increment is
    // billable now rather than waiting for the next draw to pick it up.
    await acceptContract(CONTRACT_CENTS);
    const extra = await issue({ kind: 'change_order', amountCents: 2_000_000 });
    expect(extra.computed.subtotalCents).toBe(2_000_000);
    expect((await jobBillingState(projectId)).previouslyBilledCents).toBe(2_000_000);

    // And the next draw nets it out rather than billing it twice.
    const draw = await issue({ percentCompleteTenThou: 5000n });
    expect(draw.computed.subtotalCents).toBe(3_000_000);
  });

  it('refuses a final that leaves the contract part-billed', async () => {
    await acceptContract();
    await expect(issue({ kind: 'final', percentCompleteTenThou: 9000n })).rejects.toThrow(
      /bills the contract to 100%/i,
    );
  });

  it('refuses a progress invoice with no percent complete', async () => {
    await acceptContract();
    await expect(issue({})).rejects.toThrow(/needs a percent complete/i);
  });

  it('refuses a deposit that carries a percent complete', async () => {
    await acceptContract();
    await expect(
      issue({ kind: 'deposit', amountCents: 1_000_000, percentCompleteTenThou: 2500n }),
    ).rejects.toThrow(/does not bill by percent complete/i);
  });

  it('refuses a release of more holdback than was ever withheld', async () => {
    await acceptContract();
    await issue({ percentCompleteTenThou: 2500n });
    await expect(
      issue({ kind: 'holdback_release', releaseHoldbackCents: 300_000 }),
    ).rejects.toThrow(/only 250000 cents are outstanding/i);
  });

  it('refuses a void project', async () => {
    await acceptContract();
    await db
      .update(projects)
      .set({ recordStatus: 'void', voidReason: 'Duplicate record' })
      .where(eq(projects.id, projectId));
    await expect(issue({ percentCompleteTenThou: 2500n })).rejects.toThrow(
      /void project cannot be invoiced/i,
    );
  });

  it('refuses to invoice a job whose contract has shrunk below what it has billed', async () => {
    // Voiding an accepted quote is the one way the contract can fall below the
    // invoices that already billed against it. Every kind is then billing
    // against a smaller contract than what has gone out, so it is refused until
    // a change order restores the value.
    const first = await acceptContract(6_000_000, HOLDBACK_10, 1);
    await acceptContract(4_000_000, HOLDBACK_10, 2);
    await issue({ percentCompleteTenThou: 10000n });

    await db
      .update(quotes)
      .set({ recordStatus: 'void', voidReason: 'Quoted the wrong address' })
      .where(eq(quotes.id, first));

    await expect(issue({ kind: 'deposit', amountCents: 100_000 })).rejects.toThrow(
      /has billed 10000000 cents against a contract of 4000000/i,
    );
  });

  it('refuses accepted quotes that disagree about the holdback rate', async () => {
    // The withholding accrues against their combined value, so two rates would
    // make the accrued balance depend on which row was read first.
    await acceptContract(6_000_000, 1000n, 1);
    await acceptContract(4_000_000, 500n, 2);
    await expect(issue({ percentCompleteTenThou: 2500n })).rejects.toThrow(
      /disagree about the holdback rate/i,
    );
  });

  it('changes nothing at all when it refuses', async () => {
    await acceptContract();
    await issue({ percentCompleteTenThou: 2500n });
    const before = await jobBillingState(projectId);

    await expect(issue({ percentCompleteTenThou: 11000n })).rejects.toThrow();

    expect(await jobBillingState(projectId)).toEqual(before);
    expect(await listProjectInvoices(projectId)).toHaveLength(1);
    expect(await ledgerRows()).toHaveLength(1);
  });
});

describe('a contract with no withholding', () => {
  it('bills the whole draw and taxes all of it', async () => {
    // A quote whose holdback rate is null withholds nothing. The COMPANY
    // default is NOT read here: it may have moved since the contract was
    // signed, and `contractOf` refuses to fall back to it in as many words.
    await db
      .update(companies)
      .set({ defaultHoldbackPctTenThou: 5000n })
      .where(eq(companies.id, FIRST_COMPANY_ID));
    await acceptContract(CONTRACT_CENTS, null);

    const draw = await issue({ percentCompleteTenThou: 2500n });
    expect(draw.computed.holdbackCents).toBe(0);
    expect(draw.computed.taxableBaseCents).toBe(2_500_000);
    expect(await ledgerRows()).toEqual([]);
  });
});

describe('what the database itself refuses', () => {
  it('refuses an invoice whose total does not follow from its parts', async () => {
    // The sign convention, enforced where a mistake cannot hide: get the
    // holdback backwards and the insert fails, rather than shipping an invoice
    // short by twice the withholding.
    await acceptContract();
    const text = await rejectionText(() =>
      db.insert(customerInvoices).values({
        projectId,
        invoiceNumber: 'INV-2026-9001',
        kind: 'progress',
        issueDate: ISSUE,
        subtotalCents: 2_500_000,
        holdbackCents: 250_000,
        taxTotalCents: 292_500,
        // subtotal + holdback + tax, which is the intuitive and wrong version.
        totalCents: 3_042_500,
        amountDueCents: 3_042_500,
        percentCompleteTenThou: 2500n,
        taxDeferredOnHoldback: true,
      }),
    );
    expect(text).toMatch(/customer_invoices_total_identity/i);
  });

  it('refuses a holdback release that bills work', async () => {
    await acceptContract();
    const text = await rejectionText(() =>
      db.insert(customerInvoices).values({
        projectId,
        invoiceNumber: 'INV-2026-9002',
        kind: 'holdback_release',
        issueDate: ISSUE,
        subtotalCents: 1_000_000,
        totalCents: 1_000_000,
        amountDueCents: 1_000_000,
        taxDeferredOnHoldback: true,
      }),
    );
    expect(text).toMatch(/customer_invoices_release_bills_no_work/i);
  });

  it('refuses a ledger row that is both an accrual and a release', async () => {
    const text = await rejectionText(() =>
      db.insert(holdbackLedger).values({
        projectId,
        direction: 'receivable',
        counterpartyType: 'customer',
        counterpartyId: customerId,
        entryKind: 'accrual',
        accruedCents: 250_000,
        releasedCents: 250_000,
      }),
    );
    expect(text).toMatch(/holdback_ledger_one_event_per_row/i);
  });

  it('refuses a DELETE of an invoice issued as the application role', async () => {
    await acceptContract();
    const draw = await issue({ percentCompleteTenThou: 2500n });

    const text = await rejectionText(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set local role quote_app`);
        await tx.execute(sql`delete from customer_invoices`);
      }),
    );
    expect(text).toMatch(/permission denied/i);
    expect((await headerOf(draw.invoiceId)).invoiceNumber).toBe('INV-2026-0001');
  });
});

describe('loading and listing', () => {
  it('returns the document as it was stored, lines and taxes included', async () => {
    await acceptContract();
    const draw = await issue({
      percentCompleteTenThou: 2500n,
      periodFrom: '2026-08-01',
      periodTo: '2026-08-31',
      lines: [
        { description: 'Demolition complete', calcMode: 'qty', qtyMilli: 1_000_000n, unitPriceTenThou: 40_000n, code: 'DEM-01', unitLabel: 'sqft' },
        { description: 'Permit fee', calcMode: 'flat', qtyMilli: 9_999_000n, unitPriceTenThou: 5_000_000n, code: 'ADM-01' },
      ],
      status: 'sent',
    });

    const loaded = await loadInvoice(draw.invoiceId);
    expect(loaded?.invoice.status).toBe('sent');
    expect(loaded?.invoice.sentAt).not.toBeNull();
    // 28 days of payment terms from the issue date.
    expect(loaded?.invoice.dueDate).toBe('2026-09-29');
    expect(loaded?.invoice.periodFrom).toBe('2026-08-01');
    expect(loaded?.invoice.contractValueAtInvoiceCents).toBe(CONTRACT_CENTS);
    expect(loaded?.invoice.percentCompleteTenThou).toBe(2500n);
    expect(loaded?.invoice.previouslyBilledCents).toBe(0);
    expect(loaded?.invoice.holdbackPctTenThou).toBe(HOLDBACK_10);

    expect(loaded?.lines.map((line) => line.lineTotalCents)).toEqual([
      // 1,000 sqft at $4.0000.
      400_000,
      // A flat line is a quantity of exactly one, so the stray quantity above
      // cannot multiply the $500 fee.
      50_000,
    ]);
    // Lines describe what the money covers; they do not sum to the header,
    // which comes from the contract and the percent complete.
    expect(loaded?.invoice.subtotalCents).toBe(2_500_000);
  });

  it('returns null for an invoice that does not exist', async () => {
    expect(await loadInvoice('11111111-1111-1111-1111-111111111111')).toBeNull();
  });

  it('lists a job newest first', async () => {
    await acceptContract();
    await issue({ percentCompleteTenThou: 2500n, issueDate: '2026-09-01' });
    await issue({ percentCompleteTenThou: 5000n, issueDate: '2026-10-01' });

    const rows = await listProjectInvoices(projectId);
    expect(rows.map((row) => row.issueDate)).toEqual(['2026-10-01', '2026-09-01']);
  });

  it('reports a job with no invoices as nothing billed', async () => {
    await acceptContract();
    expect(await jobBillingState(projectId)).toEqual({
      contractValueCents: CONTRACT_CENTS,
      previouslyBilledCents: 0,
      holdbackAccruedCents: 0,
      holdbackReleasedCents: 0,
      depositHeldCents: 0,
    });
  });
});
