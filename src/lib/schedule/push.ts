import {
  daysBetween,
  lagBetween,
  latestDate,
  shiftDays,
} from '@/lib/schedule/calendar';

/**
 * The auto-push: when one task's dates move, what else has to move.
 *
 * Pure. Tasks and an edit in, a description of the consequence out. It never
 * reads the clock, never touches the database, and never writes anything --
 * for the reason `lib/reminders/rules.ts` is written the same way: every
 * interesting case here is a boundary (a zero-day move, a chain that stops at
 * a task already underway, a date pulled backwards), and a function that
 * reaches for the world cannot be tested at one.
 *
 * The four rules this has to get right, from the plan's "Auto-push: the part
 * with real thinking in it". Each is load-bearing and each is easy to get
 * subtly wrong:
 *
 * **1. A standalone task is NEVER moved, even mid-chain.** Propagation follows
 * `predecessorTaskId` edges and nothing else. If A is followed by B, and C
 * happens to sit between them by date with no predecessor of its own, C stays
 * exactly where it is. That is the entire point of the owner's opt-in --
 * *"if it is auto push, if not they would stay standalone"* -- and "helpfully"
 * shifting C because it looks like it is in the way is the temptation this
 * function exists to refuse.
 *
 * **2. Planned dates move; actual dates never do.** More than that: a task
 * whose actual start or end is recorded is HELD out of the push, and the chain
 * below it stops there. Shifting the plan under a task that has already begun
 * silently rewrites the slippage measured against it, and that measurement is
 * the only evidence of how the estimates perform -- which spec 5.2 says is the
 * data that makes the next quote better. A held task is named in the preview,
 * along with what stayed behind it, so the contradiction is visible instead of
 * resolved by guesswork.
 *
 * **3. A cycle is refused, not survived.** `findPredecessorCycle` is what the
 * writers call before they write. This function still carries a visited set,
 * because a cycle that reached the table through some other door would
 * otherwise make the walk below run forever, and the honest response to
 * finding one is to describe it and write nothing.
 *
 * **4. The owner is told what will move, before it moves.** That is the whole
 * reason this returns a `MovePreview` rather than a list of updates. The
 * action shows it, he confirms, and the action then recomputes it from a fresh
 * read inside the writing transaction and refuses if the schedule changed
 * underneath -- so what the screen said and what the database did cannot
 * disagree.
 *
 * **Which delta travels down the chain.** A successor waits on its
 * predecessor's FINISH, so the delta that propagates is the change in
 * `planned_end`, not in `planned_start`. Extending a task by two days without
 * moving its start still pushes everything after it by two days, which is what
 * anybody would expect and what a start-based delta would get wrong.
 *
 * **Why the delta and not a recomputed date.** A successor shifts by the same
 * number of days its predecessor's finish shifted -- it is not re-derived as
 * "predecessor end plus lag". The two agree on a tight schedule and disagree
 * when there is slack, and when they disagree the delta is right: slack a
 * person deliberately left between two trades is a decision, and recomputing
 * would quietly delete it every time anything upstream twitched.
 */

/** The columns the push reads. Nothing else about a task is its business. */
export interface ScheduleTask {
  id: string;
  name: string;
  plannedStart: string;
  plannedEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  predecessorTaskId: string | null;
  lagDays: number;
}

export interface TaskMove {
  id: string;
  name: string;
  fromStart: string;
  fromEnd: string;
  toStart: string;
  toEnd: string;
  /** Days the planned start moves. Negative pulls it earlier. */
  startDelta: number;
  /** Days the planned finish moves -- the delta everything after it inherits. */
  endDelta: number;
  /**
   * The gap to whatever this task waits on, after the move. Zero on a task
   * with no predecessor. Derived rather than carried, because the dates are
   * what changed and the lag is a reading of them.
   */
  lagDays: number;
  /** `edited` is the task the owner changed; `pushed` is a consequence. */
  cause: 'edited' | 'pushed';
}

