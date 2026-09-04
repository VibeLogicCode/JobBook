/**
 * The small-caps label over a GROUP of cards or rows -- what `CardHeader` is
 * to one card, this is to a whole block of them.
 *
 * It reuses `t-micro uppercase`, the same treatment `Pill` wears and the same
 * one the data table's column headers wear, rather than inventing a second
 * small-caps rule. The section label and the column header name the same kind
 * of thing: what the stuff underneath is.
 *
 * The icon slot the source of this component carried is gone. At 11px beside a
 * 14px body an icon is noise, and the navigation rail is already where this
 * product spends its iconography.
 */
export function SectionHeader({
  title,
  action,
  className = '',
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 ${className}`.trim()}>
      <h2 className="min-w-0 truncate t-micro uppercase text-muted">{title}</h2>
      {action ? <div className="no-print shrink-0">{action}</div> : null}
    </div>
  );
}
