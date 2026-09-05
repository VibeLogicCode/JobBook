import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  durationDays,
  lagBetween,
  latestDate,
  shiftDays,
  startAfter,
} from '@/lib/schedule/calendar';
import {
  canonicalScheduleText,
  describeMove,
  findPredecessorCycle,
  planMove,
  type ScheduleTask,
} from '@/lib/schedule/push';

/**
 * The push, at its boundaries.
 *
 * The plan calls this the part with real thinking in it, and every case below
 * is one of the four things it says the push has to get right. They are tested
 * here, before the screen exists, because a rule proved in a browser is proved
 * for the one path somebody clicked.
 *
 * Nothing in this file touches a database or a clock. Dates are literals, so a
 * run in a UTC container at 8pm Toronto produces the same answer as a run at
 * noon -- which is the whole reason `planMove` takes its dates as arguments,
 * the way `evaluateRules` takes its `today`.
 */

/** A task, with the columns that do not matter to the push filled in. */
function task(over: Partial<ScheduleTask> & Pick<ScheduleTask, 'id' | 'name'>): ScheduleTask {
  return {
    plannedStart: '2026-03-02',
    plannedEnd: '2026-03-06',
    actualStart: null,
    actualEnd: null,
    predecessorTaskId: null,
    lagDays: 0,
    ...over,
  };
}

/**
 * A chain of three, tight: excavation, then footings the next day, then
 * framing the day after that. The shape the owner described.
 */
function chainOfThree(): ScheduleTask[] {
  return [
    task({ id: 'a', name: 'Excavation', plannedStart: '2026-03-02', plannedEnd: '2026-03-06' }),
    task({
      id: 'b',
      name: 'Footings',
      plannedStart: '2026-03-07',
      plannedEnd: '2026-03-11',
      predecessorTaskId: 'a',
      lagDays: 0,
    }),
    task({
      id: 'c',
      name: 'Framing',
      plannedStart: '2026-03-12',
      plannedEnd: '2026-03-20',
      predecessorTaskId: 'b',
      lagDays: 0,
    }),
  ];
}

const iso = (value: string) => value;

/* -------------------------------------------------------------------------
   Calendar days
   ------------------------------------------------------------------------- */

