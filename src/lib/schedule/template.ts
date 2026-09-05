import { divRoundUp } from '@/lib/money/scale';
import { shiftDays, startAfter } from '@/lib/schedule/calendar';

/**
 * Turning a saved shape of work into dated tasks on a job.
 *
 * The template holds no dates -- see §2 of
 * `docs/superpowers/specs/2026-09-05-schedule-templates-design.md`. It holds
 * durations and a dependency chain, and this file is what turns those plus one
 * start date into a schedule.
 *
 * Pure: no database, no request, no clock. Every date arrives as an argument
 * so the import sheet can show what it is about to write and the transaction
 * can recompute the same answer from the same inputs. That is the
 * `Acceptance.tsx` shape -- the client renders a preview with the engine the
 * server re-runs, and posted dates are never trusted.
 */

/* -------------------------------------------------------------------------
   What a template holds
   ------------------------------------------------------------------------- */

/** What a task's length scales with, or nothing. */
export type DurationSource = 'none' | 'area' | 'washrooms' | 'kitchens' | 'bedrooms';

/**
 * What a task's presence depends on.
 *
 * `area` is deliberately absent. `area > 0` is true of essentially every
 * quote, so it would tick everything while looking like a filter; the version
 * that would earn its place -- "a second inspection over 2,000 sqft" -- needs a
 * threshold this design does not carry. Area stays a duration source.
 */
export type ConditionMeasurement = 'washrooms' | 'kitchens' | 'bedrooms';

/** The measurements a quote was priced from. Counts are plain, area is thousandths. */
export interface Scope {
  areaSqftMilli: bigint;
  washroomCount: number;
  kitchenCount: number;
  bedroomCount: number;
}

export interface TemplateTask {
  id: string;
  name: string;
  sortOrder: number;
  isMilestone: boolean;

  durationBaseDays: number;
  durationSource: DurationSource;
  /**
   * Area units per DAY, in thousandths -- "a day per 300 sqft" is 300000n.
   *
   * Stored as a divisor rather than as days-per-unit, and that is not a
   * preference. Days per square foot for that same sentence is 0.0033, which
   * is both a translation of what the owner said and inexact: at 30,000 sqft
   * it computes 99 days against a true 100. Dividing is exact and is the
   * sentence he would actually say.
   */
  durationAreaPerDayMilli: bigint | null;
  /** Days per washroom, kitchen or bedroom. Counts read naturally in this direction. */
  durationDaysPerUnit: number | null;

  predecessorTaskId: string | null;
  lagDays: number;

  conditionMeasurement: ConditionMeasurement | null;
  conditionRateItemId: string | null;
}

/* -------------------------------------------------------------------------
   How long a task takes
   ------------------------------------------------------------------------- */

function countFor(source: DurationSource, scope: Scope): number {
  if (source === 'washrooms') return scope.washroomCount;
  if (source === 'kitchens') return scope.kitchenCount;
  if (source === 'bedrooms') return scope.bedroomCount;
  return 0;
}

/**
 * A task's length in whole days, both ends counted.
 *
 * Never less than one: a task occupying no days is not a task, and the caller
 * that produced a zero is better served by a visible one-day row than by an
 * end date before its start. A milestone is one day by definition and skips
 * the arithmetic entirely rather than computing a number it would discard.
 *
 * Rounding is UP, through `divRoundUp` rather than the money helper. Half a
 * framer-day cannot be booked, and a task that rounded down would finish late
 * without anything on screen looking wrong.
 */
export function durationDaysOf(task: TemplateTask, scope: Scope): number {
  if (task.isMilestone) return 1;

  let days = task.durationBaseDays;

  // A switch rather than a chain of conditions, so a source whose companion
  // column is null cannot fall through to the arm belonging to the other kind
  // and quietly add nothing. The nulls are refused by a CHECK; a row written
  // before it existed should still produce the base rather than a crash.
  switch (task.durationSource) {
    case 'area':
      if (task.durationAreaPerDayMilli !== null && task.durationAreaPerDayMilli > 0n) {
        days += Number(divRoundUp(scope.areaSqftMilli, task.durationAreaPerDayMilli));
      }
      break;
    case 'washrooms':
    case 'kitchens':
    case 'bedrooms':
      if (task.durationDaysPerUnit !== null) {
        days += countFor(task.durationSource, scope) * task.durationDaysPerUnit;
      }
      break;
    case 'none':
      break;
  }

  return Math.max(days, 1);
}

