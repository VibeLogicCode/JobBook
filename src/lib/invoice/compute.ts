import { holdbackDeltaCents, holdbackOutstandingCents } from '@/lib/invoice/holdback';
import { FULL_PERCENT_TEN_THOU, earnedToDateCents } from '@/lib/invoice/progress';
import { computeInvoiceTaxes, invoiceTaxableBaseCents } from '@/lib/invoice/tax';
import type {
  ComputedInvoice,
  InvoiceContext,
  InvoiceKind,
  InvoiceRequest,
  JobBillingState,
} from '@/lib/invoice/types';
import type { TaxRateInput } from '@/lib/quote/tax';

/**
 * The single entry point for pricing a customer invoice.
 *
 * Pure, like computeQuote: reads nothing, writes nothing. The database layer
 * assembles `JobBillingState` from the project's quotes, invoices and holdback
 * ledger, and persists what comes back; it never asks this function to look
 * anything up, and it never recomputes a sent invoice against today's rates.
 *
 * `state.contractValueCents` must be the **pre-tax** contract value. Spec 5.6
 * derives contract value as `sum(total)` over the accepted, active quotes and
 * `quotes.total_cents` is tax-inclusive, so the obvious call --
 * `contractValueCents()` in quote/repository.ts -- is the wrong input here:
 * spec 4.3 then uses the progress amount as a taxable base, and the tax would
 * compound on itself once per draw. The caller sums `subtotal_cents`.
 */
export function computeInvoice(
  state: JobBillingState,
  request: InvoiceRequest,
  rates: TaxRateInput[],
  context: InvoiceContext,
): ComputedInvoice {
  assertRequestShape(request);

  const { subtotalCents, billedToDateCents } = billedFigures(state, request);

  // Accrual and release are tracked apart because the ledger tracks them apart
  // (spec 4.4) and because they mean different things: a negative accrual is
  // work that turned out not to have been done, a release is money paid over.
  // They meet only in the signed `holdbackCents` the invoice prints.
  const accrualCents = holdbackDeltaCents({
    billedToDateCents,
    holdbackPctTenThou: request.holdbackPctTenThou,
    alreadyAccruedCents: state.holdbackAccruedCents,
  });
  const releasedCents = request.kind === 'holdback_release' ? resolveRelease(state, request) : 0;
  const holdbackCents = accrualCents - releasedCents;

  const depositAppliedCents = resolveDrawdown(state, request, {
    subtotalCents,
    holdbackCents,
    taxDeferredOnHoldback: context.taxDeferredOnHoldback,
  });

  const taxableBaseCents = invoiceTaxableBaseCents({
    subtotalCents,
    holdbackCents,
    depositAppliedCents,
    taxDeferredOnHoldback: context.taxDeferredOnHoldback,
  });

  const taxes = computeInvoiceTaxes(taxableBaseCents, rates, {
    onDate: request.issueDate,
    customerExempt: context.customerExempt,
  });
  const taxTotalCents = taxes.reduce((sum, tax) => sum + tax.taxAmountCents, 0);

  // One expression for all five kinds, which is what the signed holdback buys:
  // a progress invoice subtracts what it withheld, and a release invoice adds
  // back what its negative holdback says was withheld before. The drawdown
  // lands on `amountDue` rather than on `total` because the deposit was a real
  // invoice with its own tax -- it reduces what the customer pays today, not
  // the value of the work billed.
  const totalCents = subtotalCents - holdbackCents + taxTotalCents;
  const amountDueCents = totalCents - depositAppliedCents;

  return {
    kind: request.kind,
    issueDate: request.issueDate,
    subtotalCents,
    holdbackCents,
    holdbackReleasedCents: releasedCents,
    depositAppliedCents,
    taxableBaseCents,
    taxes,
    taxTotalCents,
    totalCents,
    amountDueCents,
    contractValueAtInvoiceCents: state.contractValueCents,
    percentCompleteTenThou: request.percentCompleteTenThou ?? null,
    previouslyBilledCents: state.previouslyBilledCents,
    nextState: {
      contractValueCents: state.contractValueCents,
      previouslyBilledCents: billedToDateCents,
      // A corrective draw can in principle pull the accrued balance below what
      // has already been released, on a job whose holdback was paid out and
      // whose percent complete then went backwards. That surfaces as a negative
      // outstanding balance rather than being refused here: the money is
      // genuinely owed back, and refusing the correction would only hide it.
      holdbackAccruedCents: state.holdbackAccruedCents + accrualCents,
      holdbackReleasedCents: state.holdbackReleasedCents + releasedCents,
      // A deposit invoice creates the advance that later invoices draw down. It
      // counts from issue rather than from payment because payments live in
      // their own table (spec 4.5) and this engine never sees them; a caller
      // that will only draw down collected cash passes the collected figure in
      // `depositHeldCents` instead.
      depositHeldCents:
        state.depositHeldCents -
        depositAppliedCents +
        (request.kind === 'deposit' ? subtotalCents : 0),
    },
  };
}

