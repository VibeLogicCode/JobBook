import { describe, expect, it } from 'vitest';
import {
  evaluateRules,
  isDue,
  isOverdue,
  renderTitle,
  unknownPlaceholders,
} from '@/lib/reminders/rules';
import { reminderKey, type ReminderRule, type TriggerFact } from '@/lib/reminders/types';

/**
 * The rule evaluator.
 *
 * The property that matters most is the last describe block: running the same
 * evaluation twice against unchanged state must produce nothing the second
 * time. An hourly job that fails that creates twenty-four duplicates a day,
 * and a reminder list nobody trusts is worse than no reminder list.
 */

const TODAY = '2026-09-04';

function rule(over: Partial<ReminderRule> & Pick<ReminderRule, 'id' | 'trigger'>): ReminderRule {
  return {
    name: 'A rule',
    triggerStage: null,
    offsetDays: 0,
    reminderKind: 'follow_up',
    titleTemplate: 'Do the thing',
    isActive: true,
    ...over,
  };
}

function fact(over: Partial<TriggerFact> & Pick<TriggerFact, 'trigger' | 'entityId'>): TriggerFact {
  return {
    entityType: 'quote',
    anchorDate: TODAY,
    fields: {},
    ...over,
  };
}

const NOTHING_OPEN = new Set<string>();

describe('offsets', () => {
  it('puts a follow-up the configured number of days after the anchor', () => {
    const drafts = evaluateRules(
      [rule({ id: 'r1', trigger: 'quote_sent', offsetDays: 3 })],
      [fact({ trigger: 'quote_sent', entityId: 'q1', anchorDate: '2026-09-01' })],
      { today: TODAY, openKeys: NOTHING_OPEN },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.dueOn).toBe('2026-09-04');
  });

  it('reads a negative offset as before the anchor, which is what expiry warnings need', () => {
    const drafts = evaluateRules(
      [rule({ id: 'r2', trigger: 'quote_expiring', offsetDays: -5, reminderKind: 'quote_expiring' })],
      [fact({ trigger: 'quote_expiring', entityId: 'q1', anchorDate: '2026-10-01' })],
      { today: TODAY, openKeys: NOTHING_OPEN },
    );
    expect(drafts[0]!.dueOn).toBe('2026-09-26');
  });

  it('crosses a month boundary without drifting', () => {
    const drafts = evaluateRules(
      [rule({ id: 'r1', trigger: 'quote_sent', offsetDays: 3 })],
      [fact({ trigger: 'quote_sent', entityId: 'q1', anchorDate: '2026-01-30' })],
      { today: '2026-01-30', openKeys: NOTHING_OPEN },
    );
    expect(drafts[0]!.dueOn).toBe('2026-02-02');
  });

  /**
   * The clocks go forward in Toronto on 2026-03-08. Date-only arithmetic must
   * be untouched by it; a reminder set the day before must not land two days
   * later or the same day.
   */
  it('is not moved by a daylight saving change', () => {
    const drafts = evaluateRules(
      [rule({ id: 'r1', trigger: 'quote_sent', offsetDays: 3 })],
      [fact({ trigger: 'quote_sent', entityId: 'q1', anchorDate: '2026-03-07' })],
      { today: '2026-03-07', openKeys: NOTHING_OPEN },
    );
    expect(drafts[0]!.dueOn).toBe('2026-03-10');
  });
});

describe('which rules fire at all', () => {
  it('ignores a rule that has been switched off', () => {
    const drafts = evaluateRules(
      [rule({ id: 'r1', trigger: 'quote_sent', offsetDays: 3, isActive: false })],
      [fact({ trigger: 'quote_sent', entityId: 'q1' })],
      { today: TODAY, openKeys: NOTHING_OPEN },
    );
    expect(drafts).toEqual([]);
  });

  it('ignores a fact no rule is watching for', () => {
    const drafts = evaluateRules(
      [rule({ id: 'r1', trigger: 'quote_sent' })],
      [fact({ trigger: 'project_won', entityId: 'p1', entityType: 'project' })],
      { today: TODAY, openKeys: NOTHING_OPEN },
    );
    expect(drafts).toEqual([]);
  });
});

