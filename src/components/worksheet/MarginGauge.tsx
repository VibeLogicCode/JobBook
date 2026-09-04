import { formatBasisPoints } from '@/lib/money/format';

const CELLS = 8;

/**
 * The margin gauge: eight cells, coloured by band against the tenant's target.
 *
 * The only moving colour in the interface, and the single element the owner
 * watches while working -- which is why cost sits on the same line as price.
 * Always paired with the figure in words, so the colour is never the only
 * signal.
 */
export function MarginGauge({
  marginBp,
  targetBp,
}: {
  marginBp: number;
  targetBp: number | null;
}) {
  const target = targetBp && targetBp > 0 ? targetBp : 2000;
  const ratio = marginBp / target;
  const filled = Math.max(0, Math.min(CELLS, Math.round(ratio * CELLS)));

  const tone =
    marginBp < 0
      ? { fill: 'bg-negative-solid', text: 'text-negative' }
      : ratio < 0.6
        ? { fill: 'bg-negative-solid', text: 'text-negative' }
        : ratio < 1
          ? { fill: 'bg-warning-solid', text: 'text-warning' }
          : { fill: 'bg-positive-solid', text: 'text-positive' };

  return (
    <div className="flex items-center gap-2">
      <span className="t-small text-muted">Margin</span>
      <span className={`num t-heading ${tone.text}`}>{formatBasisPoints(marginBp)}</span>
      <span
        className="flex gap-0.5"
        role="img"
        aria-label={`${formatBasisPoints(marginBp)} against a target of ${formatBasisPoints(target)}`}
      >
        {Array.from({ length: CELLS }, (_, index) => (
          <span
            key={index}
            className={`h-3.5 w-2 rounded-[1px] transition-colors ${
              index < filled ? tone.fill : 'bg-surface-3'
            }`}
          />
        ))}
      </span>
    </div>
  );
}
