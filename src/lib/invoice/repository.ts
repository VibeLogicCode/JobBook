import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  customerInvoiceLines, customerInvoiceTaxes, customerInvoices, holdbackLedger, organization,
  projects, quotes,
} from '@/db/schema';
import { computeInvoice, CONTRACT_BILLING_KINDS } from '@/lib/invoice/compute';
import { holdbackReleaseEligibleDate } from '@/lib/invoice/holdback';
import { assertPercentTenThou } from '@/lib/invoice/progress';
import type { ComputedInvoice, InvoiceKind, JobBillingState } from '@/lib/invoice/types';
import { addDays, tenantToday, yearOf } from '@/lib/quote/dates';
import { computeLine } from '@/lib/quote/lines';
import { allocateDocumentNumber } from '@/lib/quote/numbering';
import { loadTaxRatesFor } from '@/lib/quote/rates';
import { customerExemptFor, type Tx } from '@/lib/quote/repository';
import type { CalcMode } from '@/lib/quote/types';
import { contractSubtotalCents } from '@/lib/quote/repository';

/**
 * Persistence for customer invoicing.
 *
 * This module does no arithmetic. `computeInvoice` in lib/invoice/compute.ts is
 * the authority on every figure -- it is pure and separately tested -- and this
 * file's job is to assemble the state it needs, store what it returns, and
 * derive the state back out of the stored rows. Recomputing anything here would
 * put a second implementation of progress billing in the codebase, and the two
 * would disagree about a cent on the first contract that does not divide evenly.
 *
 * Everything runs in one transaction, reads included, for the reasons
 * quote/repository.ts gives: the invoice number is allocated inside it so an
 * abandoned invoice does not burn one, and the tax rates the invoice snapshots
 * are the rates that existed at the instant it was priced.
 */

/** A line on the document. Description, not arithmetic; see the schema comment. */
export interface InvoiceLineInput {
  description: string;
  /**
   * 'percent' is absent, and the schema refuses it. A percent line takes a
   * share of a line base, and an invoice has none: its amount comes from the
   * contract and the percent complete, which is a different percentage
   * entirely.
   */
  calcMode: Exclude<CalcMode, 'percent'>;
  /** Integer thousandths. Ignored when calcMode is 'flat', exactly as on a quote line. */
  qtyMilli: bigint;
  unitPriceTenThou: bigint;
  code?: string;
  lineGroup?: string;
  unitLabel?: string;
  isTaxable?: boolean;
  costCodeId?: string | null;
  /** Provenance. A change-order line is a quote line too; see the schema comment. */
  sourceQuoteLineId?: string | null;
  notes?: string;
}

export interface IssueInvoiceArgs {
  projectId: string;
  kind: InvoiceKind;
  /** Defaults to the tenant's today. Decides which tax rates applied. */
  issueDate?: string;
  /** Ten-thousandths. Required for 'progress' and 'final', refused otherwise. */
  percentCompleteTenThou?: bigint;
  /** Cents, exclusive of tax. Required for 'deposit' and 'change_order'. */
  amountCents?: number;
  /** Requested drawdown against the customer's advances. Clamped by the engine. */
  depositApplyCents?: number;
  /** 'holdback_release' only. Defaults to the whole outstanding balance. */
  releaseHoldbackCents?: number;
  periodFrom?: string;
  periodTo?: string;
  lines?: InvoiceLineInput[];
  notes?: string;
  /**
   * 'sent' stamps `sent_at`. Nothing here ever writes 'partial' or 'paid':
   * spec 4.5 derives those from the sum of an invoice's payments, and a status
   * set by hand would be the figure that disagrees with them.
   */
  status?: 'draft' | 'sent';
  createdBy?: string;
}

export interface IssuedInvoice {
  invoiceId: string;
  invoiceNumber: string;
  /** What the engine priced, `nextState` included, so a caller can chain draws. */
  computed: ComputedInvoice;
}

/** The accepted, active quotes on a project, read as a contract. */
interface Contract {
  /**
   * PRE-TAX, and that is the whole point of reading it here rather than calling
   * `contractValueCents`.
   *
   * Progress billing multiplies this by the percent complete and then charges
   * tax on the result. Handed the tax-inclusive figure it charges tax on tax,
   * once per draw -- roughly $1,690 over a $100,000 contract at 13%, spread
   * thinly enough that no single invoice looks wrong. See the two functions in
   * quote/repository.ts, which exist as a pair for exactly this reason.
   */
  subtotalCents: number;
  /**
   * The withholding rate the contract was signed at, not the organization
   * default, which may have moved since.
   */
  holdbackPctTenThou: bigint;
  quoteCount: number;
}

