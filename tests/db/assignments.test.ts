import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { db } from '@/db/client';
import { assignments, customers, projects, scheduleTasks, users, vendors } from '@/db/schema';

/**
 * What the database refuses about who is on a task.
 *
 * Schema-level proofs on purpose, and for this table more than most. The rules
 * here decide what a ROW MEANS -- exactly one assignee, a yes and a no that
 * cannot both be true, a live person on a task only once -- and every one of
 * them will be met by a writer that never went through the form: an import, a
 * calendar screen, the compliance pass in spec 5.3. A rule only the action
 * enforces is a rule that holds until the second writer arrives.
 *
 * The other half is the one nothing in the application can prove: that
 * retiring a vendor does not blank a schedule. That is a foreign key to a row
 * that is never deleted, and the test below retires and then voids a vendor
 * with a live assignment and reads it back.
 */

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, assignments, schedule_tasks, stage_history, projects,
      vendors, customers, users restart identity cascade
  `);
});

async function rejectionText(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the statement to be refused, but it succeeded');
}

async function seedTask(name = 'Framing', start = '2026-03-02', end = '2026-03-10') {
  const [customer] = await db
    .insert(customers)
    .values({ name: 'Sample Client', customerType: 'residential' })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      customerId: customer!.id,
      projectNumber: `P-${Math.floor(Math.random() * 100000)}`,
      name: 'Sample job',
      projectTypeId: PROJECT_TYPE_IDS.renovation,
    })
    .returning();
  const [task] = await db
    .insert(scheduleTasks)
    .values({ projectId: project!.id, name, plannedStart: start, plannedEnd: end })
    .returning();
  return task!;
}

async function seedSub(name = 'Sample Trade Works') {
  const [row] = await db
    .insert(vendors)
    .values({ name, isSubcontractor: true })
    .returning();
  return row!;
}

async function seedPerson(name = 'Sample Person', email = 'sample.person@example.test') {
  const [row] = await db
    .insert(users)
    .values({ email, displayName: name, role: 'admin' })
    .returning();
  return row!;
}

/* -------------------------------------------------------------------------
   Exactly one assignee
   ------------------------------------------------------------------------- */

describe('an assignment names exactly one person', () => {
  it('takes a subcontractor', async () => {
    const task = await seedTask();
    const sub = await seedSub();
    const [row] = await db
      .insert(assignments)
      .values({ scheduleTaskId: task.id, vendorId: sub.id })
      .returning();
    expect(row!.vendorId).toBe(sub.id);
    expect(row!.userId).toBeNull();
  });

  it('takes an internal person, which is how "me" is stored', async () => {
    // The owner is a row in `users`, not a word. Nothing about the assignment
    // he gives himself differs from one he gives an employee.
    const task = await seedTask();
    const person = await seedPerson();
    const [row] = await db
      .insert(assignments)
      .values({ scheduleTaskId: task.id, userId: person.id })
      .returning();
    expect(row!.userId).toBe(person.id);
    expect(row!.vendorId).toBeNull();
  });

  it('refuses a row that assigns nobody', async () => {
    const task = await seedTask();
    const text = await rejectionText(() =>
      db.insert(assignments).values({ scheduleTaskId: task.id }),
    );
    expect(text).toContain('assignments_one_assignee');
  });

  it('refuses a row that assigns two people at once', async () => {
    // The case a polymorphic pair could not have refused at all. Both set is a
    // row that means two things, and every join would double it.
    const task = await seedTask();
    const sub = await seedSub();
    const person = await seedPerson();
    const text = await rejectionText(() =>
      db.insert(assignments).values({ scheduleTaskId: task.id, vendorId: sub.id, userId: person.id }),
    );
    expect(text).toContain('assignments_one_assignee');
  });

  it('refuses an assignee that is not a row in either table', async () => {
    // What a real foreign key buys over an unchecked uuid: a value naming
    // nothing is refused at the write rather than discovered as a blank name on
    // a screen a year later.
    const task = await seedTask();
    const text = await rejectionText(() =>
      db
        .insert(assignments)
        .values({ scheduleTaskId: task.id, vendorId: '11111111-2222-4333-8444-555555555555' }),
    );
    expect(text).toContain('vendors_id_fk');
  });
});

/* -------------------------------------------------------------------------
   Yes and no
   ------------------------------------------------------------------------- */

describe('confirmed and declined are two dates, not one status', () => {
  it('lets both be absent, which is asked and heard nothing', async () => {
    const task = await seedTask();
    const sub = await seedSub();
    const [row] = await db
      .insert(assignments)
      .values({ scheduleTaskId: task.id, vendorId: sub.id })
      .returning();
    expect(row!.confirmedAt).toBeNull();
    expect(row!.declinedAt).toBeNull();
  });

  it('refuses a row that says yes and no at once', async () => {
    const task = await seedTask();
    const sub = await seedSub();
    const text = await rejectionText(() =>
      db.insert(assignments).values({
        scheduleTaskId: task.id,
        vendorId: sub.id,
        confirmedAt: new Date(),
        declinedAt: new Date(),
      }),
    );
    expect(text).toContain('assignments_not_confirmed_and_declined');
  });
});

/* -------------------------------------------------------------------------
   Money
   ------------------------------------------------------------------------- */

describe('the agreed amount', () => {
  it('stores integer cents, unrounded and unscaled', async () => {
    const task = await seedTask();
    const sub = await seedSub();
    const [row] = await db
      .insert(assignments)
      .values({ scheduleTaskId: task.id, vendorId: sub.id, agreedAmountCents: 496250 })
      .returning();
    expect(row!.agreedAmountCents).toBe(496250);
  });

  it('tells nothing agreed apart from agreed at zero', async () => {
    const task = await seedTask();
    const sub = await seedSub();
    const person = await seedPerson();
    const [nothing] = await db
      .insert(assignments)
      .values({ scheduleTaskId: task.id, vendorId: sub.id })
      .returning();
    const [zero] = await db
      .insert(assignments)
      .values({ scheduleTaskId: task.id, userId: person.id, agreedAmountCents: 0 })
      .returning();
    expect(nothing!.agreedAmountCents).toBeNull();
    expect(zero!.agreedAmountCents).toBe(0);
  });

  it('refuses a negative price', async () => {
    const task = await seedTask();
    const sub = await seedSub();
    const text = await rejectionText(() =>
      db
        .insert(assignments)
        .values({ scheduleTaskId: task.id, vendorId: sub.id, agreedAmountCents: -1 }),
    );
    expect(text).toContain('assignments_agreed_amount_not_negative');
  });
});

/* -------------------------------------------------------------------------
   One live assignment per person per task
   ------------------------------------------------------------------------- */

describe('the same person is not on one task twice', () => {
  it('refuses the second live row, so a read-then-insert race cannot land it', async () => {
    const task = await seedTask();
    const sub = await seedSub();
    await db.insert(assignments).values({ scheduleTaskId: task.id, vendorId: sub.id });
    const text = await rejectionText(() =>
      db.insert(assignments).values({ scheduleTaskId: task.id, vendorId: sub.id }),
    );
    expect(text).toContain('assignments_one_live_vendor_per_task');
  });

  it('lets them back on after they were taken off', async () => {
    // The index is partial on the live rows for exactly this: a sub taken off
    // in March and brought back in May is two assignments and one history, and
    // refusing the second would be the index enforcing a rule nobody has.
    const task = await seedTask();
    const sub = await seedSub();
    const [first] = await db
      .insert(assignments)
      .values({ scheduleTaskId: task.id, vendorId: sub.id })
      .returning();
    await db
      .update(assignments)
      .set({ removedAt: new Date(), removalReason: 'Pulled onto the other job' })
      .where(eq(assignments.id, first!.id));

    const [second] = await db
      .insert(assignments)
      .values({ scheduleTaskId: task.id, vendorId: sub.id })
      .returning();
    expect(second!.id).not.toBe(first!.id);

    const rows = await db.select().from(assignments).where(eq(assignments.scheduleTaskId, task.id));
    expect(rows).toHaveLength(2);
  });

  it('does not confuse a vendor with a person holding the same task', async () => {
    const task = await seedTask();
    const sub = await seedSub();
    const person = await seedPerson();
    await db.insert(assignments).values({ scheduleTaskId: task.id, vendorId: sub.id });
    await db.insert(assignments).values({ scheduleTaskId: task.id, userId: person.id });
    const rows = await db.select().from(assignments).where(eq(assignments.scheduleTaskId, task.id));
    expect(rows).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------
   Unassigning is not deleting
   ------------------------------------------------------------------------- */

describe('taking somebody off a task', () => {
  it('cannot be a delete, because the role holds no DELETE privilege', async () => {
    // Stated here rather than assumed. The whole shape of `removed_at` follows
    // from the fact that there is nowhere for a row to go.
    const [row] = await db.execute(sql`
      select has_table_privilege('quote_app', 'assignments', 'DELETE') as may_delete
    `);
    expect((row as { may_delete: boolean }).may_delete).toBe(false);
  });

  it('keeps the row, the date and the reason', async () => {
    const task = await seedTask();
    const sub = await seedSub();
    const [row] = await db
      .insert(assignments)
      .values({ scheduleTaskId: task.id, vendorId: sub.id, declinedAt: new Date() })
      .returning();

    await db
      .update(assignments)
      .set({ removedAt: new Date(), removalReason: 'Priced too high' })
      .where(eq(assignments.id, row!.id));

    const [after] = await db.select().from(assignments).where(eq(assignments.id, row!.id));
    // The declining is still there. Voiding the row instead would have
    // destroyed the only evidence the owner ever asked.
    expect(after!.declinedAt).not.toBeNull();
    expect(after!.removalReason).toBe('Priced too high');
    expect(after!.recordStatus).toBe('active');
  });

  it('refuses a reason with no removal behind it', async () => {
    const task = await seedTask();
    const sub = await seedSub();
    const text = await rejectionText(() =>
      db
        .insert(assignments)
        .values({ scheduleTaskId: task.id, vendorId: sub.id, removalReason: 'Priced too high' }),
    );
    expect(text).toContain('assignments_removal_detail_needs_removal');
  });
});

/* -------------------------------------------------------------------------
   A retired vendor still reads
   ------------------------------------------------------------------------- */

describe('retiring a vendor', () => {
  it('does not blank an assignment already recorded against them', async () => {
    // The requirement the foreign key exists for. Retiring means "do not offer
    // this on new work"; it is not a statement about work already planned.
    const task = await seedTask();
    const sub = await seedSub();
    await db.insert(assignments).values({ scheduleTaskId: task.id, vendorId: sub.id });

    await db.update(vendors).set({ isActive: false }).where(eq(vendors.id, sub.id));

    const [row] = await db
      .select({ name: vendors.name, isActive: vendors.isActive })
      .from(assignments)
      .leftJoin(vendors, eq(vendors.id, assignments.vendorId))
      .where(eq(assignments.scheduleTaskId, task.id));
    expect(row!.name).toBe('Sample Trade Works');
    expect(row!.isActive).toBe(false);
  });

  it('goes on reading even when the vendor row is voided', async () => {
    const task = await seedTask();
    const sub = await seedSub();
    await db.insert(assignments).values({ scheduleTaskId: task.id, vendorId: sub.id });

    await db
      .update(vendors)
      .set({ recordStatus: 'void', voidedAt: new Date(), voidReason: 'Duplicate row' })
      .where(eq(vendors.id, sub.id));

    const [row] = await db
      .select({ name: vendors.name, status: vendors.recordStatus })
      .from(assignments)
      .leftJoin(vendors, eq(vendors.id, assignments.vendorId))
      .where(eq(assignments.scheduleTaskId, task.id));
    expect(row!.name).toBe('Sample Trade Works');
    expect(row!.status).toBe('void');
  });
});

/* -------------------------------------------------------------------------
   updated_at
   ------------------------------------------------------------------------- */

describe('updated_at', () => {
  it('is advanced by the trigger, not by the application', async () => {
    // A mirrored table without this trigger updates without moving the
    // SharePoint sync cursor, and stops mirroring after its first change.
    const task = await seedTask();
    const sub = await seedSub();
    const [row] = await db
      .insert(assignments)
      .values({ scheduleTaskId: task.id, vendorId: sub.id })
      .returning();
    const before = row!.updatedAt.getTime();

    await db.execute(sql`select pg_sleep(0.01)`);
    await db
      .update(assignments)
      // A stale value passed by hand, which the trigger must overwrite rather
      // than defer to: a client clock that is behind would otherwise park the
      // row permanently before the cursor.
      .set({ notes: 'Bringing his own compactor', updatedAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(assignments.id, row!.id));

    const [after] = await db.select().from(assignments).where(eq(assignments.id, row!.id));
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before);
  });
});
