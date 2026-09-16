/**
 * One dominant figure with a label above it and, when there is something worth
 * saying, a line under it.
 *
 * `from` exists to enforce a convention rather than to leave it to prose. This
 * product derives most of its headline figures -- a contract value is the sum
 * of the quotes a customer actually signed, never a stored number -- and a
 * derived figure that does not say what it came from is a figure the owner
 * cannot reconcile against anything. So the label is written as
 * "Contract value — accepted quotes", and the em dash is produced here so
 * every derived figure on every screen reads the same way. A stored figure
 * passes no `from`, which is the visible difference between the two.
 *
 * The figure is not toned. `Money` already owns the rule that a quoted total
 * is neither good news nor bad news and is not painted green; a `tone` prop
 * here would let a screen overrule it.
 */
export function MetricCard({
  label,
  from,
  value,
  secondary,
  children,
  className = '',
}: {
  label: React.ReactNode;
  /** What the figure is derived FROM. Omitted for a stored figure. */
  from?: React.ReactNode;
  /** `<Money>` or `formatCents(...)`. Never a number formatted at the call site. */
  value: React.ReactNode;
  /** "3 accepted of 5 quotes" -- the sentence that makes the figure checkable. */
  secondary?: React.ReactNode;
  /** Anything below the figure: a `ProgressBar`, a small breakdown. A general
   *  slot rather than a `bar` prop, so job costing does not have to widen the
   *  API to hang a meter on one of these. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-panel card-surface p-4 ${className}`.trim()}>
      <p className="t-small text-muted">
        {label}
        {from ? <> — {from}</> : null}
      </p>
      <p className="num t-display">{value}</p>
      {secondary ? <p className="t-small text-muted">{secondary}</p> : null}
      {children ? <div className="mt-2">{children}</div> : null}
    </section>
  );
}
