import { isDue, isOverdue } from '@/lib/reminders/rules';
import type { ReminderRow } from '@/lib/reminders/repository';
import type { Urgency } from '@/components/reminders/labels';

/**
 * Which pile a reminder belongs in today.
 *
 * `isDue` and `isOverdue` come from the evaluator and are NOT reimplemented
 * here. They encode the one rule this screen would otherwise get wrong:
 * snoozing hides a reminder without moving its due date, so a reminder snoozed
 * past its deadline comes back OVERDUE rather than merely due. A second
 * implementation on the screen is a second answer to "is this late", and the
 * two would disagree the first time somebody edited one of them.
 *
 * Order matters. `isDue` already returns false for a snoozed row, so overdue
 * and due are asked first and a snoozed row falls through to `snoozed` --
 * where the list still shows its real due date, because that is the date it
 * will come back against.
 */
export function urgencyOf(reminder: ReminderRow, today: string): Urgency {
  if (reminder.status === 'done') return 'done';
  if (reminder.status === 'dismissed') return 'dismissed';
  if (isOverdue(reminder, today)) return 'overdue';
  if (isDue(reminder, today)) return 'today';
  if (reminder.snoozedUntil && reminder.snoozedUntil > today) return 'snoozed';
  return 'upcoming';
}

/**
 * The order the screen reads in, top to bottom.
 *
 * Overdue first and always, because the whole point of the screen is that the
 * thing already late is the first thing seen. `done` and `dismissed` sit at
 * the bottom and are hidden behind a control by default.
 */
export const URGENCY_ORDER: readonly Urgency[] = [
  'overdue', 'today', 'snoozed', 'upcoming', 'done', 'dismissed',
];

/** What the owner is being asked to act on now, as opposed to later. */
export const NEEDS_ATTENTION: readonly Urgency[] = ['overdue', 'today'];

export interface UrgencyGroup {
  urgency: Urgency;
  rows: { reminder: ReminderRow; urgency: Urgency }[];
}

/**
 * Groups a flat list into the piles above, dropping the empty ones.
 *
 * An empty group is not rendered as an empty heading: five headings with
 * nothing under four of them reads as a screen that failed to load, and the
 * one line that matters is then the hardest thing on it to find.
 */
export function groupByUrgency(
  rows: readonly ReminderRow[],
  today: string,
  only?: readonly Urgency[],
): UrgencyGroup[] {
  const allowed = only ? new Set(only) : null;
  const buckets = new Map<Urgency, { reminder: ReminderRow; urgency: Urgency }[]>();

  for (const reminder of rows) {
    const urgency = urgencyOf(reminder, today);
    if (allowed && !allowed.has(urgency)) continue;
    const bucket = buckets.get(urgency);
    if (bucket) bucket.push({ reminder, urgency });
    else buckets.set(urgency, [{ reminder, urgency }]);
  }

  return URGENCY_ORDER.flatMap((urgency) => {
    const rowsInGroup = buckets.get(urgency);
    return rowsInGroup && rowsInGroup.length > 0 ? [{ urgency, rows: rowsInGroup }] : [];
  });
}
