import { describe, expect, it } from 'vitest';
import { activityKindEnum, reminderKindEnum } from '@/db/enums';
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_ORDER,
  REMINDER_KINDS,
  SNOOZE_CHOICES,
  URGENCY_HEADINGS,
  URGENCY_TONES,
  daysBetween,
  urgencyChip,
} from '@/components/reminders/labels';
import { URGENCY_ORDER, groupByUrgency, urgencyOf } from '@/components/reminders/urgency';
import type { ReminderRow } from '@/lib/reminders/repository';

/**
 * The screens' half of the reminder engine.
 *
 * `reminder-rules.test.ts` covers the evaluator. This covers the two things
 * the SCREEN can get wrong on its own: putting a row in the wrong pile, and
 * printing a chip whose vocabulary has drifted from the enum behind it. Both
 * fail silently -- a reminder in the wrong group is still a reminder on the
 * page, and a missing label renders as blank rather than as an error.
 */

const TODAY = '2026-09-04';

function reminder(overrides: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    entityType: 'customer',
    entityId: '00000000-0000-4000-8000-0000000000ff',
    title: 'Follow up on quote to Sample Client',
    detail: null,
    kind: 'follow_up',
    status: 'open',
    dueOn: TODAY,
    snoozedUntil: null,
    assignedTo: null,
    generatedByRuleId: null,
    ...overrides,
  };
}

describe('the words the screens print', () => {
  it('names every reminder kind the database can store', () => {
    // Declared as plain data in the component layer so the client form does
    // not import the schema. That is only safe while the two agree.
    expect(Object.keys(REMINDER_KINDS).sort()).toEqual([...reminderKindEnum.enumValues].sort());
  });

  it('names every activity kind the database can store', () => {
    expect(Object.keys(ACTIVITY_KINDS).sort()).toEqual([...activityKindEnum.enumValues].sort());
  });

  it('offers every activity kind in the dropdown, exactly once', () => {
    expect([...ACTIVITY_KIND_ORDER].sort()).toEqual(Object.keys(ACTIVITY_KINDS).sort());
    expect(new Set(ACTIVITY_KIND_ORDER).size).toBe(ACTIVITY_KIND_ORDER.length);
  });

  it('gives every pile a heading and a tone', () => {
    for (const urgency of URGENCY_ORDER) {
      expect(URGENCY_HEADINGS[urgency], urgency).toBeTruthy();
      expect(URGENCY_TONES[urgency], urgency).toBeTruthy();
    }
  });

  it('offers no snooze shorter than a day, which the action would refuse', () => {
    // `snoozeReminder` throws on a snooze that is not after today, because a
    // snooze to today changes nothing. A choice the action refuses is a
    // control that only ever produces an error message.
    for (const choice of SNOOZE_CHOICES) expect(choice.days).toBeGreaterThanOrEqual(1);
  });

  it('counts whole days between two dates, across a daylight-saving boundary', () => {
    // Toronto's clocks go back on 2026-11-01. Date-only arithmetic must not
    // notice: a reminder due the day before must read as one day, not as
    // 1.04 rounded to something.
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
    expect(daysBetween('2026-09-01', '2026-09-04')).toBe(3);
  });

  it('says how late a thing is, not merely that it is late', () => {
    expect(urgencyChip('overdue', reminder({ dueOn: '2026-09-03' }), TODAY)).toBe('Overdue by a day');
    expect(urgencyChip('overdue', reminder({ dueOn: '2026-08-31' }), TODAY)).toBe('Overdue by 4 days');
    expect(urgencyChip('today', reminder(), TODAY)).toBe('Due today');
    expect(urgencyChip('upcoming', reminder({ dueOn: '2026-09-05' }), TODAY)).toBe('Due tomorrow');
  });
});

describe('which pile a reminder lands in', () => {
  it('calls a reminder due on the tenant today due today, not overdue', () => {
    expect(urgencyOf(reminder({ dueOn: TODAY }), TODAY)).toBe('today');
  });

  it('calls a reminder past its date overdue', () => {
    expect(urgencyOf(reminder({ dueOn: '2026-09-01' }), TODAY)).toBe('overdue');
  });

  it('holds a snoozed reminder out of the due piles', () => {
    expect(urgencyOf(reminder({ dueOn: TODAY, snoozedUntil: '2026-09-08' }), TODAY)).toBe('snoozed');
  });

  /**
   * The one this screen would get wrong on its own.
   *
   * Snoozing hides a reminder; it does NOT move the due date. So a reminder
   * snoozed past its deadline comes back OVERDUE rather than merely due. If
   * the screen reimplemented "is it late" it would compare against the snooze
   * and report a clean week that never happened.
   */
  it('brings a reminder snoozed past its deadline back as overdue', () => {
    const snoozedOut = reminder({ dueOn: '2026-08-28', snoozedUntil: '2026-09-02' });
    expect(urgencyOf(snoozedOut, '2026-08-30')).toBe('snoozed');
    expect(urgencyOf(snoozedOut, '2026-09-04')).toBe('overdue');
  });

  it('keeps done and dismissed apart', () => {
    expect(urgencyOf(reminder({ status: 'done' }), TODAY)).toBe('done');
    expect(urgencyOf(reminder({ status: 'dismissed' }), TODAY)).toBe('dismissed');
  });

  it('puts overdue first and drops the empty groups', () => {
    const groups = groupByUrgency(
      [
        reminder({ id: 'a', dueOn: '2026-09-06' }),
        reminder({ id: 'b', dueOn: '2026-08-30' }),
        reminder({ id: 'c', dueOn: TODAY }),
      ],
      TODAY,
    );

    expect(groups.map((group) => group.urgency)).toEqual(['overdue', 'today', 'upcoming']);
    expect(groups[0]!.rows.map((row) => row.reminder.id)).toEqual(['b']);
  });

  it('draws only the piles it was asked for, which is what Today shows', () => {
    const groups = groupByUrgency(
      [reminder({ id: 'a', dueOn: '2026-09-20' }), reminder({ id: 'b', dueOn: '2026-08-30' })],
      TODAY,
      ['overdue', 'today', 'snoozed'],
    );
    expect(groups.map((group) => group.urgency)).toEqual(['overdue']);
  });
});
