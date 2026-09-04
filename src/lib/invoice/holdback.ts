import { applyPercentCents } from '@/lib/money/scale';
import { assertPercentTenThou } from '@/lib/invoice/progress';
import { addDays } from '@/lib/quote/dates';
import type { JobBillingState } from '@/lib/invoice/types';

/**
 * Statutory holdback: money earned and not yet collectable.
 *
 * It is withheld from the progress amount, accrues to a running balance, and is
 * released once the statutory period after substantial performance has run.
 */

/**
 * The holdback balance the job should be carrying once it has billed this much.
 *
 * Cumulative for the reason progress.ts gives, and for one more of its own: the
 * withholding is a percentage of the contract price, so the balance standing at
 * completion has to be exactly that percentage of it. Rounding each draw's
 * holdback separately lands a cent or two off, and the release invoice then
 * pays out a figure that is 10% of nothing in particular -- indefensible on a
 * lien claim, which is the only moment anybody ever checks it.
 */
export function holdbackAccruedToDateCents(
  billedToDateCents: number,
  holdbackPctTenThou: bigint,
): number {
  assertPercentTenThou(holdbackPctTenThou, 'holdback percentage');
  return Number(applyPercentCents(BigInt(billedToDateCents), holdbackPctTenThou));
}

/**
 * This invoice's share of the holdback: the move in the accrued balance.
 *
 * Signed, so a draw that reverses work reverses its withholding too. A deposit
 * and a release both leave `billedToDateCents` where it was, so both come out
 * as zero here without a branch on kind -- neither is a measurement of work in
 * place, which is the only thing holdback attaches to.
 */
export function holdbackDeltaCents(args: {
  billedToDateCents: number;
  holdbackPctTenThou: bigint;
  alreadyAccruedCents: number;
}): number {
  return (
    holdbackAccruedToDateCents(args.billedToDateCents, args.holdbackPctTenThou) -
    args.alreadyAccruedCents
  );
}

/** What is still held: accrued and not yet paid out. */
export function holdbackOutstandingCents(state: JobBillingState): number {
  return state.holdbackAccruedCents - state.holdbackReleasedCents;
}

/**
 * The first day the holdback may be released: substantial performance plus the
 * statutory period.
 *
 * The period is a parameter, not the Ontario 60, because it differs by province
 * and the product is white-label. `addDays` is reused rather than reimplemented
 * so this stays in the ISO-date domain -- the same reason quote dates do. A
 * `Date` built from '2026-11-01' and advanced 60 days can land a day early or
 * late depending on the host's offset and whether the clocks changed in
 * between, and this date decides when a lien period closes.
 */
export function holdbackReleaseEligibleDate(
  substantialPerformanceDate: string,
  holdbackReleaseDays: number,
): string {
  if (!Number.isInteger(holdbackReleaseDays) || holdbackReleaseDays < 0) {
    throw new Error(`holdback release days must be a non-negative whole number, received ${holdbackReleaseDays}`);
  }
  return addDays(substantialPerformanceDate, holdbackReleaseDays);
}
