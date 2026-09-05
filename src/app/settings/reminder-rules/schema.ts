import { z } from 'zod';
import { PROJECT_STAGES } from '@/components/detail/labels';
import { REMINDER_KINDS } from '@/components/reminders/labels';
import { unknownPlaceholders } from '@/lib/reminders/rules';
import type { ReminderKind, ReminderTrigger } from '@/lib/reminders/types';

/**
 * The shape a reminder rule arrives in from a form, and the three rules about
 * one that are worth writing down once.
 *
 * A reminder rule is the only record in this product that WRITES ROWS ON ITS
 * OWN, hourly, for as long as the deployment runs. That is what makes the
 * validation here different in kind from the cost code list's: a mistyped cost
 * code is wrong on the screen where it was typed, and a mistyped placeholder
 * is wrong at three in the morning against every quote in the book. So the
 * three rules are:
 *
 * 1. **A template is checked when the rule is SAVED**, against the fields the
 *    chosen trigger can actually supply. `renderTitle` leaves an unknown
 *    placeholder standing rather than blanking it, deliberately, so a rule
 *    that slipped through reads as obviously broken -- but that is the safety
 *    net, not the check, and this is the check.
 * 2. **Interpolation is a closed set of named fields.** `TEMPLATE_FIELDS`
 *    below is the whole vocabulary and it is a narrowing of `TITLE_FIELDS` in
 *    lib/reminders/repository.ts, never a superset. The moment a template can
 *    reach an arbitrary value it is a template language, and a template
 *    language in a settings form is an expression evaluator somebody will
 *    eventually point at the database.
 * 3. **A stage-change rule must name its stage.** The evaluator treats a rule
 *    with no stage as watching NOTHING rather than everything, because firing
 *    on every stage change would bury the list. That is the right default for
 *    a row somebody wrote in SQL; it is a trap for a field somebody skipped on
 *    a form, so the form refuses instead of accepting a rule that can never
 *    fire.
 */

export const REMINDER_RULE_LABELS: Record<string, string> = {
  name: 'Name',
  trigger: 'Watches for',
  triggerStage: 'Stage',
  offsetAmount: 'How long',
  offsetDirection: 'Before or after',
  reminderKind: 'Kind of reminder',
  titleTemplate: 'What the reminder says',
  reason: 'Reason',
};

/* -------------------------------------------------------------------------
   Triggers
   ------------------------------------------------------------------------- */

/** What each trigger watches, in the words the owner would use. */
export const TRIGGER_LABELS: Record<ReminderTrigger, string> = {
  quote_sent: 'A quote went out',
  quote_expiring: 'A quote is about to expire',
  stage_entered: 'A job entered a stage',
  no_activity: 'Nobody has spoken to a customer',
  site_visit_scheduled: 'A site visit is booked',
  project_won: 'A job was won',
};

/**
 * The date the offset is measured from, worded so the offset reads as a
 * sentence rather than as a signed number.
 *
 * "Negative means before" is true and is not what anybody thinks in. The form
 * asks for a count and a direction and assembles the integer; this is what
 * turns the stored integer back into the sentence on the list.
 */
const ANCHORS: Record<ReminderTrigger, string> = {
  quote_sent: 'the quote went out',
  quote_expiring: 'the quote expires',
  stage_entered: 'the job entered that stage',
  no_activity: 'the last contact',
  site_visit_scheduled: 'the site visit',
  project_won: 'the job was won',
};

/** What the rule is for, shown beside the trigger when one is being chosen. */
export const TRIGGER_NOTES: Record<ReminderTrigger, string> = {
  quote_sent: 'Every sent quote. Catches one going quiet before it reads as a decline.',
  quote_expiring: 'Not-yet-expired quotes only. An old expired one is the sent-quote rule’s job.',
  stage_entered: 'The stage a job is in now. Does not refire for a stage it has since left.',
  no_activity: 'Customers with live work and no recent contact logged.',
  site_visit_scheduled: 'Jobs at the site-visit stage with a date on them, and only visits still ahead.',
  project_won: 'A job that has just moved to won.',
};

export const TRIGGER_OPTIONS = (
  Object.keys(TRIGGER_LABELS) as ReminderTrigger[]
).map((value) => ({ value, label: TRIGGER_LABELS[value] }));

export function isTrigger(value: string): value is ReminderTrigger {
  return Object.hasOwn(TRIGGER_LABELS, value);
}

/* -------------------------------------------------------------------------
   The template vocabulary
   ------------------------------------------------------------------------- */

