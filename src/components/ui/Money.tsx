import { formatCents } from '@/lib/money/format';

/**
 * Money, always from integer cents.
 *
 * `plain` exists because a quoted total is not good news or bad news, so it is
 * not painted green. Signed amounts -- a discount, a deductive change order --
 * take the colour and the sign together, so colour never carries meaning alone.
 */
export function Money({
  cents,
  plain = false,
  className = '',
}: {
  cents: number;
  plain?: boolean;
  className?: string;
}) {
  const tone = plain ? '' : cents < 0 ? 'text-negative' : cents > 0 ? 'text-positive' : 'text-muted';

  return (
    <span className={`num ${tone} ${className}`.trim()}>
      {formatCents(cents, { showSign: !plain })}
    </span>
  );
}
