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
 * Which columns this screen draws.
 *
 * Three narrowings, and one rule that overrides all of them.
 *
 * A stage filter takes the board down to one column rather than emptying six
 * -- on a phone that filter IS the board, because the columns are stacked and
 * choosing a stage is how a long scroll becomes a short list.
 *
 * A KIND filter takes it down to that half's stages. Showing "Quoting" while
 * the screen is filtered to jobs is not merely empty, it is untrue: a job
 * cannot be at a quoting stage, and drawing the column says it can.
 *
 * Finished stages stay behind the reveal control, exactly as the count does.
 *
 * The override: A STAGE THAT ACTUALLY HOLDS A CARD ALWAYS GETS A COLUMN. Kind
 * is derived from whether an accepted quote exists and the column comes from
 * the stage, so the two CAN disagree -- void the accepted quote on a row
 * sitting at `won` and it is an opportunity at a job stage. Rare, reachable,
 * and without this line the row would have no column and would silently vanish
 * from the pipeline. A drawn column that surprises somebody is a question; a
 * card with nowhere to go is lost work.
 */
export function boardStages(
  filters: { stage: ProjectStage | ''; kind: 'opportunity' | 'job' | ''; showClosed: boolean },
  occupied: readonly ProjectStage[],
): ProjectStage[] {
  if (filters.stage !== '') return [filters.stage];

  const half =
    filters.kind === 'job'
      ? new Set<ProjectStage>(['won', ...JOB_STAGES])
      : filters.kind === 'opportunity'
        ? new Set<ProjectStage>(OPPORTUNITY_STAGES)
        : null;
  const holdsWork = new Set(occupied);

  return BOARD_ORDER.filter((stage) => {
    if (holdsWork.has(stage)) return true;
    if (half !== null && !half.has(stage)) return false;
    return filters.showClosed || !CLOSED_STAGES.includes(stage);
  });
}

/** One project, as the board draws it. */
export interface PipelineCard {
  id: string;
  projectNumber: string;
  name: string;
  customerName: string;
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
  /** Actual start, else scheduled, else null. The row's own preference order. */
  startsOn: string | null;
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

export function groupIntoColumns(
  stages: readonly ProjectStage[],
  cards: readonly PipelineCard[],
): BoardColumn[] {
  return stages.map((stage) => {
    const inStage = cards.filter((card) => card.stage === stage);
    return {
      stage,
      cards: inStage,
      wonCents: sumCents(inStage.map((card) => card.contractValueCents)),
    };
  });
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
