import { desc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';

/**
 * `revalidatePath`, `headers` and `redirect` are request-scoped Next APIs and
 * there is no request here. Mocked rather than avoided, for the reason
 * `stage.test.ts` gives: the action genuinely must call them, and a test that
 * routed around them would be testing a different function.
 *
 * The identity header is what the proxy writes after it has verified an Access
 * token or read a session, so supplying it is exactly what a signed-in request
 * looks like to the action. `redirect` throws in Next as well, which is why the
 * action calls it outside its own try -- the mock keeps that shape so a
 * refusal and a success stay distinguishable.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-identity-email': 'owner@example.invalid' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

import { db } from '@/db/client';
import {
  companies, customerInvoices, customers, documentSequences, organization, projects, quotes, taxRates, users,
} from '@/db/schema';
// After the mocks above, deliberately: this pulls in the database client,
// and the module under test must not be loaded before they are installed.
import { seedDeployment } from '../support/organization';
import { issueCustomerInvoice } from '@/app/projects/[id]/billing/actions';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';

/**
 * Figures that divide cleanly, so a wrong answer is obvious rather than
 * plausible: a $100,000 pre-tax contract, 10% holdback, 13% sales tax. Every
 * draw, its withholding and its tax are whole cents with nothing to round.
 *
 * The contract is a quote row inserted directly. What the invoice engine reads
 * from a quote is its accepted pre-tax subtotal and its holdback rate;
 * building one through the quote repository would add a template, rate items
 * and an acceptance to a fixture that is about billing.
 */
const CONTRACT_CENTS = 10_000_000;
const HOLDBACK_10 = 1000n;
const TAX_13 = 1300n;
const ISSUE = '2026-09-01';

/** A 45% draw on the contract above, worked out by hand. */
const DRAW_45 = 4_500_000;
const HOLDBACK_ON_DRAW_45 = 450_000;
const DEFERRED_BASE = DRAW_45 - HOLDBACK_ON_DRAW_45;
/** 13% of the deferred base. What s.168(7) says this invoice may charge. */
const TAX_ON_DEFERRED_BASE = 526_500;
/** 13% of the WHOLE draw. The wrong answer, named so the test can refuse it. */
const TAX_ON_WHOLE_DRAW = 585_000;

let jobId: string;
let opportunityId: string;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

/** The refusal a person reads. Fails loudly if the action allowed the request. */
async function refusal(fields: Record<string, string>): Promise<string> {
  const result = await issueCustomerInvoice(null, form(fields));
  expect(result.ok, `expected a refusal, the action returned ${JSON.stringify(result)}`).toBe(
    false,
  );
  return String((result as { error: string }).error);
}

/**
 * Issues, and returns where the action sent the browser.
 *
 * A success never returns a value -- it redirects, which signals by throwing --
 * so anything that comes back from the call is a refusal the test did not
 * expect, and it is reported rather than swallowed.
 */
async function issued(fields: Record<string, string>): Promise<string> {
  let result: unknown;
  try {
    result = await issueCustomerInvoice(null, form(fields));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redirected = /^NEXT_REDIRECT (.+)$/.exec(message);
    if (!redirected) throw error;
    return redirected[1]!;
  }
  throw new Error(`expected the invoice to be issued, the action returned ${JSON.stringify(result)}`);
}

async function invoiceRows(projectId: string) {
  return db
    .select()
    .from(customerInvoices)
    .where(eq(customerInvoices.projectId, projectId))
    .orderBy(desc(customerInvoices.invoiceNumber));
}

/** An accepted, active quote is what makes a project a job. */
async function acceptContract(projectId: string, sequence = 1): Promise<string> {
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
      subtotalCents: CONTRACT_CENTS,
      taxTotalCents: 0,
      totalCents: CONTRACT_CENTS,
      holdbackPctTenThou: HOLDBACK_10,
    })
    .returning();
  return quote!.id;
}

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, stage_history, holdback_ledger, customer_invoice_taxes,
    customer_invoice_lines, customer_invoices, quote_taxes, quote_lines, quotes,
    scope_template_items, scope_templates, rate_items, cost_codes, tax_rates,
    projects, customers, users, organization, companies, document_sequences
    restart identity cascade
  `);

  await seedDeployment({
    id: 1,
    legalName: 'Test Company Ltd',
    displayName: 'Test Company',
    timezone: 'America/Toronto',
    defaultHoldbackPctTenThou: HOLDBACK_10,
    // Excise Tax Act s.168(7). Flipped off in its own block below, because a
    // jurisdiction without the deferral must still bill correctly.
    taxDeferredOnHoldback: true,
    holdbackReleaseDays: 60,
    paymentTermsDays: 28,
  });

  // The action is guarded, so the identity in the mocked header has to resolve
  // to a real active user with a role that carries `quote:write`.
  await db.insert(users).values({
    email: 'owner@example.invalid',
    displayName: 'Test Owner',
    role: 'owner',
    isActive: true,
  });

  await db.insert(taxRates).values({ companyId: FIRST_COMPANY_ID,
    label: 'Sales tax',
    rateTenThou: TAX_13,
    effectiveFrom: '2010-07-01',
    sortOrder: 1,
  });

  const [customer] = await db
    .insert(customers)
    .values({ name: 'Sample Client', customerType: 'residential' })
    .returning();

  const [job] = await db
    .insert(projects)
    .values({ companyId: FIRST_COMPANY_ID,
      customerId: customer!.id,
      projectNumber: 'P-0001',
      name: 'Work under contract',
      projectTypeId: PROJECT_TYPE_IDS.basement,
      stage: 'in_progress',
    })
    .returning();
  jobId = job!.id;
  await acceptContract(jobId);

  const [opportunity] = await db
    .insert(projects)
    .values({ companyId: FIRST_COMPANY_ID,
      customerId: customer!.id,
      projectNumber: 'P-0002',
      name: 'Nothing won yet',
      projectTypeId: PROJECT_TYPE_IDS.basement,
      stage: 'quote_sent',
    })
    .returning();
  opportunityId = opportunity!.id;
});

/* -------------------------------------------------------------------------
   The percentage
   ------------------------------------------------------------------------- */

/**
 * A percent complete is a measurement of work against a contract, so it cannot
 * exceed the contract. The form narrows what can be typed, but a form is a
 * hint: a stale tab and a hand-made POST both arrive at the action, which is
 * why the refusal is asserted there.
 *
 * A draw at 150% is not a rounding complaint. It prices cleanly, stores
 * cleanly and reads as internally consistent all the way to the customer --
 * an invoice for work nobody agreed to, on a contract that is the only thing
 * that says so.
 */
describe('the percentage a draw is billed at', () => {
  it('refuses 150%, which would bill work no customer accepted', async () => {
    const message = await refusal({
      projectId: jobId,
      kind: 'progress',
      percent: '150',
      issueDate: ISSUE,
    });
    expect(message).toMatch(/0 to 100/i);
    expect(await invoiceRows(jobId)).toEqual([]);
  });

  it('refuses a negative percentage', async () => {
    const message = await refusal({
      projectId: jobId,
      kind: 'progress',
      percent: '-10',
      issueDate: ISSUE,
    });
    expect(message).toMatch(/0 to 100/i);
    expect(await invoiceRows(jobId)).toEqual([]);
  });

  it('refuses a figure finer than the column can hold, rather than rounding it', async () => {
    // Rounding 45.555 to 45.56 would bill a percentage nobody typed and store
    // it as if they had.
    const message = await refusal({
      projectId: jobId,
      kind: 'progress',
      percent: '45.555',
      issueDate: ISSUE,
    });
    expect(message).toMatch(/two decimal places/i);
    expect(await invoiceRows(jobId)).toEqual([]);
  });

  it('refuses something that is not a number at all', async () => {
    const message = await refusal({
      projectId: jobId,
      kind: 'progress',
      percent: 'half done',
      issueDate: ISSUE,
    });
    expect(message).toMatch(/not a percentage/i);
  });

  it('burns no invoice number on a refusal', async () => {
    // The number is allocated inside the writing transaction, after every
    // refusal, so a rejected draw must leave the series untouched: a gap is
    // what an auditor asks about.
    await refusal({ projectId: jobId, kind: 'progress', percent: '150', issueDate: ISSUE });
    await refusal({ projectId: jobId, kind: 'progress', percent: '150', issueDate: ISSUE });

    await issued({ projectId: jobId, kind: 'progress', percent: '45', issueDate: ISSUE });

    const [row] = await invoiceRows(jobId);
    expect(row!.invoiceNumber).toBe('INV-2026-0001');
    expect(await db.select().from(documentSequences)).toHaveLength(1);
  });

  it('bills a percentage it accepts, to the ten-thousandth', async () => {
    await issued({ projectId: jobId, kind: 'progress', percent: '45.25', issueDate: ISSUE });
    const [row] = await invoiceRows(jobId);
    // 45.25% is 4525 ten-thousandths. Held as an integer the whole way, never
    // as 45.25 * 100 -- which is 4524.999999999999 in a double.
    expect(row!.percentCompleteTenThou).toBe(4525n);
    expect(row!.subtotalCents).toBe(4_525_000);
  });

  it('bills the contract to 100% when the invoice is a final, whatever the box said', async () => {
    // The screen ignores the typed percentage for a final, and so does the
    // action: a final that leaves the contract part-billed is a mislabelled
    // progress invoice, and the label is what the release clock reads.
    await issued({ projectId: jobId, kind: 'final', percent: '45', issueDate: ISSUE });
    const [row] = await invoiceRows(jobId);
    expect(row!.kind).toBe('final');
    expect(row!.percentCompleteTenThou).toBe(10000n);
    expect(row!.subtotalCents).toBe(CONTRACT_CENTS);
  });

  it('refuses a kind this screen does not collect the figures for', async () => {
    // A deposit needs an amount and a holdback release needs a balance, and
    // neither is on this form. Accepting the kind from a hand-made POST would
    // issue one with whatever the form did carry.
    const message = await refusal({
      projectId: jobId,
      kind: 'deposit',
      percent: '45',
      issueDate: ISSUE,
    });
    expect(message).toMatch(/choose what you are billing/i);
    expect(await invoiceRows(jobId)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   The holdback, and what it is taxed on
   ------------------------------------------------------------------------- */

/**
 * Excise Tax Act s.168(7): where a holdback is retained under provincial
 * legislation or a written construction contract, tax on the held-back amount
 * is not payable until the holdback is paid out or is required to be paid out.
 *
 * So a progress invoice taxes (draw - holdback). Taxing the whole draw is the
 * intuitive version and it is wrong for Canada; it over-collects on every
 * draw, by an amount too small on any single invoice for anyone to query.
 */
describe('the taxable base of a progress draw', () => {
  it('taxes the draw less the holdback, not the draw', async () => {
    await issued({ projectId: jobId, kind: 'progress', percent: '45', issueDate: ISSUE });
    const [row] = await invoiceRows(jobId);

    expect(row!.subtotalCents).toBe(DRAW_45);
    expect(row!.holdbackCents).toBe(HOLDBACK_ON_DRAW_45);
    expect(row!.taxableBaseCents).toBe(DEFERRED_BASE);
    expect(row!.taxTotalCents).toBe(TAX_ON_DEFERRED_BASE);
    // Named explicitly, because this is the figure a "simplification" of the
    // tax module would produce and every other assertion here would still pass.
    expect(row!.taxTotalCents).not.toBe(TAX_ON_WHOLE_DRAW);
  });

  it('carries the withholding to the total rather than to the tax alone', async () => {
    await issued({ projectId: jobId, kind: 'progress', percent: '45', issueDate: ISSUE });
    const [row] = await invoiceRows(jobId);
    expect(row!.totalCents).toBe(DRAW_45 - HOLDBACK_ON_DRAW_45 + TAX_ON_DEFERRED_BASE);
    expect(row!.amountDueCents).toBe(row!.totalCents);
  });

  it('snapshots the deferral and the withholding rate the invoice was billed under', async () => {
    // Flipping the organization setting mid-job must not rewrite the tax
    // treatment of an invoice already in a customer's hands.
    await issued({ projectId: jobId, kind: 'progress', percent: '45', issueDate: ISSUE });
    const [row] = await invoiceRows(jobId);
    expect(row!.taxDeferredOnHoldback).toBe(true);
    expect(row!.holdbackPctTenThou).toBe(HOLDBACK_10);
  });

  it('keeps the holdback cumulative across draws, so the second re-withholds nothing', async () => {
    await issued({ projectId: jobId, kind: 'progress', percent: '45', issueDate: ISSUE });
    await issued({ projectId: jobId, kind: 'progress', percent: '70', issueDate: ISSUE });

    const rows = await invoiceRows(jobId);
    const second = rows.find((row) => row.invoiceNumber === 'INV-2026-0002')!;
    // 70% of the contract less the 45% already billed.
    expect(second.subtotalCents).toBe(2_500_000);
    expect(second.holdbackCents).toBe(250_000);
    expect(second.taxableBaseCents).toBe(2_250_000);
    // The two draws hold exactly 10% of what has been billed, not 10% of one
    // draw plus 10% of the sum.
    const withheld = rows.reduce((sum, row) => sum + row.holdbackCents, 0);
    expect(withheld).toBe(700_000);
  });

  it('taxes the whole draw where the tenant defers no tax on holdback', async () => {
    // The deferral is a setting, not a constant: a jurisdiction without it
    // must still bill correctly, and this is what proves the flag switches the
    // base rather than the base being hardcoded either way.
    // On the COMPANY: the deferral belongs to the registrant issuing the
    // invoice, not to the deployment they happen to share.
    await db.update(companies).set({ taxDeferredOnHoldback: false })
      .where(eq(companies.id, FIRST_COMPANY_ID));

    await issued({ projectId: jobId, kind: 'progress', percent: '45', issueDate: ISSUE });
    const [row] = await invoiceRows(jobId);

    expect(row!.holdbackCents).toBe(HOLDBACK_ON_DRAW_45);
    expect(row!.taxableBaseCents).toBe(DRAW_45);
    expect(row!.taxTotalCents).toBe(TAX_ON_WHOLE_DRAW);
  });
});

/* -------------------------------------------------------------------------
   What may be invoiced at all
   ------------------------------------------------------------------------- */

/**
 * A job is a project with an accepted quote behind it. There is no `jobs`
 * table and no column saying so: the accepted, active quotes ARE the contract,
 * and their subtotals are the figure a percentage is taken of.
 *
 * The rule is therefore derived on every request rather than read off the
 * stage column, which can say `won` on a record with nothing accepted behind
 * it.
 */
describe('only a job can be invoiced', () => {
  it('refuses an opportunity with nothing accepted on it', async () => {
    const message = await refusal({
      projectId: opportunityId,
      kind: 'progress',
      percent: '45',
      issueDate: ISSUE,
    });
    expect(message).toMatch(/opportunity/i);
    expect(message).toMatch(/accept a quote/i);
    expect(await invoiceRows(opportunityId)).toEqual([]);
  });

  it('refuses an opportunity whose quote has only been sent', async () => {
    await db.insert(quotes).values({
      projectId: opportunityId,
      quoteNumber: 'QT-2026-0009',
      kind: 'estimate',
      sequence: 1,
      version: 1,
      status: 'sent',
      quoteDate: '2026-08-01',
      validUntil: '2026-09-30',
      subtotalCents: CONTRACT_CENTS,
      totalCents: CONTRACT_CENTS,
      holdbackPctTenThou: HOLDBACK_10,
    });

    const message = await refusal({
      projectId: opportunityId,
      kind: 'progress',
      percent: '45',
      issueDate: ISSUE,
    });
    expect(message).toMatch(/opportunity/i);
  });

  it('refuses a record parked at won with nothing accepted behind it', async () => {
    // The incoherent state a stage set by hand used to produce. The stage
    // column is not what makes a job, so it must not be what unlocks billing.
    await db.update(projects).set({ stage: 'won' }).where(eq(projects.id, opportunityId));

    const message = await refusal({
      projectId: opportunityId,
      kind: 'progress',
      percent: '45',
      issueDate: ISSUE,
    });
    expect(message).toMatch(/opportunity/i);
  });

  it('stops being billable once the accepted quote is voided', async () => {
    // Voided rather than deleted: the application role holds no DELETE
    // privilege, so a delete here would fail for a reason that has nothing to
    // do with what is being asserted.
    await db
      .update(quotes)
      .set({ recordStatus: 'void', voidReason: 'Accepted in error' })
      .where(eq(quotes.projectId, jobId));

    const message = await refusal({
      projectId: jobId,
      kind: 'progress',
      percent: '45',
      issueDate: ISSUE,
    });
    expect(message).toMatch(/opportunity/i);
    expect(await invoiceRows(jobId)).toEqual([]);
  });

  it('refuses a void job', async () => {
    await db
      .update(projects)
      .set({ recordStatus: 'void', voidReason: 'Booked twice' })
      .where(eq(projects.id, jobId));

    const message = await refusal({
      projectId: jobId,
      kind: 'progress',
      percent: '45',
      issueDate: ISSUE,
    });
    expect(message).toMatch(/void/i);
    expect(await invoiceRows(jobId)).toEqual([]);
  });

  it('refuses a job that no longer exists', async () => {
    const message = await refusal({
      projectId: '00000000-0000-4000-8000-000000000000',
      kind: 'progress',
      percent: '45',
      issueDate: ISSUE,
    });
    expect(message).toMatch(/no longer exists/i);
  });

  it('refuses an id that is not a job id at all', async () => {
    const message = await refusal({
      projectId: 'not-a-uuid',
      kind: 'progress',
      percent: '45',
      issueDate: ISSUE,
    });
    expect(message).toMatch(/not valid/i);
  });
});

/* -------------------------------------------------------------------------
   The document
   ------------------------------------------------------------------------- */

describe('the invoice the action writes', () => {
  it('lands as a draft unless the box was ticked, and never as paid', async () => {
    await issued({ projectId: jobId, kind: 'progress', percent: '45', issueDate: ISSUE });
    const [draft] = await invoiceRows(jobId);
    expect(draft!.status).toBe('draft');
    expect(draft!.sentAt).toBeNull();

    await issued({
      projectId: jobId,
      kind: 'progress',
      percent: '70',
      issueDate: ISSUE,
      markSent: '1',
    });
    const rows = await invoiceRows(jobId);
    const sent = rows.find((row) => row.invoiceNumber === 'INV-2026-0002')!;
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).not.toBeNull();
  });

  it('sends the browser back to the billing screen naming the number it wrote', async () => {
    const destination = await issued({
      projectId: jobId,
      kind: 'progress',
      percent: '45',
      issueDate: ISSUE,
    });
    expect(destination).toBe(`/projects/${jobId}/billing?issued=INV-2026-0001`);
  });

  it('refuses a date that is not one, because the date decides which rates applied', async () => {
    const message = await refusal({
      projectId: jobId,
      kind: 'progress',
      percent: '45',
      issueDate: 'last Tuesday',
    });
    expect(message).toMatch(/not a date/i);
    expect(await invoiceRows(jobId)).toEqual([]);
  });
});
