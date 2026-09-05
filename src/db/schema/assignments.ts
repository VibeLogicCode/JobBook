import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, cents } from '@/db/columns';
import { users } from '@/db/schema/organization';
import { scheduleTasks } from '@/db/schema/schedule';
import { vendors } from '@/db/schema/vendors';

/**
 * WHO is doing a scheduled task (spec 5.1).
 *
 * `schedule_tasks.trade` says a task needs a framer. This says which framer,
 * and it is the row without which no calendar can ever answer the question the
 * owner actually asked -- *"who is scheduled on what day, internal resource,
 * me, vendor"*. A trade string cannot answer it, because two jobs both needing
 * "framing" in the same week is not a clash and the same framer on both is.
 *
 * ---------------------------------------------------------------------------
 * THE ASSIGNEE: TWO NULLABLE FOREIGN KEYS AND A CHECK, NOT A POLYMORPHIC PAIR
 * ---------------------------------------------------------------------------
 *
 * Spec 5.1 draws this table with a single `vendor_id`, and that column alone
 * cannot say "me" or "my own crew" -- two of the three kinds of assignee the
 * owner named in one sentence. So the shape had to change, and the choice was
 * between a nullable `vendor_id` beside a nullable `user_id` with a constraint,
 * and the `assignee_type`/`assignee_id` pair that `activities` and `reminders`
 * already use here.
 *
 * The polymorphic pair is the house pattern and it is still the right one
 * THERE. The note on `timelineEntityTypeEnum` records why: a timeline hangs off
 * a customer, a project OR a quote, three separate parent tables, and expressing
 * that as real foreign keys would have meant three nullable columns on every
 * activity and every reminder -- tripling the width of the two tables that are
 * read on almost every screen, to enforce something the evaluator already knows.
 *
 * Not one clause of that reasoning survives the move to this table.
 *
 * 1. **Two parents, not three.** One extra nullable column, on a table read
 *    only through its task. The width argument is a third of the size it was
 *    and it was already the smaller half of the trade.
 *
 * 2. **The pair is never a query predicate here, only a join target.** A
 *    timeline query IS `where entity_type = ... and entity_id = ...`, which is
 *    what makes the polymorphic pair cheap there -- one index answers it. This
 *    table is read `where schedule_task_id = ...` and the assignee is then
 *    RESOLVED for display. Polymorphism buys nothing on that path: resolving a
 *    name still costs two left joins, because the name lives in two tables
 *    either way. It only costs the integrity.
 *
 * 3. **The integrity is the requirement, not a nicety.** A retired or voided
 *    vendor must still resolve on a task he is already assigned to -- retiring
 *    a sub cannot blank last spring's schedule. A real foreign key is exactly
 *    the guarantee that the row it names is still there, and nothing is ever
 *    deleted in this product, so "still there" is permanent. A polymorphic uuid
 *    is an unchecked value: it can hold a customer's id, or a task's, or a
 *    typo, and the screen finds out by rendering a blank where a person's name
 *    should be.
 *
 * 4. **The compliance gate hangs off this join.** Spec 5.3 makes issuing a PO
 *    to a subcontractor with a lapsed WSIB clearance a blocking warning, which
 *    is a query from an assignment through `vendor_id` to
 *    `compliance_documents`. A gate that exists to stop a real financial
 *    exposure should not be joining through a column the database does not
 *    check.
 *
 * So the database holds the rule rather than describing it: `num_nonnulls` says
 * EXACTLY ONE of the two is set, and a row therefore means one thing. This one
 * could be enforced, so it is.
 *
 * **The third kind of assignee is not a third column.** The owner named a
 * subcontractor, an internal person, and himself -- and the last two are both
 * rows in `users`. "Me" is `user_id` pointing at the signed-in owner's own row,
 * which is why there is no magic string and no boolean anywhere here: the
 * screen says "You" by comparing that id to the actor it already looked up,
 * and the database stores a person either way.
 */
