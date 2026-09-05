import { asc } from 'drizzle-orm';
import type { db } from '@/db/client';
import { users, vendors } from '@/db/schema';
import { assigneeKey } from '@/app/projects/[id]/schedule/clashes';
import type { Assignee } from '@/app/projects/[id]/schedule/schema';

/**
 * WHAT TO CALL THE PERSON ON A TASK — the one seam, on this side.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * A third kind of assignee is arriving. `assignments` holds `vendor_id` and
 * `user_id` today with a CHECK that exactly one is set, and a `crew_id` is
 * being added for the employees who are scheduled by name and never sign in.
 * The instruction to this screen was to resolve a name through ONE helper so
 * that third kind lands without a sweep.
 *
 * The helper named for the job -- `resolveAssignee` -- turned out to be a
 * PRIVATE function in `src/app/projects/[id]/schedule/actions.ts`, not an
 * export of `WhoSheet.tsx`, and it is the wrong shape for a read screen twice
 * over: it runs a `select` per assignee inside a writing transaction, and what
 * it returns is a REFUSAL SENTENCE ("that vendor is retired, bring them back
 * on the vendor list first") for the moment somebody is put on a task. A
 * calendar drawing thirty days would run one query per name to be told why
 * somebody could not be assigned to work they are already assigned to.
 *
 * The read-side answer it should have been is `assigneeName`, and that is a
 * closure inside `page.tsx` with no export to import.
 *
 * So this file is the seam rather than a second opinion. It is the ONLY place
 * in the calendar that knows a vendor from a user, it is two queries against
 * tables holding tens of rows, and nothing downstream of it branches on the
 * KIND of assignee -- the day cells, the clash arithmetic and the sheet all
 * hold `Assignee` and a string. When `crew` lands, one select is added here,
 * `Assignee` widens by one member, and no other file in this feature changes.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WHOLE ROSTER RATHER THAN THE ONES ON SCREEN
 * ---------------------------------------------------------------------------
 *
 * `findEngagements` -- the shared answer to "where else is this person booked"
 * -- narrows by PERSON, because the job screen knows who is on its own tasks
 * before it asks. A calendar does not: the question is "everybody, this week",
 * and there is no assignee list to hand it without first running the query it
 * would then be handed back.
 *
 * So the roster IS the person list. Every vendor and every user, which for one
 * contractor is tens of rows and two indexed scans of small tables, handed
 * straight to `findEngagements`. The alternative -- a fourth query to discover
 * which assignees appear in the window, in order to ask a question about those
 * assignees -- is the same rows read twice.
 *
 * ---------------------------------------------------------------------------
 * WHY RETIRED AND VOIDED ROWS ARE STILL READ
 * ---------------------------------------------------------------------------
 *
 * Neither select filters on `is_active` or `record_status`, and that is the
 * same rule the job screen's assignment join is written for: retiring a sub
 * must not blank a schedule he is already on. What retirement changes is that
 * the PICKER stops offering him, which is a different query. What the reader
 * gets instead is the standing printed beside the name, because "Sample Trade
 * Works" with nothing next to it says he is available when he is not.
 */

/** Whatever can run a select: the request's `db`, or a transaction. */
type Reader = Pick<typeof db, 'select'>;

export interface Roster {
  /**
   * Everybody who could hold an assignment, for `findEngagements`.
   *
   * The `crew` seam: when that table lands, its rows join this array and every
   * caller picks them up without knowing it happened.
   */
  everyone: Assignee[];
  /** `vendor:<id>` / `user:<id>` to the name and standing the screen prints. */
  names: Map<string, string>;
}

/**
 * The name a calendar chip carries, standing included.
 *
 * The suffixes are the job schedule's own wording, kept identical on purpose:
 * two screens calling the same retired subcontractor two different things is
 * how somebody rings a number that no longer answers.
 */
export async function readRoster(reader: Reader, viewerId: string | null): Promise<Roster> {
  const [vendorRows, userRows] = await Promise.all([
    reader
      .select({
        id: vendors.id,
        name: vendors.name,
        isActive: vendors.isActive,
        recordStatus: vendors.recordStatus,
      })
      .from(vendors)
      .orderBy(asc(vendors.name)),
    reader
      .select({ id: users.id, name: users.displayName, isActive: users.isActive })
      .from(users)
      .orderBy(asc(users.displayName)),
  ]);

  const everyone: Assignee[] = [];
  const names = new Map<string, string>();

  for (const row of vendorRows) {
    const assignee: Assignee = { kind: 'vendor', id: row.id };
    everyone.push(assignee);
    names.set(
      assigneeKey(assignee),
      row.recordStatus === 'void'
        ? `${row.name} (voided vendor)`
        : row.isActive === false
          ? `${row.name} (retired)`
          : row.name,
    );
  }

  for (const row of userRows) {
    const assignee: Assignee = { kind: 'user', id: row.id };
    everyone.push(assignee);
    names.set(
      assigneeKey(assignee),
      // "Me" is not a magic string anywhere in this product: it is the
      // signed-in person's own `users` row, compared to the actor the request
      // already looked up. See the note on `assignments.user_id`.
      row.id === viewerId
        ? `${row.name} (you)`
        : row.isActive === false
          ? `${row.name} (deactivated)`
          : row.name,
    );
  }

  return { everyone, names };
}

/**
 * A name for an assignee the roster may not know.
 *
 * The fallback is not decoration either. Until `crew` rows are added to
 * `readRoster` above, an assignment against one would resolve to nothing, and
 * a blank where a person's name belongs reads as a bug rather than as a gap.
 * This says which it is, once, in the one place that would have to change.
 */
export function nameOf(roster: Roster, assignee: Assignee): string {
  return roster.names.get(assigneeKey(assignee)) ?? 'Somebody this screen cannot name yet';
}