/**
 * The contract, from the quotes that make it up.
 *
 * A transaction-scoped read, which is why it does not call
 * `contractSubtotalCents` in quote/repository.ts: that function takes no `tx`
 * and runs on its own connection, so an invoice issued against it could price
 * itself from a contract another transaction was still changing. The query is
 * the same one; see the note in the report about giving that function a `tx`
 * parameter so this can call it.
 */
async function contractOf(tx: Tx, projectId: string): Promise<Contract> {
  // The MONEY comes from `contractSubtotalCents`, which is the one definition
  // of what a job's contract is worth before tax, so an invoice can never bill
  // against a different figure than the job screen reports. Only the holdback
  // rates are read here, because that is the part this query needs and the
  // shared function does not carry.
  const subtotalCents = await contractSubtotalCents(projectId, tx);

  const rows = await tx
    .select({ holdbackPct: quotes.holdbackPctTenThou })
    .from(quotes)
    .where(
      and(
        eq(quotes.projectId, projectId),
        eq(quotes.status, 'accepted'),
        eq(quotes.recordStatus, 'active'),
      ),
    );

  // A project carries more than one accepted quote -- competing estimates both
  // won, plus every accepted change order -- and they must agree on the
  // withholding rate, because the holdback accrues against their combined
  // value. Two rates would make the accrued balance depend on which row was
  // read first.
  const rates = [...new Set(rows.flatMap((row) => (row.holdbackPct === null ? [] : [row.holdbackPct])))];
  if (rates.length > 1) {
    throw new Error(
      `the accepted quotes on this project disagree about the holdback rate (${rates.join(', ')} ten-thousandths): correct them before invoicing`,
    );
  }

  return {
    subtotalCents,
    // Absent means the contract withholds nothing. Falling back to the
    // organization default here would apply today's setting to a contract
    // signed under another one, which is the mistake the per-quote column
    // exists to prevent.
    holdbackPctTenThou: rates[0] ?? 0n,
    quoteCount: rows.length,
  };
}

/**
 * The job's billing state, summed from the invoices that have been issued.
 *
 * DERIVED, never stored. A `projects.billed_to_date` column would be a second
 * source of truth that disagrees with these rows the first time an invoice is
 * voided -- the same reason there is no stored contract value (spec 4.1) -- and
 * the disagreement surfaces as a job that bills 110% of itself or stops short.
 * Voiding therefore reverses an invoice's effect for free: a void row leaves
 * the sum.
 *
 * The four figures are defined to match `JobBillingState` exactly, because the
 * engine's arithmetic assumes those definitions and a mismatch here would be
 * invisible until a whole schedule of draws failed to land on the contract.
 */
export async function deriveBillingState(
  tx: Tx,
  projectId: string,
  contractValueCents: number,
): Promise<JobBillingState> {
  const rows = await tx
    .select({
      kind: customerInvoices.kind,
      subtotalCents: customerInvoices.subtotalCents,
      holdbackCents: customerInvoices.holdbackCents,
      holdbackReleasedCents: customerInvoices.holdbackReleasedCents,
      depositAppliedCents: customerInvoices.depositAppliedCents,
    })
    .from(customerInvoices)
    .where(
      and(
        eq(customerInvoices.projectId, projectId),
        eq(customerInvoices.recordStatus, 'active'),
      ),
    );

  const state: JobBillingState = {
    contractValueCents,
    previouslyBilledCents: 0,
    holdbackAccruedCents: 0,
    holdbackReleasedCents: 0,
    depositHeldCents: 0,
  };

  for (const row of rows) {
    // GROSS of holdback: `subtotal_cents` is the work billed before the
    // withholding comes off. Summing the post-holdback figure instead would
    // make every draw re-bill the withholding of the one before it, and the
    // error compounds down the schedule.
    //
    // Deposits are EXCLUDED. A deposit is an advance, not a measurement of
    // work; counting it here as well as drawing it down against a later draw
    // would credit the customer for the same money twice. The kinds that move
    // this figure come from the engine's own list rather than a second copy of
    // it here.
    if (CONTRACT_BILLING_KINDS.includes(row.kind)) {
      state.previouslyBilledCents += row.subtotalCents;
    }

    // `holdback_cents` is signed and nets the release out of the accrual, so
    // the accrual is recovered by adding the release back. Without the separate
    // `holdback_released_cents` column the two would be indistinguishable and
    // a release would read as work that was never done.
    state.holdbackAccruedCents += row.holdbackCents + row.holdbackReleasedCents;
    state.holdbackReleasedCents += row.holdbackReleasedCents;

    state.depositHeldCents +=
      (row.kind === 'deposit' ? row.subtotalCents : 0) - row.depositAppliedCents;
  }

  return state;
}

