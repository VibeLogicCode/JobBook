import { describe, expect, it } from 'vitest';
import {
  conditionOutcome,
  durationDaysOf,
  effectiveLink,
  isSuggested,
  planFinish,
  planImport,
  type Scope,
  type ScopeEvidence,
  type TemplateTask,
} from '@/lib/schedule/template';

/**
 * `template.ts` is pure: no database, no clock. This file stays pure with it --
 * every date below is a fixed literal, never `new Date()`.
 */

/* -------------------------------------------------------------------------
   Fixtures
   ------------------------------------------------------------------------- */

function task(overrides: Partial<TemplateTask> & Pick<TemplateTask, 'id'>): TemplateTask {
  return {
    name: 'Task',
    sortOrder: 0,
    isMilestone: false,
    durationBaseDays: 0,
    durationSource: 'none',
    durationAreaPerDayMilli: null,
    durationDaysPerUnit: null,
    predecessorTaskId: null,
    lagDays: 0,
    conditionMeasurement: null,
    conditionRateItemId: null,
    ...overrides,
  };
}

function scope(overrides: Partial<Scope> = {}): Scope {
  return {
    areaSqftMilli: 0n,
    washroomCount: 0,
    kitchenCount: 0,
    bedroomCount: 0,
    ...overrides,
  };
}

function evidence(overrides: Partial<ScopeEvidence> = {}): ScopeEvidence {
  return {
    scope: scope(),
    includedRateItemIds: new Set<string>(),
    hasAcceptedQuote: true,
    ...overrides,
  };
}

function byIdOf(tasks: readonly TemplateTask[]): Map<string, TemplateTask> {
  return new Map(tasks.map((t) => [t.id, t]));
}

/* -------------------------------------------------------------------------
   How long a task takes
   ------------------------------------------------------------------------- */

describe('durationDaysOf', () => {
  it('is the base alone when the task has no duration source', () => {
    const t = task({ id: 't1', durationBaseDays: 4, durationSource: 'none' });
    expect(durationDaysOf(t, scope())).toBe(4);
  });

  it('adds a day per 300 sqft, exactly, for 1,200 sqft', () => {
    const t = task({ id: 't1', durationSource: 'area', durationAreaPerDayMilli: 300000n });
    expect(durationDaysOf(t, scope({ areaSqftMilli: 1_200_000n }))).toBe(4);
  });

  it('rounds a remainder up, so 1,240.5 sqft is 5 days, not 4', () => {
    const t = task({ id: 't1', durationSource: 'area', durationAreaPerDayMilli: 300000n });
    expect(durationDaysOf(t, scope({ areaSqftMilli: 1_240_500n }))).toBe(5);
  });

  it('multiplies a count by its days-per-unit, 2 days per washroom times 3', () => {
    const t = task({ id: 't1', durationSource: 'washrooms', durationDaysPerUnit: 2 });
    expect(durationDaysOf(t, scope({ washroomCount: 3 }))).toBe(6);
  });

  it('adds the base and the rate together rather than picking one', () => {
    const t = task({
      id: 't1',
      durationBaseDays: 2,
      durationSource: 'washrooms',
      durationDaysPerUnit: 2,
    });
    expect(durationDaysOf(t, scope({ washroomCount: 3 }))).toBe(8);
  });

  it('is one day for a milestone even with a base and a rate both set', () => {
    const t = task({
      id: 't1',
      isMilestone: true,
      durationBaseDays: 10,
      durationSource: 'area',
      durationAreaPerDayMilli: 1n,
    });
    expect(durationDaysOf(t, scope({ areaSqftMilli: 999_000_000n }))).toBe(1);
  });

  it('floors at one day when the base and every rate are zero', () => {
    const t = task({ id: 't1', durationBaseDays: 0, durationSource: 'none' });
    expect(durationDaysOf(t, scope())).toBe(1);
  });

  it('falls back to the base, without throwing, when the area rate column is null', () => {
    // A row written before the CHECK existed should still produce the base
    // rather than a crash -- see the docblock on the switch in `durationDaysOf`.
    const t = task({
      id: 't1',
      durationBaseDays: 5,
      durationSource: 'area',
      durationAreaPerDayMilli: null,
    });
    expect(durationDaysOf(t, scope({ areaSqftMilli: 900_000n }))).toBe(5);
  });

  it('falls back to the base, without throwing, when the count rate column is null', () => {
    const t = task({
      id: 't1',
      durationBaseDays: 5,
      durationSource: 'washrooms',
      durationDaysPerUnit: null,
    });
    expect(durationDaysOf(t, scope({ washroomCount: 4 }))).toBe(5);
  });
});

