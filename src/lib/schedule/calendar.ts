import { addDays } from '@/lib/quote/dates';

/**
 * Every day the schedule counts, counted in one place.
 *
 * **The schedule works in CALENDAR days, not working days.** A residential
 * crew working a Saturday is ordinary rather than exceptional, and skipping
 * weekends properly needs a per-province statutory holiday table -- Family Day
 * is February in Ontario and nowhere at all in Quebec -- which is its own
 * small project. The plan proposes calendar days and says the decision is
 * cheap to revisit *because the arithmetic lives in one function*.
 *
 * This file is that promise being kept. Nothing anywhere else in the schedule
 * adds a day, subtracts a day, or counts the days between two of them. Turning
 * the product on to working days is `shiftDays`, `daysBetween` and
 * `durationDays` learning about a calendar, and no other file changing.
 *
 * The shift itself is `addDays` from the quote engine, reused rather than
 * rewritten: it already does the one thing that matters, which is staying in
 * the date domain so no timezone or daylight-saving transition can move a
 * result by a day.
 */

/**
 * An ISO date as days since the epoch.
 *
 * The only place a date is taken apart in the scheduling code. Kept private:
 * a caller that needs a number of days asks `daysBetween`, and a caller that
 * needs a date asks `shiftDays`, so no screen and no action ever holds a
 * millisecond.
 */
function epochDay(isoDate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match || !isCalendarDate(isoDate)) {
    throw new Error(`expected an ISO date, received ${isoDate}`);
  }
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000;
}

/**
 * Is this a date that EXISTS, as opposed to one merely shaped like a date?
 *
 * The shape check on its own is not a validation, and the way it fails is the
 * dangerous kind. `Date.UTC(2026, 12, 40)` does not complain -- JavaScript
 * rolls the surplus over and hands back 2027-02-09. So `2026-13-40` matches
 * `\d{4}-\d{2}-\d{2}`, survives every arithmetic function in this file, and
 * renders a screen for a month fourteen months away from the one the URL
 * names. Nothing throws and nothing looks wrong.
 *
 * The round trip is the test: take the date apart, put it back together, and
 * see whether it is still the same string. A date that exists survives that
 * unchanged; one that rolled over comes back as the day it rolled over to.
 *
 * Exported because the check belongs at the boundary too -- `readAnchor` reads
 * a date out of a URL, where a hand-edited or stale query parameter is
 * ordinary rather than exceptional, and the right answer there is to fall back
 * to today rather than to throw a 500 at somebody who mistyped.
 */
export function isCalendarDate(isoDate: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return false;
  const [, year, month, day] = match;
  const stamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return new Date(stamp).toISOString().slice(0, 10) === isoDate;
}

/** A date, some days later. Negative pulls it earlier. */
export function shiftDays(isoDate: string, days: number): string {
  return addDays(isoDate, days);
}

/**
 * Calendar days from one date to another, signed.
 *
 * `daysBetween('2026-03-10', '2026-03-13')` is 3. Same day is 0, and going
 * backwards is negative -- which is what makes pulling a date earlier the same
 * code path as pushing it later rather than a second branch nobody tests.
 */
export function daysBetween(from: string, to: string): number {
  return epochDay(to) - epochDay(from);
}

/**
 * How long a task takes, counting both end days.
 *
 * A task that starts and finishes on the same day takes one day, not zero.
 * That is how somebody describes their own week, and getting it wrong shows up
 * as a schedule that is one day short per task.
 */
export function durationDays(start: string, end: string): number {
  return daysBetween(start, end) + 1;
}

/**
 * When a task starts, given what it waits on and the gap it waits for.
 *
 * Lag zero is the next morning. That is the convention every scheduling tool
 * uses and the one a person means by "drywall follows framing": nothing starts
 * the same day the thing before it finishes.
 */
export function startAfter(predecessorEnd: string, lagDays: number): string {
  return shiftDays(predecessorEnd, lagDays + 1);
}

/**
 * The inverse: the gap two tasks currently sit at.
 *
 * This is what makes `lag_days` a derived column rather than a typed one. The
 * owner moves dates; the lag is read back off them. A lag somebody typed and a
 * gap the dates show are two answers to one question, and the wrong one is
 * always the one on screen.
 */
export function lagBetween(predecessorEnd: string, start: string): number {
  return daysBetween(predecessorEnd, start) - 1;
}

/** The latest of a set of dates, or null when the set is empty. */
export function latestDate(dates: readonly string[]): string | null {
  let latest: string | null = null;
  for (const date of dates) {
    // ISO dates compare correctly as strings, which is the reason the column
    // is `date` and the wire format is ISO rather than anything friendlier.
    if (latest === null || date > latest) latest = date;
  }
  return latest;
}
