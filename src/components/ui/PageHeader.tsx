/**
 * The one <h1> on a page, plus whatever that page's primary action is.
 *
 * The action belongs UP HERE, not at the foot of the content. The owner's
 * complaint was about the activity log -- the button that adds an entry sat
 * under the entries, so on a job with two months of history it was two screens
 * below the thing it acts on. That is true of every list on every screen: the
 * control that adds a row is a property of the page, and a page's controls are
 * at the top of it.
 *
 * `eyebrow` is for real context -- the record's number, what kind of thing it
 * is, whether it is void -- not decoration. On a detail screen it is where the
 * status chips go: they belong to the record, but inside the <h1> they become
 * part of the heading's accessible name, so a screen reader announces "Sample
 * Client Commercial Tax exempt" as the page's title.
 *
 * THE ACTIONS SLOT IS ONE ROW THAT WRAPS. The version this was copied from
 * (Budget Tracker, `docs/superpowers/specs/2026-09-04-reuse-from-budget-tracker.md`
 * §1) records getting this wrong once: a first pass made the slot `flex-col`,
 * reasoning from a dashboard that passes three stacked rows needing a shared
 * right edge. Every other page passes a small handful of plain buttons, and
 * the column stacked those vertically too -- two buttons on two lines with
 * dead space beside each. Full width and left-aligned below `sm`, so the
 * actions take their own line on a phone rather than crushing the title;
 * right-flush at `sm` and up, on the same edge the content below ends on. A
 * page that genuinely needs several rows composes its own `flex-col` wrapper
 * and passes that one element in.
 *
 * No margin of its own: about half the screens here are `grid gap-4` and would
 * get the spacing twice. A page whose parent has no gap passes `className="mb-4"`.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className = '',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex flex-wrap items-end justify-between gap-x-6 gap-y-3 ${className}`.trim()}>
      {/* `grow basis-64` rather than `flex-1`, which is `flex-basis: 0%`: an
          item that can shrink to nothing never makes `flex-wrap` fire, so the
          title column collapses to a few characters and sets itself down the
          page three words at a time while the buttons stay on its row. Same
          lesson, same fix, as `CardHeader`. */}
      <div className="flex min-w-0 grow basis-64 flex-col gap-1">
        {eyebrow ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 t-micro uppercase text-subtle">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="t-title">{title}</h1>
        {description ? <p className="max-w-prose t-small text-muted">{description}</p> : null}
      </div>
      {/* Controls by definition, so `no-print` lives here rather than at every
          call site that forgets it -- the customer's document comes from the
          print route, and a button on paper is ink spent on something nobody
          can press. */}
      {actions ? (
        <div className="no-print flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
