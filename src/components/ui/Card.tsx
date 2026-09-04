/**
 * The general container: `--surface` on `--canvas`, a 1px hairline, a 6px
 * radius. Deliberately pixel-identical to `detail/Panel`, because two
 * containers that differ by two pixels of padding is how a screen starts
 * looking assembled rather than designed.
 *
 * Why both exist. `Panel` is the titled detail-screen panel and does one thing
 * well: a required title, a ruled header, a padded body. It has no room for an
 * action beside the title, no way to drop the padding for a child that must
 * bleed to the radius, and no way to omit the title -- so every screen that
 * needed one of those hand-rolled `<section className="rounded-[6px] border
 * ...">` instead. This is that container, with the three slots. `Panel`'s
 * markup is exactly `Card` + `CardHeader` + `CardBody`, so the adoption pass
 * can reduce it to a wrapper; until then Panel stays the shorter call on a
 * detail screen and this is what you reach for when you need a header action,
 * an unpadded body, or no title at all.
 *
 * Panels are never nested. Card-in-card defeats the density the rest of the
 * product is built for.
 */
export function Card({
  children,
  className = '',
  as: Tag = 'section',
}: {
  children: React.ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article' | 'aside';
}) {
  // No `overflow-hidden`, which the container this was ported from carries:
  // clipping turns the card into a scrollport, and the data table's sticky
  // `thead` and the sticky `.sum-bar` both stop sticking inside one. A child
  // that needs its corners clipped carries its own radius.
  return <Tag className={`rounded-[6px] border border-line bg-surface ${className}`.trim()}>{children}</Tag>;
}

export function CardHeader({
  title,
  description,
  action,
  /**
   * `3` when the card sits under a `SectionHeader`, which is already the h2 --
   * two h2s at different depths is the heading order a screen reader reads out
   * as a flat list.
   */
  level = 2,
  className = '',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  level?: 2 | 3;
  className?: string;
}) {
  const Heading = level === 3 ? 'h3' : 'h2';

  return (
    <header className={`flex flex-wrap items-start gap-3 border-b border-line px-4 py-2 ${className}`.trim()}>
      {/* `basis-48` rather than `flex-1`, which is `flex-basis: 0%`: an item
          that can shrink to nothing never makes `flex-wrap` fire, so on a
          phone the title column collapsed to about 130px and set the
          description down it three words at a time while the buttons sat on
          the same row. A real basis is what makes the actions drop to their
          own line instead. `min-w-0` still allows a long title to truncate. */}
      <div className="min-w-0 grow basis-48">
        <Heading className="t-heading">{title}</Heading>
        {description ? <p className="mt-0.5 max-w-prose t-small text-muted">{description}</p> : null}
      </div>
      {/* The action slot is controls by definition, so it carries `no-print`
          here rather than at every call site that forgot it. */}
      {action ? <div className="no-print flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </header>
  );
}

export function CardBody({
  children,
  /**
   * `false` for a child that bleeds to the card's edge -- a data table, a sum
   * bar, a divided list. A table inset in a 16px gutter loses the alignment
   * between its first column and the heading above it.
   */
  padded = true,
  className = '',
}: {
  children: React.ReactNode;
  padded?: boolean;
  className?: string;
}) {
  return <div className={`${padded ? 'px-4 py-3' : ''} ${className}`.trim()}>{children}</div>;
}

/** A ruled strip at the foot of a card: a total, a count, a note about what the
 *  card does not show. Omitted entirely when there is nothing for it, rather
 *  than reserving an empty band. */
export function CardFooter({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`border-t border-line bg-surface-2 px-4 py-2 t-small text-muted ${className}`.trim()}>
      {children}
    </div>
  );
}
