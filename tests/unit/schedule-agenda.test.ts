import { describe, expect, it } from 'vitest';
import {
  buildDays,
  coversDay,
  daysOfRange,
  monthEnd,
  monthStart,
  periodParam,
  rangeOf,
  readAnchor,
  readPeriod,
  stepAnchor,
  summarize,
  weekStart,
  weekdayIndex,
  type CalendarDay,
  type CalendarTask,
  type DayEntry,
} from '@/lib/schedule/agenda';
import type { Assignee } from '@/app/projects/[id]/schedule/schema';

/**
 * `agenda.ts` is pure: no database, no request. This file stays pure with it --
 * every date below is a fixed literal, never `new Date()`, because the one
 * thing this module must never depend on is the clock it is asked about.
 */

/* -------------------------------------------------------------------------
   Fixtures shared by the buildDays tests
   ------------------------------------------------------------------------- */

const JOB_ONE = { projectId: 'p1', projectNumber: 'P-2026-001', projectName: 'Maple Ave' };
const JOB_TWO = { projectId: 'p2', projectNumber: 'P-2026-002', projectName: 'Birch St' };

const PRIYA: Assignee = { kind: 'user', id: '11111111-1111-4111-8111-111111111111' };
const AMIR: Assignee = { kind: 'user', id: '22222222-2222-4222-8222-222222222222' };
const CLEO: Assignee = { kind: 'vendor', id: '33333333-3333-4333-8333-333333333333' };