/* -------------------------------------------------------------------------
   Whether a task applies to this job
   ------------------------------------------------------------------------- */

describe('conditionOutcome and isSuggested', () => {
  it('is unconditional, and suggested, with no condition set', () => {
    const outcome = conditionOutcome(task({ id: 't1' }), evidence());
    expect(outcome).toEqual({ kind: 'unconditional' });
    expect(isSuggested(outcome)).toBe(true);
  });

  it('is not suggested when the measured count is zero', () => {
    const t = task({ id: 't1', conditionMeasurement: 'washrooms' });
    const outcome = conditionOutcome(t, evidence({ scope: scope({ washroomCount: 0 }) }));
    expect(outcome).toEqual({ kind: 'measurement', measurement: 'washrooms', count: 0 });
    expect(isSuggested(outcome)).toBe(false);
  });

  it('is suggested when the measured count is greater than zero', () => {
    const t = task({ id: 't1', conditionMeasurement: 'washrooms' });
    const outcome = conditionOutcome(t, evidence({ scope: scope({ washroomCount: 2 }) }));
    expect(outcome).toEqual({ kind: 'measurement', measurement: 'washrooms', count: 2 });
    expect(isSuggested(outcome)).toBe(true);
  });

  it('is suggested when its rate item is among the included ones', () => {
    const t = task({ id: 't1', conditionRateItemId: 'TILE-SHWR' });
    const outcome = conditionOutcome(t, evidence({ includedRateItemIds: new Set(['TILE-SHWR']) }));
    expect(outcome).toEqual({ kind: 'rateItem', rateItemId: 'TILE-SHWR', present: true });
    expect(isSuggested(outcome)).toBe(true);
  });

  it('is not suggested when its rate item is absent from the included set', () => {
    const t = task({ id: 't1', conditionRateItemId: 'TILE-SHWR' });
    const outcome = conditionOutcome(t, evidence({ includedRateItemIds: new Set() }));
    expect(outcome).toEqual({ kind: 'rateItem', rateItemId: 'TILE-SHWR', present: false });
    expect(isSuggested(outcome)).toBe(false);
  });

  it('is noAcceptedQuote, and not suggested, for a conditional task with no accepted quote', () => {
    const t = task({ id: 't1', conditionMeasurement: 'washrooms' });
    const outcome = conditionOutcome(t, evidence({ hasAcceptedQuote: false }));
    expect(outcome).toEqual({ kind: 'noAcceptedQuote' });
    expect(isSuggested(outcome)).toBe(false);
  });

  it('is still unconditional, and still suggested, for an unconditional task even with no accepted quote', () => {
    // The order of the two checks in `conditionOutcome` matters: the
    // unconditional branch must return before `hasAcceptedQuote` is ever
    // read, or permits and cleanup would go unticked on the one job that has
    // no accepted quote to answer a condition against.
    const outcome = conditionOutcome(task({ id: 't1' }), evidence({ hasAcceptedQuote: false }));
    expect(outcome).toEqual({ kind: 'unconditional' });
    expect(isSuggested(outcome)).toBe(true);
  });
});

/* -------------------------------------------------------------------------
   What a task waits on once some are dropped
   ------------------------------------------------------------------------- */

