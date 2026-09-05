import Link from 'next/link';
import {
  PIPELINE_VIEWS, pipelineHref, type PipelineQuery, type PipelineView,
} from '@/components/pipeline/view';

/**
 * Board or list, as a segmented control sitting IN the count line.
 *
 * Three decisions, each of them the owner's complaint rather than a taste:
 *
 * NOT ITS OWN ROW. He has said twice that controls eat a phone screen before
 * any work appears -- the search box and its button were put on one row for
 * that reason, and "Show lost and complete" was moved out of a button row and
 * into this same line of prose for the same one. A view toggle used once a
 * session must not cost 44 vertical pixels every time the screen is opened, so
 * it joins the controls that are already there. It is `min-h-8` for the same
 * trade the reveal link records: a comfortable target at a third of the height
 * of a button.
 *
 * NOT A DROPDOWN. Two options behind a select is two taps and a rendered menu
 * to answer a question with two answers, and the current answer is only legible
 * once the menu is closed.
 *
 * BOTH SEGMENTS ARE LINKS, and the active one is marked `aria-current` rather
 * than merely painted. Colour is never the only carrier of state in this
 * product, and the selected segment is also the heavier of the two -- filled
 * ground, bolder text -- so which view is on is answerable at a glance and by a
 * screen reader. The inactive segment is a real navigation that keeps every
 * filter, so pressing it is never a way to lose a search.
 */
export function ViewToggle({
  basePath,
  filters,
  view,
}: {
  basePath: string;
  /** The filters in force, carried through the swap unchanged. */
  filters: PipelineQuery;
  view: PipelineView;
}) {
  return (
    <span
      // A group with a name, because "Board | List" beside a count of jobs is
      // ambiguous read aloud -- it could be two filters.
      role="group"
      aria-label="How the pipeline is drawn"
      className="inline-flex overflow-hidden rounded-control border border-line-strong"
    >
      {PIPELINE_VIEWS.map((entry, index) => {
        const active = entry.view === view;
        return (
          <Link
            key={entry.view}
            href={pipelineHref(basePath, filters, entry.view)}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex min-h-8 items-center px-2.5 ${
              index > 0 ? 'border-l border-line-strong' : ''
            } ${
              active
                ? 'bg-accent-soft font-semibold text-accent-soft-fg'
                : 'text-muted hover:bg-surface-2 hover:text-ink'
            }`}
          >
            {entry.label}
          </Link>
        );
      })}
    </span>
  );
}
