import Link from 'next/link';
import { filterHref } from '@/components/ui/FilterBar';
import { Money } from '@/components/ui/Money';
import { Pill } from '@/components/ui/Pill';
import { PROJECT_STAGES, stageTone, workNoun, type ProjectStage } from '@/components/detail/labels';
import { URGENCY_TONES, urgencyChip } from '@/components/reminders/labels';
import { urgencyOf } from '@/components/reminders/urgency';
import { groupIntoColumns, spellDaysInStage, type PipelineCard } from '@/components/pipeline/columns';
import type { ReminderRow } from '@/lib/reminders/repository';

/**
 * The pipeline, as columns of stages.
 *
 * ONE DOM TREE, reflowed by CSS. The columns are a grid whose tracks are
 * `auto-fill minmax(15rem, 1fr)`, so the same markup is a board of five or six
 * columns on a monitor, two on a tablet, and ONE COLUMN PER STAGE STACKED
 * VERTICALLY on a phone -- which is the stage-grouped list the spec asks for,
 * produced by the grid rather than by a second component chosen at a
 * breakpoint. There is no board component and no list component to drift apart,
 * and every card is in the accessibility tree exactly once.
 *
 * It never scrolls sideways, at any width, and not because something clips it:
 * the tracks WRAP. A Trello-style row of columns behind a horizontal scroller
 * is the usual answer and is the wrong trade here -- the owner has four to ten
 * live jobs, the board is read on a phone in a truck, and a second scroll axis
 * buys density that six cards do not need. Wrapping means the page cannot
 * overflow no matter how many stages the enum grows.
 *
 * The filter half of "a stage-filtered list" is the stage select in the filter
 * bar, and each column heading is a shortcut into it: tapping a stage narrows
 * the board to that one column, which is how a long stacked scroll becomes a
 * short list without leaving the screen.
 *
 * What the cards do NOT do is move. Stage changes go through `setProjectStage`,
 * which refuses a job returning to a quoting stage, refuses `won` set by hand,
 * and demands a reason for `on_hold` and `lost`. A drag that bypassed those
 * would be a lie, and a drag that silently failed them would be worse than one;
 * the card links to the record, where the control that enforces the rules is.
 */

export interface BoardProps {
  cards: readonly PipelineCard[];
  /** Which columns to draw, left to right. From `boardStages`. */
  stages: readonly ProjectStage[];
  /** The next open reminder per project id, from `nextReminderByProject`. */
  reminderOf: ReadonlyMap<string, ReminderRow>;
  /** The tenant's today. Never the server's, and never the browser's. */
  today: string;
  basePath: string;
  /**
   * The filters in force, so a column heading can narrow to its own stage
   * without dropping the search somebody has already typed.
   */
  filters: { q: string; kind: string; closed: string };
  /** True when the stage select has already narrowed this to one column. */
  stageFiltered: boolean;
}

export function Board({
  cards,
  stages,
  reminderOf,
  today,
  basePath,
  filters,
  stageFiltered,
}: BoardProps) {
  const columns = groupIntoColumns(stages, cards);

  return (
    <ol
      className="grid gap-3"
      // In a style rather than an arbitrary class so the `min()` reads as CSS.
      // `min(15rem, 100%)` and not a bare `15rem`: a lone track wider than its
      // container is exactly how a grid pushes a page sideways on a 320px
      // phone, and `auto-fill` will happily lay one down.
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(15rem, 100%), 1fr))' }}
    >
      {columns.map((column) => (
        <li
          key={column.stage}
          // The one thing CSS hides, and only below `sm`: a stage nothing is
          // sitting in. Above the breakpoint the empty column is the shape of
          // the board and says the stage exists; stacked on a phone it is a
          // heading with nothing under it, six of which turn the list of work
          // into a list of stages. Nothing that could hold a figure is hidden
          // -- an empty column holds no cards to hide.
          className={`min-w-0 ${column.cards.length === 0 ? 'max-sm:hidden' : ''}`}
        >
          <section className="flex h-full flex-col rounded-panel border border-line bg-surface-2">
            <h2 className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2">
              {stageFiltered ? (
                <Pill tone={stageTone(column.stage)}>{PROJECT_STAGES[column.stage]}</Pill>
              ) : (
                <Link
                  href={filterHref(basePath, { ...filters, stage: column.stage })}
                  className="rounded-control hover:underline"
                >
                  <Pill tone={stageTone(column.stage)}>{PROJECT_STAGES[column.stage]}</Pill>
                </Link>
              )}
              <span className="num t-small text-muted">{column.cards.length}</span>
              {/* Only when there is something to say. A column of opportunities
                  showing $0.00 reads as work worth nothing, when what is true
                  is that none of it has been won yet. */}
              {column.wonCents > 0 ? (
                <Money cents={column.wonCents} plain className="ml-auto t-small" />
              ) : null}
            </h2>

            {column.cards.length === 0 ? (
              <p className="px-3 py-3 t-small text-muted">Nothing here.</p>
            ) : (
              <ol className="grid gap-2 p-2">
                {column.cards.map((card) => (
                  <ProjectCard
                    key={card.id}
                    card={card}
                    reminder={reminderOf.get(card.id)}
                    today={today}
                  />
                ))}
              </ol>
            )}
          </section>
        </li>
      ))}
    </ol>
  );
}

function ProjectCard({
  card,
  reminder,
  today,
}: {
  card: PipelineCard;
  reminder: ReminderRow | undefined;
  today: string;
}) {
  const urgency = reminder ? urgencyOf(reminder, today) : null;

  return (
    <li className="rounded-panel border border-line bg-surface p-3">
      {/* h3 because the column heading above it is the h2. */}
      <h3 className="t-small font-semibold">
        <Link href={`/projects/${card.id}`} className="break-words text-accent-text hover:underline">
          {card.name}
        </Link>
      </h3>

      <p className="break-words t-small text-muted">{card.customerName}</p>

      <p className="mt-1 t-small text-subtle">
        {workNoun(card.isJob)} · <span className="num">{card.projectNumber}</span>
      </p>

      {/* Contract value, derived from accepted quotes and nowhere else. An
          opportunity is told apart from a job worth nothing by words, not by a
          zero: "$0.00" on every card left of `won` would make the board read as
          a pipeline with no money in it. */}
      <p className="mt-1 t-small">
        {card.contractValueCents > 0 ? (
          <Money cents={card.contractValueCents} plain />
        ) : (
          <span className="text-muted">Not won yet</span>
        )}
      </p>

      <p className="t-small text-muted">{spellDaysInStage(card.daysInStage)}</p>

      {card.startsOn ? (
        <p className="t-small text-muted">
          Starts <span className="num">{card.startsOn}</span>
        </p>
      ) : null}

      {reminder && urgency ? (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2 t-small">
          <Pill tone={URGENCY_TONES[urgency]}>{urgencyChip(urgency, reminder, today)}</Pill>
          <span className="break-words text-muted">{reminder.title}</span>
        </p>
      ) : null}
    </li>
  );
}
