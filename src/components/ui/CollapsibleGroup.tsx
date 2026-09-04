'use client';

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * A named group of rows that folds away, showing its figure while folded.
 *
 * Extracted here rather than ported: the codebase this vocabulary comes from
 * has the pattern written out four times across four screens, and this product
 * needs it in more places than that one did -- quote lines grouped by trade,
 * cost codes by division, invoices by job, receipts by vendor. Four hand-rolled
 * disclosures is how one of them ends up without `aria-expanded`.
 *
 * `<details>`/`<summary>`, not a div and a click handler. The element is
 * keyboard-operable before any JavaScript runs (Enter and Space, focus ring,
 * the right role) and it survives a hydration that has not happened yet, which
 * matters on the first paint of a job screen over a phone connection.
 *
 * The state is still tracked in React, even though the browser would toggle
 * this on its own, so that the chevron's rotation and the announced expanded
 * state cannot drift from the element's real one. `aria-expanded` on the
 * summary is redundant with the native mapping and set anyway: the mapping is
 * newer than some of the assistive tech this will meet on a site office
 * machine.
 *
 * NOT for a group band inside a data table. A `<details>` cannot wrap `<tr>`
 * elements, so a table's band is a `<tr className="group-band">` holding a
 * button -- the shape the worksheet already uses, with the sticky-cell rules
 * for it in globals.css. Nothing here replaces that.
 */
export function CollapsibleGroup({
  title,
  summary,
  defaultOpen = false,
  children,
  className = '',
}: {
  title: React.ReactNode;
  /**
   * The figure that stays readable while the group is shut -- a trade's total,
   * a division's committed cost. Optional rather than required: a settings
   * group has nothing to total. But a group with no figure is usually a `Card`
   * that does not need to fold at all, and folding it only hides content from
   * a person looking for it.
   */
  summary?: React.ReactNode;
  /** Default state is the caller's: a quote's own trades open, last year's
   *  cost codes shut. There is no house default worth guessing at. */
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      // `min-w-0` is load-bearing, not tidiness. A grid or flex item's
      // automatic minimum size is its own min-content width, and a `<details>`
      // resolves that from its whole subtree -- so a long trade name in the
      // summary refused to shrink and pushed the PAGE 450px wider than a
      // phone, horizontal scroll and all, even though the title span itself
      // was correctly set to truncate. Measured at 390px: 842px of document.
      //
      // The print rule: a shut group prints shut, which would drop a job's
      // costs off a printed screen. `::details-content` is the only hook CSS
      // has on that and it is not in every engine, so this is a mitigation
      // rather than a guarantee -- the document a customer receives still
      // comes from /print, never from printing a working screen.
      className={`min-w-0 rounded-[6px] border border-line bg-surface print:[&::details-content]:[content-visibility:visible] ${className}`.trim()}
    >
      <summary
        aria-expanded={open}
        // `list-none` plus the webkit marker rule: a flex summary still draws
        // the native triangle in some engines, and two disclosure arrows on
        // one row reads as a rendering fault.
        className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2 [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight
          size={14}
          aria-hidden
          className={`no-print shrink-0 text-muted transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="min-w-0 flex-1 truncate t-heading">{title}</span>
        {/* No `num` here: a money summary arrives as `<Money>`, which already
            carries the tabular figures, and forcing mono would set a count of
            lines in it too. */}
        {summary ? <span className="shrink-0">{summary}</span> : null}
      </summary>
      <div className="border-t border-line px-4 py-3">{children}</div>
    </details>
  );
}
