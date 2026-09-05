import { describe, expect, it } from 'vitest';
import { reminderTriggerEnum } from '@/db/enums';
import {
  FIELD_NOTES,
  KIND_OPTIONS,
  STAGE_OPTIONS,
  TEMPLATE_FIELDS,
  TRIGGER_LABELS,
  TRIGGER_NOTES,
  TRIGGER_OPTIONS,
  createFields,
  directionOf,
  offsetPhrase,
  reminderRuleFields,
  stageProblem,
  templateProblem,
  toColumns,
  toOffsetDays,
  violatesConstraint,
} from '@/app/settings/reminder-rules/schema';
import { TITLE_FIELDS } from '@/lib/reminders/repository';
import type { ReminderTrigger } from '@/lib/reminders/types';

/**
 * The reminder rule form's rules, tested where they live rather than through
 * the screen.
 *
 * This is the one settings screen whose mistakes do not surface in front of
 * the person who made them. A wrong cost code is wrong on the screen it was
 * typed on; a wrong reminder rule is wrong at three in the morning, against
 * every quote in the book, in a row somebody reads as missing data. So the two
 * things worth the most here are the placeholder check and the stage check --
 * both of them refusals that turn a silent nightly defect into a sentence at
 * the moment of saving.
 */

const TRIGGERS = reminderTriggerEnum.enumValues;

const FORM = {
  name: 'Follow up on a sent quote',
  offsetAmount: '3',
  offsetDirection: 'after',
  reminderKind: 'follow_up',
  titleTemplate: 'Follow up on quote to {customer}',
  triggerStage: '',
};

function parse(overrides: Partial<typeof FORM> = {}) {
  return reminderRuleFields.safeParse({ ...FORM, ...overrides });
}

function issueFor(result: ReturnType<typeof parse>, field: string): string | undefined {
  if (result.success) return undefined;
  return result.error.issues.find((issue) => issue.path.join('.') === field)?.message;
}

/* ------------------------------------------------------------------------- */

describe('the vocabulary the form offers', () => {
  it('has a label, a note and an anchor for every trigger the database knows', () => {
    // A trigger added to the enum and forgotten here would render as a blank
    // cell in the list and be missing from the add form -- an unreachable
    // feature that looks like an absent one.
    for (const trigger of TRIGGERS) {
      expect(TRIGGER_LABELS[trigger], trigger).toBeTruthy();
      expect(TRIGGER_NOTES[trigger], trigger).toBeTruthy();
      expect(TEMPLATE_FIELDS[trigger], trigger).toBeTruthy();
      // `offsetPhrase` reads an anchor phrase per trigger; a missing one would
      // read "3 days after undefined".
      expect(offsetPhrase(3, trigger), trigger).not.toContain('undefined');
    }
    expect(TRIGGER_OPTIONS).toHaveLength(TRIGGERS.length);
  });

  it('offers every reminder kind and every project stage', () => {
    expect(KIND_OPTIONS.length).toBeGreaterThan(0);
    expect(STAGE_OPTIONS.length).toBeGreaterThan(0);
    for (const option of [...KIND_OPTIONS, ...STAGE_OPTIONS]) {
      expect(option.label, option.value).toBeTruthy();
    }
  });
});

describe('the template vocabulary is a narrowing of the closed set, never a superset', () => {
  it('names nothing the repository does not supply', () => {
    // The moment a template can reach a value outside `TITLE_FIELDS` it is a
    // template language, and a template language in a settings form is an
    // expression evaluator somebody will eventually point at the database.
    for (const trigger of TRIGGERS) {
      for (const field of TEMPLATE_FIELDS[trigger]) {
        expect(TITLE_FIELDS, `${trigger} offers {${field}}`).toContain(field);
      }
    }
  });

  it('leaves no field in the closed set unreachable by every trigger', () => {
    const offered = new Set(TRIGGERS.flatMap((trigger) => [...TEMPLATE_FIELDS[trigger]]));
    expect([...TITLE_FIELDS].filter((field) => !offered.has(field))).toEqual([]);
  });

  it('explains every field it offers', () => {
    for (const field of TITLE_FIELDS) {
      expect(FIELD_NOTES[field], field).toBeTruthy();
    }
  });

  it('narrows the customer-silence rule, which scans customers and knows nothing else', () => {
    // The repository hands `no_activity` the other four keys as EMPTY STRINGS
    // so the evaluator never has to branch. A template naming one of them
    // would therefore save cleanly and then render "No contact with X about "
    // every night, which reads as missing data rather than as a broken rule.
    expect(TEMPLATE_FIELDS.no_activity).toEqual(['customer', 'date']);
    expect(templateProblem('No contact with {customer} since {date}', 'no_activity')).toBeNull();
    expect(templateProblem('No contact with {customer} about {project}', 'no_activity'))
      .toContain('{project}');
  });
});