/**
 * What a template may name, per trigger.
 *
 * A narrowing of `TITLE_FIELDS` in lib/reminders/repository.ts, and the
 * narrowing is the point. The repository hands every fact all six keys so the
 * evaluator never has to branch, but `no_activity` gathers from a scan over
 * CUSTOMERS -- it knows a name and a date and nothing else, and supplies the
 * other four as empty strings. A template reading "No contact with {customer}
 * about {project}" would therefore save cleanly, pass `unknownPlaceholders`
 * against the full set, and then render "No contact with Sample Client about
 * " every night. That reads as missing data and sends the owner looking in the
 * wrong place, which is precisely the failure the placeholder check exists to
 * prevent.
 *
 * The pairing with the repository is asserted in
 * `tests/unit/reminder-rule-form.test.ts`, so a field added to the closed set
 * and forgotten here fails there rather than being quietly unavailable.
 */
export const TEMPLATE_FIELDS: Record<ReminderTrigger, readonly string[]> = {
  quote_sent: ['customer', 'project', 'number', 'address', 'stage', 'date'],
  quote_expiring: ['customer', 'project', 'number', 'address', 'stage', 'date'],
  stage_entered: ['customer', 'project', 'number', 'address', 'stage', 'date'],
  site_visit_scheduled: ['customer', 'project', 'number', 'address', 'stage', 'date'],
  project_won: ['customer', 'project', 'number', 'address', 'stage', 'date'],
  no_activity: ['customer', 'date'],
};

/** What each placeholder resolves to, so the hint is not a bare list of words. */
export const FIELD_NOTES: Record<string, string> = {
  customer: 'the customer’s name',
  project: 'the job’s name',
  number: 'the quote number, or the job’s name where there is no quote',
  address: 'the site address, or the job’s name where there is none',
  stage: 'the stage the job is in',
  date: 'the date the offset was measured from',
};

/**
 * A template that names something the trigger cannot supply, said in full.
 *
 * The misspelling is quoted back. "That placeholder is not valid" leaves the
 * owner rereading a sentence for the letter that is wrong, which is the one
 * thing a computer is better at than he is.
 */
export function templateProblem(
  template: string,
  trigger: ReminderTrigger,
): string | null {
  const allowed = TEMPLATE_FIELDS[trigger];
  const unknown = unknownPlaceholders(template, allowed);
  if (unknown.length === 0) return null;

  const named = unknown.map((name) => `{${name}}`).join(', ');
  const offered = allowed.map((name) => `{${name}}`).join(', ');
  return `${named} ${unknown.length === 1 ? 'is not something' : 'are not things'} “${TRIGGER_LABELS[trigger]}” can fill in. It offers ${offered}. Nothing else is available: interpolation here is a closed set of named fields, not a template language.`;
}

/* -------------------------------------------------------------------------
   Stages
   ------------------------------------------------------------------------- */

export const STAGE_OPTIONS = (
  Object.keys(PROJECT_STAGES) as (keyof typeof PROJECT_STAGES)[]
).map((value) => ({ value, label: PROJECT_STAGES[value] }));

export function isStage(value: string): value is keyof typeof PROJECT_STAGES {
  return Object.hasOwn(PROJECT_STAGES, value);
}

/**
 * Whether the stage field agrees with the trigger, and if not, why.
 *
 * Both halves refuse rather than one of them quietly correcting. Nulling a
 * stage that was chosen alongside the wrong trigger would save a rule the
 * owner did not write, and the database's own CHECK refuses that pairing
 * anyway -- being told "that could not be saved" by Postgres is a worse
 * version of the same answer.
 */
export function stageProblem(
  trigger: ReminderTrigger,
  triggerStage: string | null,
): string | null {
  if (trigger === 'stage_entered' && triggerStage === null) {
    return 'A rule that watches a stage change has to say which stage. A rule with no stage set watches nothing at all — not everything — because firing on every stage change would bury the list.';
  }
  if (trigger !== 'stage_entered' && triggerStage !== null) {
    return `Only “${TRIGGER_LABELS.stage_entered}” watches a stage. Leave the stage unset for this trigger, or change the trigger.`;
  }
  return null;
}

/* -------------------------------------------------------------------------
   Kinds
   ------------------------------------------------------------------------- */

export const KIND_OPTIONS = (
  Object.keys(REMINDER_KINDS) as ReminderKind[]
).map((value) => ({ value, label: REMINDER_KINDS[value] }));

/* -------------------------------------------------------------------------
   The form
   ------------------------------------------------------------------------- */

/**
 * How far the offset may be pushed.
 *
 * A year, because a reminder further out than that is one the owner will not
 * recognise when it lands, and an offset typed with an extra digit is the
 * commonest way to produce one.
 */
const MAX_OFFSET = 365;

const offsetAmount = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => /^\d{1,3}$/.test(value), 'must be a whole number of days')
  .transform((value) => Number(value))
  .refine((value) => value <= MAX_OFFSET, `must be ${MAX_OFFSET} days or fewer`);

const offsetDirection = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value === 'after' || value === 'before', 'must be before or after')
  .transform((value) => value as 'after' | 'before');

const kindField = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => Object.hasOwn(REMINDER_KINDS, value), 'is not one of the kinds offered')
  .transform((value) => value as ReminderKind);

