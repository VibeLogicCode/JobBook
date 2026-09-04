import { computeTaxes, type ComputedTax, type TaxContext, type TaxRateInput } from '@/lib/quote/tax';
import type { ComputedLine } from '@/lib/quote/types';

/**
 * What an invoice is taxed on, and the tax itself.
 *
 * The rule this file exists to get the right way round: under Excise Tax Act
 * s.168(7), where a holdback is retained under provincial legislation or a
 * written construction contract, tax on the held-back amount is not payable
 * until the holdback is paid out or is required to be paid out. So a progress
 * invoice taxes (progress - holdback), and the release invoice taxes the
 * holdback that was deferred.
 *
 * An earlier draft of the spec asserted the opposite -- tax on the full
 * progress amount -- reasoning that a holdback is withheld from payment rather
 * than from the sale. That is wrong for Canada; spec 4.3 records the
 * correction. It is recorded here too, because the wrong version is the
 * intuitive one and a future reader "simplifying" this file will reach for it.
 */

/**
 * The taxable base, from the invoice's three moving parts.
 *
 * `taxDeferredOnHoldback` gates the deferral rather than the code assuming
 * Ontario: a jurisdiction without it must still bill correctly, and there the
 * full progress amount is taxed now and the release invoice taxes nothing.
 *
 * One expression covers all five kinds because `holdbackCents` is signed. A
 * release invoice bills no work and carries a negative holdback, so
 * `subtotal - holdback` is the released amount under deferral and zero without
 * it -- which is exactly the rule, with no branch on kind to get out of step.
 *
 * The deposit drawdown comes off last and before the tax is computed, not after
 * it: the deposit invoice already charged tax on that dollar (spec 4.3), so
 * taxing it again here would collect the tax twice and leave the owner
 * remitting money he never billed. Subtracting the drawdown from the *tax* or
 * from the *total* instead both look right on the invoice and are both wrong on
 * the return.
 */
export function invoiceTaxableBaseCents(args: {
  subtotalCents: number;
  holdbackCents: number;
  depositAppliedCents: number;
  taxDeferredOnHoldback: boolean;
}): number {
  const billableNowCents = args.taxDeferredOnHoldback
    ? args.subtotalCents - args.holdbackCents
    : args.subtotalCents;
  return billableNowCents - args.depositAppliedCents;
}

/**
 * Tax on an invoice's base, through the quote engine rather than beside it.
 *
 * The base is one derived amount, not a line list, so it is handed to
 * `computeTaxes` as a single synthetic line. The indirection is the point:
 * effective dating, compounding order, the exempt-customer short circuit and
 * the round-once-on-the-summed-base rule then have exactly one implementation.
 * A reimplementation here would be a few lines shorter today and would drift
 * the first time a rate acquires a rule -- and a quote disagreeing with its own
 * progress invoices about tax is the kind of bug nobody finds until an audit.
 */
export function computeInvoiceTaxes(
  baseCents: number,
  rates: TaxRateInput[],
  context: TaxContext,
): ComputedTax[] {
  return computeTaxes([baseAsLine(baseCents)], rates, context);
}

/**
 * The base, dressed as a computed line.
 *
 * The quantity and rate fields are zero and `lineTotalCents` carries the whole
 * amount: `computeTaxes` reads only the total, `isTaxable` and `isIncluded`,
 * and re-deriving the amount from a quantity times a rate would round a figure
 * that has already been rounded once.
 */
function baseAsLine(baseCents: number): ComputedLine {
  return {
    code: '',
    description: '',
    lineGroup: '',
    sortOrder: 1,
    calcMode: 'flat',
    unitLabel: '',
    qtyMilli: 0n,
    unitCostTenThou: 0n,
    unitPriceTenThou: 0n,
    isTaxable: true,
    isOptional: false,
    isIncluded: true,
    isAllowance: false,
    rateItemId: null,
    costCodeId: null,
    lineCostCents: 0,
    lineTotalCents: baseCents,
    displayPriceCents: baseCents,
  };
}
