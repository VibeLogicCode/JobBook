import { sql } from 'drizzle-orm';
import type { db as Database } from '@/db/client';

type Tx = Parameters<Parameters<typeof Database.transaction>[0]>[0];

/**
 * Today, in the tenant's own timezone, as an ISO date.
 *
 * `new Date().toISOString().slice(0, 10)` in a UTC container returns tomorrow
 * after 7pm Toronto, which would date a quote a day ahead of the conversation
 * that produced it and push valid_until with it.
 */
export async function tenantToday(tx: Tx): Promise<string> {
  const rows = await tx.execute(sql`
    select to_char((now() at time zone coalesce(o.timezone, 'UTC'))::date, 'YYYY-MM-DD') as today
    from organization o
    where o.id = 1
  `);
  const today = (rows as unknown as { today: string }[])[0]?.today;
  if (!today) throw new Error('organization row is missing; run setup first');
  return today;
}

/**
 * Adds days to an ISO date, staying in the date domain.
 *
 * Arithmetic runs in UTC on a date-only value, so no timezone or daylight
 * saving shift can move the result: adding 30 days to a quote issued the day
 * before the clocks change must still land on the same calendar day.
 */
export function addDays(isoDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match || !isCalendarDate(isoDate)) {
    throw new Error(`expected an ISO date, received ${isoDate}`);
  }
  const [, year, month, day] = match;
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Is this a date that EXISTS, as opposed to one merely shaped like a date?
 *
 * The shape check on its own is not a validation, and it fails in the
 * dangerous direction. `Date.UTC(2026, 12, 40)` does not complain -- JavaScript
 * rolls the surplus over and returns 2027-02-09 -- so `2026-13-40` matched
 * `\d{4}-\d{2}-\d{2}`, did arithmetic, and produced an answer fourteen months
 * from the one it was asked about. Nothing threw.
 *
 * The round trip is the test: take the date apart, put it back together, and
 * see whether it is still the same string. A date that exists survives
 * unchanged; one that rolled over comes back as the day it rolled over to.
 *
 * It lives beside `addDays` because that is the function it protects, and
 * because the quote engine must not import from the schedule to validate a
 * date. `lib/schedule/calendar.ts` re-exports it for the callers that found it
 * there first.
 */
export function isCalendarDate(isoDate: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return false;
  const [, year, month, day] = match;
  const stamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return new Date(stamp).toISOString().slice(0, 10) === isoDate;
}

/** The calendar year of an ISO date, for the document series. */
export function yearOf(isoDate: string): number {
  const match = /^(\d{4})-/.exec(isoDate);
  if (!match) throw new Error(`expected an ISO date, received ${isoDate}`);
  return Number(match[1]);
}
