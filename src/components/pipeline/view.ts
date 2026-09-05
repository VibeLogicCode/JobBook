import { filterHref } from '@/components/ui/FilterBar';

/**
 * Which of the pipeline's two renderings is on screen, read from the URL and
 * stored nowhere.
 *
 * The board and the list are two ways of drawing ONE query. They share the
 * filters, the closed-record rule, the derived contract value and the
 * opportunity-or-job test; what differs is the markup underneath. This module
 * owns only the choice between them, so the page reads the parameter once and
 * both the toggle and the renderer answer to the same value.
 *
 * WHY THE URL AND NOT A COOKIE. The state of every list screen in this product
 * is its URL: the back button works because each filter is a navigation, a
 * filtered view can be sent to somebody, and the server renders what the
 * address says. A remembered view is a SECOND source of truth, and the two
 * disagree the first time it matters -- somebody sends "here is the job, in the
 * list, look at the contract column" and it opens as a board because the reader
 * once pressed Board on another screen. The cost of not remembering is one tap
 * per visit, on a control that is always on screen. That is the cheaper of the
 * two mistakes, and it is reversible: a stored preference can be added later
 * over a URL that already carries the answer, but a URL cannot be recovered
 * from a cookie.
 */
export type PipelineView = 'board' | 'list';

/**
 * The board, and the reason is what each view is FOR.
 *
 * The owner runs four to ten live jobs. The question he opens this screen with
 * is "what is stuck and what is next", which is a question about position --
 * eleven leads and nothing at `quote_sent` is a sentence the board says by its
 * shape and the list can only say by being counted. The list answers the other
 * question, "what is the whole book worth and which row is which", and it
 * answers it better than the board ever did -- but it is the second question.
 *
 * It is also what `/projects` already does today, and every link into this
 * screen from the rest of the app is a bare `/projects`. A default that changed
 * would silently re-answer all of them.
 */
export const DEFAULT_VIEW: PipelineView = 'board';

export const PIPELINE_VIEWS: { view: PipelineView; label: string }[] = [
  { view: 'board', label: 'Board' },
  { view: 'list', label: 'List' },
];

/** Anything that is not the other view is the default. An unknown value is not an error page. */
export function readView(raw: string | undefined): PipelineView {
  return raw === 'list' ? 'list' : DEFAULT_VIEW;
}

/**
 * The `view` parameter as a URL carries it: empty for the default.
 *
 * `filterHref` drops empty values, so the board keeps the plain `/projects`
 * address it has always had and only a deliberate choice of the list shows up
 * in the URL. A default spelled out in every link is a default that looks like
 * a decision.
 */
export function viewParam(view: PipelineView): string {
  return view === DEFAULT_VIEW ? '' : view;
}

/** What the screen was asked for, in the order a URL says it. */
export interface PipelineQuery {
  q: string;
  stage: string;
  kind: string;
  /** The `closed` parameter, `'1'` when the reveal is on. */
  closed: string;
}

/**
 * A link to this screen with the filters kept and the view swapped.
 *
 * Every filter travels, which is the point: switching view is a change of
 * rendering and never a change of what is being rendered. A toggle that dropped
 * the search would be a toggle nobody uses twice.
 */
export function pipelineHref(basePath: string, filters: PipelineQuery, view: PipelineView): string {
  return filterHref(basePath, { ...filters, view: viewParam(view) });
}
