import { and, ilike, or, type SQL } from 'drizzle-orm';

/**
 * Free-text search over a handful of columns, turned into SQL.
 *
 * Three things go wrong when a list screen writes this itself, and all three
 * were live in the sibling project:
 *
 * 1. The pattern gets concatenated into the statement. Drizzle's `ilike` binds
 *    its pattern as a parameter, so the shape below never interpolates user
 *    text into SQL -- but only if every caller goes through here rather than
 *    reaching for `sql` with a template hole.
 * 2. `%` and `_` are wildcards in `LIKE`. Untouched, a search for "50%"
 *    matches every row in the table and the owner concludes the filter is
 *    broken. They are escaped here, and so is the backslash that escapes them.
 * 3. Two words in the box. "kitchen smith" is a customer and a job, and a
 *    single `%kitchen smith%` matches neither, because no one column holds
 *    both. Each whitespace-separated word must match SOMEWHERE among the
 *    columns; the words are then ANDed. That is what a person means by typing
 *    a second word: narrower, not a longer literal.
 */

/** Whatever `ilike` will take: a column, a raw fragment, or an alias. */
export type Searchable = Parameters<typeof ilike>[0];

/**
 * Backslash, percent and underscore, escaped for `LIKE`.
 *
 * Postgres takes backslash as the escape character in `LIKE`/`ILIKE` by
 * default, so no `ESCAPE` clause is needed -- but the backslash itself has to
 * go first, or escaping `%` would then have its own backslash escaped.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** What the box actually asked for: trimmed, inner runs of space collapsed. */
export function normalizeSearch(raw: string | undefined | null): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * `undefined` when nothing was typed, so a caller can drop it straight into
 * `and(...)` -- Drizzle skips undefined conditions, which keeps every page
 * from writing the same `q ? cond : undefined` ternary.
 *
 * A nullable column compares as NULL rather than false, which is exactly right
 * under `or`: a customer with no company name is simply not matched by that
 * branch instead of poisoning the row.
 */
export function searchCondition(term: string, columns: Searchable[]): SQL | undefined {
  const words = term.split(' ').filter(Boolean);
  if (words.length === 0 || columns.length === 0) return undefined;

  const perWord = words.map((word) => {
    const pattern = `%${escapeLike(word)}%`;
    return or(...columns.map((column) => ilike(column, pattern)));
  });

  return and(...perWord);
}