describe('effectiveLink', () => {
  const A = task({ id: 'A', sortOrder: 1 });
  const B = task({ id: 'B', sortOrder: 2, predecessorTaskId: 'A', lagDays: 3 });
  const C = task({ id: 'C', sortOrder: 3, predecessorTaskId: 'B', lagDays: 5 });
  const chain = [A, B, C];
  const byId = byIdOf(chain);

  it('leaves an untouched chain alone: B waits on A, lag preserved, not relinked', () => {
    const ticked = new Set(['A', 'B', 'C']);
    expect(effectiveLink(B, byId, ticked)).toEqual({
      predecessorTaskId: 'A',
      lagDays: 3,
      relinked: false,
      lagClamped: false,
    });
  });

  it('walks past a dropped middle task: C waits on A, marked relinked', () => {
    const ticked = new Set(['A', 'C']); // B dropped
    expect(effectiveLink(C, byId, ticked)).toEqual({
      predecessorTaskId: 'A',
      lagDays: 5,
      relinked: true,
      lagClamped: false,
    });
  });

  it('walks to the furthest ticked ancestor when two in a row are dropped', () => {
    const D = task({ id: 'D', sortOrder: 4, predecessorTaskId: 'C', lagDays: 1 });
    const byIdWithD = byIdOf([...chain, D]);
    const ticked = new Set(['A', 'D']); // B and C both dropped
    expect(effectiveLink(D, byIdWithD, ticked)).toEqual({
      predecessorTaskId: 'A',
      lagDays: 1,
      relinked: true,
      lagClamped: false,
    });
  });

  it('turns a task into a root, with no lag, when its only predecessor is dropped', () => {
    const root = task({ id: 'A' });
    const dependent = task({ id: 'B', predecessorTaskId: 'A', lagDays: 4 });
    const map = byIdOf([root, dependent]);
    const ticked = new Set(['B']); // A dropped
    expect(effectiveLink(dependent, map, ticked)).toEqual({
      predecessorTaskId: null,
      lagDays: 0,
      relinked: true,
      lagClamped: false,
    });
  });

  it('turns both sides of a fork into roots when the shared ancestor is dropped', () => {
    const root = task({ id: 'A' });
    const left = task({ id: 'B', predecessorTaskId: 'A' });
    const right = task({ id: 'C', predecessorTaskId: 'A' });
    const map = byIdOf([root, left, right]);
    const ticked = new Set(['B', 'C']); // A dropped

    expect(effectiveLink(left, map, ticked).predecessorTaskId).toBeNull();
    expect(effectiveLink(right, map, ticked).predecessorTaskId).toBeNull();
  });

  it('restores the original predecessor on re-tick -- the bug this function exists to prevent', () => {
    // Untick B: C re-links onto A.
    const dropped = effectiveLink(C, byId, new Set(['A', 'C']));
    expect(dropped.predecessorTaskId).toBe('A');

    // Tick B again. A mutating implementation would leave C pointed at A
    // (running B and C in parallel); this one recomputes from the stored
    // chain every time and lands back on the untouched answer.
    const restored = effectiveLink(C, byId, new Set(['A', 'B', 'C']));
    expect(restored).toEqual({
      predecessorTaskId: 'B',
      lagDays: 5,
      relinked: false,
      lagClamped: false,
    });
  });

  describe('a negative lag', () => {
    const root = task({ id: 'A' });
    const middle = task({ id: 'M', predecessorTaskId: 'A' });
    const dependent = task({ id: 'B', predecessorTaskId: 'M', lagDays: -2 });
    const map = byIdOf([root, middle, dependent]);

    it('survives an intact link', () => {
      const ticked = new Set(['A', 'M', 'B']);
      expect(effectiveLink(dependent, map, ticked)).toEqual({
        predecessorTaskId: 'M',
        lagDays: -2,
        relinked: false,
        lagClamped: false,
      });
    });

    it('clamps to zero across a re-link', () => {
      const ticked = new Set(['A', 'B']); // M dropped
      expect(effectiveLink(dependent, map, ticked)).toEqual({
        predecessorTaskId: 'A',
        lagDays: 0,
        relinked: true,
        lagClamped: true,
      });
    });
  });

  it('throws rather than looping forever when the stored data forms a cycle', () => {
    const a = task({ id: 'A', predecessorTaskId: 'B' });
    const b = task({ id: 'B', predecessorTaskId: 'A' });
    const map = byIdOf([a, b]);
    expect(() => effectiveLink(a, map, new Set())).toThrow(/cycle/);
  });
});

/* -------------------------------------------------------------------------
   The dated plan
   ------------------------------------------------------------------------- */