/** The billing state a screen or a report reads. */
export async function jobBillingState(projectId: string): Promise<JobBillingState> {
  // One transaction for a read of two tables: outside one, an invoice being
  // issued concurrently is visible in `customer_invoices` while the quote it
  // was priced against is not yet, and the state comes back internally
  // inconsistent.
  return db.transaction(async (tx) => {
    const contract = await contractOf(tx, projectId);
    return deriveBillingState(tx, projectId, contract.subtotalCents);
  });
}

/**
 * Issues an invoice against a job.
 *
 * The document number is allocated inside the transaction, so an invoice that
 * fails a refusal below does not burn one; the tax rows are a snapshot taken
 * against the issue date and never re-resolved, so a rate change cannot rewrite
 * an invoice already in a customer's hands; and the holdback ledger entries are
 * written from the same figures in the same transaction, so they cannot drift
 * from the invoice that caused them.
 */
export async function issueInvoice(args: IssueInvoiceArgs): Promise<IssuedInvoice> {
  return db.transaction(async (tx) => {
    const [org] = await tx.select().from(organization).where(eq(organization.id, 1));
    if (!org) throw new Error('organization row is missing; run setup first');

    const [project] = await tx.select().from(projects).where(eq(projects.id, args.projectId));
    if (!project) throw new Error(`project ${args.projectId} not found`);
    if (project.recordStatus !== 'active') {
      throw new Error('a void project cannot be invoiced');
    }

    const contract = await contractOf(tx, args.projectId);
    if (contract.quoteCount === 0) {
      // There is nothing to bill against. Progress billing would multiply a
      // contract value of zero and produce a $0 invoice that looks issued and
      // settles nothing, which is worse than a refusal because it consumes a
      // number and appears on the AR aging at zero.
      throw new Error(
        'this project has no accepted quote, so there is no contract to bill: accept a quote first',
      );
    }

    // The completion percentage is bounded HERE because computeInvoice does not
    // bound it: it calls `earnedToDateCents` directly, and the only function
    // that asserts the range -- `progressAmountCents` -- is not on its path. A
    // draw at 110% would otherwise price and store cleanly, billing work no
    // customer had accepted while leaving the contract untouched, and the
    // arithmetic would be internally consistent all the way to the customer.
    // Billing past the contract needs a change order that raises the contract.
    if (args.percentCompleteTenThou !== undefined) {
      assertPercentTenThou(args.percentCompleteTenThou, 'percent complete');
    }

    const issueDate = args.issueDate ?? (await tenantToday(tx));
    const state = await deriveBillingState(tx, args.projectId, contract.subtotalCents);

    const computed = computeInvoice(
      state,
      {
        kind: args.kind,
        issueDate,
        percentCompleteTenThou: args.percentCompleteTenThou,
        amountCents: args.amountCents,
        holdbackPctTenThou: contract.holdbackPctTenThou,
        depositApplyCents: args.depositApplyCents,
        releaseHoldbackCents: args.releaseHoldbackCents,
      },
      await loadTaxRatesFor(tx),
      {
        taxDeferredOnHoldback: org.taxDeferredOnHoldback,
        customerExempt: await customerExemptFor(tx, args.projectId),
      },
    );

    // The invariant the whole derivation rests on: the draws sum to the
    // contract. The percentage path cannot break it once the bound above holds,
    // but VOIDING AN ACCEPTED QUOTE can -- the contract shrinks while the
    // invoices that billed the old one stand -- and every kind is then billing
    // against a contract smaller than what has already gone out. Refused rather
    // than absorbed, because the fix is a change order that restores the
    // contract value and only the owner knows which one.
    if (computed.nextState.previouslyBilledCents > contract.subtotalCents) {
      throw new Error(
        `this job has billed ${computed.nextState.previouslyBilledCents} cents against a contract of ${contract.subtotalCents}: accept a change order to raise the contract before invoicing again`,
      );
    }

    const invoiceNumber = await allocateDocumentNumber(tx, 'invoice', yearOf(issueDate));
    const status = args.status ?? 'draft';

    const [invoice] = await tx
      .insert(customerInvoices)
      .values({
        projectId: args.projectId,
        invoiceNumber,
        kind: computed.kind,
        status,
        sentAt: status === 'sent' ? new Date() : null,
        issueDate,
        // Null when the tenant has not configured terms, rather than an
        // invented number: the statutory period differs by jurisdiction and the
        // product is white-label.
        dueDate:
          org.paymentTermsDays === null ? null : addDays(issueDate, org.paymentTermsDays),
        periodFrom: args.periodFrom ?? null,
        periodTo: args.periodTo ?? null,
        subtotalCents: computed.subtotalCents,
        taxTotalCents: computed.taxTotalCents,
        holdbackCents: computed.holdbackCents,
        holdbackReleasedCents: computed.holdbackReleasedCents,
        depositAppliedCents: computed.depositAppliedCents,
        taxableBaseCents: computed.taxableBaseCents,
        totalCents: computed.totalCents,
        amountDueCents: computed.amountDueCents,
        contractValueAtInvoiceCents: computed.contractValueAtInvoiceCents,
        percentCompleteTenThou: computed.percentCompleteTenThou,
        previouslyBilledCents: computed.previouslyBilledCents,
        holdbackPctTenThou: contract.holdbackPctTenThou,
        taxDeferredOnHoldback: org.taxDeferredOnHoldback,
        notes: args.notes ?? null,
        createdBy: args.createdBy,
      })
      .returning();

    await writeLines(tx, invoice!.id, args.lines ?? [], args.createdBy);
    await writeTaxes(tx, invoice!.id, computed, args.createdBy);
    await writeHoldbackEntries(tx, {
      invoiceId: invoice!.id,
      projectId: args.projectId,
      customerId: project.customerId,
      computed,
      releaseEligibleDate:
        project.substantialPerformanceDate === null
          ? null
          : holdbackReleaseEligibleDate(
              project.substantialPerformanceDate,
              org.holdbackReleaseDays,
            ),
      createdBy: args.createdBy,
    });

    return { invoiceId: invoice!.id, invoiceNumber, computed };
  });
}

