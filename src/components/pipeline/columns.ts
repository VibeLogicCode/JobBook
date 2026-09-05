import { JOB_STAGES, OPPORTUNITY_STAGES, type ProjectStage } from '@/components/detail/labels';
import { sumCents } from '@/lib/money/format';
import type { ReminderRow } from '@/lib/reminders/repository';

/**
 * The arithmetic and the ordering behind the pipeline board, held apart from
 * the markup so it can be tested without a DOM.
 *
 * Everything in here is derived. Nothing on the board is a stored figure: the
 * stage order comes from the two stage constants, the contract value comes
 * from accepted quotes, and the time in a stage comes from `stage_history`.
 * That is not incidental -- a board is the screen most likely to grow a
 * denormalised column "just for speed", and the moment it has one it disagrees
 * with the record it is drawn from.
 */

/** Work that is over. A lost bid and a finished job are both history. */
export const CLOSED_STAGES: ProjectStage[] = ['lost', 'complete'];

/**
 * Stages both halves of a project's life share.
 *
 * `on_hold` is the only one today: a stalled opportunity before anything is
 * won and a paused job afterwards. Derived rather than typed out so a second
 * shared stage turns up here without anybody remembering this file.
 */
export const SHARED_STAGES = OPPORTUNITY_STAGES.filter((stage) => JOB_STAGES.includes(stage));

const OPPORTUNITY_ONLY = OPPORTUNITY_STAGES.filter(
  (stage) => !SHARED_STAGES.includes(stage) && !CLOSED_STAGES.includes(stage),
);

const JOB_ONLY = JOB_STAGES.filter(
  (stage) => !SHARED_STAGES.includes(stage) && !CLOSED_STAGES.includes(stage),
);

/**
 * The columns, left to right, in the order a project lives them.
 *
 * `won` sits between the two halves because that is exactly what it is: the
 * hinge. It is not a stage anybody sets -- it is what accepting a quote does
 * -- which is why it belongs to neither constant and has to be named here.
 *
 * The shared stages come after both halves rather than inside either, because
 * a parked record is not further along than a running one. The closed stages
 * come last and are only drawn when the screen is showing them.
 *
 * Since the board split into two bands this is no longer the list of columns
 * anybody draws -- it is the ORDER, the one authority on which stage precedes
 * which. Each band picks its own members out of it, so a stage cannot sit in a
 * different relative position in one band than in the other.
 *
 * Derived, so a stage added to the enum and to one of the two constants
 * appears on the board on its own. A stage added to the enum and to NEITHER
 * fails `tests/unit/pipeline-board.test.ts`, which is the point: a column that
 * silently does not exist is a column of work nobody can see.
 */
export const BOARD_ORDER: ProjectStage[] = [
  ...OPPORTUNITY_ONLY,
  'won',
  ...JOB_ONLY,
  ...SHARED_STAGES,
  ...CLOSED_STAGES,
];

/**
 * The two halves of a project's life, which are now the two halves of the
 * board.
 *
 * A band is decided by `isJob` -- whether an accepted, active quote exists --
 * and NEVER by the stage, exactly as `workNoun` decides the word. The stage
 * then picks the column within the band, so the key is the PAIR.
 *
 * This is what one grid over nine stages could not say. `auto-fill` over nine
 * tracks wraps wherever the viewport happens to run out, so at one width `Won`
 * landed under `Lead` and at another it did not -- an accident that reads as
 * meaning. Two bands make the row itself the statement: the first is the sales
 * funnel, the second is delivery, and a wrap inside either only ever wraps
 * within one of those.
 */
export type Band = 'opportunity' | 'job';

export const BANDS: Band[] = ['opportunity', 'job'];

/** The half's name, said once at the head of its band. */
export const BAND_HEADINGS: Record<Band, string> = {
  opportunity: 'Opportunities',
  job: 'Jobs',
};

/** The band a card belongs to, from the accepted quote and nothing else. */
export function bandOf(card: { isJob: boolean }): Band {
  return card.isJob ? 'job' : 'opportunity';
}

// Which finished stage closes which band, derived rather than typed: `lost` is
// an opportunity stage and `complete` is a job stage, which the two constants
// already say. Abandoning work under contract is not losing a bid, so the two
// never swap bands.
const OPPORTUNITY_CLOSED = CLOSED_STAGES.filter((stage) => OPPORTUNITY_STAGES.includes(stage));
const JOB_CLOSED = CLOSED_STAGES.filter((stage) => JOB_STAGES.includes(stage));