export interface HeldTask {
  id: string;
  name: string;
  /**
   * The only reason a dependent task is held today: it has already started, so
   * its plan is now a record rather than an intention.
   */
  reason: 'already-started';
  /** The gap to its predecessor, restated because the predecessor moved and this did not. */
  lagDays: number;
  /** What stays put behind it, because what THEY wait on did not move either. */
  downstreamNames: string[];
}

export interface MovePreview {
  /** Every task whose planned dates change, the edited one first. */
  moves: TaskMove[];
  /** Dependents that did not move, and what stayed behind them. */
  held: HeldTask[];
  finishBefore: string | null;
  finishAfter: string | null;
  /**
   * Names around a loop, when the stored rows already hold one. Non-null means
   * nothing may be written: the schedule has to be repaired first.
   */
  cycle: string[] | null;
}

export interface MoveRequest {
  taskId: string;
  plannedStart: string;
  plannedEnd: string;
}

/* -------------------------------------------------------------------------
   Cycles
   ------------------------------------------------------------------------- */

/**
 * The names around the loop that pointing `taskId` at `predecessorId` would
 * close, or null when it closes none.
 *
 * Walks up from the proposed predecessor through `predecessorTaskId` until it
 * runs out of chain, meets the task itself, or meets a node twice. The first
 * is fine; the second is the cycle being proposed; the third is a cycle
 * already in the data, which is refused just as hard because a push through it
 * would not terminate.
 *
 * The returned list reads in dependency order -- the proposed predecessor
 * first, the task that would close the loop last -- so a caller can print it
 * as the sentence somebody has to act on rather than an id nobody can look up.
 *
 * Called INSIDE the writing transaction, never from the screen. A stale tab
 * can create the other half of a loop between a read and a write, and a check
 * that ran when the form was rendered would have been true at the time and
 * wrong by the time it mattered.
 */
export function findPredecessorCycle(
  tasks: readonly Pick<ScheduleTask, 'id' | 'name' | 'predecessorTaskId'>[],
  taskId: string,
  predecessorId: string | null,
): string[] | null {
  if (predecessorId === null) return null;

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = predecessorId;

  while (cursor !== null) {
    const node = byId.get(cursor);
    // Not a task in this set. The foreign key and the same-project check refuse
    // it; guessing here would be a second opinion on somebody else's question.
    if (!node) return null;

    chain.push(node.name);
    if (cursor === taskId) return chain;
    if (seen.has(cursor)) return chain;
    seen.add(cursor);

    cursor = node.predecessorTaskId;
  }

  return null;
}

/* -------------------------------------------------------------------------
   The push
   ------------------------------------------------------------------------- */

function successorsOf(tasks: readonly ScheduleTask[]): Map<string, ScheduleTask[]> {
  const map = new Map<string, ScheduleTask[]>();
  for (const task of tasks) {
    if (task.predecessorTaskId === null) continue;
    const list = map.get(task.predecessorTaskId);
    if (list) list.push(task);
    else map.set(task.predecessorTaskId, [task]);
  }
  return map;
}

/** Everything downstream of a task, by name, in the order the chain runs. */
function downstreamNames(
  successors: Map<string, ScheduleTask[]>,
  from: ScheduleTask,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>([from.id]);
  const queue = [...(successors.get(from.id) ?? [])];

  while (queue.length > 0) {
    const task = queue.shift()!;
    // The same guard the push carries, for the same reason: a loop in the data
    // must not turn a description into an infinite one.
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    names.push(task.name);
    queue.push(...(successors.get(task.id) ?? []));
  }

  return names;
}

/**
 * What moving one task's planned dates would do to the rest of the job.
 *
 * `tasks` is every live task on the project -- the whole set, because the
 * finish date is the latest planned end across all of them and a preview that
 * only looked at the chain could not say whether the job's end changed.
 *
 * Throws only when `taskId` is not in the set, which is a caller bug rather
 * than a person's mistake: the actions read the row before they ask.
 */
