import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, rate } from '@/db/columns';
import { costCodes, projects } from '@/db/schema/customers';
import { trades } from '@/db/schema/vendor-lists';

/**
 * The order the work happens in, per job (spec 5.1).
 *
 * The owner's words: *"planning for which sub contractors i need for this job
 * and assign due dates to create a timeline to manage projects where each sub
 * contract can be dependent on other. basically i want to plan out by job in
 * which order i will do, and which delay will push out what."*
 *
 * Two things follow from that sentence and they are the whole design. A task
 * has planned dates, so there is an order. A task may name ONE other task it
 * waits on, so a delay has somewhere to travel. Everything else -- float,
 * resource levelling, a critical path -- is deliberately absent, per spec 5.2:
 * a GC running four residential jobs does not need CPM, and it would be the
 * most complex code in the product serving the least-used screen.
 *
 * **The enum lives in this file rather than in `db/enums.ts`.** Every other
 * enum in the product is declared there and that is still the house rule; this
 * one is the exception because `enums.ts` was being appended to by another
 * piece of work at the same moment. `schema/index.ts` re-exports this module,
 * which is what drizzle-kit reads, so the type is created by the migration
 * exactly as the others are. Moving it into `enums.ts` later is a cut and a
 * paste with no migration behind it.
 */
export const scheduleTaskStatusEnum = pgEnum('schedule_task_status', [
  'not_started',
  'in_progress',
  'blocked',
  'complete',
]);

