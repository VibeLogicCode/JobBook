/**
 * How long a list is allowed to be.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * There was no pagination anywhere in the product: `.limit(` appeared twice in
 * the whole codebase, both existence checks inside actions. Every list screen
 * selected its entire table and filtered in JavaScript. At three quotes that is
 * invisible; at eighteen months of a working business it is the thing that
 * makes the app feel broken, and `reminders` gets there first because the
 * hourly evaluator writes it.
 *
 * ---------------------------------------------------------------------------
 * WHY A CAP AND A "SHOW MORE", NOT PAGE NUMBERS
 * ---------------------------------------------------------------------------
 *
 * Page numbers need a total, and a total needs a second `count(*)` over the
 * same filtered set on every load -- paying twice to tell somebody they are on
 * page 3 of 47, which is not a fact anybody acts on. Cursors are correct and
 * they are also a rewrite of six screens and every filter they carry.
 *
 * What an owner actually does is search. So: the most recent `LIST_PAGE` rows,
 * an honest line saying there are more, and a link that doubles the window. It
 * is one query, it keeps every existing filter working untouched, and the
 * common case -- "where is that quote from last week" -- is answered by the
 * first screen without pressing anything.
 *
 * ---------------------------------------------------------------------------
 * WHY 200
 * ---------------------------------------------------------------------------
 *
 * Big enough that a contractor with a normal year never meets it: 200 quotes
 * is more than most of these businesses write annually, so the cap is
 * invisible until it is genuinely needed. Small enough that the query is
 * bounded work against an index rather than a full scan, and that the RSC
 * payload stays sane on a phone.
 */
export const LIST_PAGE = 200;

/** The hard ceiling a URL can ask for, so `?limit=1000000` is not a table scan. */
const LIST_MAX = 2000;

/**
 * The window a request asked for, clamped.
 *
 * Anything absent, unparseable, negative or beyond the ceiling falls back to
 * one page -- a query string is somebody's address bar, not a promise.
 */
export function listLimit(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return LIST_PAGE;
  return Math.min(Math.ceil(parsed), LIST_MAX);
}

/**
 * Splits a deliberately over-fetched result into what to show and whether more
 * exists.
 *
 * The caller asks the database for `limit + 1` rows. If that extra row comes
 * back there is more to see, and the screen can say so WITHOUT a second
 * counting query -- one row of over-fetch instead of a `count(*)` over the
 * same filtered set.
 */
export function listSlice<T>(rows: readonly T[], limit: number): { visible: T[]; more: boolean } {
  const more = rows.length > limit;
  return { visible: more ? rows.slice(0, limit) : [...rows], more };
}

/** The window to ask for next, doubling until the ceiling. */
export function nextLimit(limit: number): number {
  return Math.min(limit * 2, LIST_MAX);
}
