import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, qty } from '@/db/columns';
import { conditionMeasurementEnum, durationSourceEnum } from '@/db/enums';
import { costCodes } from '@/db/schema/customers';
import { projectTypes } from '@/db/schema/project-lists';
import { rateItems } from '@/db/schema/rates';
import { trades } from '@/db/schema/vendor-lists';

/**
 * A saved shape of work -- spec `2026-09-05-schedule-templates-design.md`.
 *
 * TWO tables, not one `templates` with a `kind`, per section 4 of that spec.
 * An earlier draft renamed `scope_templates` to share a parent with this table
 * and was reverted: `guard_quote_mutability()` in
 * `drizzle/0004_quote_mutability.sql` reads `new.scope_template_id` by NAME, so
 * the rename applies cleanly and then fails at the next accept, decline or
 * mark-sent, not at migration time. And a shared parent cannot enforce its own
 * `kind` without a composite key, a trigger, or trust in application code --
 * two tables have that constraint for free. Section 12 of the spec records
 * this as one of several decisions review reversed; do not reintroduce it.
 *
 * `schedule_templates` mirrors `scope_templates` in `rates.ts` column for
 * column, on purpose: same shape of parent row, same `project_type` list, same
 * reason a template needs neither more nor less than a name, a type, a
 * description and an active flag. `scope_templates` itself is UNCHANGED by
 * this file -- not renamed, not migrated, not touched.
 */
export const scheduleTemplates = pgTable('schedule_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /**
   * Was `project_type_enum`; migration 0018 converted it to a maintained
   * list (`db/schema/project-lists.ts`), the same as `scope_templates.project_type_id`.
   */
  projectTypeId: uuid('project_type_id').notNull().references(() => projectTypes.id),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [index('schedule_templates_project_type_idx').on(t.projectTypeId)]);

/**
 * One task in a template: a name, a duration rule, a predecessor and lag, and
 * an optional condition on whether the task applies at all. No dates --
 * section 2 of the spec is explicit that a template holds no calendar, so
 * applying one takes a single start date and derives the rest through
 * `src/lib/schedule/template.ts`, which this table's shape must match exactly
 * (`TemplateTask` there is read straight off these columns).
 */