function task(
  overrides: Partial<CalendarTask> & Pick<CalendarTask, 'id' | 'name' | 'span'>,
): CalendarTask {
  return {
    isMilestone: false,
    trade: null,
    projectId: JOB_ONE.projectId,
    projectNumber: JOB_ONE.projectNumber,
    projectName: JOB_ONE.projectName,
    assignees: [],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------
   The period on screen
   ------------------------------------------------------------------------- */

describe('readPeriod', () => {
  it('accepts the three named periods', () => {
    expect(readPeriod('day')).toBe('day');
    expect(readPeriod('week')).toBe('week');
    expect(readPeriod('month')).toBe('month');
  });

  it('falls back to the default week when nothing is given', () => {
    expect(readPeriod(undefined)).toBe('week');
  });

  it('treats anything unknown as the default, not an error', () => {
    expect(readPeriod('fortnight')).toBe('week');
    expect(readPeriod('')).toBe('week');
    expect(readPeriod('DAY')).toBe('week');
  });
});

describe('periodParam', () => {
  it('is empty for the default week, so the plain address stays plain', () => {
    expect(periodParam('week')).toBe('');
  });

  it('names the period otherwise', () => {
    expect(periodParam('day')).toBe('day');
    expect(periodParam('month')).toBe('month');
  });
});

/* -------------------------------------------------------------------------
   The anchor
   ------------------------------------------------------------------------- */

describe('readAnchor', () => {
  const TODAY = '2026-09-05';

  it('passes through a valid ISO date', () => {
    expect(readAnchor('2026-03-10', TODAY)).toBe('2026-03-10');
  });

  it('falls back to today when nothing is given', () => {
    expect(readAnchor(undefined, TODAY)).toBe(TODAY);
  });

  it('falls back to today on a malformed date', () => {
    // FINDING: this currently fails. `readAnchor` validates shape only
    // (`/^\d{4}-\d{2}-\d{2}$/`), so a string of the right shape but naming no
    // real calendar date -- month 13, day 40 -- passes through unchanged
    // instead of falling back to today, contradicting the docblock ("An ISO
    // date the URL may or may not carry. Anything else is today."). Left
    // failing rather than weakened, per instructions not to edit either side
    // to agree.
    expect(readAnchor('2026-13-40', TODAY)).toBe(TODAY);
  });

  it('falls back to today on a string that is not a date at all', () => {
    expect(readAnchor('tomorrow', TODAY)).toBe(TODAY);
  });
});

/* -------------------------------------------------------------------------
   Weeks: Monday is 0
   ------------------------------------------------------------------------- */

describe('weekdayIndex and weekStart', () => {
  it('puts Monday at 0', () => {
    expect(weekdayIndex('2026-03-09')).toBe(0);
    expect(weekStart('2026-03-09')).toBe('2026-03-09');
  });

  it('puts a Sunday at 6, the case that breaks when the epoch offset is "fixed"', () => {
    // 2024-01-07 is the Sunday of the very week the epoch Monday sits in.
    expect(weekdayIndex('2024-01-07')).toBe(6);
    expect(weekStart('2024-01-07')).toBe('2024-01-01');
  });

  it('finds the Monday across a year boundary', () => {
    // 2026-01-01 is a Thursday; its week started in December of 2025.
    expect(weekdayIndex('2026-01-01')).toBe(3);
    expect(weekStart('2026-01-01')).toBe('2025-12-29');
    // The Sunday that closes the same week, still in the new year.
    expect(weekdayIndex('2026-01-04')).toBe(6);
    expect(weekStart('2026-01-04')).toBe('2025-12-29');
  });
});

/* -------------------------------------------------------------------------
   Months
   ------------------------------------------------------------------------- */

describe('monthStart and monthEnd', () => {
  it('spans a 30-day month', () => {
    expect(monthStart('2026-04-15')).toBe('2026-04-01');
    expect(monthEnd('2026-04-15')).toBe('2026-04-30');
  });

  it('spans a 31-day month', () => {
    expect(monthStart('2026-01-15')).toBe('2026-01-01');
    expect(monthEnd('2026-01-15')).toBe('2026-01-31');
  });

  it('stops February at the 28th in a non-leap year', () => {
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
  });

  it('stops February at the 29th in a leap year', () => {
    expect(monthEnd('2028-02-10')).toBe('2028-02-29');
  });
});

/* -------------------------------------------------------------------------
   The range a period covers
   ------------------------------------------------------------------------- */

describe('rangeOf', () => {
  it('gives a day the same date twice', () => {
    expect(rangeOf('day', '2026-03-10')).toEqual({ start: '2026-03-10', end: '2026-03-10' });
  });

  it('gives a week Monday to Sunday', () => {
    // 2026-03-11 is a Wednesday inside the week of 2026-03-09..2026-03-15.
    expect(rangeOf('week', '2026-03-11')).toEqual({ start: '2026-03-09', end: '2026-03-15' });
  });

  it('gives a month the 1st to the last', () => {
    expect(rangeOf('month', '2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });
});

/* -------------------------------------------------------------------------
   Stepping the anchor
   ------------------------------------------------------------------------- */

describe('stepAnchor', () => {
  it('steps a day forward and backward by more than one step', () => {
    expect(stepAnchor('day', '2026-03-10', 3)).toBe('2026-03-13');
    expect(stepAnchor('day', '2026-03-10', -3)).toBe('2026-03-07');
  });

  it('normalises a Wednesday-anchored week to the Monday it lands on', () => {
    // 2026-03-11 is a Wednesday; its week starts 2026-03-09.
    expect(stepAnchor('week', '2026-03-11', 1)).toBe('2026-03-16');
  });

  it('steps a week forward and backward by more than one step, still landing on Mondays', () => {
    expect(stepAnchor('week', '2026-03-11', 2)).toBe('2026-03-23');
    expect(stepAnchor('week', '2026-03-11', -1)).toBe('2026-03-02');
  });

  it('steps months across a December to January boundary, forward', () => {
    expect(stepAnchor('month', '2025-12-15', 1)).toBe('2026-01-01');
  });

  it('steps months across a December to January boundary, backward', () => {
    expect(stepAnchor('month', '2026-01-15', -1)).toBe('2025-12-01');
  });

  it('steps a month backward from the 1st without landing on the same month', () => {
    expect(stepAnchor('month', '2026-03-01', -1)).toBe('2026-02-01');
  });

  it('steps months forward by more than one step', () => {
    expect(stepAnchor('month', '2026-01-15', 3)).toBe('2026-04-01');
  });
});

/* -------------------------------------------------------------------------
   Every day in a range
   ------------------------------------------------------------------------- */

describe('daysOfRange', () => {
  it('includes both ends', () => {
    expect(daysOfRange({ start: '2026-03-09', end: '2026-03-15' })[0]).toBe('2026-03-09');
    expect(daysOfRange({ start: '2026-03-09', end: '2026-03-15' }).at(-1)).toBe('2026-03-15');
  });

  it('yields one day for a single-day range', () => {
    expect(daysOfRange({ start: '2026-03-10', end: '2026-03-10' })).toEqual(['2026-03-10']);
  });

  it('yields seven days for a week', () => {
    expect(daysOfRange({ start: '2026-03-09', end: '2026-03-15' })).toHaveLength(7);
  });
});

/* -------------------------------------------------------------------------
   Is a task on site that day
   ------------------------------------------------------------------------- */

describe('coversDay', () => {
  const FIVE_DAY_TASK = { start: '2026-03-10', end: '2026-03-14' };

  it('covers the first day', () => {
    expect(coversDay(FIVE_DAY_TASK, '2026-03-10')).toBe(true);
  });

  it('covers the last day', () => {
    expect(coversDay(FIVE_DAY_TASK, '2026-03-14')).toBe(true);
  });

  it('covers a one-day milestone sitting inside the task', () => {
    // The milestone's own span is a single day equal to that day -- and it
    // must still register as covered by the surrounding five-day task, which
    // is exactly why `coversDay` delegates to `spansOverlap` rather than a
    // half-open comparison.
    expect(coversDay(FIVE_DAY_TASK, '2026-03-12')).toBe(true);
  });

  it('does not cover the day before it starts', () => {
    expect(coversDay(FIVE_DAY_TASK, '2026-03-09')).toBe(false);
  });

  it('does not cover the day after it ends', () => {
    expect(coversDay(FIVE_DAY_TASK, '2026-03-15')).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   buildDays
   ------------------------------------------------------------------------- */

describe('buildDays', () => {
  const DAY = '2026-03-10';

  it('gives a task with no assignees exactly one entry, unassigned', () => {
    const nobody = task({ id: 't1', name: 'Excavation', span: { start: DAY, end: DAY } });
    const [day] = buildDays([DAY], [nobody]);
    expect(day.entries).toHaveLength(1);
    expect(day.entries[0].who).toBeNull();
    expect(day.entries[0].assigneeKey).toBeNull();
  });

  it('gives a task with two assignees two entries', () => {
    const both = task({
      id: 't2',
      name: 'Framing',
      span: { start: DAY, end: DAY },
      assignees: [
        { assignee: PRIYA, name: 'Priya Raghavan' },
        { assignee: CLEO, name: 'Cleo Vendor Co' },
      ],
    });
    const [day] = buildDays([DAY], [both]);
    expect(day.entries).toHaveLength(2);
  });

  it('is a clash when one person is on two tasks that share a day', () => {
    const excavation = task({
      id: 'ta',
      name: 'Excavation',
      span: { start: DAY, end: DAY },
      assignees: [{ assignee: PRIYA, name: 'Priya Raghavan' }],
    });
    const wiring = task({
      id: 'tb',
      name: 'Wiring',
      span: { start: DAY, end: DAY },
      projectId: JOB_TWO.projectId,
      projectNumber: JOB_TWO.projectNumber,
      projectName: JOB_TWO.projectName,
      assignees: [{ assignee: PRIYA, name: 'Priya Raghavan' }],
    });
    const [day] = buildDays([DAY], [excavation, wiring]);

    expect(day.clashCount).toBe(1);
    const excavationEntry = day.entries.find((e) => e.taskId === 'ta')!;
    const wiringEntry = day.entries.find((e) => e.taskId === 'tb')!;
    expect(excavationEntry.clashesWith).toEqual(['Wiring']);
    expect(wiringEntry.clashesWith).toEqual(['Excavation']);
  });

  it('counts two different people each clashing as two clashes', () => {
    const excavation = task({
      id: 'ta',
      name: 'Excavation',
      span: { start: DAY, end: DAY },
      assignees: [{ assignee: PRIYA, name: 'Priya Raghavan' }],
    });
    const wiring = task({
      id: 'tb',
      name: 'Wiring',
      span: { start: DAY, end: DAY },
      assignees: [{ assignee: PRIYA, name: 'Priya Raghavan' }],
    });
    const painting = task({
      id: 'tc',
      name: 'Painting',
      span: { start: DAY, end: DAY },
      assignees: [{ assignee: AMIR, name: 'Amir Khan' }],
    });
    const tiling = task({
      id: 'td',
      name: 'Tiling',
      span: { start: DAY, end: DAY },
      assignees: [{ assignee: AMIR, name: 'Amir Khan' }],
    });
    const [day] = buildDays([DAY], [excavation, wiring, painting, tiling]);

    expect(day.clashCount).toBe(2);
  });

  it('never lets a filter hide a clash from the arithmetic', () => {
    // Read the comment on `EntryFilter`: filtering the calendar to one job
    // must not make the OTHER half of a double-booking disappear, because
    // that other half is on the job that just got filtered out -- precisely
    // the case this screen exists for.
    const onJobOne = task({
      id: 'ta',
      name: 'Excavation',
      span: { start: DAY, end: DAY },
      projectId: JOB_ONE.projectId,
      assignees: [{ assignee: PRIYA, name: 'Priya Raghavan' }],
    });
    const onJobTwo = task({
      id: 'tb',
      name: 'Wiring',
      span: { start: DAY, end: DAY },
      projectId: JOB_TWO.projectId,
      assignees: [{ assignee: PRIYA, name: 'Priya Raghavan' }],
    });
    const keepJobOneOnly: (entry: DayEntry) => boolean = (entry) => entry.projectId === JOB_ONE.projectId;

    const [day] = buildDays([DAY], [onJobOne, onJobTwo], keepJobOneOnly);

    expect(day.clashCount).toBe(1);
    const jobOneEntry = day.entries.find((e) => e.taskId === 'ta')!;
    const jobTwoEntry = day.entries.find((e) => e.taskId === 'tb')!;
    expect(jobOneEntry.visible).toBe(true);
    expect(jobOneEntry.clashesWith).toEqual(['Wiring']);
    expect(jobTwoEntry.visible).toBe(false);
    expect(jobTwoEntry.clashesWith).toEqual(['Excavation']);
  });

  it('sorts a clashing entry above the rest, then by job, task and person, with unassigned last', () => {
    const excavation = task({
      id: 'exc',
      name: 'Excavation',
      span: { start: DAY, end: DAY },
      projectId: JOB_ONE.projectId,
      projectNumber: JOB_ONE.projectNumber,
      assignees: [{ assignee: PRIYA, name: 'Priya Raghavan' }],
    });
    const wiringJobTwo = task({
      id: 'wire2',
      name: 'Wiring',
      span: { start: DAY, end: DAY },
      projectId: JOB_TWO.projectId,
      projectNumber: JOB_TWO.projectNumber,
      assignees: [{ assignee: PRIYA, name: 'Priya Raghavan' }],
    });
    const survey = task({
      id: 'survey',
      name: 'Survey',
      span: { start: DAY, end: DAY },
      projectId: JOB_ONE.projectId,
      projectNumber: JOB_ONE.projectNumber,
      assignees: [{ assignee: CLEO, name: 'Cleo Vendor Co' }],
    });
    // Two different tasks that happen to share a project and a task name --
    // the comparator ties on (projectNumber, taskName), not on task id, and
    // this is the only way to force the "who === null sorts last" branch.
    const wiringJobOneWithSomeone = task({
      id: 'wire1-staffed',
      name: 'Wiring',
      span: { start: DAY, end: DAY },
      projectId: JOB_ONE.projectId,
      projectNumber: JOB_ONE.projectNumber,
      assignees: [{ assignee: AMIR, name: 'Amir Khan' }],
    });
    const wiringJobOneUnstaffed = task({
      id: 'wire1-nobody',
      name: 'Wiring',
      span: { start: DAY, end: DAY },
      projectId: JOB_ONE.projectId,
      projectNumber: JOB_ONE.projectNumber,
      assignees: [],
    });

    const [day] = buildDays(
      [DAY],
      [excavation, wiringJobTwo, survey, wiringJobOneWithSomeone, wiringJobOneUnstaffed],
    );

    expect(day.entries.map((e) => [e.taskName, e.who])).toEqual([
      ['Excavation', 'Priya Raghavan'],
      ['Wiring', 'Priya Raghavan'], // job two, the clash partner
      ['Survey', 'Cleo Vendor Co'],
      ['Wiring', 'Amir Khan'],
      ['Wiring', null],
    ]);
  });

  it('numbers the column as weekdayIndex plus one', () => {
    // 2026-03-11 is a Wednesday, weekdayIndex 2, so column 3.
    const [day] = buildDays(['2026-03-11'], []);
    expect(weekdayIndex('2026-03-11')).toBe(2);
    expect(day.column).toBe(3);
  });
});

/* -------------------------------------------------------------------------
   summarize
   ------------------------------------------------------------------------- */

function entry(overrides: Partial<DayEntry> & Pick<DayEntry, 'key'>): DayEntry {
  return {
    taskId: 't',
    taskName: 'Task',
    projectId: JOB_ONE.projectId,
    projectNumber: JOB_ONE.projectNumber,
    projectName: JOB_ONE.projectName,
    isMilestone: false,
    who: null,
    assigneeKey: null,
    clashesWith: [],
    visible: true,
    ...overrides,
  };
}

function calendarDay(overrides: Partial<CalendarDay> & Pick<CalendarDay, 'date'>): CalendarDay {
  return { column: 1, entries: [], clashCount: 0, ...overrides };
}

describe('summarize', () => {
  it('counts shown as only the visible entries', () => {
    const day = calendarDay({
      date: '2026-03-10',
      entries: [
        entry({ key: '1', who: 'Priya Raghavan', visible: true }),
        entry({ key: '2', who: 'Amir Khan', visible: true }),
        entry({ key: '3', who: 'Cleo Vendor Co', visible: false }),
      ],
    });
    expect(summarize([day]).shown).toBe(2);
  });

  it('counts unassigned as visible entries with no person', () => {
    const day = calendarDay({
      date: '2026-03-10',
      entries: [
        entry({ key: '1', who: null, visible: true }),
        entry({ key: '2', who: 'Amir Khan', visible: true }),
        entry({ key: '3', who: null, visible: false }),
      ],
    });
    const summary = summarize([day]);
    expect(summary.unassigned).toBe(1);
    expect(summary.shown).toBe(2);
  });

  it('sums clashCount across days for clashes', () => {
    const days = [
      calendarDay({ date: '2026-03-10', clashCount: 1 }),
      calendarDay({ date: '2026-03-11', clashCount: 2 }),
    ];
    expect(summarize(days).clashes).toBe(3);
  });

  it('names the earliest day holding a clash', () => {
    const days = [
      calendarDay({ date: '2026-03-10', clashCount: 0 }),
      calendarDay({ date: '2026-03-11', clashCount: 1 }),
      calendarDay({ date: '2026-03-12', clashCount: 1 }),
    ];
    expect(summarize(days).firstClashDay).toBe('2026-03-11');
  });

  it('names the worst clash: who, when, and the tasks', () => {
    const day = calendarDay({
      date: '2026-03-10',
      clashCount: 1,
      entries: [
        entry({
          key: '1',
          taskName: 'Excavation',
          who: 'Priya Raghavan',
          clashesWith: ['Wiring'],
          visible: true,
        }),
        entry({
          key: '2',
          taskName: 'Wiring',
          who: 'Priya Raghavan',
          clashesWith: ['Excavation'],
          visible: true,
        }),
      ],
    });
    expect(summarize([day]).worst).toEqual({
      who: 'Priya Raghavan',
      date: '2026-03-10',
      taskNames: ['Excavation', 'Wiring'],
    });
  });

  it('still reports the worst clash when every one of its entries is filtered invisible', () => {
    // Narrowing the calendar to one job must not silence the warning that
    // job's own screen cannot give -- the special branch this covers.
    const day = calendarDay({
      date: '2026-03-10',
      clashCount: 1,
      entries: [
        entry({
          key: '1',
          taskName: 'Framing',
          who: 'Amir Khan',
          clashesWith: ['Drywall'],
          visible: false,
        }),
        entry({
          key: '2',
          taskName: 'Drywall',
          who: 'Amir Khan',
          clashesWith: ['Framing'],
          visible: false,
        }),
      ],
    });
    const summary = summarize([day]);
    expect(summary.shown).toBe(0);
    expect(summary.unassigned).toBe(0);
    expect(summary.worst).toEqual({
      who: 'Amir Khan',
      date: '2026-03-10',
      taskNames: ['Framing', 'Drywall'],
    });
  });
});