async function writeLines(
  tx: Tx,
  invoiceId: string,
  lines: InvoiceLineInput[],
  createdBy?: string,
): Promise<void> {
  if (lines.length === 0) return;

  await tx.insert(customerInvoiceLines).values(
    lines.map((line, index) => {
      // Priced through the quote engine's own line function rather than a
      // second copy of the formula. The 'flat' clamp is the reason: it forces a
      // quantity of one so a stray qtyMilli left on a permit fee cannot
      // silently multiply it, and a reimplementation here would lose that the
      // first time somebody simplified it. The cost half of the result is
      // discarded -- an invoice is a billing document and spec 4.3 keeps cost
      // out of it.
      const priced = computeLine({
        code: line.code ?? '',
        description: line.description,
        lineGroup: line.lineGroup ?? '',
        sortOrder: index + 1,
        calcMode: line.calcMode,
        unitLabel: line.unitLabel ?? '',
        qtyMilli: line.qtyMilli,
        unitCostTenThou: 0n,
        unitPriceTenThou: line.unitPriceTenThou,
        isTaxable: line.isTaxable ?? true,
        isOptional: false,
        isIncluded: true,
        isAllowance: false,
        rateItemId: null,
        costCodeId: line.costCodeId ?? null,
      });

      return {
        invoiceId,
        sortOrder: index + 1,
        lineGroup: line.lineGroup ?? '',
        code: line.code ?? '',
        description: line.description,
        calcMode: line.calcMode,
        unitLabel: line.unitLabel ?? '',
        costCodeId: line.costCodeId ?? null,
        sourceQuoteLineId: line.sourceQuoteLineId ?? null,
        qtyMilli: line.qtyMilli,
        unitPriceTenThou: line.unitPriceTenThou,
        lineTotalCents: priced.lineTotalCents,
        isTaxable: line.isTaxable ?? true,
        notes: line.notes ?? null,
        createdBy,
      };
    }),
  );
}

/**
 * The tax snapshot, written even when it is empty.
 *
 * Rows are what the engine resolved against the issue date, stored with the
 * base each rate was charged on, so the document reconciles years later without
 * re-running anything against whatever the rates say then -- the same rule as
 * `quote_taxes`. An exempt customer or a period with no rate in force yields no
 * rows at all, which is why `customer_invoices.taxable_base_cents` carries the
 * base as well.
 */
