'use server';

import { count, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { reminderRules, reminders } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  REMINDER_RULE_LABELS,
  STAGE_CHECK,
  createFields,
  offsetPhrase,
  reminderRuleFields,
  stageProblem,
  templateProblem,
  toColumns,
  violatesConstraint,
} from '@/app/settings/reminder-rules/schema';

/**
 * The reminder rule list's write side.
 *
 * The same three rules that run through `settings/cost-codes/actions.ts` run
 * through this file, plus one that belongs only to this screen.
 *
 * 1. **Authorization is a separate lookup, per request.** `guard(...)` reads
 *    the role out of `users` every time, before a single argument is read.
 *    The refusal lives here rather than only in the screen, because a disabled
 *    button is a hint and a stale tab is not obliged to read it.
 * 2. **Nothing is deleted, and switching off is not voiding.**
 *    `is_active = false` says "stop firing this"; `record_status = 'void'`
 *    says "this row should never have existed". They are separate controls
 *    with separate wording, and the evaluator honours both separately --
 *    `loadRules` filters `record_status` in SQL and the evaluator itself skips
 *    `!isActive`, so a voided rule cannot fire even if `is_active` still says
 *    true.
 * 3. **Editing a rule cannot disturb the reminders it already produced.**
 *    Nothing in this file writes `reminders`. A reminder's title is rendered
 *    ONCE, by `insertDrafts`, and stored as a column; no screen re-renders it
 *    from the rule, and nothing joins `reminder_rules` for display -- the only
 *    reader of that table in the whole product is the evaluator's `loadRules`.
 *    So retitling a rule changes what it writes NEXT, and changes nothing that
 *    is already on the owner's list. That is deliberate: a reminder is a
 *    statement made on a day, and a statement that rewrites itself later is
 *    not one anybody can act on.
 *
 * The rule that belongs only here: **a template is validated on save**, with
 * `unknownPlaceholders`, against the fields the chosen trigger can actually
 * supply. This is the one screen in the product whose mistakes surface at
 * three in the morning against every record in the book rather than in front
 * of the person who made them, and `renderTitle` leaving an unknown
 * placeholder standing is the safety net rather than the check.
 *
 * `rates:edit` is the capability, and `record:void` gates voiding as it does
 * everywhere else. The reasoning is written out beside `REFUSAL` below.
 */

/**
 * Why `rates:edit` and not one of the owner-only capabilities.
 *
 * The five owner-only capabilities are the ones whose blast radius is the
 * whole deployment AND whose mistakes are expensive to walk back: the tax rate
 * every future quote inherits, the company's identity on every document it
 * sends, whether records leave the box for a Microsoft tenant, whether backups
 * exist at all. A reminder rule has the first half of that and not the second.
 * It writes rows for everybody, hourly, forever -- and the cost of getting one
 * wrong is noise on a list, undone by one press of a button that leaves every
 * reminder it already made exactly where it was.
 *
 * What the rule list actually separates is "runs the office" from "reads the
 * books". Whoever is chasing quotes is who notices that a rule is firing
 * uselessly, and a screen that made them wait for the owner to switch it off
 * would produce the one failure this screen exists to prevent -- a list nobody
 * trusts, which is worse than no list. `rates:edit` is the capability that
 * draws exactly that line: `owner` and `admin` hold it, `bookkeeper` does not.
 * It is also the capability the cost code list settled on, for the neighbouring
 * reason, so this is the fourth CRUD screen in this area rather than a fourth
 * shape.
 */
const REFUSAL = 'Your role does not permit changing the reminder rules.';

/**
 * A rule rejected for what it SAYS rather than for its shape.
 *
 * It carries the control it is about, because these two refusals -- a
 * placeholder no trigger can fill, a stage-change rule with no stage -- are
 * both about one box on a form somebody is looking at. A banner with no field
 * marked leaves them rereading a sentence for the letter that is wrong, which
 * is the one thing a computer is better at than they are.
 */
class RuleError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
  }
}

/** The refusal, with the offending control named where there is one. */
function refusedField(error: RuleError): ActionResult {
  return refused(error.message, [
    { field: error.field, label: REMINDER_RULE_LABELS[error.field] ?? error.field, message: error.message },
  ]);
}

