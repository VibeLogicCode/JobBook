/**
 * Today, as an ISO date, in the tenant's own timezone.
 *
 * `new Date().toISOString().slice(0, 10)` in a UTC container returns tomorrow
 * from early evening onwards, which would mark a quote expired a day before it
 * actually is -- and the person reading the screen is the one who has to
 * explain that to the customer.
 *
 * The engine has a database-side equivalent for figures that get stored. This
 * one only decides what a chip says, so it never needs a round trip.
 */
export function tenantIsoToday(timeZone: string): string {
  // The parts are read back by type, so this locale only picks the numbering
  // system, never the order or the separators. The tenant's own locale governs
  // anything a person actually reads.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const find = (type: 'year' | 'month' | 'day') =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${find('year')}-${find('month')}-${find('day')}`;
}
