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
  if (!match) throw new Error(`expected an ISO date, received ${isoDate}`);
  const [, year, month, day] = match;
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** The calendar year of an ISO date, for the document series. */
export function yearOf(isoDate: string): number {
  const match = /^(\d{4})-/.exec(isoDate);
  if (!match) throw new Error(`expected an ISO date, received ${isoDate}`);
  return Number(match[1]);
}