/**
 * Which stages each band may draw.
 *
 * `on_hold` IS IN BOTH, deliberately and not by oversight. A stalled bid and a
 * paused job are different things that the enum happens to spell the same, and
 * the `on_hold` ambiguity this codebase keeps explaining in prose -- in
 * `workNoun`, in `SHARED_STAGES`, in the stage dropdown's groups -- is
 * resolved here by layout instead: each band's `On hold` holds that band's
 * parked work, beside the columns it paused from.
 *
 * `won` belongs to the Jobs band and to no other. It is not a stage anybody
 * sets; it is the moment a job begins, so it opens the delivery half.
 */
export const BAND_STAGES: Record<Band, ProjectStage[]> = {
  opportunity: [...OPPORTUNITY_ONLY, ...SHARED_STAGES, ...OPPORTUNITY_CLOSED],
  job: ['won', ...JOB_ONLY, ...SHARED_STAGES, ...JOB_CLOSED],
};

/**
 * Whether the screen is showing work that is over.
 *
 * Asking for a finished stage overrides the default hiding, so choosing "Lost"
 * does not return an empty screen. Exported because the page needs the same
 * answer for its query as the board needs for its columns, and two copies of
 * this line is how a filter comes to disagree with what it drew.
 */
export function showsClosed(filters: { stage: ProjectStage | ''; closed: string }): boolean {
  return filters.closed === '1' || CLOSED_STAGES.includes(filters.stage as ProjectStage);
}

/** What the board was asked for. The columns and the heading links both read it. */
export interface BoardFilters {
  q: string;
  stage: ProjectStage | '';
  kind: Band | '';
  /** The `closed` URL parameter, `'1'` when the reveal is on. */
  closed: string;
}

/**
 * Which columns ONE BAND draws.
 *
 * Four narrowings, and one rule that overrides all of them.
 *
 * A stage that is not this band's is not this band's column. A KIND filter
 * removes the other band outright -- showing "Quoting" while the screen is
 * filtered to jobs is not merely empty, it is untrue. A stage filter takes the
 * band down to that one column. Finished stages stay behind the reveal
 * control, exactly as the count does.
 *
 * The override: A STAGE THAT ACTUALLY HOLDS ONE OF THIS BAND'S CARDS ALWAYS
 * GETS A COLUMN IN IT. Band comes from whether an accepted quote exists and
 * the column comes from the stage, so the two CAN disagree -- void the
 * accepted quote on a row sitting at `won` and it is an OPPORTUNITY at a job
 * stage. Rare, reachable, and without this line the row would have no column
 * in either band and would silently vanish from the pipeline. It is checked
 * per band, so that card draws a `Won` column inside Opportunities rather than
 * being quietly relabelled a job. A drawn column that surprises somebody is a
 * question; a card with nowhere to go is lost work.
 *
 * `occupied` is the stages held BY THIS BAND'S CARDS, never by every card:
 * passing the whole board would give the Jobs band a `Quoting` column the
 * moment any opportunity was being quoted.
 */
export function boardStages(
  band: Band,
  filters: { stage: ProjectStage | ''; kind: Band | ''; showClosed: boolean },
  occupied: readonly ProjectStage[],
): ProjectStage[] {
  const holdsWork = new Set(occupied);
  const belongs = new Set(BAND_STAGES[band]);

  return BOARD_ORDER.filter((stage) => {
    if (holdsWork.has(stage)) return true;
    if (!belongs.has(stage)) return false;
    if (filters.kind !== '' && filters.kind !== band) return false;
    if (filters.stage !== '' && filters.stage !== stage) return false;
    return filters.showClosed || !CLOSED_STAGES.includes(stage);
  });
}

