import Link from 'next/link';
import { weekStart, type CalendarDay } from '@/lib/schedule/agenda';
import { shiftDays } from '@/lib/schedule/calendar';

/**
 * The day cells — one DOM tree for all three periods, reflowed by CSS.
 *
 * The layout argument lives in `globals.css` beside the rules that carry it
 * out, next to `.data-table--stack`, which is the same ruling applied to a
 * table. What this file owes that decision is the discipline: no width is
 * tested here, nothing is conditionally rendered on a breakpoint, and a day
 * with nothing in it is emitted exactly like a day that is full. The only
 * thing the markup says about a cell is whether it HOLDS anything --
 * `data-empty` -- and the stylesheet decides what that is worth at each width.
 *
 * `--calendar-column` is the one number that crosses over. `CalendarDay.column`
 * is already `weekdayIndex + 1`, so it drops into `grid-column-start` unchanged
 * and the first row of a month begins on the weekday the month begins on. It is
 * written as a custom property rather than as `gridColumnStart` directly
 * because the stacked single column must NOT honour it -- an explicit column
 * start in a one-column grid invents the other six.
 */

/** A task's own dates, said the way the schedule screen says them. */
function headingFormats(locale: string) {
  return {
    weekday: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }),
    // `timeZone: 'UTC'` for the reason `dayFormatter` gives: these are
    // date-only values, and rendering one west of UTC prints the day before.
    date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }),
  };
}

function format(formatter: Intl.DateTimeFormat, isoDay: string): string {
  return formatter.format(new Date(`${isoDay}T00:00:00Z`));
}

export function CalendarGrid({
  days,
  columns,
  locale,
  today,
  taskHref,
}: {
  days: readonly CalendarDay[];
  /** Seven for a week or a month, one for a day. The stacked width ignores it. */
  columns: 1 | 7;
  locale: string;
  /** The tenant's own date, so the marker is not the server's idea of now. */
  today: string;
  /** Where tapping an entry goes — `?task=<id>`, so the editor is server-rendered. */
  taskHref: (taskId: string) => string;
}) {
  const formats = headingFormats(locale);
  const columnAttribute = String(columns);

  /**
   * Monday first, named in the tenant's locale.
   *
   * Derived from the Monday of the first day on screen rather than from a list
   * of English words, so a French tenant reads "lun." and the order still
   * matches `weekdayIndex`, which is Monday-zero for the reason `agenda.ts`
   * gives: a work week is not a consumer calendar and a weekend should read as
   * one thing at the end of the row.
   */
  const monday = days.length > 0 ? weekStart(days[0]!.date) : today;
  const weekdayNames = Array.from({ length: 7 }, (_, offset) =>
    format(formats.weekday, shiftDays(monday, offset)),
  );

  return (
    <div>
      {/* Presentational: every cell carries its own date, so these seven words
          are a second announcement of the same thing to a screen reader.

          Absent for the day period, which is the one branch here on the PERIOD
          rather than on a width -- a day has no columns to name at any size,
          where a week and a month have seven the moment there is room. Whether
          they are drawn at a given width stays the stylesheet's decision. */}
      {columns === 7 ? (
        <div aria-hidden className="calendar-weekdays mb-1" data-columns={columnAttribute}>
          {weekdayNames.map((name) => (
            <span key={name} className="px-2 t-micro uppercase text-subtle">
              {name}
            </span>
          ))}
        </div>
      ) : null}

      <ol className="calendar-grid" data-columns={columnAttribute}>
        {days.map((day) => {
          const shown = day.entries.filter((entry) => entry.visible);
          // A day holding a clash is never empty even when a filter has taken
          // every line off it: the collision still happened, and the cell is
          // where the warning above points.
          const empty = shown.length === 0 && day.clashCount === 0;

          return (
            <li
              key={day.date}
              data-empty={empty ? 'true' : 'false'}
              style={{ '--calendar-column': day.column } as React.CSSProperties}
              // `min-w-0`: a grid item's default `min-width: auto` lets its
              // content push a column wider than the track, and a month at 7
              // columns has no width to spare.
              className={`min-w-0 rounded-panel border p-2 ${
                day.clashCount > 0 ? 'border-warning bg-warning-soft' : 'border-line bg-surface'
              }`}
            >
              <p className="mb-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                <span className="calendar-cell-weekday t-micro uppercase text-subtle">
                  {format(formats.weekday, day.date)}
                </span>
                <span className="num t-small font-semibold">{format(formats.date, day.date)}</span>
                {day.date === today ? (
                  <span className="t-micro uppercase text-accent-text">Today</span>
                ) : null}
                {day.clashCount > 0 ? (
                  <span className="t-micro uppercase text-warning-soft-fg">
                    {day.clashCount === 1 ? 'Double-booked' : `${day.clashCount} double-booked`}
                  </span>
                ) : null}
              </p>

              <ol className="flex flex-col gap-1">
                {shown.map((entry) => (
                  <li key={entry.key}>
                    {/* The whole line is the target and it is 44px tall, because
                        this is tapped with a glove on. Tapping opens the editor
                        from the URL, so it works before the page has hydrated. */}
                    <Link
                      href={taskHref(entry.taskId)}
                      className={`flex min-h-11 flex-col justify-center break-words rounded-control border px-2 py-1 hover:border-accent ${
                        entry.clashesWith.length > 0
                          ? 'border-warning bg-warning-soft text-warning-soft-fg'
                          : entry.who === null
                            ? 'border-dashed border-line-strong bg-surface-2'
                            : 'border-line bg-surface-2'
                      }`}
                    >
                      <span className="t-small font-semibold">
                        {/* Said in words rather than left blank, the way the job
                            schedule says "Nobody yet": a blank reads as missing
                            data, and this is a question nobody has answered. */}
                        {entry.who ?? 'Nobody booked'}
                      </span>
                      <span className="t-small">
                        {entry.taskName}
                        {entry.isMilestone ? ' · milestone' : ''}
                      </span>
                      <span className="t-micro uppercase text-subtle">{entry.projectNumber}</span>
                      {entry.clashesWith.length > 0 ? (
                        <span className="t-micro">Also on {entry.clashesWith.join(', ')}</span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
