import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { db } from '@/db/client';
import { costCodes, customers, expenseTaxes, expenses, organization, projects, vendors } from '@/db/schema';
import { ensureCompany, ensureOrganization } from '../support/organization';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';

/**
 * What the database refuses, and the one thing it must never quietly change.
 *
 * These are schema-level proofs on purpose. The rules they check are the ones
 * a future caller -- an import, an OCR pass, a script somebody writes at year
 * end -- will meet without going through the form, and a rule that only the
 * form enforces is a rule that holds until the second writer arrives.
 */

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, expense_taxes, expenses, stage_history, projects,
      cost_codes, vendors, customers restart identity cascade
  `);
  /**
   * The company row, created here rather than assumed.
   *
   * This file reads `organization` for the mileage rate, and did not create it
   * -- so it passed only while some earlier file happened to leave one behind.
   * `tests/integration/files.test.ts` truncates `organization` in its last
   * test, and the day the order changed this file did not fail on the
   * assertion it was making: its setup threw, every remaining test in the file
   * silently never ran, and the suite reported ninety-eight fewer tests
   * passing rather than one failing.
   *
   * A test that depends on another file's leftovers is not a test. Creating
   * what it needs is the fix; `on conflict do nothing` because a file that
   * runs after a truncate and a file that runs after a seed must both work.
   */
  await ensureOrganization();
  await ensureCompany();
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

async function seedProject() {
  const [customer] = await db
    .insert(customers)
    .values({ name: 'Sample Client', customerType: 'residential' })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ companyId: FIRST_COMPANY_ID,
      customerId: customer!.id,
      projectNumber: 'P-9001',
      name: 'Basement finish',
      projectTypeId: PROJECT_TYPE_IDS.basement,
    })
    .returning();
  return project!;
}

async function seedVendor() {
  const [row] = await db.insert(vendors).values({ name: 'Sample Supply' }).returning();
  return row!;
}

/* -------------------------------------------------------------------------
   The snapshot, which is the whole point of the mileage columns
   ------------------------------------------------------------------------- */

describe('the mileage rate is snapshotted, never read live', () => {
  it('leaves a logged trip exactly as it was when the configured rate changes', async () => {
    const project = await seedProject();

    // A trip driven at 0.7200: 42.5 km, $30.60.
    await db.insert(expenses).values({
      kind: 'mileage',
      projectId: project.id,
      expenseDate: '2026-08-14',
      description: 'Site visit',
      distanceMilli: 42_500n,
      ratePerKmTenThou: 7200n,
      subtotalCents: 3060,
      totalCents: 3060,
      status: 'posted',
    });

    // The allowance changes, the way it does most Januaries.
    await db
      .update(organization)
      .set({ mileageRatePerKmTenThou: 6800n })
      .where(eq(organization.id, 1));

    const [after] = await db.select().from(expenses);
    // Neither number moved. Had the rate been resolved at display time, this
    // trip would now cost $28.90 -- a silent restatement of a period that may
    // already have been filed, with nothing on any screen to say it happened.
    expect(after!.ratePerKmTenThou).toBe(7200n);
    expect(after!.subtotalCents).toBe(3060);
    expect(after!.totalCents).toBe(3060);

    // And the configured rate really did change, so the assertion above is
    // not passing because nothing happened.
    const [org] = await db.select().from(organization).where(eq(organization.id, 1));
    expect(org!.mileageRatePerKmTenThou).toBe(6800n);
  });

  it('lets two trips of the same distance carry two different rates', async () => {
    const project = await seedProject();
    await db.insert(expenses).values([
      {
        kind: 'mileage',
        projectId: project.id,
        expenseDate: '2025-11-02',
        description: 'Last year',
        distanceMilli: 100_000n,
        ratePerKmTenThou: 7000n,
        subtotalCents: 7000,
        totalCents: 7000,
      },
      {
        kind: 'mileage',
        projectId: project.id,
        expenseDate: '2026-03-02',
        description: 'This year',
        distanceMilli: 100_000n,
        ratePerKmTenThou: 7200n,
        subtotalCents: 7200,
        totalCents: 7200,
      },
    ]);

    const rows = await db.select().from(expenses).orderBy(expenses.expenseDate);
    expect(rows.map((row) => row.subtotalCents)).toEqual([7000, 7200]);
  });
});

/* -------------------------------------------------------------------------
   The shapes each kind is allowed to have
   ------------------------------------------------------------------------- */

describe('what the row shapes refuse', () => {
  it('refuses mileage with a vendor on it', async () => {
    const project = await seedProject();
    const vendor = await seedVendor();
    const text = await rejectionText(() =>
      db.insert(expenses).values({
        kind: 'mileage',
        projectId: project.id,
        vendorId: vendor.id,
        expenseDate: '2026-08-14',
        description: 'Site visit',
        distanceMilli: 10_000n,
        ratePerKmTenThou: 7200n,
        subtotalCents: 720,
        totalCents: 720,
      }),
    );
    expect(text).toMatch(/expenses_kind_shape/);
  });

  it('refuses mileage that claims to be billable to the customer', async () => {
    // Mileage is cost only. It moves the margin and it never appears on
    // anything the customer is sent, and that is not left to a form to
    // remember.
    const project = await seedProject();
    const text = await rejectionText(() =>
      db.insert(expenses).values({
        kind: 'mileage',
        projectId: project.id,
        expenseDate: '2026-08-14',
        description: 'Site visit',
        distanceMilli: 10_000n,
        ratePerKmTenThou: 7200n,
        subtotalCents: 720,
        totalCents: 720,
        isBillable: true,
      }),
    );
    expect(text).toMatch(/expenses_kind_shape/);
  });

  it('refuses mileage carrying tax', async () => {
    const project = await seedProject();
    const text = await rejectionText(() =>
      db.insert(expenses).values({
        kind: 'mileage',
        projectId: project.id,
        expenseDate: '2026-08-14',
        description: 'Site visit',
        distanceMilli: 10_000n,
        ratePerKmTenThou: 7200n,
        subtotalCents: 720,
        taxTotalCents: 94,
        totalCents: 814,
      }),
    );
    expect(text).toMatch(/expenses_kind_shape/);
  });

  it('refuses a purchase carrying a distance', async () => {
    const project = await seedProject();
    const text = await rejectionText(() =>
      db.insert(expenses).values({
        kind: 'purchase',
        projectId: project.id,
        expenseDate: '2026-08-14',
        description: 'Lumber',
        subtotalCents: 1000,
        totalCents: 1000,
        distanceMilli: 10_000n,
      }),
    );
    expect(text).toMatch(/expenses_kind_shape/);
  });

  it('refuses mileage with no rate on it at all', async () => {
    // The failure mode this exists for: a caller that meant to snapshot the
    // rate and forgot. A null here would be a trip that costs nothing and
    // cannot be re-costed, because nothing recorded what it was driven at.
    const project = await seedProject();
    const text = await rejectionText(() =>
      db.insert(expenses).values({
        kind: 'mileage',
        projectId: project.id,
        expenseDate: '2026-08-14',
        description: 'Site visit',
        distanceMilli: 10_000n,
        subtotalCents: 0,
        totalCents: 0,
      }),
    );
    expect(text).toMatch(/expenses_kind_shape/);
  });
});

describe('the arithmetic the database keeps', () => {
  it('refuses a total that is not the subtotal plus the tax', async () => {
    const project = await seedProject();
    const text = await rejectionText(() =>
      db.insert(expenses).values({
        projectId: project.id,
        expenseDate: '2026-08-14',
        description: 'Lumber',
        subtotalCents: 10_000,
        taxTotalCents: 1300,
        totalCents: 10_000,
      }),
    );
    expect(text).toMatch(/expenses_total_identity/);
  });

  it('refuses a trip whose cost is not the distance times the rate', async () => {
    const project = await seedProject();
    const text = await rejectionText(() =>
      db.insert(expenses).values({
        kind: 'mileage',
        projectId: project.id,
        expenseDate: '2026-08-14',
        description: 'Site visit',
        distanceMilli: 42_500n,
        ratePerKmTenThou: 7200n,
        // The right answer is 3060. This is what a display-time recalculation
        // at a changed rate would have written.
        subtotalCents: 2890,
        totalCents: 2890,
      }),
    );
    expect(text).toMatch(/expenses_mileage_cost_identity/);
  });

  it('agrees with the application about how a half rounds', async () => {
    // 1 km at 0.1250 is 12.5 cents. `divRoundHalfUp` says 13; Postgres
    // `round()` on numeric rounds half away from zero and says the same. Two
    // implementations of the house rule that disagreed would refuse every row
    // that landed on a half.
    const project = await seedProject();
    await db.insert(expenses).values({
      kind: 'mileage',
      projectId: project.id,
      expenseDate: '2026-08-14',
      description: 'Short hop',
      distanceMilli: 1000n,
      ratePerKmTenThou: 1250n,
      subtotalCents: 13,
      totalCents: 13,
    });
    const [row] = await db.select().from(expenses);
    expect(row!.subtotalCents).toBe(13);
  });

  it('accepts a credit: a negative subtotal, tax and total together', async () => {
    // Material went back to the yard. The job's cost genuinely falls, and the
    // only way to record that is a row that is negative all the way through.
    const project = await seedProject();
    await db.insert(expenses).values({
      projectId: project.id,
      expenseDate: '2026-08-14',
      description: 'Returned two sheets',
      subtotalCents: -4500,
      taxTotalCents: -585,
      totalCents: -5085,
    });
    const [row] = await db.select().from(expenses);
    expect(row!.totalCents).toBe(-5085);
  });
});

/* -------------------------------------------------------------------------
   Tax lines
   ------------------------------------------------------------------------- */

describe('tax broken out per tax', () => {
  it('keeps recoverable and non-recoverable apart on one receipt', async () => {
    const project = await seedProject();
    const [expense] = await db
      .insert(expenses)
      .values({
        projectId: project.id,
        expenseDate: '2026-08-14',
        description: 'Mixed receipt',
        subtotalCents: 10_000,
        taxTotalCents: 1800,
        totalCents: 11_800,
      })
      .returning();

    await db.insert(expenseTaxes).values([
      {
        expenseId: expense!.id,
        label: 'Recoverable tax',
        rateTenThou: 500n,
        taxAmountCents: 500,
        isRecoverable: true,
        sortOrder: 0,
      },
      {
        expenseId: expense!.id,
        label: 'Levy',
        rateTenThou: 1300n,
        taxAmountCents: 1300,
        isRecoverable: false,
        sortOrder: 1,
      },
    ]);

    const [claimable] = await db
      .select({ cents: sql<number>`coalesce(sum(${expenseTaxes.taxAmountCents}), 0)::int` })
      .from(expenseTaxes)
      .where(eq(expenseTaxes.isRecoverable, true));

    // 500, not the 1800 on the header. Reading the header total instead would
    // claim an input tax credit larger than the company is entitled to, which
    // is the wrong direction to be wrong in.
    expect(claimable!.cents).toBe(500);
  });
});

/* -------------------------------------------------------------------------
   The invariants every table in this product carries
   ------------------------------------------------------------------------- */

describe('the table invariants', () => {
  it('maintains updated_at by trigger, without the application setting it', async () => {
    const project = await seedProject();
    const [row] = await db
      .insert(expenses)
      .values({
        projectId: project.id,
        expenseDate: '2026-08-14',
        description: 'Lumber',
        subtotalCents: 1000,
        totalCents: 1000,
      })
      .returning();

    await db.execute(sql`select pg_sleep(0.01)`);
    await db.update(expenses).set({ description: 'Framing lumber' }).where(eq(expenses.id, row!.id));

    const [after] = await db.select().from(expenses).where(eq(expenses.id, row!.id));
    expect(after!.updatedAt.getTime()).toBeGreaterThan(row!.updatedAt.getTime());
  });

  it('refuses a DELETE issued as the application role', async () => {
    const project = await seedProject();
    await db.insert(expenses).values({
      projectId: project.id,
      expenseDate: '2026-08-14',
      description: 'Lumber',
      subtotalCents: 1000,
      totalCents: 1000,
    });

    // SET LOCAL is scoped to a transaction. Outside one it is a no-op and the
    // DELETE would run as the connection's own superuser role -- the test
    // would empty the table while appearing to prove that it cannot be
    // emptied.
    const text = await rejectionText(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set local role quote_app`);
        await tx.execute(sql`delete from expenses`);
      }),
    );
    expect(text).toMatch(/permission denied/i);

    const rows = await db.select().from(expenses);
    expect(rows).toHaveLength(1);
  });

  it('lets the application role write what it actually needs to', async () => {
    const project = await seedProject();
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role quote_app`);
      await tx.execute(sql`
        insert into expenses (project_id, expense_date, description, subtotal_cents, total_cents)
        values (${project.id}, '2026-08-14', 'Lumber', 1000, 1000)
      `);
    });
    const rows = await db.select().from(expenses);
    expect(rows).toHaveLength(1);
  });

  it('records a void in the audit log as a void rather than an update', async () => {
    const project = await seedProject();
    const [row] = await db
      .insert(expenses)
      .values({
        projectId: project.id,
        expenseDate: '2026-08-14',
        description: 'Lumber',
        subtotalCents: 1000,
        totalCents: 1000,
      })
      .returning();

    await db
      .update(expenses)
      .set({ recordStatus: 'void', voidReason: 'Coded to the wrong job' })
      .where(eq(expenses.id, row!.id));

    const entries = await db.execute(sql`
      select action from audit_log where table_name = 'expenses' and record_id = ${row!.id}
    `);
    // The set, not the order: the two rows can share a transaction timestamp,
    // and there is nothing else to sort them by.
    const seen = (entries as unknown as { action: string }[])
      .map((entry) => entry.action)
      .sort();
    expect(seen).toEqual(['insert', 'void']);
  });

  it('keeps a cost code resolving after it is retired', async () => {
    // Retiring means "do not offer this on new work". Spend already coded to
    // a winding-down division still has to read back.
    const project = await seedProject();
    const [code] = await db
      .insert(costCodes)
      .values({ code: '06-10', name: 'Framing' })
      .returning();

    await db.insert(expenses).values({
      projectId: project.id,
      costCodeId: code!.id,
      expenseDate: '2026-08-14',
      description: 'Lumber',
      subtotalCents: 1000,
      totalCents: 1000,
    });
    await db.update(costCodes).set({ isActive: false }).where(eq(costCodes.id, code!.id));

    const rows = await db
      .select({ code: costCodes.code })
      .from(expenses)
      .innerJoin(costCodes, eq(costCodes.id, expenses.costCodeId));
    expect(rows[0]?.code).toBe('06-10');
  });
});