/**
 * What this invoice bills of the contract, and what that brings the job to.
 *
 * Every kind resolves to these two figures, so the holdback accrual above needs
 * no branch on kind. 'final' shares the 'progress' arithmetic exactly -- it is
 * a label on a draw, not a second way to compute one.
 */
function billedFigures(
  state: JobBillingState,
  request: InvoiceRequest,
): { subtotalCents: number; billedToDateCents: number } {
  switch (request.kind) {
    case 'progress':
    case 'final': {
      const earnedCents = earnedToDateCents(
        state.contractValueCents,
        request.percentCompleteTenThou!,
      );
      return {
        subtotalCents: earnedCents - state.previouslyBilledCents,
        billedToDateCents: earnedCents,
      };
    }
    case 'change_order': {
      // Billed as an amount rather than as a percentage because the work is
      // extra to the schedule: the change order raised the contract value, and
      // this invoice bills that increment now instead of waiting for the next
      // draw to pick it up. It still counts towards `previouslyBilled`, or the
      // next draw would bill the same work a second time.
      const billedToDateCents = state.previouslyBilledCents + request.amountCents!;
      if (billedToDateCents > state.contractValueCents) {
        throw new Error(
          `billing ${request.amountCents} cents would take the job to ${billedToDateCents} cents against a contract of ${state.contractValueCents}: accept the change order first`,
        );
      }
      return { subtotalCents: request.amountCents!, billedToDateCents };
    }
    case 'deposit':
      // An advance, not a measurement of work, so it leaves `billedToDate`
      // alone: the first progress draw still bills its full percentage of the
      // contract and the deposit comes off that invoice as a drawdown. Counting
      // it here as well would credit the customer for the same money twice.
      return {
        subtotalCents: request.amountCents!,
        billedToDateCents: state.previouslyBilledCents,
      };
    case 'holdback_release':
      // Bills no work. The holdback was already inside the subtotals of the
      // progress invoices that withheld it, so putting it in this invoice's
      // subtotal would recognise the same revenue twice; it appears as a
      // negative withholding instead.
      return { subtotalCents: 0, billedToDateCents: state.previouslyBilledCents };
  }
}

/**
 * How much holdback this release pays out.
 *
 * Defaults to the whole outstanding balance, which is the ordinary case once
 * the statutory period has run. The optional figure exists for a partial
 * release -- owner and customer settling part of it while a deficiency is
 * argued over -- and an over-release is refused, because paying out more than
 * was ever withheld is a data error that would leave the ledger permanently
 * negative.
 */
function resolveRelease(state: JobBillingState, request: InvoiceRequest): number {
  const outstandingCents = holdbackOutstandingCents(state);
  const requestedCents = request.releaseHoldbackCents ?? outstandingCents;
  if (requestedCents < 0) {
    throw new Error(`a holdback release cannot be negative, received ${requestedCents} cents`);
  }
  if (requestedCents > outstandingCents) {
    throw new Error(
      `cannot release ${requestedCents} cents of holdback: only ${outstandingCents} cents are outstanding`,
    );
  }
  return requestedCents;
}

