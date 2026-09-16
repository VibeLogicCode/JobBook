import Link from 'next/link';
import { filterHref } from '@/components/ui/FilterBar';
import { Money } from '@/components/ui/Money';
import { Pill } from '@/components/ui/Pill';
import { PROJECT_STAGES, stageTone } from '@/components/detail/labels';
import { URGENCY_TONES, urgencyChip } from '@/components/reminders/labels';
import { urgencyOf } from '@/components/reminders/urgency';
import {
  formatWholeDollars, groupIntoColumns, spellStarts, spellTiming,
  type BoardFilters, type PipelineCard,
} from '@/components/pipeline/columns';
import type { ReminderRow } from '@/lib/reminders/repository';

/**
 * The pipeline: two bands, each a grid of stage columns.
 *
 * ONE DOM TREE, reflowed by CSS. Every grid's tracks are
 * `auto-fill minmax(min(14rem, 100%), 1fr)`, so the same markup is a row of
 * columns on a monitor and ONE COLUMN PER STAGE STACKED VERTICALLY on a phone
 * -- which is the stage-grouped list the spec asks for, produced by the grid
 * rather than by a second component chosen at a breakpoint. There is no board
 * component and no list component to drift apart, and every card is in the
 * accessibility tree exactly once.
 *
 * TWO BANDS RATHER THAN ONE GRID, because one `auto-fill` grid over nine
 * stages wrapped wherever the viewport ran out: at one width `Won` sat under
 * `Lead` and `In progress` under `Site visit`, at another it was three and
 * three and one. A board's whole advantage over a table is that position
 * carries meaning, and a wrap that lands where the arithmetic happens to put
 * it destroys exactly that. Split in two, the first row is the sales funnel
 * and the second is delivery, so a wrap can only ever happen INSIDE one of
 * those -- the wrap becomes meaning instead of accident. `columns.ts` owns
 * which stage is in which band, including `On hold` being in both.
 *
 * It never scrolls sideways, at any width, and not because something clips it:
 * the tracks WRAP. A Trello-style row of columns behind a horizontal scroller
 * is the usual answer and is the wrong trade here -- the owner has four to ten
 * live jobs, the board is read on a phone in a truck, and a second scroll axis
 * buys density that six cards do not need.
 *
 * `items-start` on each grid, so a stage nothing is sitting in is a heading
 * with one line under it rather than an empty slab stretched to the height of
 * the fullest column beside it.
 *
 * The filter half of "a stage-filtered list" is the stage select in the filter
 * bar, and each column heading is a shortcut into it: tapping a stage narrows
 * the board to that one column, and tapping it again -- the heading stays a
 * link when the board is already narrowed -- widens it back without dropping
 * the search somebody has typed.
 *
 * What the cards do NOT do is move. Stage changes go through `setProjectStage`,
 * which refuses a job returning to a quoting stage, refuses `won` set by hand,
 * and demands a reason for `on_hold` and `lost`. A drag that bypassed those
 * would be a lie, and a drag that silently failed them would be worse than one;
 * the card links to the record, where the control that enforces the rules is.
 */

export interface BoardProps {
  cards: readonly PipelineCard[];
  /** The next open reminder per project id, from `nextReminderByProject`. */
  reminderOf: ReadonlyMap<string, ReminderRow>;
  /** The tenant's today. Never the server's, and never the browser's. */
  today: string;
  basePath: string;
  /**
   * The filters in force. They choose the columns AND build the heading links,
   * from one value rather than two, so the board cannot narrow to a stage its
   * own heading does not link to.
   */
  filters: BoardFilters;
  /** Whether the finished stages are being shown. From `showsClosed`. */
  showClosed: boolean;
}

// `min(14rem, 100%)` and not a bare `14rem`: a lone track wider than its
// container is exactly how a grid pushes a page sideways on a 320px phone, and
// `auto-fill` will happily lay one down. In a style rather than an arbitrary
// class so the `min()` reads as CSS.
const TRACKS = { gridTemplateColumns: 'repeat(auto-fill, minmax(min(14rem, 100%), 1fr))' };

