import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { db } from '@/db/client';
import { auditLog, customers, projects, stageHistory } from '@/db/schema';

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, stage_history, projects, customers restart identity cascade
  `);
});

/**
 * Drizzle wraps a driver error as `Failed query: ...` and hangs the real
 * PostgresError off `cause`, so asserting on the top-level message alone would
 * pass for any failure at all -- including a typo in the SQL.
 */
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

async function seedCustomer(name = 'Eleanor Vance') {
  const [row] = await db
    .insert(customers)
    .values({ name, customerType: 'residential' })
    .returning();
  return row!;
}

describe('updated_at trigger', () => {
  it('advances updated_at on every update without the application setting it', async () => {
    const row = await seedCustomer();
    const before = row.updatedAt.getTime();

    await db.execute(sql`select pg_sleep(0.01)`);
    await db.update(customers).set({ name: 'Eleanor V.' }).where(eq(customers.id, row.id));

    const [after] = await db.select().from(customers).where(eq(customers.id, row.id));
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before);
  });

  it('advances it even when the caller passes a stale value', async () => {
    // The trigger overwrites rather than defaults. A client clock that is
    // behind would otherwise park a row permanently before the sync cursor.
    const row = await seedCustomer();
    await db.execute(sql`select pg_sleep(0.01)`);
    await db
      .update(customers)
      .set({ name: 'Eleanor V.', updatedAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(customers.id, row.id));

    const [after] = await db.select().from(customers).where(eq(customers.id, row.id));
    expect(after!.updatedAt.getFullYear()).toBeGreaterThan(2020);
  });

  it('covers every mirrored table, read from the catalog', async () => {
    // A hardcoded trigger list drifts as tables are added, and the table it
    // forgets is the one that stops syncing.
    const missing = await db.execute(sql`
      select c.table_name
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.column_name = 'updated_at'
        and c.table_name not in ('settings', 'document_sequences')
        and not exists (
          select 1 from pg_trigger tg
          join pg_class cl on cl.oid = tg.tgrelid
          where cl.relname = c.table_name and tg.tgname = 'touch_' || c.table_name
        )
    `);
    expect(missing).toEqual([]);
  });
});

describe('stage history trigger', () => {
  async function seedProject(stage: 'lead' | 'quoting' = 'lead') {
    const customer = await seedCustomer();
    const [project] = await db
      .insert(projects)
      .values({
        customerId: customer.id,
        projectNumber: 'P-0001',
        name: 'Basement finish',
        projectTypeId: PROJECT_TYPE_IDS.basement,
        stage,
      })
      .returning();
    return project!;
  }

  it('records the opening stage on insert', async () => {
    const project = await seedProject('lead');
    const rows = await db.select().from(stageHistory).where(eq(stageHistory.projectId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fromStage).toBeNull();
    expect(rows[0]?.toStage).toBe('lead');
  });

  it('records a transition with both ends', async () => {
    const project = await seedProject('lead');
    await db.update(projects).set({ stage: 'site_visit' }).where(eq(projects.id, project.id));
    const rows = await db
      .select()
      .from(stageHistory)
      .where(and(eq(stageHistory.projectId, project.id), eq(stageHistory.toStage, 'site_visit')));
    expect(rows[0]?.fromStage).toBe('lead');
  });

  it('does not record an update that leaves the stage alone', async () => {
    const project = await seedProject('lead');
    await db.update(projects).set({ notes: 'called back' }).where(eq(projects.id, project.id));
    const rows = await db.select().from(stageHistory).where(eq(stageHistory.projectId, project.id));
    expect(rows).toHaveLength(1);
  });
});

describe('audit log trigger', () => {
  it('records an insert', async () => {
    const row = await seedCustomer();
    const entries = await db.select().from(auditLog).where(eq(auditLog.recordId, row.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('insert');
  });

  it('records only the fields that changed', async () => {
    const row = await seedCustomer();
    await db.update(customers).set({ phone: '555-0100' }).where(eq(customers.id, row.id));
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.recordId, row.id), eq(auditLog.action, 'update')));
    expect(Object.keys(entry?.diff as object)).toEqual(['phone']);
    expect((entry?.diff as Record<string, { to: string }>).phone.to).toBe('555-0100');
  });

  it('ignores a write that changes nothing but updated_at', async () => {
    const row = await seedCustomer();
    await db.update(customers).set({ name: 'Eleanor Vance' }).where(eq(customers.id, row.id));
    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.recordId, row.id), eq(auditLog.action, 'update')));
    expect(entries).toEqual([]);
  });

  it('distinguishes a void from an ordinary update', async () => {
    const row = await seedCustomer();
    await db
      .update(customers)
      .set({ recordStatus: 'void', voidReason: 'Duplicate record' })
      .where(eq(customers.id, row.id));
    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.recordId, row.id), eq(auditLog.action, 'void')));
    expect(entries).toHaveLength(1);
  });

  it('attributes a change to the session actor when one is set', async () => {
    const row = await seedCustomer();
    const actor = '11111111-1111-1111-1111-111111111111';
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${actor}, true)`);
      await tx.update(customers).set({ city: 'Hamilton' }).where(eq(customers.id, row.id));
    });
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.recordId, row.id), eq(auditLog.action, 'update')));
    expect(entry?.changedBy).toBe(actor);
  });
});

describe('no-delete grant', () => {
  it('refuses a DELETE issued as the application role', async () => {
    const row = await seedCustomer();

    // SET LOCAL is scoped to a transaction. Outside one it is a no-op, so the
    // DELETE would run as the connection's own superuser role -- the test would
    // either fail for the wrong reason or actually empty the table while
    // appearing to prove that deletion is impossible.
    const text = await rejectionText(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set local role quote_app`);
        await tx.execute(sql`delete from customers`);
      }),
    );
    expect(text).toMatch(/permission denied/i);

    const rows = await db.select().from(customers).where(eq(customers.id, row.id));
    expect(rows).toHaveLength(1);
  });

  it('still permits the writes the application actually needs', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role quote_app`);
      await tx.execute(sql`
        insert into customers (name, customer_type) values ('Marcus Vance', 'residential')
      `);
      await tx.execute(sql`update customers set phone = '555-0199' where name = 'Marcus Vance'`);
    });
    const rows = await db.select().from(customers).where(eq(customers.name, 'Marcus Vance'));
    expect(rows[0]?.phone).toBe('555-0199');
  });

  it('refuses TRUNCATE as well, which would evade the DELETE grant', async () => {
    const text = await rejectionText(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set local role quote_app`);
        await tx.execute(sql`truncate table customers`);
      }),
    );
    expect(text).toMatch(/permission denied|must be owner/i);
  });
});