/** A void refused because the rule is doing work. Same trip, same reason. */
class InUseError extends Error {}

function failureText(error: unknown): string {
  if (error instanceof RuleError || error instanceof InUseError) return error.message;
  if (violatesConstraint(error, STAGE_CHECK)) {
    return 'Only a stage-change rule watches a stage. Nothing was written.';
  }
  // Deliberately NOT `error.message`. Every write here runs inside a
  // transaction, and Drizzle wraps a driver error in a DrizzleQueryError whose
  // message is the failed SQL and its bound parameters. Putting that on the
  // screen tells the owner nothing he can act on and shows him the schema; the
  // server log still has the whole thing.
  return 'That change could not be saved. Nothing was written.';
}

/** The one path off this screen. Nothing here changes an existing reminder. */
function revalidate() {
  revalidatePath('/settings/reminder-rules');
}

/* -------------------------------------------------------------------------
   One rule at a time
   ------------------------------------------------------------------------- */

export async function createReminderRule(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = createFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, REMINDER_RULE_LABELS);
  const { trigger, ...rest } = parsed.data;

  const stage = stageProblem(trigger, rest.triggerStage);
  if (stage) return refusedField(new RuleError(stage, 'triggerStage'));

  const template = templateProblem(rest.titleTemplate, trigger);
  if (template) return refusedField(new RuleError(template, 'titleTemplate'));

  try {
    await db.insert(reminderRules).values({
      ...toColumns(rest),
      trigger,
      isActive: true,
      createdBy: allowed.actor.id,
    });
  } catch (error) {
    return refused(failureText(error));
  }

  revalidate();
  return saved(
    `${rest.name} added, switched on — fires ${offsetPhrase(toColumns(rest).offsetDays, trigger)}.`,
  );
}

const withId = reminderRuleFields.extend({ id: z.uuid('is not a reminder rule') });

/**
 * Edits a rule in place, except for what it watches.
 *
 * The trigger is fixed once a rule exists, and that is a decision rather than
 * an omission. It is the same doctrine the cost code list states about a code
 * whose trade has changed: renaming a bucket relabels it, and repurposing one
 * rewrites history instead. A rule repurposed from "a quote went out" to "a
 * job was won" is a different rule that inherits the first one's open
 * reminders -- and inherits them invisibly, because the idempotency index is
 * keyed on the rule and the record, so the reminders the OLD rule left open go
 * on suppressing the new one until each is completed. Retire this rule and add
 * the one you meant; both rows stay, and nothing is deleted anyway.
 *
 * What IS editable is everything that does not change the question the rule
 * asks: its name, its timing, the kind of reminder it produces, the sentence
 * it writes, and -- for a stage rule -- which stage. The stage is editable
 * because the alternative is a trap: the evaluator treats a rule with no stage
 * as watching nothing, so a rule saved with the wrong stage would otherwise be
 * unfixable rather than merely wrong.
 */
export async function updateReminderRule(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = withId.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, REMINDER_RULE_LABELS);
  const { id, ...rest } = parsed.data;

  let name: string | undefined;
  try {
    name = await db.transaction(async (tx) => {
      // The trigger is read from the row inside the writing transaction rather
      // than taken from the form. It is not editable, so a trigger arriving in
      // a POST is either a stale tab or a hand-made request, and either way the
      // template has to be checked against what this rule ACTUALLY watches.
      const [row] = await tx
        .select({
          trigger: reminderRules.trigger,
          recordStatus: reminderRules.recordStatus,
        })
        .from(reminderRules)
        .where(eq(reminderRules.id, id));

      if (!row) return undefined;
      if (row.recordStatus !== 'active') {
        throw new RuleError(
          'That rule is void. A void row is kept as a record and is not edited.',
          'name',
        );
      }

      const stage = stageProblem(row.trigger, rest.triggerStage);
      if (stage) throw new RuleError(stage, 'triggerStage');

      const template = templateProblem(rest.titleTemplate, row.trigger);
      if (template) throw new RuleError(template, 'titleTemplate');

      const rows = await tx
        .update(reminderRules)
        // `updated_at` is deliberately absent: a trigger maintains it, and a
        // value written here would be the one the sync cursor trusts.
        .set(toColumns(rest))
        .where(eq(reminderRules.id, id))
        .returning({ name: reminderRules.name });

      return rows[0]?.name;
    });
  } catch (error) {
    if (error instanceof RuleError) return refusedField(error);
    return refused(failureText(error));
  }

  if (!name) return refused('That reminder rule no longer exists.');

  revalidate();
  return saved(`${name} saved. Applies from the next hourly run.`);
}

