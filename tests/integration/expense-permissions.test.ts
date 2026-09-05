import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may write to the expense ledger.
 *
 * This file exists because the answer changed and because the change cannot be
 * seen in a browser. `AUTH_MODE=local` supplies one identity and the deployment
 * signs in as an owner, so a bookkeeper's reach is not something anybody can
 * click through -- the only honest demonstration of it is here, against the
 * real `users` table and the real actions.
 *
 * What it proves, in the two directions that matter:
 *
 * 1. A `bookkeeper` may now enter an expense, a trip and a batch, and may void
 *    one. Under `quote:write` -- the capability these actions used to hold --
 *    the role could do none of it, which meant the person hired to keep the
 *    books could not record a cost.
 * 2. Nothing else moved. `record:void` still means a quote, a project or a
 *    customer, and the bookkeeper still holds neither it nor `quote:write`.
 *
 * `revalidatePath` and `headers` are request-scoped Next APIs and there is no
 * request here, so they are mocked rather than routed around: the actions
 * genuinely call them, and a test that avoided them would be testing a
 * different function. The identity header is exactly what the proxy writes
 * after it has verified a session, which is why supplying it is a fair
 * imitation of a signed-in request and not a way around the guard -- the guard
 * still resolves that address against `users` on every call.
 */

const signedIn = vi.hoisted(() => ({ email: 'books@example.invalid' }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-identity-email': signedIn.email }),
}));

import { db } from '@/db/client';
import { costCodes, customers, expenseTaxes, expenses, organization, projects, users } from '@/db/schema';
import {
  createExpense,
  createExpenseBatch,
  createMileage,
  voidExpense,
} from '@/app/expenses/actions';
import { can } from '@/lib/auth/permissions';

const BOOKKEEPER = 'books@example.invalid';
const OWNER = 'owner@example.invalid';
/** Comfortably behind the tenant's today, so nothing here is refused as a future date. */
const SPENT_ON = '2026-08-14';

let projectId: string;
let bookkeeperId: string;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

/**
 * The boxes a rendered purchase form always posts, blank included.
 *
 * A select left on its empty option posts an empty string, and the schema
 * treats blank and absent as the same fact -- but only for the fields it marks
 * optional, and only when the key is there. Spelling them out keeps this test
 * submitting what a browser submits rather than a convenient subset.
 */
function purchase(fields: Record<string, string>): FormData {
  return form({
    vendorId: '',
    costCodeId: '',
    reference: '',
    paymentMethod: '',
    vendorTaxNumberCaptured: '',
    notes: '',
    ...fields,
  });
}

function mileage(fields: Record<string, string>): FormData {
  return form({ costCodeId: '', notes: '', ...fields });
}

beforeEach(async () => {
  signedIn.email = BOOKKEEPER;

  await db.execute(sql`
    truncate table audit_log, expense_taxes, expenses, stage_history, projects,
      cost_codes, vendors, customers, users, organization
    restart identity cascade
  `);

  await db.insert(organization).values({
    id: 1,
    legalName: 'Test Holdings Ltd',
    displayName: 'Test Holdings',
    timezone: 'America/Toronto',
    mileageRatePerKmTenThou: 7200n,
  });

  const [books] = await db
    .insert(users)
    .values({
      email: BOOKKEEPER,
      displayName: 'Test Bookkeeper',
      role: 'bookkeeper',
      isActive: true,
    })
    .returning({ id: users.id });
  bookkeeperId = books!.id;

  // A spare owner, so the last-owner guardrail never interferes with a test
  // that deactivates somebody, and so an owner identity is available.
  await db
    .insert(users)
    .values({ email: OWNER, displayName: 'Test Owner', role: 'owner', isActive: true });

  const [customer] = await db
    .insert(customers)
    .values({ name: 'Sample Client', customerType: 'residential' })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      customerId: customer!.id,
      projectNumber: 'P-9101',
      name: 'Basement finish',
      projectType: 'basement',
    })
    .returning();
  projectId = project!.id;
});

/* -------------------------------------------------------------------------
   The matrix, restated where the actions can see it
   ------------------------------------------------------------------------- */