describe('stage_entered', () => {
  it('fires only for the stage it is configured to watch', () => {
    const rules = [rule({ id: 'r1', trigger: 'stage_entered', triggerStage: 'won', offsetDays: 1 })];
    const entered = (stage: string) =>
      fact({ trigger: 'stage_entered', entityId: 'p1', entityType: 'project', stage });

    expect(evaluateRules(rules, [entered('won')], { today: TODAY, openKeys: NOTHING_OPEN })).toHaveLength(1);
    expect(evaluateRules(rules, [entered('on_hold')], { today: TODAY, openKeys: NOTHING_OPEN })).toEqual([]);
  });

  /**
   * A stage rule with no stage set watches NOTHING, not everything. The other
   * reading fires on every stage change a project ever makes, which buries the
   * list -- and the list only works if the owner trusts every row on it.
   */
  it('fires on nothing when no stage is configured', () => {
    const drafts = evaluateRules(
      [rule({ id: 'r1', trigger: 'stage_entered', triggerStage: null })],
      [fact({ trigger: 'stage_entered', entityId: 'p1', entityType: 'project', stage: 'won' })],
      { today: TODAY, openKeys: NOTHING_OPEN },
    );
    expect(drafts).toEqual([]);
  });
});

describe('no_activity, the one rule that asserts something about the past', () => {
  const rules = [
    rule({
      id: 'r1',
      trigger: 'no_activity',
      offsetDays: 14,
      titleTemplate: 'No contact with {customer} in 14 days',
    }),
  ];
  const lastSpoke = (date: string) =>
    fact({
      trigger: 'no_activity',
      entityId: 'c1',
      entityType: 'customer',
      anchorDate: date,
      fields: { customer: 'Sample Client' },
    });

  it('stays quiet while the statement would still be false', () => {
    // Last activity was yesterday. Creating "no contact in 14 days" today puts
    // a wrong row against every customer in the book.
    expect(evaluateRules(rules, [lastSpoke('2026-09-03')], { today: TODAY, openKeys: NOTHING_OPEN })).toEqual([]);
  });

  it('fires on the day the threshold is crossed, not after it', () => {
    const drafts = evaluateRules(rules, [lastSpoke('2026-08-21')], {
      today: TODAY,
      openKeys: NOTHING_OPEN,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.dueOn).toBe('2026-09-04');
    expect(drafts[0]!.title).toBe('No contact with Sample Client in 14 days');
  });

  /**
   * Forward-looking triggers are the opposite case and must NOT be gated: a
   * follow-up created the day a quote goes out, due in three days, is a true
   * statement about a future intention and is worth seeing early.
   */
  it('does not gate a forward-looking trigger the same way', () => {
    const drafts = evaluateRules(
      [rule({ id: 'r2', trigger: 'quote_sent', offsetDays: 3 })],
      [fact({ trigger: 'quote_sent', entityId: 'q1', anchorDate: TODAY })],
      { today: TODAY, openKeys: NOTHING_OPEN },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.dueOn).toBe('2026-09-07');
  });
});

describe('idempotency', () => {
  const rules = [rule({ id: 'r1', trigger: 'quote_sent', offsetDays: 3 })];
  const facts = [fact({ trigger: 'quote_sent', entityId: 'q1' })];

  it('produces nothing when this rule already has an open reminder on that entity', () => {
    const open = new Set([reminderKey('r1', 'quote', 'q1')]);
    expect(evaluateRules(rules, facts, { today: TODAY, openKeys: open })).toEqual([]);
  });

  it('still fires for a different entity', () => {
    const open = new Set([reminderKey('r1', 'quote', 'q1')]);
    const drafts = evaluateRules(rules, [...facts, fact({ trigger: 'quote_sent', entityId: 'q2' })], {
      today: TODAY,
      openKeys: open,
    });
    expect(drafts.map((d) => d.entityId)).toEqual(['q2']);
  });

  /**
   * Two facts for one entity inside a single batch -- a quote revised twice in
   * a day -- both pass the openKeys check, because neither is in the database
   * yet. Without the in-batch claim they collide on the unique partial index
   * and take the whole insert down with them.
   */
  it('collapses two facts for one entity within a single evaluation', () => {
    const twice = [
      fact({ trigger: 'quote_sent', entityId: 'q1', anchorDate: '2026-09-01' }),
      fact({ trigger: 'quote_sent', entityId: 'q1', anchorDate: '2026-09-02' }),
    ];
    expect(evaluateRules(rules, twice, { today: TODAY, openKeys: NOTHING_OPEN })).toHaveLength(1);
  });

  /**
   * The property the hourly job depends on. Feeding the first run's output
   * back in as open reminders is exactly what the second run sees an hour
   * later.
   */
  it('produces nothing on a second run against unchanged state', () => {
    const first = evaluateRules(rules, facts, { today: TODAY, openKeys: NOTHING_OPEN });
    expect(first).toHaveLength(1);

    const nowOpen = new Set(first.map((d) => reminderKey(d.ruleId, d.entityType, d.entityId)));
    expect(evaluateRules(rules, facts, { today: TODAY, openKeys: nowOpen })).toEqual([]);
  });

  /**
   * NOT asserted here, deliberately: that a COMPLETED reminder stops
   * suppressing its rule, so a quote followed up in March and still open in
   * June gets chased again. That behaviour lives in how the repository builds
   * `openKeys` -- it selects `status = 'open'` -- and asserting it against a
   * hand-built set here would only prove that a set I just wrote contains what
   * I put in it. It belongs in the repository's integration test, and is
   * recorded here so the gap is visible rather than assumed covered.
   */
});

describe('titles', () => {
  it('fills placeholders from the fact', () => {
    expect(renderTitle('Follow up on quote to {customer}', { customer: 'Sample Client' })).toBe(
      'Follow up on quote to Sample Client',
    );
  });

  it('leaves an unknown placeholder standing rather than blanking it', () => {
    // "Follow up on quote to " looks like missing data and sends the owner
    // looking in the wrong place; the visible token names the broken rule.
    expect(renderTitle('Follow up to {custmer}', { customer: 'Sample Client' })).toBe(
      'Follow up to {custmer}',
    );
  });

  it('names the placeholders a template cannot supply, so a rule fails when it is saved', () => {
    expect(unknownPlaceholders('{customer} owes {amount} on {customer}', ['customer'])).toEqual(['amount']);
    expect(unknownPlaceholders('{customer}', ['customer', 'number'])).toEqual([]);
  });
});

describe('due, overdue and snoozed', () => {
  const open = (dueOn: string, snoozedUntil: string | null = null) => ({
    dueOn,
    snoozedUntil,
    status: 'open',
  });

  it('is due on its date and every day after', () => {
    expect(isDue(open('2026-09-04'), TODAY)).toBe(true);
    expect(isDue(open('2026-09-01'), TODAY)).toBe(true);
    expect(isDue(open('2026-09-05'), TODAY)).toBe(false);
  });

  it('is not due while snoozed', () => {
    expect(isDue(open('2026-09-01', '2026-09-10'), TODAY)).toBe(false);
  });

  it('comes back once the snooze runs out', () => {
    expect(isDue(open('2026-09-01', '2026-09-04'), TODAY)).toBe(true);
  });

  /**
   * Snoozing must not move the deadline. If it did, a quote follow-up could be
   * deferred indefinitely and still look on time -- which is precisely the
   * habit the reminder exists to break.
   */
  it('returns overdue, not merely due, after a snooze past the deadline', () => {
    expect(isOverdue(open('2026-08-20', '2026-09-03'), TODAY)).toBe(true);
  });

  it('counts a reminder due today as due but not overdue', () => {
    expect(isDue(open('2026-09-04'), TODAY)).toBe(true);
    expect(isOverdue(open('2026-09-04'), TODAY)).toBe(false);
  });

  it('ignores anything not open', () => {
    expect(isDue({ dueOn: '2026-09-01', snoozedUntil: null, status: 'done' }, TODAY)).toBe(false);
    expect(isDue({ dueOn: '2026-09-01', snoozedUntil: null, status: 'dismissed' }, TODAY)).toBe(false);
  });
});
