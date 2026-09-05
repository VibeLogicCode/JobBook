import { describe, expect, it } from 'vitest';
import { reminderKindEnum, timelineEntityTypeEnum } from '@/db/enums';
import { REMINDER_KINDS } from '@/components/reminders/labels';
import {
  DEFAULT_DUE_CHOICE,
  DUE_CHOICES,
  DUE_VALUES,
  ON_A_DATE,
  REMINDER_KIND_CHOICES,
  defaultReminderKind,
  defaultReminderTitle,
  dueOffsetDays,
} from '@/components/reminders/new-reminder';
import type { EntityType } from '@/lib/reminders/types';

/**
 * The add-a-reminder form's vocabulary, without a DOM.
 *
 * There is no renderer in this suite, so what is covered here is what a
 * screenshot could not prove anyway: that the dropdowns offer values the
 * database will accept, that the day-choices the action validates against are
 * the same ones the form renders, and that every record type has a default
 * title and kind. Each of those fails silently in a browser -- a blank
 * option, a refusal nobody reads, a form that opens on an empty box.
 */

const ENTITY_TYPES = timelineEntityTypeEnum.enumValues as readonly EntityType[];

describe('the kinds a person may pick', () => {
  it('offers only kinds the column will accept', () => {
    for (const kind of REMINDER_KIND_CHOICES) {
      expect(reminderKindEnum.enumValues).toContain(kind);
    }
  });

  it('offers each of them once', () => {
    expect(new Set(REMINDER_KIND_CHOICES).size).toBe(REMINDER_KIND_CHOICES.length);
  });

  it('withholds exactly one kind, and it is the rule-owned one', () => {
    // `quote_expiring` is derived from a quote's valid_until by the rule that
    // owns it. A hand-written one would assert an expiry nothing checked, and
    // the screen would be lying about a document a customer is holding. If a
    // kind is ever added to the enum, this fails rather than quietly hiding it
    // from the picker.
    const withheld = reminderKindEnum.enumValues.filter(
      (kind) => !REMINDER_KIND_CHOICES.includes(kind),
    );
    expect(withheld).toEqual(['quote_expiring']);
  });

  it('has a word on the screen for every kind it offers', () => {
    for (const kind of REMINDER_KIND_CHOICES) {
      expect(REMINDER_KINDS[kind]).toBeTruthy();
    }
  });
});

describe('what the form opens on', () => {
  it('picks a kind for every record type, and one that is offered', () => {
    // A record per entity type rather than a switch, so a fourth type is a
    // line rather than a branch somebody forgets. This is what says so.
    for (const entityType of ENTITY_TYPES) {
      expect(REMINDER_KIND_CHOICES).toContain(defaultReminderKind(entityType));
    }
  });

  it('opens on a callback for a person and a follow-up for the work', () => {
    expect(defaultReminderKind('customer')).toBe('callback');
    expect(defaultReminderKind('project')).toBe('follow_up');
    expect(defaultReminderKind('quote')).toBe('follow_up');
  });

  it('writes the title from the record, so the owner types nothing', () => {
    expect(defaultReminderTitle('customer', 'Sample Client')).toBe('Call Sample Client');
    expect(defaultReminderTitle('project', 'Basement finish')).toBe(
      'Follow up on Basement finish',
    );
    expect(defaultReminderTitle('quote', 'QT-0001')).toBe('Follow up on QT-0001');
  });

  it('leaves the title empty rather than printing a bare verb', () => {
    // "Call" on its own is not a reminder. A required field left blank asks
    // for the one word that would have made it one.
    expect(defaultReminderTitle('customer', '')).toBe('');
    expect(defaultReminderTitle('project', '   ')).toBe('');
  });

  it('gives every record type a title', () => {
    for (const entityType of ENTITY_TYPES) {
      expect(defaultReminderTitle(entityType, 'Sample Client')).toContain('Sample Client');
    }
  });

  it('opens the day picker on a real choice', () => {
    expect(DUE_VALUES).toContain(DEFAULT_DUE_CHOICE);
  });
});

describe('when it is due', () => {
  it('validates against the same list it renders', () => {
    // The action builds its `z.enum` from `DUE_VALUES`. A choice added to the
    // dropdown and forgotten in the validator would be refused at submit with
    // a message about a field the person can see.
    expect([...DUE_VALUES]).toEqual(DUE_CHOICES.map((choice) => choice.value));
    expect(new Set(DUE_VALUES).size).toBe(DUE_VALUES.length);
  });

  it('carries a day offset on every choice but the one that asks for a date', () => {
    const undated = DUE_CHOICES.filter((choice) => choice.days === null);
    expect(undated.map((choice) => choice.value)).toEqual([ON_A_DATE]);
  });

  it('counts the offsets forward from today, never backward', () => {
    expect(dueOffsetDays('0')).toBe(0);
    expect(dueOffsetDays('1')).toBe(1);
    expect(dueOffsetDays('7')).toBe(7);
    expect(dueOffsetDays(ON_A_DATE)).toBeNull();
    for (const choice of DUE_CHOICES) {
      if (choice.days !== null) expect(choice.days).toBeGreaterThanOrEqual(0);
    }
  });

  it('refuses a token it does not offer rather than guessing at today', () => {
    // A value that got past the validator is a bug, and a reminder quietly
    // filed on the wrong day is the failure this screen exists to prevent.
    expect(() => dueOffsetDays('99')).toThrow(/not a due choice/);
  });
});
