/**
 * Keyboard operation of the worksheet.
 *
 * Tab moves across a row, Enter commits and descends to the same column of the
 * next row, Escape cancels. That is what lets a forty-line quote be adjusted
 * without touching the mouse, which is how an estimate actually gets built:
 * the owner works down the quantity column, not across each row in turn.
 */

/** The editable columns, in the order they appear in a row. */
export type WorksheetColumn = 'qty' | 'rate';

/** The attribute the descent reads. One name, so a typo cannot half-work. */
export const COLUMN_ATTR = 'data-worksheet-col';

/**
 * Moves focus to the next row's field in the same column.
 *
 * The next field is found by querying the table in document order rather than
 * by threading refs up through the group and row components. Document order IS
 * the order the owner sees, it survives a regeneration replacing every row, and
 * it skips rows that have no field in that column on its own -- a percent line
 * has no quantity, and stopping on its empty cell would be a dead end.
 */
export function focusNextInColumn(from: HTMLInputElement, column: WorksheetColumn): void {
  const table = from.closest('table');
  if (!table) return;

  const fields = Array.from(
    table.querySelectorAll<HTMLInputElement>(`input[${COLUMN_ATTR}="${column}"]`),
  );
  const index = fields.indexOf(from);
  // Not found means the table re-rendered out from under the keystroke. Doing
  // nothing beats `fields[0]`, which would throw the caret to the first row.
  if (index === -1) return;

  const next = fields[index + 1];
  // The last row keeps focus rather than wrapping to the top: a wrap would put
  // the caret four screens away from where the owner is looking.
  if (!next) return;

  next.focus();
  next.select();
}