describe('planImport', () => {
  it('starts every root on the given date, independently -- they do not queue behind each other', () => {
    const first = task({ id: 'first', sortOrder: 1, durationBaseDays: 3 });
    const second = task({ id: 'second', sortOrder: 2, durationBaseDays: 7 });
    const rows = planImport([first, second], new Set(['first', 'second']), scope(), '2026-10-05');
    expect(rows.map((r) => r.start)).toEqual(['2026-10-05', '2026-10-05']);
  });

  it('starts the next task the next morning when lag is zero', () => {
    const A = task({ id: 'A', sortOrder: 1, durationBaseDays: 2 });
    const B = task({
      id: 'B',
      sortOrder: 2,
      predecessorTaskId: 'A',
      lagDays: 0,
      durationBaseDays: 1,
    });
    const rows = planImport([A, B], new Set(['A', 'B']), scope(), '2026-10-05');
    const a = rows.find((r) => r.templateTaskId === 'A')!;
    const b = rows.find((r) => r.templateTaskId === 'B')!;
    expect(a.end).toBe('2026-10-06'); // 2 days, both ends counted
    expect(b.start).toBe('2026-10-07'); // the morning after A ends, not the same day
  });

  it('ends a 1-day task on the day it starts', () => {
    const t = task({ id: 't1', durationBaseDays: 1 });
    const [row] = planImport([t], new Set(['t1']), scope(), '2026-10-05');
    expect(row.start).toBe('2026-10-05');
    expect(row.end).toBe('2026-10-05');
  });

  it('ends a 5-day task starting Monday Oct 5 on Friday Oct 9', () => {
    const t = task({ id: 't1', durationBaseDays: 5 });
    const [row] = planImport([t], new Set(['t1']), scope(), '2026-10-05');
    expect(row.end).toBe('2026-10-09');
  });

  it('dates correctly against a hostile sort_order where the dependent sorts above its own predecessor', () => {
    const predecessor = task({ id: 'pred', sortOrder: 2, durationBaseDays: 3 });
    const dependent = task({
      id: 'dep',
      sortOrder: 1, // sorts BEFORE its own predecessor
      predecessorTaskId: 'pred',
      lagDays: 0,
      durationBaseDays: 1,
    });
    // The array is given in the same hostile order as sort_order, not in
    // dependency order.
    const rows = planImport(
      [dependent, predecessor],
      new Set(['pred', 'dep']),
      scope(),
      '2026-10-05',
    );

    const pred = rows.find((r) => r.templateTaskId === 'pred')!;
    const dep = rows.find((r) => r.templateTaskId === 'dep')!;
    expect(pred.start).toBe('2026-10-05');
    expect(pred.end).toBe('2026-10-07');
    expect(dep.start).toBe('2026-10-08'); // correct despite sorting above its predecessor
  });

  it('returns the rows in sort_order, not dependency order or array order', () => {
    const c = task({ id: 'c', sortOrder: 3, durationBaseDays: 1 });
    const a = task({ id: 'a', sortOrder: 1, durationBaseDays: 1 });
    const b = task({ id: 'b', sortOrder: 2, durationBaseDays: 1 });
    const rows = planImport([c, a, b], new Set(['a', 'b', 'c']), scope(), '2026-10-05');
    expect(rows.map((r) => r.templateTaskId)).toEqual(['a', 'b', 'c']);
  });

  it('omits an unticked task entirely', () => {
    const kept = task({ id: 'kept', sortOrder: 1, durationBaseDays: 1 });
    const dropped = task({ id: 'dropped', sortOrder: 2, durationBaseDays: 1 });
    const rows = planImport([kept, dropped], new Set(['kept']), scope(), '2026-10-05');
    expect(rows.map((r) => r.templateTaskId)).toEqual(['kept']);
  });

  it('carries a chain across a month boundary', () => {
    const A = task({ id: 'A', sortOrder: 1, durationBaseDays: 5 });
    const B = task({
      id: 'B',
      sortOrder: 2,
      predecessorTaskId: 'A',
      lagDays: 0,
      durationBaseDays: 1,
    });
    // 2026-01-28 plus 4 days (5-day task) lands on 2026-02-01.
    const rows = planImport([A, B], new Set(['A', 'B']), scope(), '2026-01-28');
    const a = rows.find((r) => r.templateTaskId === 'A')!;
    const b = rows.find((r) => r.templateTaskId === 'B')!;
    expect(a.end).toBe('2026-02-01');
    expect(b.start).toBe('2026-02-02');
  });

  it('counts weekend days rather than skipping them -- the schedule deliberately works in calendar days', () => {
    // 2026-10-02 is a Friday. A working-day schedule would push a 3-day task's
    // last day to Monday 2026-10-05; this one lands on Sunday 2026-10-04
    // because Saturday and Sunday both count.
    const t = task({ id: 't1', durationBaseDays: 3 });
    const [row] = planImport([t], new Set(['t1']), scope(), '2026-10-02');
    expect(row.end).toBe('2026-10-04');
  });
});

/* -------------------------------------------------------------------------
   The job's finish
   ------------------------------------------------------------------------- */

describe('planFinish', () => {
  it('is null for an empty array', () => {
    expect(planFinish([])).toBeNull();
  });

  it('is the latest end date among the planned rows', () => {
    const rows = planImport(
      [
        task({ id: 'a', sortOrder: 1, durationBaseDays: 3 }),
        task({ id: 'b', sortOrder: 2, durationBaseDays: 10 }),
      ],
      new Set(['a', 'b']),
      scope(),
      '2026-10-05',
    );
    // 'a' ends 2026-10-07 (3 days); 'b' ends 2026-10-14 (10 days) and is later.
    expect(planFinish(rows)).toBe('2026-10-14');
  });
});
