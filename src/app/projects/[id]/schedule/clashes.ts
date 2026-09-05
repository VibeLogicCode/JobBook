import { and, asc, eq, gte, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { db } from '@/db/client';
import { assignments, projects, scheduleTasks } from '@/db/schema';
import type { Assignee, Clash, Span } from '@/app/projects/[id]/schedule/schema';

/**
 * Where else these people are already booked.
 *
 * ONE query for the whole screen rather than one per row. The schedule renders
 * tens of tasks and a handful of people, and a per-assignment lookup would be a
 * cross-job query per row -- the shape that is invisible in development against
 * four tasks and unusable against a year of them.
 *
 * The pairing is left to `spansOverlap`, which is pure and tested. This file
 * only narrows the read: the people on this screen, inside the window this
 * screen covers, on tasks and jobs that are still live.
 *
 * Deliberately NOT restricted to other PROJECTS. The same sub on two
 * overlapping tasks of one job is a double-booking too -- the owner can see
 * both rows here, which is the only reason it is the less dangerous half, not a
 * reason to leave it out of the count.
 */

/** Whatever can run a select: the request's `db`, or a transaction inside an action. */
type Reader = Pick<typeof db, 'select'>;

export interface Engagement {
  assignee: Assignee;
  taskId: string;
  taskName: string;
  projectId: string;
  projectNumber: string;
  projectName: string;
  span: Span;
}

/** The key an engagement is grouped under. Written once so the two sides agree. */
export function assigneeKey(assignee: Assignee): string {
  return `${assignee.kind}:${assignee.id}`;
}

/**
 * Every live assignment these people hold whose task touches `window`.
 *
 * `window` is the stretch the caller cares about: the whole job's span for the
 * screen, one task's span for an action. Without it this is a read of every
 * assignment a busy subcontractor has ever had.
 */
export async function findEngagements(
  reader: Reader,
  assignees: readonly Assignee[],
  window: Span,
): Promise<Engagement[]> {
  const vendorIds = assignees.filter((a) => a.kind === 'vendor').map((a) => a.id);
  const userIds = assignees.filter((a) => a.kind === 'user').map((a) => a.id);
  if (vendorIds.length === 0 && userIds.length === 0) return [];

  const who = [
    vendorIds.length > 0 ? inArray(assignments.vendorId, vendorIds) : undefined,
    userIds.length > 0 ? inArray(assignments.userId, userIds) : undefined,
  ].filter((clause) => clause !== undefined);

  const rows = await reader
    .select({
      vendorId: assignments.vendorId,
      userId: assignments.userId,
      taskId: scheduleTasks.id,
      taskName: scheduleTasks.name,
      plannedStart: scheduleTasks.plannedStart,
      plannedEnd: scheduleTasks.plannedEnd,
      projectId: projects.id,
      projectNumber: projects.projectNumber,
      projectName: projects.name,
    })
    .from(assignments)
    .innerJoin(scheduleTasks, eq(scheduleTasks.id, assignments.scheduleTaskId))
    .innerJoin(projects, eq(projects.id, scheduleTasks.projectId))
    .where(
      and(
        or(...who),
        // A removed assignment is not a booking, and neither is a voided one.
        isNull(assignments.removedAt),
        ne(assignments.recordStatus, 'void'),
        // A voided task is off the schedule, and a voided job's schedule is a
        // record rather than a plan. Neither can double-book anybody.
        ne(scheduleTasks.recordStatus, 'void'),
        ne(projects.recordStatus, 'void'),
        // Both ends inclusive, matching `spansOverlap`. The index on
        // vendor_id / user_id is what keeps this off a full scan.
        lte(scheduleTasks.plannedStart, window.end),
        gte(scheduleTasks.plannedEnd, window.start),
      ),
    )
    .orderBy(asc(scheduleTasks.plannedStart), asc(scheduleTasks.name));

  return rows.map((row) => ({
    assignee:
      row.vendorId !== null
        ? ({ kind: 'vendor', id: row.vendorId } as const)
        : ({ kind: 'user', id: row.userId! } as const),
    taskId: row.taskId,
    taskName: row.taskName,
    projectId: row.projectId,
    projectNumber: row.projectNumber,
    projectName: row.projectName,
    span: { start: row.plannedStart, end: row.plannedEnd },
  }));
}

/** The engagements that are not this task, grouped by who holds them. */
export function groupEngagements(engagements: readonly Engagement[]): Map<string, Engagement[]> {
  const byAssignee = new Map<string, Engagement[]>();
  for (const engagement of engagements) {
    const key = assigneeKey(engagement.assignee);
    const list = byAssignee.get(key);
    if (list) list.push(engagement);
    else byAssignee.set(key, [engagement]);
  }
  return byAssignee;
}

/** An engagement as the clash sentence and the pill read it. */
export function toClash(engagement: Engagement, days: number): Clash {
  return {
    taskName: engagement.taskName,
    projectId: engagement.projectId,
    projectNumber: engagement.projectNumber,
    projectName: engagement.projectName,
    span: engagement.span,
    days,
  };
}
