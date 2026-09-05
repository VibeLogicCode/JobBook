import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

/**
 * Where a page sits, when it sits under a record.
 *
 * The complaint that produced this: open a job, press Expenses, and you are on
 * `/expenses?project=…` -- a top-level destination, with the rail highlighting
 * Expenses and not one control on screen pointing at the job the list is
 * about. Every way out went further out.
 *
 * This is STRUCTURAL, not historical, and the difference is the whole design.
 * A `router.back()` button answers "how did I get here", which is a question
 * that has no answer on a refresh, on a pasted link, on a bookmark, or after a
 * form post -- four things this owner does daily, because he mails himself
 * links and reloads a page when a number looks stale. A parent link answers
 * "what is this page about", which is true no matter how the URL was reached,
 * and it is a real `href` so it middle-clicks, right-click-copies and
 * prefetches like every other link in the product.
 *
 * ONE PARENT, NOT A TRAIL. The hierarchy here is two deep -- a job, and the
 * screens about that job -- and the third crumb would always be the word
 * already sitting in the rail. On a 390px phone "Pipeline / P-2026-0001
 * Kitchen reno /" wraps to two lines to tell him something he knows. A trail
 * would also owe a `nav` landmark and an `aria-current` item duplicating the
 * `<h1>` immediately below it. So: one link, to the record this page belongs
 * to, named after that record.
 *
 * THE LABEL IS THE RECORD'S NAME, NEVER A VERB. "Open the job" and "Back to
 * job" are instructions, and the two of them shipped on two screens, which is
 * exactly the drift this component exists to stop. "P-2026-0001 · Kitchen
 * reno" is an answer instead: it says where you are as well as where the link
 * goes. The relationship is carried by the chevron for sighted readers and by
 * a visually hidden "Back to" for everyone else, so the accessible name reads
 * "Back to P-2026-0001 · Kitchen reno" and the wording is generated here
 * rather than typed at nine call sites.
 */
export interface PageParent {
  /** A real URL. Never a `router.back()` -- see above. */
  href: string;
  /** The record's own name, as the record says it. Not "Back to …". */
  label: string;
}

export function PageParentLink({ href, label }: PageParent) {
  return (
    <Link
      href={href}
      // `relative` because of the `sr-only` span below: `.sr-only` is
      // `position: absolute`, and without a positioned ancestor the browser
      // hands it the page as its containing block -- which is how an offscreen
      // span ends up widening the document and giving a phone a horizontal
      // scrollbar. Same trap AppShell's collapsed rail labels hit.
      //
      // `normal-case` because the eyebrow row it sits in is uppercase, and a
      // job name is a name: "KITCHEN RENO — 42 MAIN" is a label, "Kitchen reno
      // — 42 Main" is the thing he called it.
      //
      // `-my-1.5 py-1.5` grows the tap target to ~26px without growing the
      // row: the negative margin gives the padding back to the flex line, so
      // the eyebrow is the same height it was and the owner's screen loses
      // nothing. Short of the house 44px, deliberately -- a 44px band here is
      // the row of vertical space he has twice asked not to spend, and this is
      // a secondary aid at the top of the page with nothing around it to
      // mis-hit.
      //
      // `shrink-0` with `max-w-full`, which is the pair that makes the eyebrow
      // WRAP rather than squeeze. A flex item shrinks before the line wraps,
      // so on a 390px template screen the link gave up its width to the status
      // chip beside it and rendered "Scope templa…" with half the row empty
      // underneath. Refusing to shrink pushes the chip onto its own line
      // instead; `max-w-full` is what still keeps a genuinely long job name
      // inside the viewport, truncating only when there is really no room.
      // Same reasoning as `Pill`, which is `shrink-0` for the same reason.
      className="no-print relative -my-1.5 -mr-1 inline-flex max-w-full shrink-0 items-center gap-1 rounded-control py-1.5 pr-1 normal-case text-accent-text hover:underline"
    >
      <ChevronLeft size={14} aria-hidden className="shrink-0" />
      <span className="sr-only">Back to </span>
      <span className="truncate">{label}</span>
    </Link>
  );
}

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
 * `parent` is for a page that belongs to a record living at another URL --
 * this job's expenses, this job's schedule, this job's billing, this quote's
 * job. It is OPTIONAL and must stay that way: `/expenses` reached from the
 * rail is nobody's child, and a header that invented a job there would be
 * lying about the list underneath it. Pass it only when the page genuinely
 * narrows to one record.
 *
 * `eyebrow` is for real context -- the record's number, what kind of thing it
 * is, whether it is void -- not decoration. On a detail screen it is where the
 * status chips go: they belong to the record, but inside the <h1> they become
 * part of the heading's accessible name, so a screen reader announces "Sample
 * Client Commercial Tax exempt" as the page's title. `parent` shares that row
 * rather than taking one of its own, so on a screen that already has chips the
 * way back costs no height at all.
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
 * The way back is NOT an action. It went in `actions` once, on the billing
 * screen, where it rendered as a full-width secondary button above the fold on
 * a phone -- a 44px row spent on leaving, sitting where the button that issues
 * an invoice should be. Actions are what you came to do.
 *
 * No margin of its own: about half the screens here are `grid gap-4` and would
 * get the spacing twice. A page whose parent has no gap passes `className="mb-4"`.
 */
export function PageHeader({
  title,
  description,
  parent,
  eyebrow,
  actions,
  className = '',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  parent?: PageParent;
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
        {parent || eyebrow ? (
          // The parent SHARES this row with the status chips rather than
          // taking one above them, which is what makes it free on the screens
          // that already have an eyebrow. `PageParentLink` carries its own
          // `no-print`: the chips belong on paper, the way off the page does
          // not.
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 t-micro uppercase text-subtle">
            {parent ? <PageParentLink {...parent} /> : null}
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
