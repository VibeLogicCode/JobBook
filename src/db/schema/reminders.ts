import { sql } from 'drizzle-orm';
import {
  boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns } from '@/db/columns';
import {
  activityKindEnum, projectStageEnum, reminderKindEnum, reminderRecurrenceEnum,
  reminderStatusEnum, reminderTriggerEnum, timelineEntityTypeEnum,
} from '@/db/enums';
import { users } from '@/db/schema/organization';

/**
 * The middle of the owner's process: what happened, and what happens next.
 *
 * Phase 1 made the quote good and did nothing about the follow-up, which is
 * where work is actually lost -- a quote sent and never chased is
 * indistinguishable from a quote that was declined, and both show up as
 * silence. These three tables are what turns that into a screen that says who
 * to call.
 */

/**
 * One thing that happened, against a customer, a project or a quote.
 *
 * `occurred_at` is NOT `created_at`, and the distinction is the whole point of
 * having two columns. An owner logs Tuesday's call on Thursday: the timeline
 * orders by `occurred_at` because that is when the call happened, and the
 * audit trail keeps `created_at` because that is when he said so. Conflating
 * them makes the timeline lie, and it is the kind of lie nobody notices until
 * they are reconstructing a dispute.
 *
 * `user_id` and `created_by` are the same distinction applied to people:
 * `user_id` is who was on the call, `created_by` is who typed it in. Usually
 * the same person and not always -- somebody entering the owner's Tuesday from
 * a note is exactly the case the timeline must not misattribute.
 */
export const activities = pgTable('activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: timelineEntityTypeEnum('entity_type').notNull(),
  /** Polymorphic, so no foreign key. See the note on `timelineEntityTypeEnum`. */
  entityId: uuid('entity_id').notNull(),
  kind: activityKindEnum('kind').notNull(),
  /**
   * When it happened, in the tenant's zone. Defaulted to now for the common
   * case of logging a call as it ends, and freely backdated otherwise.
   */
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  subject: text('subject'),
  body: text('body'),
  durationMinutes: integer('duration_minutes'),
  /** Who did the thing. Null for an activity nobody has claimed. */
  userId: uuid('user_id').references(() => users.id),
  ...auditColumns,
}, (t) => [
  // The timeline query, and the `no_activity` rule's scan, are both
  // "everything against this entity, newest first". Ordered DESC in the index
  // so neither has to sort.
  index('activities_timeline_idx').on(t.entityType, t.entityId, t.occurredAt.desc()),
  // A negative call length is a typo, and it would otherwise sit in a report
  // subtracting time from a day.
  check('activities_duration_not_negative', sql`duration_minutes is null or duration_minutes >= 0`),
]);

/**
 * A rule the owner can edit, seeded rather than hardcoded.
 *
 * Five of these ship (`src/db/seed/reminder-rules.ts`) and every one of them
 * is editable, because a rule that fires uselessly must be something the owner
 * can turn off in the interface rather than something that needs a developer.
 */
export const reminderRules = pgTable('reminder_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  trigger: reminderTriggerEnum('trigger').notNull(),
  /**
   * Only meaningful for `stage_entered`, and null for every other trigger.
   *
   * Left nullable for `stage_entered` too, deliberately: the evaluator treats
   * a rule with no stage as watching NOTHING rather than everything, because
   * firing on every stage change would bury the list. The CHECK below refuses
   * only the half that is meaningless -- a stage on a rule that does not watch
   * stages at all.
   */
  triggerStage: projectStageEnum('trigger_stage'),
  /** Negative means before the anchor: the quote-expiry rule is -5. */
  offsetDays: integer('offset_days').notNull().default(0),
  reminderKind: reminderKindEnum('reminder_kind').notNull(),
  /**
   * `{customer}`, `{number}` and the rest, filled from a closed set of fields
   * resolved server-side. It is not a template language and must not become
   * one; `TITLE_FIELDS` in lib/reminders/repository.ts is the whole vocabulary.
   */
  titleTemplate: text('title_template').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  index('reminder_rules_trigger_idx').on(t.trigger, t.isActive),
  check(
    'reminder_rules_stage_only_on_stage_trigger',
    sql`trigger_stage is null or trigger = 'stage_entered'`,
  ),
]);