describe('a mistyped placeholder is refused when the rule is saved', () => {
  it('quotes the misspelling back rather than saying the template is invalid', () => {
    const problem = templateProblem('Follow up on quote to {custmer}', 'quote_sent');
    expect(problem).toContain('{custmer}');
    // And says what IS available, so the fix does not need a second screen.
    expect(problem).toContain('{customer}');
  });

  it('names every unknown placeholder, not only the first', () => {
    const problem = templateProblem('{custmer} owes {ammount}', 'quote_sent');
    expect(problem).toContain('{custmer}');
    expect(problem).toContain('{ammount}');
  });

  it('accepts the five shipped templates against their own triggers', () => {
    const shipped: [string, ReminderTrigger][] = [
      ['Follow up on quote to {customer}', 'quote_sent'],
      ['Quote {number} expires in 5 days', 'quote_expiring'],
      ['Site visit tomorrow at {address}', 'site_visit_scheduled'],
      ['No contact with {customer} in 14 days', 'no_activity'],
      ['Won {project} — confirm start date and deposit', 'project_won'],
    ];
    for (const [template, trigger] of shipped) {
      expect(templateProblem(template, trigger), template).toBeNull();
    }
  });

  it('leaves a template with no placeholders alone', () => {
    expect(templateProblem('Ring the customer back', 'quote_sent')).toBeNull();
  });
});

describe('a stage rule has to say which stage', () => {
  it('refuses a stage-change rule with no stage, because it would watch nothing', () => {
    const problem = stageProblem('stage_entered', null);
    expect(problem).toContain('watches nothing');
  });

  it('accepts a stage-change rule that names one', () => {
    expect(stageProblem('stage_entered', 'won')).toBeNull();
  });

  it('refuses a stage on a trigger that does not watch stages, rather than dropping it', () => {
    // Dropping it would save a rule the owner did not write; the database's own
    // CHECK refuses the pairing anyway, and being told "that could not be
    // saved" by Postgres is a worse version of the same answer.
    expect(stageProblem('quote_sent', 'won')).toBeTruthy();
  });

  it('accepts every other trigger with no stage', () => {
    for (const trigger of TRIGGERS.filter((value) => value !== 'stage_entered')) {
      expect(stageProblem(trigger, null), trigger).toBeNull();
    }
  });
});

describe('the offset, which the form asks for as a count and a direction', () => {
  it('reads "before" as the negative the column stores', () => {
    expect(toOffsetDays({ offsetAmount: 5, offsetDirection: 'before' })).toBe(-5);
    expect(toOffsetDays({ offsetAmount: 3, offsetDirection: 'after' })).toBe(3);
  });

  it('normalises zero, which has no direction', () => {
    // `-0` is a real value in JavaScript, survives into the driver, and would
    // make two rules that are the same rule read differently.
    expect(Object.is(toOffsetDays({ offsetAmount: 0, offsetDirection: 'before' }), 0)).toBe(true);
  });

  it('puts the two controls back the way round the stored rule was saved', () => {
    expect(directionOf(-5)).toBe('before');
    expect(directionOf(3)).toBe('after');
    expect(directionOf(0)).toBe('after');
  });

  it('refuses something that is not a whole number of days', () => {
    expect(issueFor(parse({ offsetAmount: '3.5' }), 'offsetAmount')).toBeTruthy();
    expect(issueFor(parse({ offsetAmount: '-3' }), 'offsetAmount')).toBeTruthy();
    expect(issueFor(parse({ offsetAmount: '' }), 'offsetAmount')).toBeTruthy();
  });

  it('caps the offset at a year, which is where an extra digit lands', () => {
    expect(parse({ offsetAmount: '365' }).success).toBe(true);
    expect(issueFor(parse({ offsetAmount: '366' }), 'offsetAmount')).toBeTruthy();
  });

  it('says the timing as a sentence, in the trigger’s own words', () => {
    expect(offsetPhrase(3, 'quote_sent')).toBe('3 days after the quote went out');
    expect(offsetPhrase(-5, 'quote_expiring')).toBe('5 days before the quote expires');
    expect(offsetPhrase(-1, 'site_visit_scheduled')).toBe('1 day before the site visit');
    expect(offsetPhrase(0, 'project_won')).toBe('the same day as the job was won');
  });
});