export function planMove(tasks: readonly ScheduleTask[], request: MoveRequest): MovePreview {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const root = byId.get(request.taskId);
  if (!root) throw new Error(`no schedule task ${request.taskId} in the set given`);

  const successors = successorsOf(tasks);
  const moves: TaskMove[] = [];
  const held: HeldTask[] = [];
  const newEnd = new Map<string, string>();
  let cycle: string[] | null = null;

  const startDelta = daysBetween(root.plannedStart, request.plannedStart);
  const endDelta = daysBetween(root.plannedEnd, request.plannedEnd);

  if (startDelta !== 0 || endDelta !== 0) {
    // The edited task's own gap is re-read off its new start. Its predecessor
    // is upstream and does not move -- a push travels one way, because "what
    // will this delay push out" is a question about what comes after.
    const predecessor = root.predecessorTaskId ? byId.get(root.predecessorTaskId) : undefined;
    moves.push({
      id: root.id,
      name: root.name,
      fromStart: root.plannedStart,
      fromEnd: root.plannedEnd,
      toStart: request.plannedStart,
      toEnd: request.plannedEnd,
      startDelta,
      endDelta,
      lagDays: predecessor ? lagBetween(predecessor.plannedEnd, request.plannedStart) : 0,
      cause: 'edited',
    });
    newEnd.set(root.id, request.plannedEnd);
  }

  // A finish that did not move pushes nothing, whatever happened to the start.
  // A successor waits on a finish; it has no opinion about when the work began.
  if (endDelta !== 0) {
    const visited = new Set<string>([root.id]);
    const queue: { task: ScheduleTask; delta: number }[] = (successors.get(root.id) ?? []).map(
      (task) => ({ task, delta: endDelta }),
    );

    while (queue.length > 0) {
      const { task, delta } = queue.shift()!;

      if (visited.has(task.id)) {
        // Only reachable if the stored rows already hold a loop, which the
        // writers refuse. Describing it and writing nothing is the only safe
        // answer; walking it is the bug this guard exists for.
        cycle = findPredecessorCycle(tasks, task.id, task.predecessorTaskId) ?? [task.name];
        break;
      }
      visited.add(task.id);

      if (task.actualStart !== null || task.actualEnd !== null) {
        // Rule 2. Its plan is now the record of what was planned, and the
        // chain below it stops because what THOSE tasks wait on did not move.
        // The predecessor always moved -- that is the only way this queue was
        // reached -- so the first branch is the live one. The fallback is the
        // unmoved end, so a future caller cannot get a lag read off nothing.
        const predecessorId = task.predecessorTaskId!;
        const predecessorEnd =
          newEnd.get(predecessorId) ?? byId.get(predecessorId)?.plannedEnd ?? task.plannedStart;
        held.push({
          id: task.id,
          name: task.name,
          reason: 'already-started',
          lagDays: lagBetween(predecessorEnd, task.plannedStart),
          downstreamNames: downstreamNames(successors, task),
        });
        continue;
      }

      const toStart = shiftDays(task.plannedStart, delta);
      const toEnd = shiftDays(task.plannedEnd, delta);
      moves.push({
        id: task.id,
        name: task.name,
        fromStart: task.plannedStart,
        fromEnd: task.plannedEnd,
        toStart,
        toEnd,
        startDelta: delta,
        endDelta: delta,
        // Unchanged, and that is the point of shifting by a delta: this task
        // and the one it waits on moved the same distance, so the gap between
        // them is exactly what it was.
        lagDays: task.lagDays,
        cause: 'pushed',
      });
      newEnd.set(task.id, toEnd);

      for (const next of successors.get(task.id) ?? []) queue.push({ task: next, delta });
    }
  }

  const finishBefore = latestDate(tasks.map((task) => task.plannedEnd));
  const finishAfter = latestDate(
    tasks.map((task) => newEnd.get(task.id) ?? task.plannedEnd),
  );

  return {
    moves: cycle === null ? moves : [],
    held: cycle === null ? held : [],
    finishBefore,
    finishAfter: cycle === null ? finishAfter : finishBefore,
    cycle,
  };
}

/* -------------------------------------------------------------------------
   Proving the preview and the commit agree
   ------------------------------------------------------------------------- */