async function writeTaxes(
  tx: Tx,
  invoiceId: string,
  computed: ComputedInvoice,
  createdBy?: string,
): Promise<void> {
  if (computed.taxes.length === 0) return;

  await tx.insert(customerInvoiceTaxes).values(
    computed.taxes.map((tax, index) => ({
      invoiceId,
      label: tax.label,
      registrationNumber: tax.registrationNumber,
      rateTenThou: tax.rateTenThou,
      taxableBaseCents: tax.taxableBaseCents,
      taxAmountCents: tax.taxAmountCents,
      sortOrder: index,
      createdBy,
    })),
  );
}

/**
 * The ledger entries this invoice causes: at most one accrual and one release.
 *
 * One row per event, each naming its own invoice, which is how both sides of a
 * holdback are expressible at all -- see the note on `holdbackLedger`. A
 * progress invoice writes an accrual; a release invoice writes a release; a
 * corrective draw whose percent went backwards writes an accrual of a NEGATIVE
 * amount, because no money moved and calling that a release would report a
 * payout that never happened.
 *
 * Zero-amount accruals are skipped. A deposit invoice and a release invoice
 * both leave the work billed to date where it was, so both accrue nothing, and
 * a row saying so would be a row the release-eligibility report has to filter.
 */
async function writeHoldbackEntries(
  tx: Tx,
  args: {
    invoiceId: string;
    projectId: string;
    customerId: string;
    computed: ComputedInvoice;
    releaseEligibleDate: string | null;
    createdBy?: string;
  },
): Promise<void> {
  const accruedCents = args.computed.holdbackCents + args.computed.holdbackReleasedCents;
  const releasedCents = args.computed.holdbackReleasedCents;

  const common = {
    projectId: args.projectId,
    // Receivable: money we have earned and cannot yet collect. It must stay a
    // separate AR bucket, because folded into ordinary AR it overstates
    // available cash by the withholding on every active job at once.
    direction: 'receivable' as const,
    counterpartyType: 'customer' as const,
    counterpartyId: args.customerId,
    invoiceId: args.invoiceId,
    releaseEligibleDate: args.releaseEligibleDate,
    createdBy: args.createdBy,
  };

  if (accruedCents !== 0) {
    await tx.insert(holdbackLedger).values({ ...common, entryKind: 'accrual', accruedCents });
  }
  if (releasedCents !== 0) {
    await tx
      .insert(holdbackLedger)
      .values({ ...common, entryKind: 'release', releasedCents, releasedAt: new Date() });
  }
}

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  kind: InvoiceKind;
  status: 'draft' | 'sent' | 'partial' | 'paid';
  issueDate: string;
  dueDate: string | null;
  subtotalCents: number;
  holdbackCents: number;
  taxTotalCents: number;
  totalCents: number;
  amountDueCents: number;
  percentCompleteTenThou: bigint | null;
  /** 'void' rows are listed; see the note on the function. */
  recordStatus: 'active' | 'void';
  voidReason: string | null;
}

/**
 * A job's invoices, newest first, INCLUDING the voided ones.
 *
 * Voided invoices are listed rather than filtered because the number series has
 * no gaps that a reader can otherwise explain: a jump from INV-2026-0003 to
 * INV-2026-0005 reads as lost data, and the row that explains it carries the
 * reason somebody typed. They contribute nothing to the derived state, which is
 * what `record_status` on each row lets a caller show.
 */
export async function listProjectInvoices(projectId: string): Promise<InvoiceSummary[]> {
  const rows = await db
    .select()
    .from(customerInvoices)
    .where(eq(customerInvoices.projectId, projectId))
    .orderBy(desc(customerInvoices.issueDate), desc(customerInvoices.invoiceNumber));

  return rows.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    kind: row.kind,
    status: row.status,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    subtotalCents: row.subtotalCents,
    holdbackCents: row.holdbackCents,
    taxTotalCents: row.taxTotalCents,
    totalCents: row.totalCents,
    amountDueCents: row.amountDueCents,
    percentCompleteTenThou: row.percentCompleteTenThou,
    recordStatus: row.recordStatus,
    voidReason: row.voidReason,
  }));
}

