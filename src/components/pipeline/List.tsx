import { Fragment } from 'react';
import Link from 'next/link';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { Pill } from '@/components/ui/Pill';
import { PROJECT_STAGES, stageTone, workNoun } from '@/components/detail/labels';
import { URGENCY_TONES, urgencyChip } from '@/components/reminders/labels';
import { urgencyOf } from '@/components/reminders/urgency';
import { formatCents } from '@/lib/money/format';
import {
  formatWholeDollars, groupIntoBands, spellStarts, spellTiming, type PipelineCard,
} from '@/components/pipeline/columns';
import type { ReminderRow } from '@/lib/reminders/repository';

/**
 * The pipeline as a list: every opportunity and job, one row each, in project
 * number order.
 *
 * THE SAME DATA AS THE BOARD, NOT A SECOND QUERY. The page runs one query and
 * hands the same `PipelineCard[]` and the same reminder map to whichever of the
 * two components the URL asked for. Every derived figure here comes from the
 * helpers the board calls -- `bandOf` for which half a row is in, `spellTiming`
 * and `spellStarts` for the dates, `sumCents` and `formatWholeDollars` for the
 * totals -- so the two views cannot report different things about the same row.
 * The only difference is markup.
 *
 * ONE DOM TREE, REFLOWED BY CSS, WITHIN THIS VIEW. It is a `<table>` at `sm` and
 * above and the same rows as stacked cards below, through
 * `data-table data-table--stack` and a `data-label` on every cell; there is no
 * phone component and no desktop component. That the owner may choose between
 * this and the board is a different thing entirely -- a person picking a
 * rendering is not a breakpoint picking one for him.
 *
 * WHY IT IS WORTH KEEPING BESIDE THE BOARD. A board answers "what is stuck and
 * where" by position. It cannot answer "read me the book" -- nine columns of
 * cards is nine places to hunt for the row whose number is on a delivery
 * docket, and a figure per column is not a figure per screen. The list is one
 * order, one line per record, and the columns line up.
 *
 * WHAT IT TOOK FROM THE BOARD. The table this restores predates most of what is
 * on a card: it had no town, no stage age, no next reminder, and it printed
 * `$0.00` against every opportunity. The first three are here; the fourth is
 * deliberately gone -- see the contract cell.
 */
