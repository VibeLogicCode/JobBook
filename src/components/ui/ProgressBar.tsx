/**
 * The one meter in the product: how much of something has happened against a
 * limit -- invoiced against contract value, holdback released, a job's spend
 * against its budget.
 *
 * The ruling this file exists to hold: the FILL clamps at 100% so a bar can
 * never overflow its track, while `aria-valuenow` and whatever the caller
 * prints beside it keep reporting the truth. Over-invoiced at 112% renders a
 * full negative bar -- the bar says "past the limit", the figure next to it
 * says by how much.
 *
 * The automatic 80%/100% tone scale that came with this component elsewhere is
 * deliberately NOT here. There, 80 was a real setting the notification
 * evaluator alerted on, so a bar turning amber described a threshold the rest
 * of the app agreed with. This product has no such setting, and a component
 * that invents one is a component telling the owner a job is in trouble on a
 * number nothing else in the system knows about. `tone` is the caller's, from
 * the rule that actually applies.
 */
export type BarTone = 'accent' | 'positive' | 'warning' | 'negative';

const FILLS: Record<BarTone, string> = {
  accent: 'bg-accent',
  // The `-solid` tokens, not `--positive`/`--warning`: a graphic fill needs
  // 3:1 and text needs 4.5:1, and holding a fill to the text ratio is what
  // turns amber into mud.
  positive: 'bg-positive-solid',
  warning: 'bg-warning-solid',
  negative: 'bg-negative-solid',
};

/** Exported for its own test: the clamp is the part that has to be right, and
 *  it is the part a caller cannot see is working. */
export function fillPercent(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

export function ProgressBar({
  pct,
  tone = 'accent',
  label,
  className = '',
}: {
  /** The true percentage, which may run past 100. The fill clamps; this does not. */
  pct: number;
  tone?: BarTone;
  /** The accessible name -- "Invoiced against contract value". The bar carries
   *  no visible caption of its own; the figure beside it is what a sighted
   *  reader reads, which is also why colour here never carries the meaning. */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      // `no-print`: browsers drop background fills when printing, so this
      // prints as an empty track -- a bar that reads as zero regardless of the
      // figure. The figure beside it is the printable version.
      //
      // 2px, not the 4px control radius: at 8px tall a 4px radius is a pill by
      // arithmetic, and the house scale has no pill shape in it.
      className={`no-print h-2 w-full overflow-hidden rounded-[2px] bg-surface-3 ${className}`.trim()}
    >
      <div
        style={{ width: `${fillPercent(pct)}%` }}
        className={`h-full rounded-[2px] transition-[width] duration-300 ease-out ${FILLS[tone]}`}
      />
    </div>
  );
}