export const assignments = pgTable('assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  scheduleTaskId: uuid('schedule_task_id')
    .notNull()
    .references(() => scheduleTasks.id),
  /**
   * A subcontractor. Only ever one with `is_subcontractor = true` -- a lumber
   * yard is not assigned to a task -- which is a rule the ACTION enforces
   * inside its transaction rather than a check constraint, because
   * `is_subcontractor` lives on another table and a check may not read one.
   *
   * A live foreign key rather than a name snapshot, for the reason
   * `schedule_tasks.cost_code_id` is one: the vendor is retired or voided
   * later and the assignment goes on resolving, with the screen saying which.
   */
  vendorId: uuid('vendor_id').references(() => vendors.id),
  /**
   * An internal person -- the owner himself, or somebody who works for him.
   *
   * `users` and not a separate `crew` table, deliberately: this product has
   * exactly one table of people who work for the company, an internal person
   * needs to be told what they are on, and inventing a second roster would
   * mean the owner appears twice and the two disagree the first time somebody
   * edits one.
   */
  userId: uuid('user_id').references(() => users.id),
  /**
   * TWO DATES, NOT ONE STATUS, and that is the whole point of the pair.
   *
   * A status column with members `asked`, `confirmed`, `declined` cannot
   * distinguish "I asked him on Tuesday and have heard nothing" from "he said
   * no" without a second column saying when -- and the first of those is the
   * one the owner needs to chase. Both null is asked-and-silent; `confirmed_at`
   * is a yes with a date on it; `declined_at` is a no with a date on it. The
   * check below refuses the only combination that means nothing.
   *
   * Timestamps rather than dates because each records a MOMENT somebody was
   * spoken to, the way `reminders.completed_at` and `voided_at` do. The
   * calendar days a task occupies are `date` columns on `schedule_tasks` and
   * are the tenant's; these are instants, and the screen renders them in the
   * tenant's zone rather than the server's.
   */
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  declinedAt: timestamp('declined_at', { withTimezone: true }),
  /**
   * What was agreed for this task, in integer cents. NULLABLE, and the null is
   * load-bearing.
   *
   * Null means nothing has been agreed -- the common state of an assignment
   * that has been asked about and not priced. Zero means agreed at zero, which
   * is what an internal person on salary or an own-crew day genuinely is. An
   * expense row's money columns default to zero because a receipt with no tax
   * on it HAD no tax; an assignment with no agreed price has no price yet, and
   * collapsing that into zero would report a job as having a sub lined up for
   * nothing.
   *
   * A plan figure, not a ledger line: what is actually paid is an `expenses`
   * row against the vendor, coded to the task's cost code. Nothing computes
   * against this column, so nothing here can be wrong by a cent -- the value
   * is parsed once through `lib/money`, stored, and formatted for display.
   */
  agreedAmountCents: cents('agreed_amount_cents'),
  /**
   * Which purchase order covers this assignment. NO FOREIGN KEY, because
   * `purchase_orders` does not exist yet.
   *
   * Created now and written by nothing, deliberately, in the same spirit as
   * `schedule_tasks.percent_complete_ten_thou` and the expense OCR columns:
   * the column is part of the shape spec 5.1 draws, and adding it later would
   * be a migration against a table holding a live schedule. The constraint
   * arrives with the table it points at -- which is the honest order, since a
   * foreign key to a table that does not exist is not a thing a migration can
   * write.
   */
  purchaseOrderId: uuid('purchase_order_id'),
  /**
   * UNASSIGNING, WHICH IS NEITHER A DELETE NOR A VOID.
   *
   * Nothing is deleted -- the application role holds no DELETE privilege at
   * all -- so taking somebody off a task had to become a written fact, and the
   * question was which written fact.
   *
   * NOT `record_status = 'void'`. Void means the row should never have existed,
   * and this product is careful about that distinction in two other places
   * already: a retired cost code is not a voided one, and a dismissed reminder
   * is not a voided one. A sub who was asked, or who confirmed and then got
   * pulled onto another job, WAS on this task. Voiding that erases the fact
   * that he was asked -- and where he declined, `declined_at` is the record of
   * it and voiding the row would destroy the only evidence the owner has that
   * he went looking.
   *
   * So unassigning is an END DATE with a reason on it, and `record_status`
   * keeps its own meaning exactly: the wrong sub picked off the list, or an
   * assignment typed against the wrong task, is still a void.
   *
   * The removed row stays on screen, greyed and dated, and stops counting as a
   * live assignment -- which is what takes it out of the partial unique
   * indexes below, so the same person may be assigned to the same task again
   * later. That is correct: a sub taken off in March and brought back in May
   * is two assignments and one history.
   */
  removedAt: timestamp('removed_at', { withTimezone: true }),
  removedBy: uuid('removed_by'),
  removalReason: text('removal_reason'),
  /** "Bring his own compactor", "second week only". What was said on the phone. */
  notes: text('notes'),
  ...auditColumns,
}, (t) => [
  /** The screen's query: everybody on this task. */
  index('assignments_task_idx').on(t.scheduleTaskId),
  /**
   * The two queries that read this table BY ASSIGNEE rather than by task, and
   * the reason they are indexed before anything asks them.
   *
   * A double-booking check is "every other live assignment this person holds",
   * across every job, which is a scan of the whole table without these. So is
   * the compliance gate of spec 5.3, and so is the calendar view this table
   * exists to make possible.
   */
  index('assignments_vendor_idx').on(t.vendorId),
  index('assignments_user_idx').on(t.userId),
  /**
   * One live assignment per person per task, enforced by the database rather
   * than by a read-then-insert.
   *
   * A check followed by an insert is two statements with a gap between them,
   * and the gap is where the second tab's insert lands -- the same reasoning
   * `reminders_one_open_per_rule` is written down for. Assigning the same
   * framer to the same task twice is not two facts; it is one fact and a
   * duplicate that would then be counted twice by every roll-up.
   *
   * Partial on the LIVE rows, unlike `vendors_name_unique`, and the difference
   * is deliberate. A vendor's name is unique on the column because the whole
   * point of that table is that one counterparty is not three rows, and
   * freeing the name on retirement would let the duplicate straight back in.
   * Here the opposite is true: an assignment that was removed is finished
   * history, and refusing to re-assign the same sub to the same task because
   * he was once taken off it would be the index enforcing a rule nobody has.
   */
  uniqueIndex('assignments_one_live_vendor_per_task')
    .on(t.scheduleTaskId, t.vendorId)
    .where(sql`vendor_id is not null and removed_at is null and record_status = 'active'`),
  uniqueIndex('assignments_one_live_user_per_task')
    .on(t.scheduleTaskId, t.userId)
    .where(sql`user_id is not null and removed_at is null and record_status = 'active'`),

  /**
   * Exactly one assignee. The rule the whole file is about, held by the
   * database because it can be.
   *
   * Neither set is a row that assigns nobody to anything; both set is a row
   * that means two different things at once and that every join would double.
   */
  check('assignments_one_assignee', sql`num_nonnulls(vendor_id, user_id) = 1`),
  /**
   * Yes and no are not both true. Silence is both columns null, which is the
   * state this pair exists to keep distinguishable from a refusal.
   *
   * A mind changed is a fact with a later date, so clearing one before setting
   * the other is what the action does rather than what the row allows.
   */
  check(
    'assignments_not_confirmed_and_declined',
    sql`confirmed_at is null or declined_at is null`,
  ),
  /**
   * A negative agreed amount is not a price anybody agreed to. A credit from a
   * sub is an expense row with a sign on it, on the ledger side, where the
   * paper that justifies it lives.
   */
  check(
    'assignments_agreed_amount_not_negative',
    sql`agreed_amount_cents is null or agreed_amount_cents >= 0`,
  ),
  /**
   * A removal reason with no removal behind it is a sentence about nothing,
   * and it would read on screen as though somebody had been taken off.
   */
  check(
    'assignments_removal_detail_needs_removal',
    sql`removed_at is not null or (removed_by is null and removal_reason is null)`,
  ),
]);