/** One project, as the board draws it. */
export interface PipelineCard {
  id: string;
  projectNumber: string;
  name: string;
  customerName: string;
  /** Where the work is. A contractor names a job by its town, not its number. */
  siteCity: string | null;
  stage: ProjectStage;
  /**
   * Whether an accepted, active quote exists. Opportunity or job is decided by
   * that and never by the stage -- `on_hold` is both, at different points.
   */
  isJob: boolean;
  /** Derived from accepted quotes. Zero for work that has not been won. */
  contractValueCents: number;
  /**
   * Whole days since the row entered the stage it is in, computed in SQL from
   * `stage_history`. Null when the project has no history row, which the
   * trigger makes impossible for anything inserted through the database.
   */
  daysInStage: number | null;
  /**
   * The three dates the card can say something with. Kept apart rather than
   * collapsed into one "starts on", because a running job reports the day it
   * REALLY began and the day it is due to end, and the difference between
   * scheduled and actual is the slippage the detail screen exists to show.
   */
  scheduledStart: string | null;
  actualStart: string | null;
  scheduledEnd: string | null;
}

export interface BoardColumn {
  stage: ProjectStage;
  cards: PipelineCard[];
  /**
   * What the column is worth, which is only ever what has been WON in it.
   *
   * Summed through `sumCents` rather than `reduce` at the call site, so the
   * empty-column boundary has one definition, and over integer cents rather
   * than anything that has been through a float.
   */
  wonCents: number;
}

/** Half the board: its heading, its columns, and what the half adds up to. */
export interface BoardBand {
  band: Band;
  heading: string;
  columns: BoardColumn[];
  /** Cards in the half. Every card has a column, so this is their sum. */
  count: number;
  /** Won value across the half. Zero for Opportunities, by definition. */
  wonCents: number;
}

/**
 * The whole board: cards split by band, then by stage within it.
 *
 * A band with no columns at all is dropped rather than drawn empty -- that is
 * what a kind filter does, and a heading over nothing is not the shape of
 * anything.
 *
 * Both sums are in integer cents and are formatted at the very end. The
 * heading shows whole dollars and the cards show cents, which is a
 * FORMATTING difference: rounding each card and adding the results would make
 * a column total that is not the sum of the column.
 */
export function groupIntoColumns(
  filters: { stage: ProjectStage | ''; kind: Band | ''; showClosed: boolean },
  cards: readonly PipelineCard[],
): BoardBand[] {
  return BANDS.map((band) => {
    const mine = cards.filter((card) => bandOf(card) === band);
    const stages = boardStages(band, filters, mine.map((card) => card.stage));

    return {
      band,
      heading: BAND_HEADINGS[band],
      columns: stages.map((stage) => {
        const inStage = mine.filter((card) => card.stage === stage);
        return {
          stage,
          cards: inStage,
          wonCents: sumCents(inStage.map((card) => card.contractValueCents)),
        };
      }),
      count: mine.length,
      wonCents: sumCents(mine.map((card) => card.contractValueCents)),
    };
  }).filter((band) => band.columns.length > 0);
}

/**
 * A column total, in whole dollars.
 *
 * The cards keep their cents; a heading does not need them, and `$488,508.51`
 * above a column costs four characters to say something nobody reads a board
 * to learn. The rounding happens HERE, once, on a sum that was carried in
 * integer cents the whole way -- the divide by 100 is the same last step
 * `formatCents` takes, not arithmetic anything else depends on.
 *
 * The symbol comes from `Intl` against a currency code, never a `$` literal:
 * the product is white-label and a future deployment may not bill in CAD.
 */