export interface LoadedInvoice {
  invoice: typeof customerInvoices.$inferSelect;
  lines: (typeof customerInvoiceLines.$inferSelect)[];
  taxes: (typeof customerInvoiceTaxes.$inferSelect)[];
  /** The holdback this invoice moved, as the ledger recorded it. */
  holdback: (typeof holdbackLedger.$inferSelect)[];
}

/**
 * One invoice, as the document says it.
 *
 * The stored figures are returned untouched and nothing is recomputed. A
 * display value derived from today's rates would make the screen and the paper
 * the customer holds disagree, which is the failure the whole snapshot rule
 * exists to prevent.
 */
export async function loadInvoice(invoiceId: string): Promise<LoadedInvoice | null> {
  const [invoice] = await db
    .select()
    .from(customerInvoices)
    .where(eq(customerInvoices.id, invoiceId));
  if (!invoice) return null;

  const [lines, taxes, holdback] = await Promise.all([
    db
      .select()
      .from(customerInvoiceLines)
      .where(
        and(
          eq(customerInvoiceLines.invoiceId, invoiceId),
          eq(customerInvoiceLines.recordStatus, 'active'),
        ),
      )
      .orderBy(asc(customerInvoiceLines.sortOrder)),
    db
      .select()
      .from(customerInvoiceTaxes)
      .where(
        and(
          eq(customerInvoiceTaxes.invoiceId, invoiceId),
          eq(customerInvoiceTaxes.recordStatus, 'active'),
        ),
      )
      .orderBy(asc(customerInvoiceTaxes.sortOrder)),
    db
      .select()
      .from(holdbackLedger)
      .where(
        and(eq(holdbackLedger.invoiceId, invoiceId), eq(holdbackLedger.recordStatus, 'active')),
      )
      .orderBy(asc(holdbackLedger.createdAt)),
  ]);

  return { invoice, lines, taxes, holdback };
}

/**
 * Voids an invoice. Nothing is ever deleted, and a reason is mandatory.
 *
 * Voiding is how an invoice's effect on the job is REVERSED: the billing state
 * is summed from active invoices, so a voided one stops counting and the next
 * draw re-bills the work it had billed. The alternative -- a reversing credit
 * invoice -- was rejected because it would need its own number, its own tax
 * snapshot and its own holdback entries, all of which must be exact negatives
 * of the original, and the arithmetic that guarantees they are is the
 * arithmetic being reversed.
 *
 * The snapshot columns on LATER invoices are deliberately left alone. They say
 * what those documents said when they were issued, which is the only thing they
 * are for; the live figures come from the sum, and the sum has already changed.
 */
export async function voidInvoice(args: {
  invoiceId: string;
  reason: string;
  voidedBy?: string;
}): Promise<{ state: JobBillingState }> {
  const reason = args.reason.trim();
  if (reason.length === 0) throw new Error('a void reason is required');

  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(customerInvoices)
      .where(eq(customerInvoices.id, args.invoiceId));
    if (!invoice) throw new Error(`invoice ${args.invoiceId} not found`);
    if (invoice.recordStatus !== 'active') {
      // Refused rather than ignored: a second void would overwrite the reason
      // somebody typed the first time with whichever one was passed last.
      throw new Error(`invoice ${invoice.invoiceNumber} is already void`);
    }

    const voided = {
      recordStatus: 'void' as const,
      voidedAt: new Date(),
      voidedBy: args.voidedBy,
      voidReason: reason,
    };

    await tx.update(customerInvoices).set(voided).where(eq(customerInvoices.id, invoice.id));
    // Children too, so a report that reads lines, taxes or the ledger directly
    // sees the same thing the derived state does. Restricted to the active ones
    // so an already-void child keeps the reason it was voided with.
    await tx
      .update(customerInvoiceLines)
      .set(voided)
      .where(
        and(
          eq(customerInvoiceLines.invoiceId, invoice.id),
          eq(customerInvoiceLines.recordStatus, 'active'),
        ),
      );
    await tx
      .update(customerInvoiceTaxes)
      .set(voided)
      .where(
        and(
          eq(customerInvoiceTaxes.invoiceId, invoice.id),
          eq(customerInvoiceTaxes.recordStatus, 'active'),
        ),
      );
    await tx
      .update(holdbackLedger)
      .set(voided)
      .where(
        and(eq(holdbackLedger.invoiceId, invoice.id), eq(holdbackLedger.recordStatus, 'active')),
      );

    const contract = await contractOf(tx, invoice.projectId);
    return { state: await deriveBillingState(tx, invoice.projectId, contract.subtotalCents) };
  });
}
