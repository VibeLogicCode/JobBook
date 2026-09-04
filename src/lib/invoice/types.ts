import type { ComputedTax } from '@/lib/quote/tax';

/**
 * The shape of a customer invoice, before and after arithmetic.
 *
 * Money crosses this boundary as `number` cents for the reason quote/types.ts
 * gives: cents are whole and a construction contract would have to reach ~$90
 * trillion before a double loses one. Percentages cross as `bigint`
 * ten-thousandths, because that is what the `rate()` column stores and the
 * boundary is exactly where a float would otherwise get in.
 */

/**
 * Invoice kinds, per spec 4.3.
 *
 * There is deliberately no 'full' member. A full invoice is progress at 100%
 * on a job with no prior draws, so it needs no code path of its own; giving it
 * one would mean two ways to bill a whole contract that could disagree by a
 * cent, and the one nobody tested would be the one that shipped.
 *
 * Declared here rather than imported from db/enums because the engine is pure
 * and has to be testable without a schema. The pgEnum mirrors this list.
 */
export type InvoiceKind = 'deposit' | 'progress' | 'final' | 'holdback_release' | 'change_order';

/**
 * Everything the engine needs to know about what a job has already billed.
 *
 * Assembled by the caller from the project's quotes, invoices and holdback
 * ledger. Passed in rather than looked up so that reproducing a sent invoice is
 * a matter of replaying its stored snapshot, not of hoping the tables still say
 * what they said (spec 4.5).
 */
export interface JobBillingState {
  /**
   * Contract value in cents, **exclusive of tax**: the sum of the *subtotals*
   * of the accepted, active quotes on the project.
   *
   * Spec 5.6 writes this as `sum(total)`, and `quotes.total_cents` is
   * tax-inclusive. Feeding that figure in would make the progress amount
   * tax-inclusive, and spec 4.3 then uses the progress amount as a taxable
   * base -- tax charged on tax, compounding once per draw. The caller owes this
   * function the pre-tax figure; see the note in the module header of
   * compute.ts.
   */
  contractValueCents: number;
  /**
   * Progress billed by earlier invoices, gross of holdback and exclusive of
   * tax.
   *
   * Gross, not net: if this held the post-holdback figure, every draw would
   * re-bill the holdback withheld by the one before it. Deposits are absent
   * from it on purpose -- a deposit is an advance, not a measurement of work,
   * and counting it here as well as drawing it down would credit the customer
   * for it twice.
   */
  previouslyBilledCents: number;
  /** Holdback withheld to date, per the ledger. Reduced by a corrective draw. */
  holdbackAccruedCents: number;
  /** Holdback paid out to date, per the ledger. Only a release invoice moves it. */
  holdbackReleasedCents: number;
  /** Customer advances invoiced and not yet drawn down. Unearned revenue, not income. */
  depositHeldCents: number;
}

export interface InvoiceRequest {
  kind: InvoiceKind;
  /**
   * ISO date. Decides which tax rates applied -- the issue date, never today,
   * so re-rendering a six-month-old invoice cannot re-rate it.
   */
  issueDate: string;
  /**
   * Ten-thousandths, so 100% is 10000n. The owner's stored judgement (spec
   * 4.3); the cost-to-cost ratio sits beside it on screen and is never billed,
   * because cost-to-cost is what an accountant defends and judgement is what
   * the contractor actually invoiced.
   *
   * Required for 'progress' and 'final'. Refused for the other kinds.
   */
  percentCompleteTenThou?: bigint;
  /** Cents, exclusive of tax. Required for 'deposit' and 'change_order'. */
  amountCents?: number;
  /**
   * Ten-thousandths. Read from the accepted quote, not the current
   * organization default, which may have moved since the contract was signed.
   */
  holdbackPctTenThou: bigint;
  /** Requested drawdown against `depositHeldCents`. Clamped, not refused; see compute.ts. */
  depositApplyCents?: number;
  /** 'holdback_release' only. Defaults to the whole outstanding balance. */
  releaseHoldbackCents?: number;
}

export interface InvoiceContext {
  /**
   * `organization.tax_deferred_on_holdback`. Excise Tax Act s.168(7); see
   * invoice/tax.ts for what it switches and why it is not a constant.
   */
  taxDeferredOnHoldback: boolean;
  customerExempt: boolean;
}

export interface ComputedInvoice {
  kind: InvoiceKind;
  issueDate: string;
  /** Work billed by this invoice, gross of holdback and exclusive of tax. */
  subtotalCents: number;
  /**
   * Signed. Positive withholds from this invoice; negative gives back --
   * either a release, or the reversal that follows a percent going backwards.
   * One signed field rather than two columns keeps `total` a single expression
   * for all five kinds.
   */
  holdbackCents: number;
  /** How much of `holdbackCents` is a payout rather than a reversal of accrual. */
  holdbackReleasedCents: number;
  depositAppliedCents: number;
  taxableBaseCents: number;
  taxes: ComputedTax[];
  taxTotalCents: number;
  totalCents: number;
  amountDueCents: number;
  /**
   * Snapshot fields (spec 4.5). Without them a progress invoice cannot be
   * reproduced once a later change order moves the contract value.
   */
  contractValueAtInvoiceCents: number;
  percentCompleteTenThou: bigint | null;
  previouslyBilledCents: number;
  /**
   * The job's billing state with this invoice applied, so a caller can chain
   * draws without re-deriving the running totals -- and so the tests can prove
   * that a whole schedule of draws lands on the contract exactly.
   */
  nextState: JobBillingState;
}
