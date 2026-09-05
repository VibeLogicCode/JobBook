import type { EntityType, ReminderKind } from '@/lib/reminders/types';

/**
 * The vocabulary of a reminder somebody writes by hand.
 *
 * Separate from `labels.ts` because that file names what the screens PRINT and
 * this one decides what the add-a-reminder form OFFERS -- two different
 * questions, and the second is shared with the server action rather than only
 * with a component. The action imports the same lists the form renders from,
 * which is the trick `activity/actions.ts` already uses with
 * `ACTIVITY_KIND_ORDER`: a member added to the dropdown and forgotten in the
 * validator is the bug this shape makes impossible.
 *
 * Nothing here imports the schema, so the client bundle stays clear of the
 * database layer. `tests/unit/new-reminder.test.ts` asserts the pairing with
 * the enums, so a drift fails there rather than rendering a blank option.
 */

/**
 * The kinds a person may choose.
 *
 * `quote_expiring` is deliberately absent, and it is the only one missing. It
 * is derived from a quote's `valid_until` by the rule that owns it; a
 * hand-written one would be a row asserting an expiry date nothing checked,
 * and the first time the two disagreed the screen would be lying about a
 * document a customer is holding.
 *
 * Ordered by what the owner writes most often, not by the enum. A list that
 * opens on 'compliance' costs a scroll on every reminder he actually makes.
 */
export const REMINDER_KIND_CHOICES: readonly ReminderKind[] = [
  'callback', 'follow_up', 'site_visit', 'compliance', 'custom',
];

/**
 * What the kind picker opens on, per record.
 *
 * A reminder against a PERSON is almost always "ring them back"; one against a
 * job or a quote is almost always "chase this". Guessing right saves a tap on
 * the control the owner would otherwise have to think about, and guessing
 * wrong costs the same tap he would have spent anyway.
 *
 * A record per entity type rather than a switch, so a fourth type is a line
 * here rather than a branch somebody forgets to add.
 */
const DEFAULT_KIND: Record<EntityType, ReminderKind> = {
  customer: 'callback',
  project: 'follow_up',
  quote: 'follow_up',
};

export function defaultReminderKind(entityType: EntityType): ReminderKind {
  return DEFAULT_KIND[entityType];
}

/** How a default title opens, per record. Same reasoning as `DEFAULT_KIND`. */
const TITLE_VERB: Record<EntityType, string> = {
  customer: 'Call',
  project: 'Follow up on',
  quote: 'Follow up on',
};

/**
 * A title already filled in, from what the page it was opened on knows.
 *
 * The owner is doing this one-handed on a phone between jobs. "Call Sample
 * Client" typed for him is the difference between a reminder written and a
 * reminder meant -- and it is a DEFAULT, sitting in an editable field, so
 * anything more specific costs him nothing but the typing he was going to do.
 *
 * An empty label yields an empty title rather than a bare verb: "Call" on its
 * own is not a reminder, and a required field left blank asks him for the one
 * word that would have made it one.
 */
export function defaultReminderTitle(entityType: EntityType, label: string): string {
  const named = label.trim();
  if (named === '') return '';
  return `${TITLE_VERB[entityType]} ${named}`;
}

/**
 * When it is due, as an OFFSET IN DAYS rather than a date.
 *
 * The same decision `SNOOZE_CHOICES` made, for the same reason: the offset is
 * resolved against the tenant's today on the server, so a phone whose clock is
 * wrong -- or one still showing yesterday because it has been in a pocket
 * since 7pm -- cannot file a reminder on a day nobody meant. It is also fewer
 * taps than a date picker for the four answers that cover almost every case.
 *
 * `date` is the escape hatch, and the only value that makes the date field
 * mean anything.
 */
export const ON_A_DATE = 'date';

export interface DueChoice {
  value: string;
  label: string;
  /** Days from the tenant's today. `null` on `date`, which carries its own. */
  days: number | null;
}

export const DUE_CHOICES: readonly DueChoice[] = [
  { value: '0', label: 'Today', days: 0 },
  { value: '1', label: 'Tomorrow', days: 1 },
  { value: '3', label: 'In three days', days: 3 },
  { value: '7', label: 'Next week', days: 7 },
  { value: '14', label: 'In two weeks', days: 14 },
  { value: ON_A_DATE, label: 'On a date…', days: null },
];

/** What the form opens on. A day's grace is the common case for a callback. */
export const DEFAULT_DUE_CHOICE = '1';

/** The accepted tokens, for the action's validator. One list, two readers. */
export const DUE_VALUES: readonly string[] = DUE_CHOICES.map((choice) => choice.value);

/**
 * The offset a token means, or `null` where the person picked a date instead.
 *
 * Throws on a token that is not offered, rather than falling back to today: a
 * value that reached here without passing the validator is a bug, and a
 * reminder quietly filed on the wrong day is exactly the failure this whole
 * screen exists to prevent.
 */
export function dueOffsetDays(value: string): number | null {
  const choice = DUE_CHOICES.find((candidate) => candidate.value === value);
  if (!choice) throw new Error(`${value} is not a due choice`);
  return choice.days;
}