describe('the rest of the form', () => {
  it('parses a whole rule and maps it to columns', () => {
    const result = parse();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(toColumns(result.data)).toEqual({
      name: 'Follow up on a sent quote',
      offsetDays: 3,
      reminderKind: 'follow_up',
      titleTemplate: 'Follow up on quote to {customer}',
      triggerStage: null,
    });
  });

  it('does not take the trigger from the edit form at all', () => {
    // The trigger is fixed once a rule exists: a rule pointed at a different
    // event inherits the first one's open reminders, which then suppress it
    // invisibly until each is completed. `updateReminderRule` reads it from
    // the row, so a trigger arriving in a POST is ignored rather than obeyed.
    expect(Object.keys(reminderRuleFields.shape)).not.toContain('trigger');
    expect(Object.keys(createFields.shape)).toContain('trigger');
  });

  it('refuses a trigger, kind or stage that is not one of the offered values', () => {
    const bad = createFields.safeParse({ ...FORM, trigger: 'quote_deleted' });
    expect(bad.success).toBe(false);
    expect(issueFor(parse({ reminderKind: 'urgent' }), 'reminderKind')).toBeTruthy();
    expect(issueFor(parse({ triggerStage: 'nowhere' }), 'triggerStage')).toBeTruthy();
  });

  it('accepts a submission with no stage key at all, because the control is not always rendered', () => {
    // A browser submits NOTHING for a control that is not on the form, and the
    // edit sheet renders the stage select only for a rule that watches stages.
    // A required `z.string()` here refused every one of the five shipped rules
    // with "expected string, received undefined" -- a validation error naming a
    // field the person could not see. Caught in a browser, not by reading.
    const { triggerStage: _omitted, ...withoutStage } = FORM;
    const result = reminderRuleFields.safeParse(withoutStage);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.triggerStage).toBeNull();
  });

  it('requires a name and something for the reminder to say', () => {
    expect(issueFor(parse({ name: '   ' }), 'name')).toBeTruthy();
    expect(issueFor(parse({ titleTemplate: '' }), 'titleTemplate')).toBeTruthy();
  });
});

describe('the one database error this screen has a sentence for', () => {
  it('finds the constraint through a wrapped transaction error', () => {
    // Every write on this screen runs inside a transaction, and Drizzle wraps
    // the driver's error in a DrizzleQueryError that carries the original on
    // `cause`. Reading only the top of that prints the failed SQL and its
    // bound parameters on the screen instead of a sentence -- which is the bug
    // the cost code list found and this pattern is copied from.
    const wrapped = Object.assign(new Error('failed query'), {
      cause: Object.assign(new Error('violates check constraint'), {
        code: '23514',
        constraint_name: 'reminder_rules_stage_only_on_stage_trigger',
      }),
    });
    expect(violatesConstraint(wrapped, 'reminder_rules_stage_only_on_stage_trigger')).toBe(true);
    expect(violatesConstraint(wrapped, 'something_else')).toBe(false);
  });

  it('does not spin on an error whose cause is itself', () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(violatesConstraint(loop, 'anything')).toBe(false);
  });

  it('is false for something that is not an error at all', () => {
    expect(violatesConstraint(null, 'anything')).toBe(false);
    expect(violatesConstraint('a string', 'anything')).toBe(false);
  });
});
