/**
 * The one panel treatment for a detail screen: `--surface` on `--canvas` with a
 * 1px hairline and a 6px radius. Elevation here is structural, not atmospheric,
 * and panels are never nested -- card-in-card defeats the density the rest of
 * the product is built for.
 */
export function Panel({
  title,
  children,
  className = '',
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-[6px] border border-line bg-surface ${className}`.trim()}>
      <header className="border-b border-line px-4 py-2">
        <h2 className="t-heading">{title}</h2>
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** A label/value grid. Labels stay in one column so values align down the page. */
export function DetailList({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[minmax(8rem,12rem)_1fr]">{children}</dl>
  );
}

/**
 * One label and its value.
 *
 * An absent value prints an em dash rather than nothing: a blank space beside a
 * label reads as a rendering failure, and "we do not have this" is information.
 */
export function DetailRow({
  label,
  value,
  children,
  numeric = false,
  className = '',
}: {
  label: string;
  value?: string | null;
  children?: React.ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  const empty = children === undefined && (value === null || value === undefined || value === '');

  return (
    <>
      <dt className={`t-small text-muted ${className}`.trim()}>{label}</dt>
      <dd className={`${numeric ? 'num' : ''} ${empty ? 'text-subtle' : ''} ${className} mb-1 sm:mb-0`.trim()}>
        {children ?? (empty ? '—' : value)}
      </dd>
    </>
  );
}

/**
 * Every list ships an empty state that names the next action, so a screen with
 * nothing on it still tells the person what to do (UI spec section 6).
 */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="p-2 t-small text-muted">{children}</p>;
}
