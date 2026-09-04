import { applyPercentCents } from '@/lib/money/scale';
import type { ComputedLine } from '@/lib/quote/types';

/**
 * A tax rate as configured, not as applied.
 *
 * Rates are effective-dated rather than edited in place. When HST moves, an old
 * quote must still print the tax it was signed at, and a filing period that
 * straddles the change must split at the right day -- both impossible if the
 * settings row simply held today's number.
 */
export interface TaxRateInput {
  label: string;
  /** Printed on the document beside the tax. Null while setup is incomplete. */
  registrationNumber: string | null;
  /** Integer ten-thousandths: 13% is 1300n. */
  rateTenThou: bigint;
  /** ISO date, inclusive. */
  effectiveFrom: string;
  /** ISO date, inclusive. Null means still in force. */
  effectiveTo: string | null;
  /**
   * Charged on the base plus the tax already accumulated by lower-sorted rates.
   * Ontario needs this never -- HST is one harmonized rate -- but Quebec QST was
   * compound until 2013 and a white-label deployment cannot assume the province.
   */
  isCompound: boolean;
  /** Application order. Compounding makes this load-bearing, not cosmetic. */
  sortOrder: number;
}

export interface ComputedTax {
  label: string;
  registrationNumber: string | null;
  rateTenThou: bigint;
  /** What this particular rate was charged on, which compounding can raise. */
  taxableBaseCents: number;
  taxAmountCents: number;
}

export interface TaxContext {
  /** The date whose rates apply: quote date, not today. */
  onDate: string;
  customerExempt: boolean;
}

/**
 * The rates in force on a date, in application order.
 *
 * ISO dates compare correctly as strings, so no Date is constructed -- parsing
 * '2025-04-01' into a Date and comparing would drag the host timezone into a
 * decision about which tax rate a contract was signed under.
 */
export function selectRatesInForce(rates: TaxRateInput[], onDate: string): TaxRateInput[] {
  return rates
    .filter((rate) => rate.effectiveFrom <= onDate && (rate.effectiveTo === null || onDate <= rate.effectiveTo))
    // Copy before sorting: the caller's array is often the settings cache, and
    // reordering it in place would be a mutation of shared state.
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Tax on a computed line list.
 *
 * The base is summed first and rounded once. Rounding each line and adding the
 * results drifts a cent per few lines -- enough that a customer checking the
 * arithmetic on a forty-line quote finds the printed document wrong.
 */
export function computeTaxes(
  lines: ComputedLine[],
  rates: TaxRateInput[],
  context: TaxContext,
): ComputedTax[] {
  if (context.customerExempt) return [];

  const inForce = selectRatesInForce(rates, context.onDate);
  if (inForce.length === 0) return [];

  // Excluded optional lines are not part of the contract, so they are not part
  // of the base. Their grossed-up display price is a separate question.
  let baseCents = 0n;
  for (const line of lines) {
    if (!line.isIncluded || !line.isTaxable) continue;
    baseCents += BigInt(line.lineTotalCents);
  }

  const taxes: ComputedTax[] = [];
  let accumulatedCents = 0n;

  for (const rate of inForce) {
    const rateBaseCents = rate.isCompound ? baseCents + accumulatedCents : baseCents;
    const amountCents = applyPercentCents(rateBaseCents, rate.rateTenThou);
    accumulatedCents += amountCents;
    taxes.push({
      label: rate.label,
      registrationNumber: rate.registrationNumber,
      rateTenThou: rate.rateTenThou,
      taxableBaseCents: Number(rateBaseCents),
      taxAmountCents: Number(amountCents),
    });
  }

  return taxes;
}
