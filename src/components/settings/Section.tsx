import { Card } from '@/components/ui/Card';

/**
 * One settings section: a panel with a title, the reason it exists, and a form.
 *
 * The description is not decoration. Every field on this screen has a
 * consequence the form itself cannot show -- what date a quote carries, what
 * a customer document says, who can sign in -- and a settings screen that
 * only labels its inputs makes the owner guess.
 */
export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  /**
   * A control that belongs to this section rather than to the page --
   * the `SheetButton` that adds a row to the table below it, most often.
   * Lives beside the title for the same reason `PageHeader`'s own `actions`
   * does: the control that adds a row is a property of the section, and a
   * section's controls sit at the top of it rather than below its table.
   */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // The surface treatment comes from `Card` rather than a third copy of
    // `rounded-panel card-surface`. The header is still
    // written here rather than through `CardHeader`: a settings section runs
    // its title, its reason and its form together in one padded block, and
    // `CardHeader`'s ruled band would draw a line between the reason and the
    // fields it is the reason for.
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h2 className="t-heading">{title}</h2>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {description ? (
        <div className="mt-1 mb-4 max-w-prose t-small text-muted">{description}</div>
      ) : (
        <div className="mb-4" />
      )}
      {children}
    </Card>
  );
}