export function PipelineList({
  cards,
  reminderOf,
  today,
}: {
  cards: readonly PipelineCard[];
  /** The next open reminder per project id, from `nextReminderByProject`. */
  reminderOf: ReadonlyMap<string, ReminderRow>;
  /** The tenant's today. Never the server's, and never the browser's. */
  today: string;
}) {
  const bands = groupIntoBands(cards);

  return (
    // Seven columns, and the narrowest they stay readable at. Below `sm` the
    // stack rule drops the min-width entirely, so this is the width at which the
    // TABLE scrolls inside its own container -- never the width at which the
    // PAGE does.
    <TableWrap minWidth="54rem">
      <thead>
        <tr>
          <th scope="col">Work</th>
          <th scope="col">Number</th>
          <th scope="col">Customer</th>
          <th scope="col">Stage</th>
          <th scope="col">Timing</th>
          <th scope="col">Next</th>
          <th scope="col" className="cell-num">Contract</th>
        </tr>
      </thead>
      <tbody>
        {bands.map((band) => (
          <Fragment key={band.band}>
            {/* The two halves, said in the table the way the board says them in
                its headings -- and by the same rule, so a row cannot be an
                opportunity on one view and a job on the other. `group-band` is
                the house band row: it sticks under the header on a monitor and
                becomes a full-bleed strip on a phone. */}
            <tr className="group-band">
              <td colSpan={7} data-label="Pipeline">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span>{band.heading}</span>
                  <span className="num t-small text-muted">{band.count}</span>
                  {/* Whole dollars, exactly as the board's band heading shows
                      them, summed in integer cents and divided once at the very
                      end. Only ever on Jobs: won value is what an accepted quote
                      produces, so Opportunities has none by definition rather
                      than by a rule. */}
                  {band.wonCents > 0 ? (
                    <span className="ml-auto flex items-baseline gap-2">
                      <span className="t-small font-normal text-muted">under contract</span>
                      <span className="num">{formatWholeDollars(band.wonCents)}</span>
                    </span>
                  ) : null}
                </span>
              </td>
            </tr>

            {band.cards.map((card) => {
              const reminder = reminderOf.get(card.id);
              const urgency = reminder ? urgencyOf(reminder, today) : null;
              const starts = spellStarts(card, today);

              return (
                <tr key={card.id}>
                  {/* The headline cell on a phone, which is why the town rides
                      with it: a contractor names a job by where it is, and the
                      board learned that before this table did. The noun beside
                      it is `workNoun`, derived from the accepted quote and never
                      from the stage. */}
                  <td data-label="Work">
                    <Link
                      href={`/projects/${card.id}`}
                      className="break-words text-accent-text hover:underline"
                    >
                      {card.name}
                    </Link>
                    <span className="block t-small text-subtle">
                      {workNoun(card.isJob)}
                      {card.siteCity ? ` · ${card.siteCity}` : ''}
                    </span>
                  </td>

                  <td data-label="Number" className="num t-small text-muted">
                    {card.projectNumber}
                  </td>

                  <td data-label="Customer">{card.customerName}</td>

                  <td data-label="Stage">
                    <Pill tone={stageTone(card.stage)}>{PROJECT_STAGES[card.stage]}</Pill>
                  </td>

                  {/* The board's two timing lines, unchanged and in the same
                      order. `spellTiming` says how long the work has sat where it
                      is, except at `in_progress` where it says the real start and
                      the date it is due to finish; `spellStarts` is null there
                      for exactly that reason, so a date is never printed twice.
                      Both strings name themselves, which is why the column
                      heading can be one word. */}
                  <td data-label="Timing" className="t-small text-muted">
                    {/* ONE child, not two. Below `sm` the cell is a flex row
                        holding its label and its value, so two sibling spans
                        become two flex items and the stacked card spreads the
                        two lines across the row with the label. Wrapped, the
                        cell has a value, and the value has two lines.

                        `whitespace-nowrap` because both strings are short,
                        fixed phrases and neither reads as anything broken in
                        half: auto table layout was giving the width to the
                        reminder titles beside them and printing "Under a day
                        in / stage" at 1440. The reminder is the elastic
                        column -- it is clamped to two lines and expects to
                        wrap. */}
                    <span className="block whitespace-nowrap">
                      <span className="block">{spellTiming(card, today)}</span>
                      {starts ? <span className="block">{starts}</span> : null}
                    </span>
                  </td>

                  {/* The next thing to do about the row -- the one thing the old
                      table could not show, and half the reason the board was
                      built. Empty when nothing is due, and EMPTY rather than an
                      em-dash: `td:empty` shortens the cell away on a phone, and
                      a labelled dash on six of eight cards is six lines of
                      nothing between him and the work. */}
                  <td data-label="Next">
                    {reminder && urgency ? (
                      <span className="flex flex-wrap items-center gap-1.5 t-small">
                        <Pill tone={URGENCY_TONES[urgency]}>
                          {urgencyChip(urgency, reminder, today)}
                        </Pill>
                        <span className="line-clamp-2 min-w-0 break-words text-muted">
                          {reminder.title}
                        </span>
                      </span>
                    ) : null}
                  </td>

                  {/* Contract value, derived from accepted quotes and nowhere
                      else. Blank for work that has not been won, which is the
                      correction the board made to this table: `$0.00` down the
                      whole Opportunities half read as a pipeline with no money in
                      it, when what is true is that none of it has been won yet. A
                      won row shows cents -- this is the figure he reads down the
                      phone. */}
                  <AmountCell data-label="Contract">
                    {card.contractValueCents > 0 ? formatCents(card.contractValueCents) : null}
                  </AmountCell>
                </tr>
              );
            })}
          </Fragment>
        ))}
      </tbody>
    </TableWrap>
  );
}