/**
 * Something to do, on a day, about one record.
 *
 * The unique partial index below is what makes the hourly scheduler safe, and
 * it is the single most important line in this file. A rule that has already
 * produced an open reminder for an entity must not produce a second, or the
 * job creates twenty-four duplicates a day and the owner stops opening the
 * screen -- which is the only failure mode that matters, because a reminder
 * system nobody trusts is worse than no reminder system.
 */
export const reminders = pgTable('reminders', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: timelineEntityTypeEnum('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  title: text('title').notNull(),
  detail: text('detail'),
  /**
   * A moment, not a day -- the tenant's midnight on the due date when the
   * scheduler writes it, and whatever hour a person picks when they do.
   *
   * Read back as a date IN THE TENANT'S ZONE, never the server's: in a UTC
   * container after 7pm Toronto those are different days, and a reminder due
   * "today" that appears tomorrow reads as the system being broken.
   */
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  kind: reminderKindEnum('kind').notNull(),
  status: reminderStatusEnum('status').notNull().default('open'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  completedBy: uuid('completed_by').references(() => users.id),
  assignedTo: uuid('assigned_to').references(() => users.id),
  /**
   * Hides a reminder without completing it. The DUE DATE DOES NOT MOVE with
   * it, so a reminder snoozed past its deadline comes back overdue -- which is
   * the honest outcome. Pushing the deadline would let a quote follow-up be
   * deferred forever and still look on time.
   */
  snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
  /**
   * Nothing reads these two yet. They are here because the shape of a
   * recurring reminder is a schema decision and a later migration to add them
   * would have to rewrite rows; rolling one occurrence forward on completion
   * is Phase 2's screen work, not this slice.
   *
   * `recurrence_until` is a DATE where `due_at` is a timestamp: a reminder is
   * due at a moment, a recurrence stops on a day. Storing the second as a
   * timestamp invites a timezone bug at the boundary.
   */
  recurrence: reminderRecurrenceEnum('recurrence').notNull().default('none'),
  recurrenceUntil: date('recurrence_until'),
  /**
   * Which rule produced this, and NULL when a person wrote it by hand.
   *
   * Null is load-bearing: PostgreSQL treats nulls as distinct in a unique
   * index, so hand-made reminders fall outside `reminders_one_open_per_rule`
   * entirely. The owner may write "call Dave" twice if he wants to -- that is
   * not the machine duplicating itself.
   */
  generatedByRuleId: uuid('generated_by_rule_id').references(() => reminderRules.id),
  ...auditColumns,
}, (t) => [
  /**
   * The idempotency guard, and an INDEX rather than an application check
   * because a SELECT followed by an INSERT is not a guard. Two evaluations
   * racing after a restart both read an empty result and both insert; this is
   * what survives that. The application checks as well, so the second
   * evaluation is a quiet no-op instead of an exception.
   *
   * Note what it deliberately allows: once a reminder is completed it leaves
   * the index, and the rule may fire again. That is correct -- a quote
   * followed up in March and still open in June should be chased again.
   */
  uniqueIndex('reminders_one_open_per_rule')
    .on(t.generatedByRuleId, t.entityType, t.entityId)
    .where(sql`status = 'open' and record_status = 'active'`),
  // The two screens that read this table: the reminder list, ordered by when
  // it is due, and the panel on a customer or project.
  index('reminders_due_idx').on(t.status, t.dueAt),
  index('reminders_entity_idx').on(t.entityType, t.entityId, t.status),
  // Completion is a fact with a time on it. A `done` row with no
  // `completed_at` cannot answer "when did we deal with this", and a
  // `completed_at` on an open row is a completion somebody undid without
  // saying so. Dismissal is NOT completion and correctly carries neither.
  check(
    'reminders_completed_iff_done',
    sql`(status = 'done') = (completed_at is not null)`,
  ),
  check(
    'reminders_recurrence_until_needs_recurrence',
    sql`recurrence <> 'none' or recurrence_until is null`,
  ),
]);