const activeFields = z.object({ id: z.uuid(), isActive: z.stringbool() });

/**
 * Switches a rule on or off.
 *
 * Off is not a deletion, not a void, and NOT a retraction of anything the rule
 * has already said. The open reminders it produced stay open and stay on the
 * list: they were true statements on the day they were made, and a screen that
 * swept them up when a rule went quiet would be a screen that loses work
 * without saying so. `is_active = false` stops it firing again. Nothing more,
 * and this action writes nothing but that column.
 */
export async function setReminderRuleActive(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = activeFields.safeParse(formValues(formData));
  if (!parsed.success) return refused('That request did not make sense.');

  const rows = await db
    .update(reminderRules)
    .set({ isActive: parsed.data.isActive })
    .where(eq(reminderRules.id, parsed.data.id))
    .returning({ name: reminderRules.name });

  const row = rows[0];
  if (!row) return refused('That reminder rule no longer exists.');

  // Counted after the write, and only to say what is still on the screen. A
  // rule going quiet must not disturb these rows, and nothing above does.
  const [openNow] = await db
    .select({ n: count() })
    .from(reminders)
    .where(eq(reminders.generatedByRuleId, parsed.data.id));

  const already = openNow?.n ?? 0;

  revalidate();
  return saved(
    parsed.data.isActive
      ? `${row.name} is on.`
      : `${row.name} is off.${
          already > 0
            ? ` Its ${already} open reminder${already === 1 ? '' : 's'} ${already === 1 ? 'stays' : 'stay'} open.`
            : ''
        }`,
  );
}

const voidFields = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/**
 * Marks a rule as one that should never have existed.
 *
 * For a rule added twice, or one written against the wrong trigger before it
 * fired. It is not how a noisy rule is taken out of circulation -- that is the
 * on/off switch, and it is one press away.
 *
 * Refused for a rule that has produced a reminder, by the same reasoning the
 * cost code list refuses voiding a code that documents point at: a rule that
 * has written a row somebody has read was not a mistake, and `reminders.
 * generated_by_rule_id` is a live foreign key rather than a snapshot, so
 * anything asking "where did this come from" would be answered by a row the
 * screen calls void.
 */
export async function voidReminderRule(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = voidFields.safeParse(formValues(formData));
  if (!parsed.success) {
    return invalid(parsed.error, REMINDER_RULE_LABELS, 'That void needs a reason.');
  }

  let name: string | undefined;
  try {
    name = await db.transaction(async (tx) => {
      // Counted inside the writing transaction rather than read off the
      // screen: the screen was rendered before the evaluation that ran on the
      // hour and gave this rule its first reminder.
      const [produced] = await tx
        .select({ n: count() })
        .from(reminders)
        .where(eq(reminders.generatedByRuleId, parsed.data.id));

      if ((produced?.n ?? 0) > 0) {
        throw new InUseError(
          `This rule has already produced ${produced?.n} reminder${produced?.n === 1 ? '' : 's'}, so it is not a row that should never have existed. Switch it off instead: that stops it firing and leaves those reminders saying what they said.`,
        );
      }

      const rows = await tx
        .update(reminderRules)
        .set({
          recordStatus: 'void',
          voidedAt: new Date(),
          voidedBy: allowed.actor.id,
          voidReason: parsed.data.reason,
        })
        .where(eq(reminderRules.id, parsed.data.id))
        .returning({ name: reminderRules.name });

      return rows[0]?.name;
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (!name) return refused('That reminder rule no longer exists.');

  revalidate();
  return saved(`${name} is void. It will not fire again.`);
}
