import { RATE_SCALE, applyPercentCents } from '@/lib/money/scale';

/** 100%, in the ten-thousandths a stored percent uses. */
export const FULL_PERCENT_TEN_THOU = RATE_SCALE;

/**
 * A completion or withholding percentage has to sit within 0%..100%.
 *
 * Above 100% is refused rather than clamped: it is not a completion figure at
 * all. A job that must bill more than its contract needs a change order that
 * raises the contract, and accepting 110% here would bill work no customer had
 * accepted while leaving the contract value untouched -- the one error in this
 * file that a customer would not catch, because the arithmetic would be
 * internally consistent.
 */
export function assertPercentTenThou(value: bigint, label: string): void {
  if (value < 0n || value > FULL_PERCENT_TEN_THOU) {
    throw new Error(
      `${label} must be between 0% and 100%, received ${value} ten-thousandths`,
    );
  }
}

/**
 * Work earned to date: contract value times percent complete, rounded once.
 *
 * Cumulative rather than incremental, and that is the entire rounding-drift
 * strategy. Rounding each draw's own share leaves an error per draw that adds
 * up, so a contract that does not divide evenly across thirteen draws finishes
 * a few cents away from its own total and the final invoice has to be fudged by
 * hand. Rounding the running total instead makes every draw the difference
 * between two exact cumulative figures: the errors cancel as they arise, and
 * the draw at 100% is exactly `contract - previously billed` no matter how the
 * earlier ones fell.
 *
 * The alternative considered and rejected was to compute draws naively and
 * force the last one to absorb the remainder. That works only if there is a
 * last one -- it cannot say what the *fourth* of seven draws should be, it
 * silently mis-states every intermediate percentage, and a job whose final
 * invoice is issued before the schedule completes never gets its correction.
 */
export function earnedToDateCents(
  contractValueCents: number,
  percentCompleteTenThou: bigint,
): number {
  return Number(applyPercentCents(BigInt(contractValueCents), percentCompleteTenThou));
}

/**
 * The progress amount for one invoice: spec 4.3's
 * `contract value x percent complete - previously invoiced`.
 *
 * A negative result is returned, not refused. The owner bills 60%, then walks
 * the site and finds the drywall is 45% done; the correction is a draw with a
 * negative amount. Refusing it would push the fix outside the system as a
 * hand-typed credit note, and then the sum of what was billed would no longer
 * be the contract -- which is the one property every other decision in this
 * module exists to protect. The engine already carries negatives through every
 * base for deductive change orders (quote/change-order.ts), and because the
 * holdback accrual is cumulative too, a corrective draw reverses the holdback
 * it withheld without any special handling.
 */
export function progressAmountCents(args: {
  contractValueCents: number;
  percentCompleteTenThou: bigint;
  previouslyBilledCents: number;
}): number {
  assertPercentTenThou(args.percentCompleteTenThou, 'percent complete');
  return (
    earnedToDateCents(args.contractValueCents, args.percentCompleteTenThou) -
    args.previouslyBilledCents
  );
}