export const scheduleTemplateTasks = pgTable('schedule_template_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  scheduleTemplateId: uuid('schedule_template_id')
    .notNull()
    .references(() => scheduleTemplates.id),
  /** What somebody would say on the phone: "framing", "rough-in", "drywall". */
  name: text('name').notNull(),
  /**
   * Which trade this task needs, mirroring `schedule_tasks.trade_id`
   * (migration 0016) -- a live foreign key into the same list, so the
   * assignment picker on an imported job can offer the right subcontractors
   * without the name drifting the first time a trade is renamed. This is
   * exactly why section 3 of the spec promotes `schedule_tasks.trade` to a
   * foreign key BEFORE this table exists: it would otherwise have nowhere to
   * land.
   */
  tradeId: uuid('trade_id').references(() => trades.id),
  /** Where this task's spend is expected to land, mirroring `schedule_tasks.cost_code_id`. */
  costCodeId: uuid('cost_code_id').references(() => costCodes.id),
  /**
   * The one field a duration and a lag cannot carry: section 1's motivating
   * example is a supplier lead time, where the lag holds the fourteen days and
   * only a note holds *"call the cabinet shop"*.
   */
  notes: text('notes'),
  /** Read order on the import sheet and the editor. NOT the order dates derive in -- see section 5.2. */
  sortOrder: integer('sort_order').notNull().default(0),
  /** A date with no duration -- an inspection, a permit, a deposit due. Matches `schedule_tasks.is_milestone`. */
  isMilestone: boolean('is_milestone').notNull().default(false),

  /* -----------------------------------------------------------------------
     Duration (section 5.1). days = base + scaled-by-source, floored at 1 by
     the engine, not here -- a milestone is one day regardless of what these
     columns hold, and the engine skips the arithmetic entirely for one rather
     than computing a number it would discard.
     ----------------------------------------------------------------------- */
  durationBaseDays: integer('duration_base_days').notNull().default(0),
  durationSource: durationSourceEnum('duration_source').notNull().default('none'),
  /**
   * Area units per DAY, in thousandths -- "a day per 300 sqft" is 300000n.
   * A DIVISOR, not a rate: `qty` (bigint thousandths), matching
   * `TemplateTask.durationAreaPerDayMilli` in `src/lib/schedule/template.ts`
   * exactly. NOT NULL only when `duration_source = 'area'`; see the CHECK
   * below.
   */
  durationAreaPerDayMilli: qty('duration_area_per_day_milli'),
  /**
   * Days per washroom, kitchen or bedroom -- a plain integer, matching
   * `TemplateTask.durationDaysPerUnit`. NOT NULL only when `duration_source`
   * is one of the three counts; see the CHECK below.
   */
  durationDaysPerUnit: integer('duration_days_per_unit'),

  /**
   * The one task this one waits on, or null for a root. Single-predecessor,
   * matching `schedule_tasks.predecessor_task_id`.
   *
   * A cycle here is refused two ways rather than `schedule_tasks`'s three: the
   * CHECK below catches a task naming itself, and `findPredecessorCycle` (spec
   * 5.3) is run by the action before a save is accepted. There is
   * deliberately NO trigger under an advisory lock -- section 5.3 of the spec
   * is explicit that the lock exists for the concurrent writers the live
   * schedule has and the template editor does not: one person edits this
   * table, from one screen.
   *
   * Deliberately NOT `.references()` on this column alone -- that would add a
   * second, weaker foreign key duplicating the composite one below, which is
   * the one that actually matters: a plain `predecessor_task_id ->
   * schedule_template_tasks.id` reference is exactly the thing that CANNOT
   * enforce "same template", so it earns no place here even redundantly.
   */
  predecessorTaskId: uuid('predecessor_task_id'),
  /** Calendar days between the predecessor finishing and this task starting. Matches `schedule_tasks.lag_days`. */
  lagDays: integer('lag_days').notNull().default(0),

  /* -----------------------------------------------------------------------
     Condition (section 6). Two nullable columns rather than a child table --
     every worked example has ONE condition per task, and a second wanted
     condition is a second task (kitchen plumbing vs. bathroom plumbing).
     `num_nonnulls(...) <= 1` below is what keeps that true at the database
     level rather than only in the form.
     ----------------------------------------------------------------------- */
  conditionMeasurement: conditionMeasurementEnum('condition_measurement'),
  conditionRateItemId: uuid('condition_rate_item_id').references(() => rateItems.id),

  ...auditColumns,
}, (t) => [
  /** The editor's and the import sheet's query: this template's tasks, in the order they read. */
  index('schedule_template_tasks_template_idx').on(t.scheduleTemplateId, t.sortOrder),
  /** The same walk `effectiveLink` and cycle detection do, in-process; this is the query behind it. */
  index('schedule_template_tasks_predecessor_idx').on(t.predecessorTaskId),
  /** The assignment picker's query: which trade a task needs. */
  index('schedule_template_tasks_trade_idx').on(t.tradeId),

  /**
   * The FK target for the composite constraint below. `id` alone is already
   * unique (it is the primary key), so this constraint is satisfied by every
   * row for free -- its only purpose is to give Postgres a unique key on
   * `(id, schedule_template_id)` to reference.
   */
  unique('schedule_template_tasks_id_template_unique').on(t.id, t.scheduleTemplateId),

  /**
   * "A predecessor must belong to the same template" (spec 5.3), enforced
   * declaratively rather than with a trigger. A plain CHECK cannot read
   * another row, so this instead says: whenever `predecessor_task_id` is set,
   * a row with that id AND this row's own `schedule_template_id` must exist in
   * this table. Two templates cannot cross-link because the composite match
   * requires the predecessor's `schedule_template_id` to equal this row's --
   * which is precisely the property a plain `predecessor_task_id ->
   * schedule_template_tasks.id` foreign key cannot express.
   *
   * `predecessor_task_id` is nullable and Postgres composite foreign keys use
   * MATCH SIMPLE by default, so a root task (predecessor null) is exempt from
   * the constraint entirely rather than needing a null-columns special case.
   */
  foreignKey({
    columns: [t.predecessorTaskId, t.scheduleTemplateId],
    foreignColumns: [t.id, t.scheduleTemplateId],
    name: 'schedule_template_tasks_predecessor_same_template_fk',
  }),

  // The cheapest cycle, refused by the database itself -- the only one this
  // table refuses declaratively. The rest of section 5.3's cycle guard is the
  // action's `findPredecessorCycle`, not a trigger; see the note on
  // predecessorTaskId above.
  check(
    'schedule_template_tasks_no_self_dependency',
    sql`predecessor_task_id is null or predecessor_task_id <> id`,
  ),
  // A lag with nothing to lag behind is a number that means nothing.
  check(
    'schedule_template_tasks_lag_needs_predecessor',
    sql`predecessor_task_id is not null or lag_days = 0`,
  ),
  // Ten years out and a year back -- a fence around a mistyped value, matching schedule_tasks_lag_range.
  check('schedule_template_tasks_lag_range', sql`lag_days >= -365 and lag_days <= 3650`),
  // A task occupying no days is not a task; the floor of 1 is the engine's job, not this CHECK's.
  check('schedule_template_tasks_duration_base_days_range', sql`duration_base_days >= 0`),
  /**
   * Section 5.3, transcribed: each duration source dictates exactly which of
   * the two scaling columns is populated, and refuses the other one being set
   * at the same time -- a row with both `duration_area_per_day_milli` and
   * `duration_days_per_unit` set is not a shape `durationDaysOf` in
   * `src/lib/schedule/template.ts` was written to expect.
   */
  check(
    'schedule_template_tasks_duration_source_columns',
    sql`(duration_source = 'area'
          and duration_area_per_day_milli is not null and duration_area_per_day_milli > 0
          and duration_days_per_unit is null)
        or (duration_source in ('washrooms', 'kitchens', 'bedrooms')
          and duration_days_per_unit is not null and duration_days_per_unit > 0
          and duration_area_per_day_milli is null)
        or (duration_source = 'none'
          and duration_area_per_day_milli is null
          and duration_days_per_unit is null)`,
  ),
  // At most one condition (section 6): num_nonnulls treats two nulls as unconditional, which is correct.
  check(
    'schedule_template_tasks_condition_single',
    sql`num_nonnulls(condition_measurement, condition_rate_item_id) <= 1`,
  ),
]);
