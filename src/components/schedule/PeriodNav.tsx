import Link from 'next/link';
import { dayFormatter } from '@/app/projects/[id]/schedule/schema';
import {
  PERIOD_LABELS,
  PERIODS,
  periodParam,
  rangeOf,
  stepAnchor,
  type Period,
} from '@/lib/schedule/agenda';
import { SegmentedLinks } from '@/components/ui/SegmentedLinks';
import { filterHref } from '@/components/ui/FilterBar';

/**
 * Where in the calendar we are, and the controls that move it -- the
 * Day/Week/Month control and the prev/next/today buttons that used to be
 * written inline in `/calendar`'s page, now shared with the job schedule's own
 * calendar view.
 *
 * It takes a base path and a `carry` bag rather than assuming one address,
 * because the two screens it serves are not at the same URL and do not carry
 * the same extra parameters: `/calendar` carries a search, a job filter and a
 * person filter; the job schedule's calendar view carries only `view=calendar`
 * so stepping a week does not silently drop back to the list. Either way,
 * `task` is deliberately NOT carried -- stepping the period or jumping to
 * Today closes whatever sheet happens to be open, the same way the calendar's
 * own `closeHref` does, because a block from the day just left behind is not
 * a thing either screen should still be showing.
 */
export function PeriodNav({
  basePath,
  carry,
  period,
  anchor,
  today,
  locale,
  extra,
}: {
  basePath: string;
  /** Parameters besides `period` and `on` to keep on every link this draws. Empty values are dropped. */
  carry: Record<string, string | undefined>;
  period: Period;
  anchor: string;
  today: string;
  locale: string;
  /** Drawn at the end of the prev/next/today row -- the calendar's own "N with nobody booked". */
  extra?: React.ReactNode;
}) {
  const linkTo = (nextPeriod: Period, nextAnchor: string) =>
    filterHref(basePath, {
      ...carry,
      period: periodParam(nextPeriod),
      on: nextAnchor === today ? '' : nextAnchor,
    });

  const range = rangeOf(period, anchor);
  const day = dayFormatter(locale);
  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const rangeLabel =
    period === 'day'
      ? day(range.start)
      : period === 'week'
        ? `${day(range.start)} – ${day(range.end)}`
        : monthLabel.format(new Date(`${range.start}T00:00:00Z`));

  // `relative` because of the `sr-only` labels inside: `.sr-only` is
  // `position: absolute`, and without a positioned ancestor the browser hands
  // it the page as its containing block -- which is how an offscreen span ends
  // up widening the document and giving a phone a horizontal scrollbar. Same
  // trap `PageParentLink` and the rail's collapsed labels record.
  const stepClass =
    'relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-line-strong px-3 t-small text-ink hover:bg-surface-2';

  return (
    <div className="mb-3 flex flex-col gap-2">
      <SegmentedLinks
        ariaLabel="How much of the calendar is on screen"
        options={PERIODS.map((entry) => ({
          href: linkTo(entry, anchor),
          label: PERIOD_LABELS[entry],
          active: entry === period,
        }))}
      />

      {/* Links, not buttons: each is a navigation, so the back button works
          and a week can be sent to somebody. */}
      <div className="flex flex-wrap items-center gap-2">
        <Link href={linkTo(period, stepAnchor(period, anchor, -1))} className={stepClass}>
          <span aria-hidden>‹</span>
          <span className="sr-only">Previous {PERIOD_LABELS[period].toLowerCase()}</span>
        </Link>
        <Link href={linkTo(period, stepAnchor(period, anchor, 1))} className={stepClass}>
          <span aria-hidden>›</span>
          <span className="sr-only">Next {PERIOD_LABELS[period].toLowerCase()}</span>
        </Link>
        <Link href={linkTo(period, today)} className={stepClass}>
          Today
        </Link>
        <h2 className="min-w-0 t-heading">{rangeLabel}</h2>
        {extra}
      </div>
    </div>
  );
}