describe('the capability a bookkeeper now holds, and the three it still does not', () => {
  it('grants expense:write and withholds the customer-facing writes', () => {
    expect(can('bookkeeper', 'expense:write')).toBe(true);
    // Unchanged, and the point of adding a row rather than loosening one.
    expect(can('bookkeeper', 'quote:write')).toBe(false);
    expect(can('bookkeeper', 'quote:transition')).toBe(false);
    expect(can('bookkeeper', 'record:void')).toBe(false);
    expect(can('bookkeeper', 'rates:edit')).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   Entering
   ------------------------------------------------------------------------- */

describe('a bookkeeper entering spend', () => {
  it('records a purchase, attributed to the bookkeeper who typed it', async () => {
    const result = await createExpense(
      null,
      purchase({
        projectId,
        expenseDate: SPENT_ON,
        description: 'Framing lumber',
        subtotal: '412.60',
      }),
    );

    expect(result.ok).toBe(true);

    const [row] = await db.select().from(expenses);
    expect(row?.subtotalCents).toBe(41_260);
    expect(row?.totalCents).toBe(41_260);
    expect(row?.status).toBe('posted');
    // The actor comes from the guard's own lookup, never from the form.
    expect(row?.createdBy).toBe(bookkeeperId);
  });

  it('records a trip', async () => {
    const result = await createMileage(
      null,
      mileage({
        projectId,
        expenseDate: SPENT_ON,
        description: 'Site visit',
        distance: '42.5',
      }),
    );

    expect(result.ok).toBe(true);
    const [row] = await db.select().from(expenses);
    expect(row?.kind).toBe('mileage');
    expect(row?.ratePerKmTenThou).toBe(7200n);
    expect(row?.createdBy).toBe(bookkeeperId);
  });

  it('records a batch, which is the shape a year-end catch-up actually takes', async () => {
    const result = await createExpenseBatch(
      null,
      form({
        projectId,
        r0_date: SPENT_ON,
        r0_desc: 'Fasteners',
        r0_sub: '18.40',
        r1_date: SPENT_ON,
        r1_desc: 'Drywall compound',
        r1_sub: '61.20',
      }),
    );

    expect(result.ok).toBe(true);
    const rows = await db.select().from(expenses);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.createdBy === bookkeeperId)).toBe(true);
  });
});

/* -------------------------------------------------------------------------
   Correcting
   ------------------------------------------------------------------------- */

describe('a bookkeeper correcting their own entry', () => {
  it('voids an expense, keeping the row, the reason and the actor', async () => {
    await createExpense(
      null,
      purchase({
        projectId,
        expenseDate: SPENT_ON,
        description: 'Framing lumber',
        subtotal: '412.60',
      }),
    );
    const [entered] = await db.select().from(expenses);

    // The capability under test. `record:void` is false for this role, and the
    // action deliberately does not ask for it: entering forty receipts and
    // being unable to retract the one typed twice leaves a double-count in the
    // books the role exists to keep.
    const result = await voidExpense(
      null,
      form({ id: entered!.id, reason: 'Entered twice from the same receipt.' }),
    );
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(expenses).where(eq(expenses.id, entered!.id));
    // Voided, not deleted. The row is still there, and so is the reason.
    expect(after?.recordStatus).toBe('void');
    expect(after?.voidedBy).toBe(bookkeeperId);
    expect(after?.voidReason).toBe('Entered twice from the same receipt.');
    expect(after?.voidedAt).toBeInstanceOf(Date);
  });

  it('refuses a second void of the same row rather than restating the reason', async () => {
    await createExpense(
      null,
      purchase({ projectId, expenseDate: SPENT_ON, description: 'Sundries', subtotal: '10.00' }),
    );
    const [entered] = await db.select().from(expenses);
    const data = () => form({ id: entered!.id, reason: 'First reason.' });

    expect((await voidExpense(null, data())).ok).toBe(true);
    const second = await voidExpense(null, form({ id: entered!.id, reason: 'Second reason.' }));
    expect(second.ok).toBe(false);

    const [after] = await db.select().from(expenses).where(eq(expenses.id, entered!.id));
    expect(after?.voidReason).toBe('First reason.');
  });
});

/* -------------------------------------------------------------------------
   Deny by default, which the new capability does not soften
   ------------------------------------------------------------------------- */

describe('refusals', () => {
  it('refuses a deactivated bookkeeper, and writes nothing', async () => {
    await db.update(users).set({ isActive: false }).where(eq(users.id, bookkeeperId));

    const entry = await createExpense(
      null,
      purchase({ projectId, expenseDate: SPENT_ON, description: 'Lumber', subtotal: '412.60' }),
    );
    expect(entry.ok).toBe(false);
    expect(await db.select().from(expenses)).toHaveLength(0);
  });

  it('refuses a deactivated bookkeeper a void as well as an entry', async () => {
    await createExpense(
      null,
      purchase({ projectId, expenseDate: SPENT_ON, description: 'Lumber', subtotal: '412.60' }),
    );
    const [entered] = await db.select().from(expenses);

    await db.update(users).set({ isActive: false }).where(eq(users.id, bookkeeperId));
    const result = await voidExpense(null, form({ id: entered!.id, reason: 'No longer here.' }));

    expect(result.ok).toBe(false);
    const [after] = await db.select().from(expenses).where(eq(expenses.id, entered!.id));
    expect(after?.recordStatus).toBe('active');
  });

  it('refuses an address with no users row at all', async () => {
    signedIn.email = 'stranger@example.invalid';
    const result = await createExpense(
      null,
      purchase({ projectId, expenseDate: SPENT_ON, description: 'Lumber', subtotal: '412.60' }),
    );

    expect(result.ok).toBe(false);
    expect(await db.select().from(expenses)).toHaveLength(0);
    expect(await db.select().from(expenseTaxes)).toHaveLength(0);
    expect(await db.select().from(costCodes)).toHaveLength(0);
  });
});