describe('schedule calendar', () => {
  it('counts calendar days, weekends included', () => {
    // Friday to Monday is three days here and one working day elsewhere. The
    // product has chosen calendar days deliberately; this is that choice
    // written down where a change to it would fail.
    expect(daysBetween('2026-03-06', '2026-03-09')).toBe(3);
    expect(shiftDays('2026-03-06', 3)).toBe('2026-03-09');
  });

  it('counts a one-day task as one day, not none', () => {
    expect(durationDays('2026-03-06', '2026-03-06')).toBe(1);
    expect(durationDays('2026-03-06', '2026-03-10')).toBe(5);
  });

  it('treats lag zero as the next morning, both ways round', () => {
    expect(startAfter('2026-03-06', 0)).toBe('2026-03-07');
    expect(startAfter('2026-03-06', 2)).toBe('2026-03-09');
    expect(lagBetween('2026-03-06', '2026-03-07')).toBe(0);
    expect(lagBetween('2026-03-06', '2026-03-09')).toBe(2);
    // Trades overlap: starting the day before the thing in front finishes.
    expect(lagBetween('2026-03-06', '2026-03-05')).toBe(-2);
  });

  it('crosses a daylight-saving change without losing a day', () => {
    // Toronto springs forward on 8 March 2026. Date-domain arithmetic must not
    // notice, or every schedule slips a day twice a year.
    expect(shiftDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
  });

  it('crosses a month and a leap-year February', () => {
    expect(shiftDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(shiftDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3);
  });

  it('reads the latest of a set, and says nothing about an empty one', () => {
    expect(latestDate(['2026-03-02', '2026-03-20', '2026-03-11'])).toBe('2026-03-20');
    expect(latestDate([])).toBeNull();
  });
});

/* -------------------------------------------------------------------------
   A chain of three
   ------------------------------------------------------------------------- */

describe('planMove: a chain of three', () => {
  it('pushes everything after the moved task by the same delta', () => {
    const preview = planMove(chainOfThree(), {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });

    expect(preview.cycle).toBeNull();
    expect(preview.moves.map((move) => [move.name, move.toStart, move.toEnd])).toEqual([
      ['Excavation', '2026-03-05', '2026-03-09'],
      ['Footings', '2026-03-10', '2026-03-14'],
      ['Framing', '2026-03-15', '2026-03-23'],
    ]);
    expect(preview.moves[0]!.cause).toBe('edited');
    expect(preview.moves.slice(1).every((move) => move.cause === 'pushed')).toBe(true);
    expect(preview.finishBefore).toBe('2026-03-20');
    expect(preview.finishAfter).toBe('2026-03-23');
  });

  it('leaves every gap in the chain exactly as it was', () => {
    const tasks = chainOfThree();
    // Two days of cure time between footings and framing, deliberately left there.
    tasks[2] = { ...tasks[2]!, plannedStart: '2026-03-14', plannedEnd: '2026-03-22', lagDays: 2 };

    const preview = planMove(tasks, {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });

    const framing = preview.moves.find((move) => move.id === 'c')!;
    expect(framing.toStart).toBe('2026-03-17');
    // The slack survives. Recomputing from "predecessor end plus lag" would
    // have produced the same number here only because the lag was stored; the
    // point is that the two days were never re-derived at all.
    expect(framing.lagDays).toBe(2);
    expect(lagBetween('2026-03-14', framing.toStart)).toBe(2);
  });

  it('moves only what is downstream of the task that was edited', () => {
    const preview = planMove(chainOfThree(), {
      taskId: 'b',
      plannedStart: '2026-03-09',
      plannedEnd: '2026-03-13',
    });

    expect(preview.moves.map((move) => move.name)).toEqual(['Footings', 'Framing']);
    // Excavation is upstream. A push travels one way.
    expect(preview.moves.some((move) => move.id === 'a')).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   The standalone task in the middle -- the whole point of the opt-in
   ------------------------------------------------------------------------- */

describe('planMove: a standalone task', () => {
  it('never moves one, even when it sits mid-chain by date', () => {
    const tasks = chainOfThree();
    // Sits between Footings and Framing on the calendar, waits on nothing.
    tasks.push(
      task({
        id: 's',
        name: 'Window delivery',
        plannedStart: '2026-03-11',
        plannedEnd: '2026-03-11',
        predecessorTaskId: null,
      }),
    );

    const preview = planMove(tasks, {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });

    expect(preview.moves.map((move) => move.name)).toEqual([
      'Excavation',
      'Footings',
      'Framing',
    ]);
    expect(preview.moves.some((move) => move.id === 's')).toBe(false);
  });

  it('moves nothing at all when the edited task has no dependents', () => {
    const tasks = [
      task({ id: 's', name: 'Window delivery', plannedStart: '2026-03-11', plannedEnd: '2026-03-11' }),
      task({ id: 't', name: 'Permit', plannedStart: '2026-03-14', plannedEnd: '2026-03-14' }),
    ];

    const preview = planMove(tasks, {
      taskId: 's',
      plannedStart: '2026-03-18',
      plannedEnd: '2026-03-18',
    });

    expect(preview.moves.map((move) => move.name)).toEqual(['Window delivery']);
    expect(preview.finishBefore).toBe('2026-03-14');
    expect(preview.finishAfter).toBe('2026-03-18');
  });
});

/* -------------------------------------------------------------------------
   Zero-day and negative moves
   ------------------------------------------------------------------------- */

describe('planMove: the edges of the delta', () => {
  it('moves nothing when the dates are the ones it already has', () => {
    const preview = planMove(chainOfThree(), {
      taskId: 'a',
      plannedStart: '2026-03-02',
      plannedEnd: '2026-03-06',
    });

    expect(preview.moves).toEqual([]);
    expect(preview.held).toEqual([]);
    expect(preview.finishAfter).toBe(preview.finishBefore);
    expect(describeMove(preview, iso)).toBe('Those are the dates it already has, so nothing moves.');
  });

  it('pulls the chain earlier when the date is pulled earlier', () => {
    const preview = planMove(chainOfThree(), {
      taskId: 'a',
      plannedStart: '2026-02-26',
      plannedEnd: '2026-03-02',
    });

    expect(preview.moves.map((move) => [move.name, move.toStart])).toEqual([
      ['Excavation', '2026-02-26'],
      ['Footings', '2026-03-03'],
      ['Framing', '2026-03-08'],
    ]);
    expect(preview.moves.every((move) => move.startDelta === -4)).toBe(true);
    expect(preview.finishAfter).toBe('2026-03-16');
  });

  it('pushes on the finish, not the start, when only the finish moves', () => {
    // Framing takes three days longer. Nothing about its start changed, and
    // everything after it still slips three days.
    const preview = planMove(chainOfThree(), {
      taskId: 'a',
      plannedStart: '2026-03-02',
      plannedEnd: '2026-03-09',
    });

    expect(preview.moves.map((move) => [move.name, move.toStart, move.toEnd])).toEqual([
      ['Excavation', '2026-03-02', '2026-03-09'],
      ['Footings', '2026-03-10', '2026-03-14'],
      ['Framing', '2026-03-15', '2026-03-23'],
    ]);
  });

  it('pushes nothing when the start moves but the finish does not', () => {
    // The crew starts two days late and still finishes on the day promised.
    const preview = planMove(chainOfThree(), {
      taskId: 'a',
      plannedStart: '2026-03-04',
      plannedEnd: '2026-03-06',
    });

    expect(preview.moves.map((move) => move.name)).toEqual(['Excavation']);
    expect(preview.finishAfter).toBe(preview.finishBefore);
  });
});

/* -------------------------------------------------------------------------
   A task with an actual date
   ------------------------------------------------------------------------- */

describe('planMove: a task that has already started', () => {
  it('holds its plan, and stops the chain behind it', () => {
    const tasks = chainOfThree();
    tasks[1] = { ...tasks[1]!, actualStart: '2026-03-07' };

    const preview = planMove(tasks, {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });

    expect(preview.moves.map((move) => move.name)).toEqual(['Excavation']);
    expect(preview.held).toHaveLength(1);
    expect(preview.held[0]!.name).toBe('Footings');
    expect(preview.held[0]!.reason).toBe('already-started');
    // Framing waits on Footings, and Footings did not move.
    expect(preview.held[0]!.downstreamNames).toEqual(['Framing']);
    expect(preview.finishAfter).toBe(preview.finishBefore);
  });

  it('restates the gap it now sits at, because its predecessor moved and it did not', () => {
    const tasks = chainOfThree();
    tasks[1] = { ...tasks[1]!, actualStart: '2026-03-07' };

    const preview = planMove(tasks, {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });

    // Excavation now finishes 9 March; Footings still plans to start 7 March.
    // The stored lag of 0 is no longer what the dates say, so the write puts
    // the truth back on the row rather than leaving two answers on screen.
    expect(preview.held[0]!.lagDays).toBe(lagBetween('2026-03-09', '2026-03-07'));
    expect(preview.held[0]!.lagDays).toBe(-3);
  });

  it('never invents or alters an actual date', () => {
    const tasks = chainOfThree();
    tasks[1] = { ...tasks[1]!, actualStart: '2026-03-07', actualEnd: '2026-03-13' };

    const preview = planMove(tasks, {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });

    // Nothing in the preview names an actual date at all: the only dates a
    // move carries are planned ones, which is what makes "the push moves
    // planned dates only" a property of the type rather than of the caller.
    const text = JSON.stringify(preview);
    expect(text).not.toContain('2026-03-13');
    expect(preview.moves.every((move) => 'toStart' in move && 'toEnd' in move)).toBe(true);
  });

  it('still lets the owner edit the plan of a task that has started', () => {
    // A deliberate correction to the plan is his to make; what is refused is
    // the SYSTEM doing it to him as a side effect of moving something else.
    const tasks = chainOfThree();
    tasks[0] = { ...tasks[0]!, actualStart: '2026-03-02' };

    const preview = planMove(tasks, {
      taskId: 'a',
      plannedStart: '2026-03-03',
      plannedEnd: '2026-03-07',
    });

    expect(preview.moves[0]!.name).toBe('Excavation');
    expect(preview.moves.map((move) => move.name)).toEqual([
      'Excavation',
      'Footings',
      'Framing',
    ]);
  });
});

/* -------------------------------------------------------------------------
   Cycles
   ------------------------------------------------------------------------- */

describe('findPredecessorCycle', () => {
  it('says nothing about a task that waits on nothing', () => {
    expect(findPredecessorCycle(chainOfThree(), 'a', null)).toBeNull();
  });

  it('allows an edge that does not close a loop', () => {
    const tasks = chainOfThree();
    tasks.push(task({ id: 'd', name: 'Roofing' }));
    expect(findPredecessorCycle(tasks, 'd', 'c')).toBeNull();
  });

  it('refuses a task that would wait on itself', () => {
    expect(findPredecessorCycle(chainOfThree(), 'a', 'a')).toEqual(['Excavation']);
  });

  it('refuses a two-task loop', () => {
    // Footings already waits on Excavation. Pointing Excavation at Footings
    // closes the loop the push would walk forever.
    expect(findPredecessorCycle(chainOfThree(), 'a', 'b')).toEqual(['Footings', 'Excavation']);
  });

  it('refuses a loop three links long', () => {
    expect(findPredecessorCycle(chainOfThree(), 'a', 'c')).toEqual([
      'Framing',
      'Footings',
      'Excavation',
    ]);
  });

  it('reports a loop that is already in the data rather than walking it', () => {
    const tasks = chainOfThree();
    // A loop that reached the table some other way: b -> c -> b.
    tasks[1] = { ...tasks[1]!, predecessorTaskId: 'c' };
    const found = findPredecessorCycle(tasks, 'a', 'b');
    expect(found).not.toBeNull();
    expect(found!.length).toBeGreaterThan(1);
  });

  it('says nothing about a predecessor that is not in the set', () => {
    // Another project's task, or one that has been voided. The foreign key and
    // the same-project check are what refuse that; guessing here would be a
    // second opinion on somebody else's question.
    expect(findPredecessorCycle(chainOfThree(), 'a', 'not-a-task')).toBeNull();
  });
});

describe('planMove: a loop already in the data', () => {
  it('describes it and proposes no writes at all', () => {
    const tasks = chainOfThree();
    tasks[0] = { ...tasks[0]!, predecessorTaskId: 'c' };

    const preview = planMove(tasks, {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });

    expect(preview.cycle).not.toBeNull();
    expect(preview.moves).toEqual([]);
    expect(preview.held).toEqual([]);
    expect(preview.finishAfter).toBe(preview.finishBefore);
    expect(describeMove(preview, iso)).toContain('wait on each other in a loop');
  });
});

/* -------------------------------------------------------------------------
   Branches, and the shape of a real job
   ------------------------------------------------------------------------- */

describe('planMove: branching', () => {
  it('pushes both branches that wait on the same task', () => {
    const tasks = chainOfThree();
    tasks.push(
      task({
        id: 'd',
        name: 'Electrical rough-in',
        plannedStart: '2026-03-07',
        plannedEnd: '2026-03-10',
        predecessorTaskId: 'a',
      }),
    );

    const preview = planMove(tasks, {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });

    expect(preview.moves.map((move) => move.name).sort()).toEqual([
      'Electrical rough-in',
      'Excavation',
      'Footings',
      'Framing',
    ]);
  });

  it('holds one branch and pushes the other', () => {
    const tasks = chainOfThree();
    tasks.push(
      task({
        id: 'd',
        name: 'Electrical rough-in',
        plannedStart: '2026-03-07',
        plannedEnd: '2026-03-10',
        predecessorTaskId: 'a',
        actualStart: '2026-03-07',
      }),
    );

    const preview = planMove(tasks, {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });

    expect(preview.moves.map((move) => move.name)).toEqual([
      'Excavation',
      'Footings',
      'Framing',
    ]);
    expect(preview.held.map((task) => task.name)).toEqual(['Electrical rough-in']);
  });
});

/* -------------------------------------------------------------------------
   The preview and the commit
   ------------------------------------------------------------------------- */

describe('the preview and the commit cannot disagree', () => {
  /** The write the action performs, done to the in-memory set instead. */
  function apply(tasks: readonly ScheduleTask[], preview: ReturnType<typeof planMove>) {
    const moveById = new Map(preview.moves.map((move) => [move.id, move]));
    const heldById = new Map(preview.held.map((held) => [held.id, held]));
    return tasks.map((task) => {
      const move = moveById.get(task.id);
      if (move) {
        return { ...task, plannedStart: move.toStart, plannedEnd: move.toEnd, lagDays: move.lagDays };
      }
      const held = heldById.get(task.id);
      return held ? { ...task, lagDays: held.lagDays } : task;
    });
  }

  it('names exactly the tasks whose stored dates then differ', () => {
    const before = chainOfThree();
    const preview = planMove(before, {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });
    const after = apply(before, preview);

    const changed = after
      .filter((task, index) => {
        const was = before[index]!;
        return task.plannedStart !== was.plannedStart || task.plannedEnd !== was.plannedEnd;
      })
      .map((task) => task.id)
      .sort();

    expect(changed).toEqual(preview.moves.map((move) => move.id).sort());
  });

  it('is idempotent: replaying the same move a second time moves nothing', () => {
    const before = chainOfThree();
    const first = planMove(before, {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });
    const after = apply(before, first);

    const second = planMove(after, {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });
    expect(second.moves).toEqual([]);
  });

  it('leaves every lag on the row agreeing with the dates on the row', () => {
    const before = chainOfThree();
    before[1] = { ...before[1]!, actualStart: '2026-03-07' };

    const after = apply(
      before,
      planMove(before, { taskId: 'a', plannedStart: '2026-03-05', plannedEnd: '2026-03-09' }),
    );

    const byId = new Map(after.map((task) => [task.id, task]));
    for (const task of after) {
      if (task.predecessorTaskId === null) continue;
      const predecessor = byId.get(task.predecessorTaskId)!;
      expect(task.lagDays).toBe(lagBetween(predecessor.plannedEnd, task.plannedStart));
    }
  });

  it('changes the fingerprint when anything the push reads changes', () => {
    const before = chainOfThree();
    const text = canonicalScheduleText(before);

    // Row order is not information: the same rows in another order fingerprint
    // the same, or every preview would expire on a query planner's whim.
    expect(canonicalScheduleText([...before].reverse())).toBe(text);

    for (const change of [
      { plannedStart: '2026-03-03' },
      { plannedEnd: '2026-03-07' },
      { actualStart: '2026-03-02' },
      { actualEnd: '2026-03-06' },
      { predecessorTaskId: 'c' },
      { lagDays: 4 },
      { name: 'Excavation and shoring' },
    ]) {
      const changed = [{ ...before[0]!, ...change }, ...before.slice(1)];
      expect(canonicalScheduleText(changed), JSON.stringify(change)).not.toBe(text);
    }
  });
});

/* -------------------------------------------------------------------------
   The sentence
   ------------------------------------------------------------------------- */

describe('describeMove', () => {
  it('names the task, the count and the new finish', () => {
    const preview = planMove(chainOfThree(), {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });

    expect(describeMove(preview, iso)).toBe(
      'Moving Excavation 3 days later moves 2 tasks after it: Footings, Framing.' +
        ' The job now finishes 2026-03-23 instead of 2026-03-20.',
    );
  });

  it('says so plainly when nothing else is affected', () => {
    const tasks = [task({ id: 's', name: 'Permit', plannedStart: '2026-03-11', plannedEnd: '2026-03-11' })];
    const preview = planMove(tasks, {
      taskId: 's',
      plannedStart: '2026-03-12',
      plannedEnd: '2026-03-12',
    });

    expect(describeMove(preview, iso)).toBe(
      'Moving Permit 1 day later moves nothing else. The job now finishes 2026-03-12 instead of 2026-03-11.',
    );
  });

  it('says what stayed behind, and why', () => {
    const tasks = chainOfThree();
    tasks[1] = { ...tasks[1]!, actualStart: '2026-03-07' };
    const preview = planMove(tasks, {
      taskId: 'a',
      plannedStart: '2026-03-05',
      plannedEnd: '2026-03-09',
    });

    const sentence = describeMove(preview, iso);
    expect(sentence).toContain('Footings has already started, so its plan stays where it is');
    expect(sentence).toContain('does Framing behind it');
    expect(sentence).toContain('The job still finishes 2026-03-20.');
  });

  it('uses the right verb when a task is only extended', () => {
    const preview = planMove(chainOfThree(), {
      taskId: 'a',
      plannedStart: '2026-03-02',
      plannedEnd: '2026-03-09',
    });
    expect(describeMove(preview, iso)).toContain('Extending Excavation by 3 days');
  });

  it('uses the right verb when a date is pulled earlier', () => {
    const preview = planMove(chainOfThree(), {
      taskId: 'a',
      plannedStart: '2026-02-26',
      plannedEnd: '2026-03-02',
    });
    expect(describeMove(preview, iso)).toContain('Moving Excavation 4 days earlier');
  });

  it('spells out the new span when the start and the finish move differently', () => {
    const preview = planMove(chainOfThree(), {
      taskId: 'a',
      plannedStart: '2026-03-04',
      plannedEnd: '2026-03-12',
    });
    expect(describeMove(preview, iso)).toContain(
      'Rescheduling Excavation to 2026-03-04 – 2026-03-12',
    );
  });
});
