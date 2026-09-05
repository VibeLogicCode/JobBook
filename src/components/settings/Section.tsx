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
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // The surface treatment comes from `Card` rather than a third copy of
    // `rounded-panel border border-line bg-surface`. The header is still
    // written here rather than through `CardHeader`: a settings section runs
    // its title, its reason and its form together in one padded block, and
    // `CardHeader`'s ruled band would draw a line between the reason and the
    // fields it is the reason for.
    <Card className="p-4 sm:p-5">
      <h2 className="t-heading">{title}</h2>
      {description ? (
        <div className="mt-1 mb-4 max-w-prose t-small text-muted">{description}</div>
      ) : (
        <div className="mb-4" />
      )}
      {children}
    </Card>
  );
}
