import { Info } from 'lucide-react';

/**
 * The reasoning behind a field, closed until somebody asks for it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Three different kinds of text had been collapsing into one `hint` prop:
 *
 *   - the LABEL, which is always visible and is not this component's business;
 *   - the DISAMBIGUATOR -- "Net days. 0 is cash on delivery, which is a
 *     different fact." -- one short line that stays visible, because a person
 *     filling the box needs it while they fill the box;
 *   - the RATIONALE -- the argument for why the field exists at all.
 *
 * The third is good thinking and it does not need re-reading every time
 * somebody edits a supplier's phone number. The owner's words, on the vendor
 * sheet: *"all this explanation makes the page really busy."* He was right;
 * that sheet scrolled because two of its sections carried a paragraph each.
 *
 * `hint` keeps the second kind. This takes the third.
 *
 * ---------------------------------------------------------------------------
 * WHY `<details>` AND NOT A TOOLTIP, AND NOT A CLIENT COMPONENT
 * ---------------------------------------------------------------------------
 *
 * **Not a tooltip.** There is no hover on a phone, and this product is used on
 * site with one hand. A hover tooltip is also invisible to find-in-page and
 * awkward for a screen reader unless it is built very carefully. A press works
 * on touch, on a mouse and on a keyboard, and it is the same press either way.
 *
 * **Not a client component.** `Fields.tsx` is server-rendered on purpose -- its
 * own docblock says the fields are HTML so a form still works while the page's
 * JavaScript is on its way. A `useState` disclosure would have made every form
 * in the product a client component to open a paragraph. `<details>` is a
 * disclosure the browser already implements: it opens with no JavaScript at
 * all, it is in the accessibility tree as a real disclosure with its own
 * expanded state, and find-in-page in Chrome and Safari opens it to reveal a
 * match rather than skipping past it. Nothing hand-rolled gets all four.
 *
 * The `Sheet` focus trap needs no change to accommodate it: that component
 * re-reads its focusable list on every Tab rather than caching it at open,
 * precisely so a sheet's own controls can add and remove stops while it stays
 * open. Opening one of these inside a sheet is that case, already handled.
 */
export function Reveal({
  label = 'Why this is here',
  children,
}: {
  /**
   * What the press says. Default fits the common case; a field with a
   * genuinely different question -- "What counts as a holdback?" -- should say
   * so, because a row of identical triggers teaches nobody which one to press.
   */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group/reveal">
      {/* `list-none` plus the webkit marker rule removes the browser's own
          triangle in both engines. The icon replaces it rather than joining
          it. */}
      <summary
        className="flex w-fit cursor-pointer list-none items-center gap-1.5 py-2 t-small text-subtle underline decoration-dotted underline-offset-2 sm:py-0.5 [&::-webkit-details-marker]:hidden"
      >
        {/* 44px of target on a phone, where this is pressed with a thumb in a
            basement; compact at a desk, where a 44px row under every field
            would put back the bulk this component exists to remove. The
            padding does it rather than a height, so the closed state costs one
            line of space instead of three. */}
        <Info size={14} aria-hidden className="shrink-0" />
        <span className="group-open/reveal:hidden">{label}</span>
        <span className="hidden group-open/reveal:inline">Hide</span>
      </summary>
      <p className="mb-1 max-w-prose pt-1 t-small text-subtle">{children}</p>
    </details>
  );
}
