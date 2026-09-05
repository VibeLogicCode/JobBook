import { addDays } from '@/lib/quote/dates';
import {
  firesOnlyWhenDue,
  reminderKey,
  type ReminderDraft,
  type ReminderRule,
  type TriggerFact,
} from '@/lib/reminders/types';

/**
 * The rule evaluator.
 *
 * Pure: rules and facts in, drafts out. It never reads the clock and never
 * touches the database, because every interesting case in a scheduler is a
 * boundary -- the day a quote expires, the day a threshold is crossed -- and a
 * function that calls `Date.now()` cannot be tested at one.
 *
 * `today` is the tenant's own date, from `tenantToday`. Not the server's and
 * not UTC: in a UTC container after 7pm Toronto those are different days, and
 * a reminder due "today" that appears tomorrow reads as the system being
 * broken.
 */

/**
 * Fills `{name}` placeholders from a closed set of fields.
 *
 * An unknown placeholder is left standing rather than blanked. A title reading
 * "Follow up on quote to {custmer}" is obviously a broken rule the owner can
 * go and fix; "Follow up on quote to " looks like missing data and sends him
 * looking in the wrong place. Templates are validated when a rule is SAVED --
 * see `unknownPlaceholders` -- so this path is the safety net, not the check.
 */
export function renderTitle(template: string, fields: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(fields, name) ? fields[name]! : whole,
  );
}

/**
 * Placeholders in a template that no fact will ever supply.
 *
 * Used by the settings form so a mistyped field fails loudly at the moment the
 * owner writes the rule, rather than quietly at 3am when it fires.
 */
export function unknownPlaceholders(template: string, allowed: readonly string[]): string[] {
  const known = new Set(allowed);
  const found = new Set<string>();
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    if (!known.has(match[1]!)) found.add(match[1]!);
  }
  return [...found];
}

export interface EvaluateOptions {
  /** The tenant's today, as an ISO date. */
  today: string;
  /**
   * Keys of reminders already open, from `reminderKey`. A rule that already
   * has an open reminder for an entity does not produce a second; without
   * this an hourly job creates twenty-four duplicates a day and the owner
   * stops opening the screen, which is the only failure that matters.
   */
  openKeys: ReadonlySet<string>;
}

export function evaluateRules(
  rules: readonly ReminderRule[],
  facts: readonly TriggerFact[],
  { today, openKeys }: EvaluateOptions,
): ReminderDraft[] {
  const drafts: ReminderDraft[] = [];

  // Within one evaluation as well as against the database: two facts of the
  // same trigger on one entity -- a quote revised twice in a day -- would
  // otherwise produce two drafts that both pass the openKeys check and then
  // collide on the unique index, failing the whole batch.
  const claimed = new Set<string>();

  for (const rule of rules) {
    if (!rule.isActive) continue;

    for (const fact of facts) {
      if (fact.trigger !== rule.trigger) continue;

      // `stage_entered` is the one trigger that is not identified by its name
      // alone: a rule watching `won` must ignore a project that entered
      // `on_hold`. A rule with no stage set watches nothing rather than
      // everything -- firing on every stage change would bury the list.
      if (rule.trigger === 'stage_entered' && (!rule.triggerStage || fact.stage !== rule.triggerStage)) {
        continue;
      }

      const dueOn = addDays(fact.anchorDate, rule.offsetDays);

      // Retrospective triggers assert something about the past and are false
      // until their date arrives. See `firesOnlyWhenDue`.
      if (firesOnlyWhenDue(rule.trigger) && dueOn > today) continue;

      const key = reminderKey(rule.id, fact.entityType, fact.entityId);
      if (openKeys.has(key) || claimed.has(key)) continue;
      claimed.add(key);

      drafts.push({
        ruleId: rule.id,
        entityType: fact.entityType,
        entityId: fact.entityId,
        kind: rule.reminderKind,
        title: renderTitle(rule.titleTemplate, fact.fields),
        dueOn,
      });
    }
  }

  return drafts;
}

/**
 * Whether a reminder should show in the "due" list on a given day.
 *
 * Snoozing hides a reminder without completing it, so a snoozed row is not due
 * until its snooze runs out -- but its due date does NOT move. A reminder
 * snoozed past its deadline comes back overdue, which is the honest outcome:
 * pushing the deadline with the snooze would let a quote follow-up be deferred
 * forever and still look on time.
 */
export function isDue(
  reminder: { dueOn: string; snoozedUntil: string | null; status: string },
  today: string,
): boolean {
  if (reminder.status !== 'open') return false;
  if (reminder.snoozedUntil && reminder.snoozedUntil > today) return false;
  return reminder.dueOn <= today;
}

/** Open, past its due date, and not snoozed out of the way. */
export function isOverdue(
  reminder: { dueOn: string; snoozedUntil: string | null; status: string },
  today: string,
): boolean {
  return isDue(reminder, today) && reminder.dueOn < today;
}