/**
 * Every input `planMove` reads, as one string, in an order that does not
 * depend on how the rows came back from the database.
 *
 * The preview the owner reads is computed from one snapshot; the write happens
 * against another, a few seconds later, inside a transaction. If anything the
 * push depends on changed in between, the second computation could name a
 * different set of tasks than the sentence he agreed to -- and a preview that
 * disagrees with the commit is worse than no preview at all, because he has
 * stopped checking.
 *
 * So the preview carries a fingerprint of this text, and the commit recomputes
 * it inside the writing transaction. Equal means the recomputed preview is the
 * one he read, by construction. Not equal means the schedule moved underneath
 * him and he is shown the new consequence instead of having the old one
 * applied.
 *
 * `name` is included even though the push does not branch on it: it is what
 * the sentence he agreed to was written in, and a task renamed in another tab
 * makes that sentence describe rows by names nobody would recognise.
 */
export function canonicalScheduleText(tasks: readonly ScheduleTask[]): string {
  return [...tasks]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((task) =>
      [
        task.id,
        task.name,
        task.plannedStart,
        task.plannedEnd,
        task.actualStart ?? '',
        task.actualEnd ?? '',
        task.predecessorTaskId ?? '',
        String(task.lagDays),
      ].join('|'),
    )
    .join('\n');
}

/* -------------------------------------------------------------------------
   Saying it in a sentence
   ------------------------------------------------------------------------- */

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function days(n: number): string {
  const size = Math.abs(n);
  return `${size} ${size === 1 ? 'day' : 'days'}`;
}

/**
 * The sentence the owner reads before anything is written.
 *
 * The plan calls this the single most important interaction in the feature: *a
 * drag that silently shifts nine tasks is how somebody loses a schedule they
 * spent an evening building.* So it names the task, says how many others go
 * with it, says what stayed and why, and finishes with the one number the job
 * is actually judged on.
 *
 * `formatDay` is injected rather than imported so this stays pure and
 * testable: the tenant's locale lives on the organization row, and a function
 * that read it would need a database to be tested at a boundary.
 */
export function describeMove(preview: MovePreview, formatDay: (iso: string) => string): string {
  if (preview.cycle) {
    return `These tasks wait on each other in a loop — ${preview.cycle.join(' → ')} — so nothing can be moved until one of those links is removed.`;
  }

  const edited = preview.moves.find((move) => move.cause === 'edited');
  if (!edited) return 'Those are the dates it already has, so nothing moves.';

  const pushed = preview.moves.filter((move) => move.cause === 'pushed');
  const parts: string[] = [];

  if (edited.startDelta === edited.endDelta) {
    parts.push(
      `Moving ${edited.name} ${days(edited.startDelta)} ${edited.startDelta > 0 ? 'later' : 'earlier'}`,
    );
  } else if (edited.startDelta === 0) {
    parts.push(
      `${edited.endDelta > 0 ? 'Extending' : 'Shortening'} ${edited.name} by ${days(edited.endDelta)}`,
    );
  } else {
    parts.push(
      `Rescheduling ${edited.name} to ${formatDay(edited.toStart)} – ${formatDay(edited.toEnd)}`,
    );
  }

  parts.push(
    pushed.length === 0
      ? 'moves nothing else.'
      : `moves ${count(pushed.length, 'task', 'tasks')} after it: ${pushed
          .map((move) => move.name)
          .join(', ')}.`,
  );

  let sentence = parts.join(' ');

  for (const task of preview.held) {
    // Named individually rather than counted. A task that has started is a
    // fact somebody has to reconcile by hand, and burying it in a number is
    // how it gets missed.
    sentence += ` ${task.name} has already started, so its plan stays where it is${
      task.downstreamNames.length > 0
        ? `, and so ${
            task.downstreamNames.length === 1 ? 'does' : 'do'
          } ${task.downstreamNames.join(', ')} behind it`
        : ''
    }.`;
  }

  if (preview.finishAfter && preview.finishBefore && preview.finishAfter !== preview.finishBefore) {
    sentence += ` The job now finishes ${formatDay(preview.finishAfter)} instead of ${formatDay(preview.finishBefore)}.`;
  } else if (preview.finishAfter) {
    sentence += ` The job still finishes ${formatDay(preview.finishAfter)}.`;
  }

  return sentence;
}