/* -------------------------------------------------------------------------
   Whether a task applies to this job
   ------------------------------------------------------------------------- */

/**
 * Why a task is or is not suggested, as data rather than as a sentence.
 *
 * The wording belongs to the screen. This says which fact is true, so the
 * sheet can print "No washrooms on this quote" and the editor can print
 * "When: washrooms" from one answer.
 */
export type ConditionOutcome =
  | { kind: 'unconditional' }
  | { kind: 'measurement'; measurement: ConditionMeasurement; count: number }
  | { kind: 'rateItem'; rateItemId: string; present: boolean }
  | { kind: 'noAcceptedQuote' };

export interface ScopeEvidence {
  scope: Scope;
  /**
   * Rate items on every accepted, active quote of the project -- the estimate
   * AND its change orders, because a change order's lines are contract scope.
   * Reading only the estimate would silently miss a deck that CO-1 added.
   *
   * A line somebody typed by hand carries no rate item and so appears in no
   * set. That is why an unmatched row stays visible and tickable.
   */
  includedRateItemIds: ReadonlySet<string>;
  /** False when the job has no accepted quote at all: every condition is unanswerable. */
  hasAcceptedQuote: boolean;
}

function countOf(measurement: ConditionMeasurement, scope: Scope): number {
  if (measurement === 'washrooms') return scope.washroomCount;
  if (measurement === 'kitchens') return scope.kitchenCount;
  return scope.bedroomCount;
}

/**
 * Whether the import should tick this task, and on what grounds.
 *
 * **No condition means unconditional**, not "never applies". Permits, site
 * protection, supervision and cleanup are on every job, and requiring a
 * condition to be invented for them would be a worse default than the one
 * failure it prevents -- a forgotten condition ticks a task that is visible on
 * the sheet and one press from removed.
 */
export function conditionOutcome(task: TemplateTask, evidence: ScopeEvidence): ConditionOutcome {
  if (task.conditionMeasurement === null && task.conditionRateItemId === null) {
    return { kind: 'unconditional' };
  }
  if (!evidence.hasAcceptedQuote) return { kind: 'noAcceptedQuote' };

  if (task.conditionMeasurement !== null) {
    return {
      kind: 'measurement',
      measurement: task.conditionMeasurement,
      count: countOf(task.conditionMeasurement, evidence.scope),
    };
  }

  const rateItemId = task.conditionRateItemId!;
  return {
    kind: 'rateItem',
    rateItemId,
    present: evidence.includedRateItemIds.has(rateItemId),
  };
}

/** The tick state the sheet opens with. */
export function isSuggested(outcome: ConditionOutcome): boolean {
  if (outcome.kind === 'unconditional') return true;
  if (outcome.kind === 'measurement') return outcome.count > 0;
  if (outcome.kind === 'rateItem') return outcome.present;
  return false;
}

/* -------------------------------------------------------------------------
   What a task waits on once some are dropped
   ------------------------------------------------------------------------- */

export interface EffectiveLink {
  /** The nearest ticked ancestor, or null when every ancestor was dropped. */
  predecessorTaskId: string | null;
  lagDays: number;
  /** True when the chain was walked past a dropped task to reach this one. */
  relinked: boolean;
  /** A negative lag is not carried onto a predecessor it was not planned against. */
  lagClamped: boolean;
}

/**
 * WHAT A TASK WAITS ON, computed rather than stored.
 *
 * A FUNCTION of the ticked set, never a mutation of the chain, and the
 * difference is a bug this was rewritten to remove. Re-pointing predecessors
 * on each untick loses the original: untick B, tick it again, and C is still
 * attached to A -- so B and C run in parallel when the template said C follows
 * B. A function cannot drift, and re-ticking costs nothing.
 *
 * It also means a cycle cannot occur here. Single predecessors make the
 * template a forest, and walking up to an ancestor closes no loop. The guard
 * below is against malformed stored data, not against this algorithm.
 *
 * **Skipping a step means the next one follows the one before it.** That is
 * what happens on a site, and it is why re-linking beats refusing (which would
 * mean hand-unticking every task behind the one you dropped) and beats
 * cascading (which drops five tasks because you dropped one).
 */
