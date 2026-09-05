import { parseRateToTenThou } from '@/lib/money/format';
import { FULL_PERCENT_TEN_THOU } from '@/lib/invoice/progress';

/**
 * The percent complete, between what a person types and what the engine bills.
 *
 * A completion figure is stored in ten-thousandths -- 100% is 10000 -- so it is
 * a bigint from the first character to the last, never a float that gets
 * multiplied by 100 on the way in. `0.1 * 100` is 10.000000000000002, and a
 * completion figure that lands a hair over 100% is refused by a bound that was
 * meant to catch a typed 150.
 */

/** 1% in ten-thousandths. 45.5% is therefore 4550. */
const ONE_PERCENT_TEN_THOU = FULL_PERCENT_TEN_THOU / 100n;

/**
 * What this screen can bill.
 *
 * There is no 'full' kind in the engine and there is not one here either: a
 * full invoice is the contract billed to 100%, which is exactly what 'final'
 * means, and the engine already refuses a 'final' below 100%. Giving the
 * screen its own 'full' would be a second way to bill a whole contract.
 */
export type BillingKind = 'progress' | 'final';

export type PercentResult = { ok: true; value: bigint } | { ok: false; error: string };

/**
 * The percentage this request bills at.
 *
 * ONE function, called by the page that previews and by the action that
 * commits, because the rule "a final invoice is 100% whatever the box says"
 * has to be the same rule in both. Written twice, the preview would show a
 * draw at the typed figure and the invoice would bill the whole contract.
 *
 * A figure finer than 0.01% is refused rather than rounded. The column cannot
 * hold it, so rounding would bill a percentage nobody typed and store it as if
 * they had.
 */
export function resolvePercentTenThou(kind: BillingKind, raw: string): PercentResult {
  if (kind === 'final') return { ok: true, value: FULL_PERCENT_TEN_THOU };

  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'Say how complete the work is.' };

  const parsed = parseRateToTenThou(trimmed);
  if (parsed === null) {
    return { ok: false, error: `“${trimmed}” is not a percentage.` };
  }
  if (parsed % ONE_PERCENT_TEN_THOU !== 0n) {
    return {
      ok: false,
      error: 'A percent complete is recorded to two decimal places; 45.25 is as fine as it goes.',
    };
  }

  const value = parsed / ONE_PERCENT_TEN_THOU;
  if (value < 0n || value > FULL_PERCENT_TEN_THOU) {
    // Not clamped to 100. Above the contract is not a completion figure at
    // all, and billing past the contract needs a change order that raises it.
    return {
      ok: false,
      error:
        'A percent complete runs from 0 to 100. To bill more than the contract, accept a change order that raises it first.',
    };
  }
  return { ok: true, value };
}

/**
 * A stored percentage, for a screen. Two decimals, always, because 45.5% and
 * 45.50% are the same figure and a column of them has to line up.
 */
export function formatPercent(tenThou: bigint): string {
  const negative = tenThou < 0n;
  const magnitude = negative ? -tenThou : tenThou;
  const whole = magnitude / ONE_PERCENT_TEN_THOU;
  const fraction = (magnitude % ONE_PERCENT_TEN_THOU).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}%`;
}