export function Board({ cards, reminderOf, today, basePath, filters, showClosed }: BoardProps) {
  const bands = groupIntoColumns({ ...filters, showClosed }, cards);
  const stageFiltered = filters.stage !== '';
  // What a heading link has to carry forward. `stage` is deliberately absent:
  // each link supplies its own, or omits it to widen back out.
  const kept = { q: filters.q, kind: filters.kind, closed: filters.closed };

  return (
    <div className="flex flex-col gap-4">
      {bands.map((band) => (
        <section
          key={band.band}
          // Same rule as an empty column, one level up: above `sm` a half with
          // nothing in it is the shape of the board and says the half exists;
          // stacked on a phone it is a heading and three "Nothing here"s
          // between the reader and the work. Nothing that could hold a figure
          // is hidden -- a band with no cards holds no money either.
          className={band.count === 0 ? 'max-sm:hidden' : ''}
        >
          <h2 className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="t-heading">{band.heading}</span>
            <span className="num t-small text-muted">{band.count}</span>
            {/* The one dominant figure on the page, and only ever on Jobs:
                won value is what an accepted quote produces, so the
                Opportunities band has none by definition rather than by a
                rule. Whole dollars -- the cards keep the cents. */}
            {band.wonCents > 0 ? (
              /* Labelled, because an unattributed figure floating at the right
                 edge of a heading is a number the reader has to guess at --
                 and the guesses available here are all plausible and mostly
                 wrong. It is the contract value of the jobs in this band. */
              <span className="ml-auto flex items-baseline gap-2">
                <span className="t-small text-muted">under contract</span>
                <span className="num t-heading">{formatWholeDollars(band.wonCents)}</span>
              </span>
            ) : null}
          </h2>

          <ol className="grid items-start gap-3" style={TRACKS}>
            {band.columns.map((column) => (
              <li
                key={column.stage}
                // The one thing CSS hides, and only below `sm`: a stage
                // nothing is sitting in. Above the breakpoint the empty column
                // is the shape of the band; stacked on a phone it is a heading
                // with nothing under it, six of which turn the list of work
                // into a list of stages.
                className={`min-w-0 ${column.cards.length === 0 ? 'max-sm:hidden' : ''}`}
              >
                <section className="flex flex-col rounded-panel card-surface-2">
                  {/* Sticky at EVERY width. It was `max-sm:` only, on the
                      reasoning that stacked columns are the case where one
                      fills the screen -- but a desktop column of fifteen leads
                      scrolls the page just as far, and the reader arrives at
                      the bottom of it no longer sure which stage they are
                      reading. Same question, same answer, whatever the layout.

                      It works because nothing between here and the document
                      sets `overflow` -- `Card` records why it refuses
                      `overflow-hidden`, and this is the other half of that
                      lesson. `bg-surface-2` is not decoration: a sticky
                      heading with a transparent background has cards sliding
                      through its text. */}
                  <h3 className="sticky top-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface-2 px-3 py-2">
                    <Link
                      href={
                        stageFiltered
                          ? filterHref(basePath, kept)
                          : filterHref(basePath, { ...kept, stage: column.stage })
                      }
                      // Said in full because the link's job reverses: on a
                      // narrowed board it is the only way back that does not
                      // also throw away the search. Without this the pill read
                      // "Lead" whichever direction it went.
                      aria-label={`${PROJECT_STAGES[column.stage]} — ${
                        stageFiltered ? 'show every stage' : 'show only this stage'
                      }`}
                      // `inline-flex min-h-11`: a Pill is about 20px tall and
                      // this is the board's primary narrowing control, pressed
                      // with a thumb. The pill keeps its size; the target grows
                      // around it.
                      className="inline-flex min-h-11 items-center rounded-control px-1 hover:underline"
                    >
                      <Pill tone={stageTone(column.stage)}>{PROJECT_STAGES[column.stage]}</Pill>
                    </Link>
                    <span className="num t-small text-muted">{column.cards.length}</span>
                    {/* Only when there is something to say. A column of
                        opportunities showing $0 reads as work worth nothing,
                        when what is true is that none of it has been won. */}
                    {column.wonCents > 0 ? (
                      <span className="num ml-auto t-small">
                        {formatWholeDollars(column.wonCents)}
                      </span>
                    ) : null}
                  </h3>

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
        </section>
      ))}
    </div>
  );
}

/**
 * One project.
 *
 * Everything here is said ONCE. The card used to tell a reader an opportunity
 * was not won three separate times -- the column heading said `Lead`, the card
 * said `Opportunity`, and the value line said `Not won yet` -- and on a phone
 * that is three of the six lines he scrolls past. The band heading above now
 * carries the word, so the card carries the record.
 */
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
  const starts = spellStarts(card, today);

  return (
    /* `row-target`: the whole card opens the job. It LOOKED tappable and only
       the name was -- about 20px of a card the width of the column. */
    <li className="row-target rounded-panel card-surface p-3">
      {/* h4 because the column heading is the h3 and the band heading the h2. */}
      <h4 className="t-small font-semibold">
        <Link
          href={`/projects/${card.id}`}
          className="row-link break-words text-accent-text hover:underline"
        >
          {card.name}
        </Link>
      </h4>

      {/* Customer, town, number: one line, because the number is the least of
          the three and does not deserve its own. A contractor says "the job
          out east" and never "P-2026-0001", so the town sits with the name he
          does use and the number goes to the right edge where a reference
          belongs -- findable when he needs to quote it down the phone,
          invisible when he does not. */}
      <p className="flex flex-wrap items-baseline gap-x-2 t-small text-muted">
        <span className="min-w-0 break-words">
          {card.customerName}
          {card.siteCity ? ` · ${card.siteCity}` : ''}
        </span>
        <span className="num ml-auto shrink-0 text-subtle">{card.projectNumber}</span>
      </p>

      {/* Contract value, derived from accepted quotes and nowhere else, and
          shown only when there is one. An opportunity carries no figure and is
          told apart by the band it is in -- "$0.00" on every card left of
          `won` made the board read as a pipeline with no money in it. Cents
          here, unlike the headings: this is the number he reads to the
          customer. */}
      {card.contractValueCents > 0 ? (
        <p className="mt-1 t-small">
          <Money cents={card.contractValueCents} plain />
        </p>
      ) : null}

      {/* One line, whose words depend on the stage: how long it has waited
          everywhere it is waiting, and the real dates where it is running. */}
      <p className="t-small text-muted">{spellTiming(card, today)}</p>

      {starts ? <p className="t-small text-muted">{starts}</p> : null}

      {reminder && urgency ? (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line pt-2 t-small">
          <Pill tone={URGENCY_TONES[urgency]}>{urgencyChip(urgency, reminder, today)}</Pill>
          {/* Two lines, then it stops. A reminder is a prompt to open the
              record, not the record: one long title used to set itself down
              five lines and push the next card off the screen. */}
          <span className="line-clamp-2 min-w-0 break-words text-muted">{reminder.title}</span>
        </p>
      ) : null}
    </li>
  );
}