export function effectiveLink(
  task: TemplateTask,
  byId: ReadonlyMap<string, TemplateTask>,
  ticked: ReadonlySet<string>,
): EffectiveLink {
  let cursor = task.predecessorTaskId;
  let relinked = false;
  const seen = new Set<string>([task.id]);

  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new Error(`template tasks form a cycle at ${cursor}`);
    }
    seen.add(cursor);

    const ancestor = byId.get(cursor);
    if (ancestor === undefined) break;
    if (ticked.has(cursor)) {
      // The lag belongs to the edge that survived. Across a re-link a negative
      // lag would start this task before an ancestor it was never planned
      // against -- an overlap with a trade nobody agreed to -- so it clamps.
      const lagClamped = relinked && task.lagDays < 0;
      return {
        predecessorTaskId: cursor,
        lagDays: lagClamped ? 0 : task.lagDays,
        relinked,
        lagClamped,
      };
    }

    relinked = true;
    cursor = ancestor.predecessorTaskId;
  }

  // Every ancestor was dropped, so this becomes a root and starts on the date
  // the import was given. `lag_needs_predecessor` refuses a lag without one.
  return {
    predecessorTaskId: null,
    lagDays: 0,
    relinked: relinked || task.predecessorTaskId !== null,
    lagClamped: false,
  };
}

/* -------------------------------------------------------------------------
   The dated plan
   ------------------------------------------------------------------------- */

export interface PlannedTask {
  templateTaskId: string;
  name: string;
  start: string;
  end: string;
  days: number;
  /** A template task id. The action maps these to the job's own rows. */
  predecessorTemplateTaskId: string | null;
  lagDays: number;
  relinked: boolean;
  lagClamped: boolean;
}

/**
 * Every ticked task, dated.
 *
 * Computed in DEPENDENCY order, not `sort_order`: a task may sort above its own
 * predecessor, and ordering by the column somebody typed would date it against
 * a predecessor that has no dates yet. Memoised depth-first from each task
 * instead, so the order the caller supplies cannot change the answer.
 *
 * Roots start on the given date -- all of them. "Waits on nothing" should mean
 * a task can begin on day one, not that it queues behind whatever happened to
 * be listed above it.
 *
 * The returned array is in `sort_order`, because that is the order to read.
 * Only the arithmetic cares about dependency order.
 */
export function planImport(
  tasks: readonly TemplateTask[],
  ticked: ReadonlySet<string>,
  scope: Scope,
  startDate: string,
): PlannedTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const planned = new Map<string, PlannedTask>();

  function plan(task: TemplateTask): PlannedTask {
    const held = planned.get(task.id);
    if (held) return held;

    const link = effectiveLink(task, byId, ticked);
    const days = durationDaysOf(task, scope);

    let start = startDate;
    if (link.predecessorTaskId !== null) {
      const ancestor = byId.get(link.predecessorTaskId)!;
      start = startAfter(plan(ancestor).end, link.lagDays);
    }

    const row: PlannedTask = {
      templateTaskId: task.id,
      name: task.name,
      start,
      // Both ends counted, matching `durationDays` and `planned_start` /
      // `planned_end`. Adding the whole duration instead would make a one-day
      // task two.
      end: shiftDays(start, days - 1),
      days,
      predecessorTemplateTaskId: link.predecessorTaskId,
      lagDays: link.lagDays,
      relinked: link.relinked,
      lagClamped: link.lagClamped,
    };
    planned.set(task.id, row);
    return row;
  }

  const rows = tasks.filter((task) => ticked.has(task.id)).map(plan);
  return rows.sort((a, b) => {
    const orderA = byId.get(a.templateTaskId)!.sortOrder;
    const orderB = byId.get(b.templateTaskId)!.sortOrder;
    if (orderA !== orderB) return orderA - orderB;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** The job's finish: the latest end among the planned tasks. */
export function planFinish(rows: readonly PlannedTask[]): string | null {
  let latest: string | null = null;
  // ISO dates compare correctly as strings, which is why the columns are
  // `date` and the wire format is ISO rather than anything friendlier.
  for (const row of rows) if (latest === null || row.end > latest) latest = row.end;
  return latest;
}