/**
 * How much of the customer's advance this invoice absorbs.
 *
 * Clamped rather than refused, because a drawdown is an intent ("apply the
 * deposit") and the answer depends on figures the caller does not have in front
 * of it. Two ceilings: what is actually held, and what this invoice bills
 * before tax. Without the second, a deposit larger than the draw would push the
 * taxable base negative and produce an invoice that refunds tax and owes the
 * customer money -- which is a credit note, not a progress invoice. Whatever is
 * left over stays in `nextState.depositHeldCents` for the next draw, so nothing
 * is lost by clamping.
 */
function resolveDrawdown(
  state: JobBillingState,
  request: InvoiceRequest,
  invoice: { subtotalCents: number; holdbackCents: number; taxDeferredOnHoldback: boolean },
): number {
  const requestedCents = request.depositApplyCents ?? 0;
  if (requestedCents < 0) {
    throw new Error(`a deposit drawdown cannot be negative, received ${requestedCents} cents`);
  }

  const billableNowCents = invoice.taxDeferredOnHoldback
    ? invoice.subtotalCents - invoice.holdbackCents
    : invoice.subtotalCents;
  return Math.max(0, Math.min(requestedCents, state.depositHeldCents, billableNowCents));
}

/**
 * Which fields each kind requires, and which it refuses.
 *
 * Refused rather than ignored. A caller reusing one form object across kinds
 * would otherwise leave a percent complete on a deposit request, and the
 * invoice would bill the deposit amount while silently discarding the
 * completion figure the owner typed -- a wrong invoice that looks
 * arithmetically perfect.
 */
function assertRequestShape(request: InvoiceRequest): void {
  assertIsoDate(request.issueDate);

  const needsPercent = request.kind === 'progress' || request.kind === 'final';
  const needsAmount = request.kind === 'deposit' || request.kind === 'change_order';

  if (needsPercent && request.percentCompleteTenThou === undefined) {
    throw new Error(`a ${request.kind} invoice needs a percent complete`);
  }
  if (!needsPercent && request.percentCompleteTenThou !== undefined) {
    throw new Error(`a ${request.kind} invoice does not bill by percent complete`);
  }
  if (needsAmount && request.amountCents === undefined) {
    throw new Error(`a ${request.kind} invoice needs an amount`);
  }
  if (!needsAmount && request.amountCents !== undefined) {
    throw new Error(`a ${request.kind} invoice does not take an amount; it is derived`);
  }
  if (request.kind !== 'holdback_release' && request.releaseHoldbackCents !== undefined) {
    throw new Error(`a ${request.kind} invoice does not release holdback`);
  }
  if (request.kind === 'deposit' && request.depositApplyCents !== undefined) {
    // The deposit being invoiced IS the advance. Drawing an earlier advance
    // down against it would net two liabilities against each other and report
    // the customer as having paid for work nobody has billed.
    throw new Error('a deposit invoice does not draw down a deposit');
  }
  if (request.kind === 'deposit' && request.amountCents! < 0) {
    // Refunding an advance is a payment out, not an invoice, and the payments
    // table is where it belongs (spec 4.5).
    throw new Error('a deposit invoice cannot be negative; refund the deposit as a payment');
  }
  if (request.kind === 'final' && request.percentCompleteTenThou !== FULL_PERCENT_TEN_THOU) {
    // A final invoice that leaves the contract part-billed is a progress
    // invoice that has been mislabelled, and the label is what the holdback
    // release clock and the WIP schedule read. Enforcing it here is what makes
    // "the draws sum to the contract" a guarantee rather than a hope.
    throw new Error('a final invoice bills the contract to 100%; use a progress invoice below that');
  }
}

/**
 * The issue date decides which rates applied, and `selectRatesInForce` compares
 * it as a string. A malformed date therefore matches no rate and yields a
 * zero-tax invoice rather than an error, so the shape is checked here while it
 * can still be refused.
 */
function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`expected an ISO date, received ${value}`);
  }
}

/** The kinds that move `previouslyBilled`, for a caller building a schedule. */
export const CONTRACT_BILLING_KINDS: readonly InvoiceKind[] = ['progress', 'final', 'change_order'];