export function formatWholeDollars(
  cents: number,
  opts?: { locale?: string; currencyCode?: string },
): string {
  const { locale = 'en-CA', currencyCode = 'CAD' } = opts ?? {};
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

const ISO_DATE = /^(\d{4})-\d{2}-\d{2}$/;

/**
 * A stored date as a person reading it in a truck would say it: `Oct 5`.
 *
 * An ISO date belongs in the database and in a `data-` attribute, not on a
 * card. `2026-10-05` takes a beat to parse and reads as a serial number.
 *
 * The year is added only when it is NOT the tenant's current year. A job
 * starting next spring shown as "Apr 12" beside one starting this month is the
 * one ambiguity dropping the year introduces, and it is the ambiguity that
 * costs a site visit.
 *
 * Formatted through `Intl` pinned to UTC over a midnight-UTC instant, which is
 * the only way to turn a bare `date` column into words without the container's
 * timezone moving it a day -- the same failure `tenantIsoToday` exists to
 * avoid, in the other direction.
 */
export function spellDate(iso: string | null | undefined, today: string): string | null {
  if (!iso) return null;
  const match = ISO_DATE.exec(iso);
  if (match === null) return null;

  const sameYear = today.slice(0, 4) === match[1];
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(new Date(`${iso}T00:00:00Z`));
}

/**
 * How long it has been here, in the words the detail screen already uses.
 *
 * Deliberately the same vocabulary as `detail/StageTimeline` -- "under a day",
 * then whole days -- because the two screens are reporting the same number
 * about the same row, and a board saying "1 day" beside a timeline saying
 * "under a day" is a product arguing with itself.
 */
export function spellDaysInStage(days: number | null): string {
  if (days === null) return 'No stage history';
  if (days <= 0) return 'Under a day in stage';
  return `${days} day${days === 1 ? '' : 's'} in stage`;
}

/**
 * The one timing line every card carries, whose CONTENT depends on the stage.
 *
 * "How long has this sat" is the right question at `lead`, `site_visit`,
 * `quoting`, `quote_sent`, `won` and `on_hold`. Every one of those is a
 * WAITING state: nothing is happening, and the number is how long nothing has
 * been happening.
 *
 * At `in_progress` nothing is waiting. A crew has been on site for eleven days
 * because the job takes eleven days, so "11 days in stage" reads as a warning
 * about work that is going exactly to plan -- and the two dates that DO matter
 * there, the day it started and the day it is due to finish, were nowhere on
 * the card.
 *
 * This is one line whose words vary by row, in the same way "Not won yet" used
 * to vary with the contract value -- not a second card component chosen by
 * stage. Every card renders this string in the same element.
 *
 * The dates are entered by hand on the detail screen and nothing forces them,
 * so a running job with neither falls back to the stage age. That is the only
 * signal left, and a blank line would be worse than an imperfect one.
 */
export function spellTiming(card: PipelineCard, today: string): string {
  if (card.stage !== 'in_progress') return spellDaysInStage(card.daysInStage);

  const started = spellDate(card.actualStart, today);
  const finish = spellDate(card.scheduledEnd, today);

  if (started !== null && finish !== null) return `Started ${started} · finish ${finish}`;
  if (started !== null) return `Started ${started}`;
  if (finish !== null) return `Finish ${finish}`;
  return spellDaysInStage(card.daysInStage);
}

/**
 * When the work begins, for work that has not begun.
 *
 * Null at `in_progress`, where the timing line above has already said the day
 * it started: the same date twice on a card three lines tall is exactly the
 * repetition this screen was trimmed to remove.
 *
 * Actual start beats scheduled everywhere else too -- once a job has really
 * begun, the date it was meant to begin is history the detail screen keeps for
 * slippage.
 */
export function spellStarts(card: PipelineCard, today: string): string | null {
  if (card.stage === 'in_progress') return null;
  const when = spellDate(card.actualStart ?? card.scheduledStart, today);
  return when === null ? null : `Starts ${when}`;
}

/**
 * The one reminder a card shows, per project.
 *
 * A quote's reminders count as the project's. The rule that fires most often
 * on this screen is "follow up on quote to {customer}", and it is written
 * against the QUOTE -- so a board that only looked at reminders whose
 * entity_type is `project` would show nothing at `quote_sent`, which is the
 * column the owner opens this screen to read.
 *
 * A CUSTOMER's reminders are deliberately excluded. A customer with three jobs
 * would otherwise put the same "no contact in 14 days" line on three cards,
 * and a reminder repeated three times is a reminder the owner stops reading.
 *
 * `reminders` must arrive earliest-due first, which is the order
 * `listReminders` returns; the first match for a project is therefore the next
 * one due. Nothing re-sorts here, because a second sort is a second answer to
 * "which is next" and the two would drift.
 */
export function nextReminderByProject(
  reminders: readonly ReminderRow[],
  projectOfQuote: ReadonlyMap<string, string>,
): Map<string, ReminderRow> {
  const found = new Map<string, ReminderRow>();

  for (const reminder of reminders) {
    const projectId =
      reminder.entityType === 'project'
        ? reminder.entityId
        : reminder.entityType === 'quote'
          ? projectOfQuote.get(reminder.entityId)
          : undefined;
    if (projectId === undefined || found.has(projectId)) continue;
    found.set(projectId, reminder);
  }

  return found;
}
