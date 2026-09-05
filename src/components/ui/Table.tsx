import { formatCents } from '@/lib/money/format';

/**
 * The house table: a scroll container, the `.data-table` cell styling from
 * globals.css, and the width below which the table scrolls rather than
 * shrinks.
 *
 * Ported from the sibling project and cut to what this product actually
 * renders, per the reuse spec's rule -- copy, then delete rather than leave
 * configurable. Stacking is not a flag here: every list in this app reflows
 * into cards below `sm`, and nine tables across eight screens were each
 * hand-rolling the same three decisions (the scroll container, the class
 * pair, an inline min-width) with nothing holding them together.
 *
 * A page writes plain thead/tbody markup and gets the house table for free.
 * It goes on writing its own cells deliberately: a `Cell` primitive would
 * take every cell tag out of the pages and blind
 * tests/ops/stacked-table.test.ts, which reads the markup to prove each cell
 * carries the column name it prints on a phone. Only the numeric cell became
 * a component, because it carries a class that was being remembered rather
 * than imported.
 */
export function TableWrap({
  children,
  minWidth,
  bare = false,
  className = '',
}: {
  children: React.ReactNode;
  /**
   * The table's real width. REQUIRED, and the reason is a bug the sibling
   * project shipped without it.
   *
   * `.data-table` is `width: 100%`, so the table can never grow past its
   * container -- which means the `overflow-x-auto` on that container NEVER
   * engages by itself, because nothing overflows. On a narrow screen the
   * browser honours the columns by shrinking every one of them instead, and
   * whichever column is elastic collapses towards nothing: a description ends
   * up a character wide, spelling its words down the page one letter a line.
   *
   * A min-width restores the intent -- the table keeps its size, the
   * container takes the sideways scroll -- so read this as the width below
   * which the table scrolls. It is required rather than defaulted because
   * only the caller knows how narrow its own columns may go before they stop
   * being readable, and a table that never says loses the argument silently.
   *
   * Below `sm` it stops applying: the stack rule in globals.css drops it with
   * `!important`, which it needs because this is an inline style and inline
   * beats a class. That `!important` is load-bearing, not clutter.
   *
   * Rejected: `table-layout: fixed` with a colgroup, which is how the
   * sibling project stops the controls in a row from renegotiating column
   * widths. Two conditions travel with it -- one col per header, or fixed
   * layout simply divides the width equally, which is worse than auto; and a
   * min-width equal to the colgroup's own total, or the shrinking described
   * above happens to the declared widths instead. It is not used here because
   * the one table whose rows carry controls (the template line editor) opens
   * a whole form inside its last cell: a column wide enough for that form is
   * wider than the screen, and a column narrow enough to sit in the row
   * crushes it. Measured on that screen at 1440: opening one row's form drags
   * its column from 109px to 327px and squeezes the item description from
   * 304px to 180px, reflowing every other row. Fixed layout would trade that
   * for an unusable form; the row editor wants to be a dialog rather than a
   * cell, and until it is, auto layout is the lesser fault.
   */
  minWidth: string;
  /**
   * Already inside a Panel or Section? Drop the frame so two borders do not
   * double up.
   *
   * One flag covers both framed cases even though a list page sits on
   * `--canvas` and a Section paints `--surface` under the table: the frame's
   * own `bg-surface` is invisible against a surface it matches, so the two
   * render identically and a third variant would only be a third thing to
   * choose wrong.
   */
  bare?: boolean;
  className?: string;
}) {
  const frame = bare ? '' : 'rounded-panel border border-line bg-surface';

  return (
    <div className={`w-full overflow-x-auto ${frame} ${className}`.trim()}>
      <table className="data-table data-table--stack" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

type AmountCellProps = {
  /**
   * The column header text, reprinted by `.data-table--stack td::before` when
   * the table stacks into cards. Required, not optional: below the breakpoint
   * this attribute IS the column header, and a figure with nothing to say
   * what it is reads worse on a phone than the column it came from. The
   * markup sweep in tests/ops/stacked-table.test.ts cannot see a cell tag
   * this component renders, so the type is what holds the line here, and
   * tests/ops/table-conventions.test.ts sweeps the call sites.
   */
  'data-label': string;
  className?: string;
} & (
  | { cents: number; children?: never }
  | { children: React.ReactNode; cents?: never }
);

/**
 * The right-aligned, tabular-figure cell every table puts its figures in
 * (`.cell-num` in globals.css, which is where the mono face and the tabular
 * numerals come from -- figures that do not align down a column are the
 * reason that face is loaded at all).
 *
 * `cents` is the money path and formats through `formatCents`, so integer
 * cents stay integer cents up to the string and no screen invents its own
 * rounding. `children` carries the figures that are not money -- a rate at
 * four decimals, a quantity, a margin, a count -- which still belong in the
 * same column treatment. Exactly one of the two, enforced by the type rather
 * than by a runtime check.
 *
 * `Money` is the other formatter in the house and is deliberately not used
 * here: it paints a sign and a colour, and a quoted total is neither good
 * news nor bad news. A cell that wants the signed treatment passes it as
 * `children`.
 */
export function AmountCell({
  cents,
  children,
  className = '',
  'data-label': dataLabel,
}: AmountCellProps) {
  return (
    <td className={`cell-num ${className}`.trim()} data-label={dataLabel}>
      {cents === undefined ? children : formatCents(cents)}
    </td>
  );
}