export const scheduleTasks = pgTable('schedule_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  /** What somebody would say on the phone: "framing", "rough-in", "drywall". */
  name: text('name').notNull(),
  /**
   * Where this task's spend is expected to land, so the schedule and the job
   * costing view speak the same language. A live foreign key rather than a
   * snapshot, for the reason `vendors.default_cost_code_id` is one: a retired
   * code goes on resolving, and the picker says which it is.
   */
  costCodeId: uuid('cost_code_id').references(() => costCodes.id),
  /**
   * WHICH TRADE this task needs, which is the half of the owner's ask this
   * table answers today.
   *
   * A live foreign key into the same list `vendors.trade_id` and `crew.trade_id`
   * already point at (migration 0014), rather than free text -- promoted from
   * text by migration 0016 for the reason both of those are foreign keys: a
   * schedule template (spec 5) has to carry a trade so the assignment picker
   * can offer the right subcontractors, and it cannot do that against free text
   * without the name drifting the first time a trade is renamed.
   *
   * Nullable, matching the column it replaces: a task with no single trade --
   * "site cleanup" -- names none. A retired trade goes on resolving here, so
   * retiring one does not blank every task that already named it; see the note
   * on `trades.isActive`.
   *
   * Naming the actual subcontractor is `assignments` (spec 5.1), which is step
   * 5 of the plan and a separate piece of work; a `vendor_id` here would be a
   * second place to say who is on a task, and the two would disagree the first
   * time somebody swapped a sub without opening both screens.
   */
  tradeId: uuid('trade_id').references(() => trades.id),
  /**
   * The plan. NOT NULL, both of them, and that is stricter than spec 5.1 draws
   * it.
   *
   * A task with no planned date cannot be ordered by date, cannot be pushed,
   * and cannot appear on a screen whose whole job is "who is on site this
   * week". Allowing it would put a row on the schedule that the schedule
   * cannot answer any question about. A milestone -- "permit approved" -- is a
   * single day, which is `planned_end = planned_start`, and the check below
   * enforces exactly that rather than leaving the end null.
   *
   * These are the ONLY dates the auto-push writes. See `src/lib/schedule/push.ts`.
   */
  plannedStart: date('planned_start').notNull(),
  plannedEnd: date('planned_end').notNull(),
  /**
   * What happened. Nullable, because most of it has not happened yet, and
   * never computed by anything.
   *
   * Spec 5.2 is explicit and the plan repeats it: overwriting a planned date
   * with an actual one destroys the only evidence of how estimates perform,
   * which is the data that makes the next quote better. So the pair is stored
   * twice and the push moves the planned half only -- and a task that has
   * ALREADY STARTED is held out of the push entirely, because shifting the
   * plan under a task whose actual start is already recorded silently rewrites
   * the slippage measured against it.
   */
  actualStart: date('actual_start'),
  actualEnd: date('actual_end'),
  /**
   * Progress in ten-thousandths, matching `invoices.percent_complete_ten_thou`
   * so the two can ever be compared without a scale conversion.
   *
   * Created now and written by nothing yet, deliberately, the way the plan's
   * third decision creates the OCR columns unused: the screen offers `status`,
   * which is the answer somebody standing on site can give in one tap, and a
   * percentage that has to be estimated is a field that goes stale. Adding the
   * column later would be a migration against a table holding a live schedule.
   */
  percentCompleteTenThou: rate('percent_complete_ten_thou'),
  /** A date with no duration -- an inspection, a permit, a deposit due. */
  isMilestone: boolean('is_milestone').notNull().default(false),
  /**
   * The one task this one waits on, or null for a task that stands alone.
   *
   * Opt-in, and that is the owner's decision verbatim: *"let me add if this is
   * a dependent task, if it is auto push, if not they would stay standalone."*
   * A null here is not missing data. It is a promise that this task's date
   * never moves because something else moved -- not by inference, and not
   * because it happens to sit between two tasks that did.
   *
   * Single-predecessor, per spec 5.2. A task that genuinely waits on two
   * things names the later one, which is the same date.
   *
   * A cycle here makes the push walk forever, so it is refused three times
   * over: the check constraint below catches a task naming itself, a trigger
   * in migration 0012 walks the chain inside the writing transaction under a
   * per-project advisory lock, and the action says it in a sentence before
   * either of those has to.
   */
  predecessorTaskId: uuid('predecessor_task_id').references((): AnyPgColumn => scheduleTasks.id),
  /**
   * Calendar days between the predecessor finishing and this task starting.
   * Zero means the next morning; two means a two-day gap for concrete to cure.
   *
   * DERIVED, never typed. It is `planned_start - predecessor.planned_end - 1`
   * and the writers recompute it from the dates, because the dates are what
   * the owner edits and a lag that disagrees with them is a lag nobody can
   * trust. It is stored rather than computed on read so the schedule screen
   * can say "starts 2 days after Framing ends" without a join per row, and so
   * the SharePoint mirror carries the relationship rather than only its
   * consequence.
   *
   * Negative is allowed: trades overlap, and "start drywall the day before
   * framing finishes" is an ordinary thing to plan. The bounds below are there
   * to catch a mistyped date, not to express a rule.
   */
  lagDays: integer('lag_days').notNull().default(0),
  /** The tie-break when two tasks share a planned start. */
  sortOrder: integer('sort_order').notNull().default(0),
  status: scheduleTaskStatusEnum('status').notNull().default('not_started'),
  notes: text('notes'),
  ...auditColumns,
}, (t) => [
  /** The screen's only query: this job's tasks, in the order they happen. */
  index('schedule_tasks_project_idx').on(t.projectId, t.plannedStart, t.sortOrder),
  /**
   * The push's query: everything that names this task as what it waits on.
   * Walked once per level of the chain on every date change, so it is an index
   * the feature reads rather than one a report might.
   */
  index('schedule_tasks_predecessor_idx').on(t.predecessorTaskId),
  /** The assignment picker's query: which trade a task needs. */
  index('schedule_tasks_trade_idx').on(t.tradeId),

  // A task cannot finish before it starts. A one-day task has end = start.
  check('schedule_tasks_planned_order', sql`planned_end >= planned_start`),
  // An end with no start is not a record of anything, and neither is an end
  // before its own start. Both halves stay nullable: most work has not happened.
  check(
    'schedule_tasks_actual_order',
    sql`actual_end is null or (actual_start is not null and actual_end >= actual_start)`,
  ),
  // A milestone is a day, not a span. Enforced rather than left to the form,
  // because the form is not the only thing that writes rows.
  check(
    'schedule_tasks_milestone_is_one_day',
    sql`not is_milestone or planned_end = planned_start`,
  ),
  // The cheapest cycle, refused by the database itself. The longer ones need
  // the chain walked, which is the trigger in 0012.
  check(
    'schedule_tasks_no_self_dependency',
    sql`predecessor_task_id is null or predecessor_task_id <> id`,
  ),
  // A lag with nothing to lag behind is a number that means nothing. Zero is
  // the only honest value on a standalone task.
  check('schedule_tasks_lag_needs_predecessor', sql`predecessor_task_id is not null or lag_days = 0`),
  // Ten years out and a year back. Not a rule about scheduling -- a fence
  // around a mistyped date, which is the only way a lag gets to four figures.
  check('schedule_tasks_lag_range', sql`lag_days >= -365 and lag_days <= 3650`),
  check(
    'schedule_tasks_percent_range',
    sql`percent_complete_ten_thou is null
        or (percent_complete_ten_thou >= 0 and percent_complete_ten_thou <= 10000)`,
  ),
]);
