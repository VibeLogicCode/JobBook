import type { Tone } from '@/components/ui/Pill';
import type { ReminderKind } from '@/lib/reminders/types';

/**
 * The words the reminder and activity screens print.
 *
 * Declared as plain data with no runtime import from the schema, the same way
 * `lib/reminders/types.ts` declares its unions: the log-an-activity form is a
 * client component, and importing an enum from `@/db/enums` there would drag
 * the database layer into the browser bundle for the sake of eight strings.
 * The pairing with the enums is asserted in `tests/unit/reminder-labels.test.ts`,
 * so a member added on one side and forgotten on the other fails there rather
 * than rendering a blank chip.
 */

export const REMINDER_KINDS: Record<ReminderKind, string> = {
  callback: 'Callback',
  follow_up: 'Follow-up',
  quote_expiring: 'Quote expiring',
  site_visit: 'Site visit',
  compliance: 'Compliance',
  custom: 'Reminder',
};

/**
 * What happened, named by direction rather than by a separate column.
 *
 * "Email sent" and "Email received" are two different facts about a
 * conversation, and a timeline that says only "Email" cannot answer whose turn
 * it is -- which is the one question the owner is reading it to answer.
 *
 * `email_out` is where the Phase 2 plan's log-an-email lands. Nothing here
 * sends mail: the deferral and its trigger are recorded in the plan.
 */
export const ACTIVITY_KINDS = {
  call_in: 'Call received',
  call_out: 'Call made',
  email_in: 'Email received',
  email_out: 'Email sent',
  sms: 'Text message',
  site_visit: 'Site visit',
  meeting: 'Meeting',
  note: 'Note',
} as const;

export type ActivityKindName = keyof typeof ACTIVITY_KINDS;

/**
 * The order the kind dropdown offers them in: what the owner logs most often,
 * first. A list in enum order would put the two inbound calls above the
 * outbound one he makes twenty times a week.
 */
export const ACTIVITY_KIND_ORDER: readonly ActivityKindName[] = [
  'call_out', 'call_in', 'email_out', 'email_in', 'sms', 'site_visit', 'meeting', 'note',
];

/**
 * Where a reminder stands today.
 *
 * `overdue` and `today` are separate states rather than degrees of one,
 * because they need different treatment on the screen: overdue has to be
 * impossible to miss, and due-today has to be visible without shouting, or the
 * shouting stops meaning anything.
 */
export type Urgency = 'overdue' | 'today' | 'snoozed' | 'upcoming' | 'done' | 'dismissed';

/** The heading a group of reminders sits under, and the empty line for it. */
export const URGENCY_HEADINGS: Record<Urgency, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  snoozed: 'Snoozed',
  upcoming: 'Coming up',
  done: 'Done',
  dismissed: 'Not doing',
};

/**
 * Chip tone per state. Every chip carries its word as well -- colour never
 * conveys the state on its own, and the owner reads this screen on a phone in
 * daylight where the fills are close to invisible.
 */
export const URGENCY_TONES: Record<Urgency, Tone> = {
  overdue: 'negative',
  today: 'warning',
  snoozed: 'info',
  upcoming: 'neutral',
  done: 'positive',
  dismissed: 'neutral',
};

/** Whole days from one ISO date to another. Both are date-only, so no zone. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The words on the chip.
 *
 * "Overdue by 4 days" rather than "Overdue", because the number is what
 * decides which of six overdue rows he deals with first, and a date he has to
 * subtract from today in his head is a date he does not subtract.
 */
export function urgencyChip(
  urgency: Urgency,
  reminder: { dueOn: string; snoozedUntil: string | null },
  today: string,
): string {
  switch (urgency) {
    case 'overdue': {
      const late = daysBetween(reminder.dueOn, today);
      return late === 1 ? 'Overdue by a day' : `Overdue by ${late} days`;
    }
    case 'today':
      return 'Due today';
    case 'snoozed': {
      const back = reminder.snoozedUntil ? daysBetween(today, reminder.snoozedUntil) : 0;
      return back === 1 ? 'Back tomorrow' : `Back in ${back} days`;
    }
    case 'upcoming': {
      const away = daysBetween(today, reminder.dueOn);
      return away === 1 ? 'Due tomorrow' : `Due in ${away} days`;
    }
    case 'done':
      return 'Done';
    case 'dismissed':
      return 'Not doing';
  }
}

/**
 * How long a reminder may be pushed out for.
 *
 * Offsets in days rather than dates, and resolved against the tenant's today
 * on the server: the browser's clock is not the tenant's, and a phone left on
 * a plane would snooze into yesterday.
 */
export const SNOOZE_CHOICES: readonly { days: number; label: string }[] = [
  { days: 1, label: 'Tomorrow' },
  { days: 3, label: 'In three days' },
  { days: 7, label: 'Next week' },
  { days: 14, label: 'In two weeks' },
];
