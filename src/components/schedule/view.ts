import { filterHref } from '@/components/ui/FilterBar';

/**
 * Which of the job schedule's two renderings is on screen, read from the URL
 * and stored nowhere. Mirrors `components/pipeline/view.ts` exactly in shape,
 * for the same reason that one gives: the state of every list screen in this
 * product is its URL, so a shared address can be sent, bookmarked, and
 * survives the back button.
 */
export type ScheduleView = 'list' | 'calendar';

/**
 * The list, because the owner asked for it: *"shouldn't i have a button here
 * to switch from calendar to list view? similar to pipeline page? default
 * should be list."*
 *
 * It is also what `/projects/[id]/schedule` already does today, and every
 * link into this screen is a bare `.../schedule`. A default that changed
 * would silently re-answer all of them.
 */
export const DEFAULT_VIEW: ScheduleView = 'list';

export const SCHEDULE_VIEWS: { view: ScheduleView; label: string }[] = [
  { view: 'list', label: 'List' },
  { view: 'calendar', label: 'Calendar' },
];

/** Anything that is not the other view is the default. An unknown value is not an error page. */
export function readScheduleView(raw: string | undefined): ScheduleView {
  return raw === 'calendar' ? 'calendar' : DEFAULT_VIEW;
}

/**
 * The `view` parameter as a URL carries it: empty for the default.
 *
 * `filterHref` drops empty values, so the list keeps the plain
 * `/projects/[id]/schedule` address it has always had and only a deliberate
 * choice of the calendar shows up in the URL.
 */
export function viewParam(view: ScheduleView): string {
  return view === DEFAULT_VIEW ? '' : view;
}

/** What the screen was asked for, in the order a URL says it. */
export interface ScheduleQuery {
  /** The `voided` parameter, `'1'` when voided tasks are shown. Only the list view reads it. */
  voided: string;
}

/**
 * A link to this screen with the other parameters kept and the view swapped.
 *
 * `voided` travels because it is a real filter and switching view is a change
 * of rendering, never a change of what is being asked for. `period` and `on`
 * do NOT travel -- they are not in `ScheduleQuery` at all -- because they are
 * meaningless to the list and the calendar view's own defaults (this week,
 * today) are the right place to land coming from a screen that had no
 * period of its own.
 */
export function scheduleHref(basePath: string, filters: ScheduleQuery, view: ScheduleView): string {
  return filterHref(basePath, { ...filters, view: viewParam(view) });
}