/**
 * The stage, which is ABSENT rather than empty on most of the forms that
 * submit this shape.
 *
 * `.optional()` is load-bearing, and is the same rule the shared `checkbox`
 * builder in `settings/validate.ts` is written for: a browser submits nothing
 * at all for a control that is not on the form, and the edit sheet renders the
 * stage select only for a rule that actually watches stages. Without this the
 * five shipped rules could not be saved at all -- every one of them failed on
 * "Stage: expected string, received undefined" before the template was ever
 * looked at, which is a validation error about a field the person could not
 * see.
 */
const stageField = z
  .string()
  .optional()
  .transform((value) => (value ?? '').trim())
  .refine((value) => value === '' || isStage(value), 'is not one of the stages')
  .transform((value) => (value === '' ? null : value));

const triggerField = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => isTrigger(value), 'is not one of the triggers offered')
  .transform((value) => value as ReminderTrigger);

/**
 * Everything a rule carries except what it watches.
 *
 * The trigger is deliberately absent from the shared shape: it is asked for
 * once, when the rule is created, and is not editable afterwards. See
 * `createFields` below.
 */
export const reminderRuleFields = z.object({
  name: z.string().trim().min(1, 'is required').max(120, 'must be 120 characters or fewer'),
  offsetAmount,
  offsetDirection,
  reminderKind: kindField,
  titleTemplate: z
    .string()
    .trim()
    .min(1, 'is required')
    .max(200, 'must be 200 characters or fewer'),
  triggerStage: stageField,
});

export type ReminderRuleInput = z.output<typeof reminderRuleFields>;

export const createFields = reminderRuleFields.extend({ trigger: triggerField });

/**
 * The signed integer the column stores, assembled from the two controls the
 * form actually asks for.
 *
 * Zero has no direction, so it is normalised to zero rather than to "minus
 * nothing": `-0` is a real value in JavaScript, it survives into the driver,
 * and two rules that are the same rule should not read differently on the
 * screen.
 */
export function toOffsetDays(input: Pick<ReminderRuleInput, 'offsetAmount' | 'offsetDirection'>): number {
  if (input.offsetAmount === 0) return 0;
  return input.offsetDirection === 'before' ? -input.offsetAmount : input.offsetAmount;
}

/** Form names to column names, so no action writes the mapping by hand. */
export function toColumns(input: ReminderRuleInput) {
  return {
    name: input.name,
    offsetDays: toOffsetDays(input),
    reminderKind: input.reminderKind,
    titleTemplate: input.titleTemplate,
    triggerStage: input.triggerStage,
  };
}

/* -------------------------------------------------------------------------
   Reading a stored rule back out
   ------------------------------------------------------------------------- */

/** Which way round the two controls should be when an existing rule opens. */
export function directionOf(offsetDays: number): 'after' | 'before' {
  return offsetDays < 0 ? 'before' : 'after';
}

/** The timing as a sentence: "3 days after the quote went out". */
export function offsetPhrase(offsetDays: number, trigger: ReminderTrigger): string {
  const anchor = ANCHORS[trigger];
  if (offsetDays === 0) return `the same day as ${anchor}`;
  const days = Math.abs(offsetDays);
  const unit = days === 1 ? 'day' : 'days';
  return `${days} ${unit} ${offsetDays < 0 ? 'before' : 'after'} ${anchor}`;
}

/* -------------------------------------------------------------------------
   The database errors this screen has a sentence for
   ------------------------------------------------------------------------- */

/**
 * Whether a Postgres error anywhere in the chain names a constraint.
 *
 * The chain walk is the part worth keeping, and it is the corrected version
 * from `cost-codes/schema.ts` rather than the older direct `.code` read in
 * `rates/actions.ts`. Every write on this screen runs inside a transaction --
 * a rule's reminders have to be counted at the moment of the write, not
 * merely when the form was rendered -- and Drizzle wraps a transaction's
 * failure in a `DrizzleQueryError` that carries the driver's error on `cause`.
 * Reading only the top of that turns a named constraint into an unexplained
 * failure with the failed SQL and its bound parameters printed on the screen.
 *
 * `reminder_rules` carries no unique index beyond its primary key, so nothing
 * here is a duplicate-key path: the one constraint a form can reach is the
 * CHECK that refuses a stage on a rule that does not watch stages. The form
 * refuses that first, in `stageProblem`, and this is what stops a hand-made
 * POST getting the raw SQL back instead of a sentence.
 */
export function violatesConstraint(error: unknown, name: string): boolean {
  let current: unknown = error;
  // Bounded, because an error whose `cause` is itself would otherwise spin.
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const candidate = current as { constraint_name?: unknown; constraint?: unknown };
    if (candidate.constraint_name === name || candidate.constraint === name) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export const STAGE_CHECK = 'reminder_rules_stage_only_on_stage_trigger';
