import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';

/**
 * `revalidatePath` and `headers` are request-scoped Next APIs and there is no
 * request here. Mocked rather than avoided, for the reason `billing-action.test.ts`
 * gives: the action genuinely must call them, and a test that routed around
 * them would be testing a different function.
 *
 * The identity is mutable so the refusal path can be exercised. It is what the
 * proxy writes after it has verified an Access token or read a session, so
 * changing it is exactly what a different person signing in looks like to the
 * action -- which is the point: authorization is a lookup against the user
 * table on every request, never a claim the browser carried.
 */
const identity = vi.hoisted(() => ({ email: 'owner@example.invalid' as string | null }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers(identity.email ? { 'x-identity-email': identity.email } : {}),
}));

import { db } from '@/db/client';
import { customers, organization, companies, projects, quotes, reminders, users } from '@/db/schema';
// After the mocks above, deliberately: this pulls in the database client,
// and the module under test must not be loaded before they are installed.
import { seedDeployment } from '../support/organization';
import { createReminderAction } from '@/app/reminders/actions';
import { addDays, tenantToday } from '@/lib/quote/dates';
import { listReminders } from '@/lib/reminders/repository';
import type { FormResult } from '@/components/detail/form-state';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';

/**
 * A reminder somebody wrote by hand.
 *
 * The repository's `createReminder` is covered in `reminders.test.ts`. What is
 * covered HERE is the action around it -- the half a form can reach and a
 * hand-made POST can reach too: the guard, the entity check the database
 * cannot make, and which day an offset lands on.
 *
 * The last of those is the one worth a database. `tenantToday` reads the
 * organization's zone out of PostgreSQL, and every assertion about a due date
 * below is really an assertion that no `new Date()` crept onto the path.
 */

const TIMEZONE = 'America/Toronto';

let customerId: string;
let projectId: string;
let quoteId: string;
let today: string;

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

/** The fields a form posts, with the ones under test overridable. */
function against(entityType: string, entityId: string, overrides: Record<string, string> = {}) {
  return form({
    entityType,
    entityId,
    title: 'Call Dave back',
    when: '3',
    kind: 'callback',
    ...overrides,
  });
}

async function add(data: FormData): Promise<FormResult> {
  return createReminderAction(null, data);
}

/** The refusal a person reads. Fails loudly if the action allowed the request. */
async function refusal(data: FormData): Promise<string> {
  const result = await add(data);
  expect(result.ok, `expected a refusal, the action returned ${JSON.stringify(result)}`).toBe(
    false,
  );
  return String((result as { ok: false; error: string }).error);
}

async function countReminders(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(reminders);
  return row!.n;
}

beforeEach(async () => {
  identity.email = 'owner@example.invalid';

  await db.execute(sql`
    truncate table audit_log, activities, reminders, reminder_rules, stage_history, sessions,
    user_identities, quote_taxes, quote_lines, quotes, scope_template_items, scope_templates,
    rate_items, cost_codes, tax_rates, projects, customers, users, organization,
    document_sequences
    restart identity cascade
  `);

  await seedDeployment({
    id: 1,
    legalName: 'Test Company Ltd',
    displayName: 'Test Company',
    timezone: TIMEZONE,
  });

  await db.insert(users).values([
    {
      email: 'owner@example.invalid',
      displayName: 'Test Owner',
      role: 'owner',
      isActive: true,
    },
    // Reads the books, and may not change a priced record. `quote:write` is
    // the line the reminder actions already draw.
    {
      email: 'books@example.invalid',
      displayName: 'Test Bookkeeper',
      role: 'bookkeeper',
      isActive: true,
    },
  ]);

  const [customer] = await db
    .insert(customers)
    .values({ name: 'Sample Client', customerType: 'residential' })
    .returning({ id: customers.id });
  customerId = customer!.id;

  const [project] = await db
    .insert(projects)
    .values({ companyId: FIRST_COMPANY_ID,
      customerId,
      projectNumber: 'P-0001',
      name: 'Basement finish',
      projectTypeId: PROJECT_TYPE_IDS.basement,
      stage: 'quote_sent',
      siteAddressLine1: '12 Sample Street',
      siteCity: 'Sample City',
    })
    .returning({ id: projects.id });
  projectId = project!.id;

  today = await db.transaction((tx) => tenantToday(tx));

  const [quote] = await db
    .insert(quotes)
    .values({
      projectId,
      quoteNumber: 'QT-0001',
      kind: 'estimate',
      sequence: 1,
      version: 1,
      status: 'sent',
      quoteDate: today,
      validUntil: addDays(today, 30),
    })
    .returning({ id: quotes.id });
  quoteId = quote!.id;
});

/* ------------------------------------------------------------------------- */

describe('writing one down', () => {
  it('files it against the record, open, on the day the offset names', async () => {
    expect(await add(against('customer', customerId))).toEqual({ ok: true });

    const [row] = await listReminders({ entity: { type: 'customer', id: customerId } });
    expect(row!.title).toBe('Call Dave back');
    expect(row!.kind).toBe('callback');
    expect(row!.status).toBe('open');
    expect(row!.dueOn).toBe(addDays(today, 3));
  });

  /**
   * The property the whole feature turns on.
   *
   * A null rule id puts the row outside `reminders_one_open_per_rule` --
   * PostgreSQL treats nulls as distinct -- so the hourly evaluation never
   * treats a hand-written reminder as its own work, and never completes,
   * supersedes or deduplicates it.
   */
  it('leaves no rule behind it, and is not assigned to anybody', async () => {
    await add(against('project', projectId));

    const [row] = await listReminders({ entity: { type: 'project', id: projectId } });
    expect(row!.generatedByRuleId).toBeNull();
    expect(row!.assignedTo).toBeNull();
  });

  it('lets the owner write the same thing twice, because he is repeating himself', async () => {
    // Not the machine duplicating itself. The unique index is on the rule id,
    // and there isn't one.
    expect(await add(against('customer', customerId))).toEqual({ ok: true });
    expect(await add(against('customer', customerId))).toEqual({ ok: true });
    expect(await countReminders()).toBe(2);
  });

  it('takes a picked day exactly as picked', async () => {
    const day = addDays(today, 45);
    await add(against('quote', quoteId, { when: 'date', dueOn: day }));

    const [row] = await listReminders({ entity: { type: 'quote', id: quoteId } });
    expect(row!.dueOn).toBe(day);
  });

  it('files a reminder due today on today, not on tomorrow', async () => {
    // The failing case if any part of this path reached for `new Date()`: in a
    // UTC container after 7pm Toronto, "today" is already the next day.
    await add(against('customer', customerId, { when: '0' }));

    const [row] = await listReminders({ entity: { type: 'customer', id: customerId } });
    expect(row!.dueOn).toBe(today);
  });

  it('keeps the detail, and trims what was typed around it', async () => {
    await add(
      against('customer', customerId, {
        title: '  Call Dave back  ',
        detail: '  He wants the basement priced without the bathroom.  ',
      }),
    );

    const [row] = await listReminders({ entity: { type: 'customer', id: customerId } });
    expect(row!.title).toBe('Call Dave back');
    expect(row!.detail).toBe('He wants the basement priced without the bathroom.');
  });

  it('stores no detail rather than an empty one', async () => {
    await add(against('customer', customerId, { detail: '   ' }));

    const [row] = await listReminders({ entity: { type: 'customer', id: customerId } });
    expect(row!.detail).toBeNull();
  });
});

describe('what it refuses', () => {
  it('refuses a reminder with nothing written on it', async () => {
    expect(await refusal(against('customer', customerId, { title: '   ' }))).toMatch(
      /say what the reminder is for/,
    );
    expect(await countReminders()).toBe(0);
  });

  it('refuses a day-choice it does not offer', async () => {
    expect(await refusal(against('customer', customerId, { when: '365' }))).toMatch(
      /say when this is due/,
    );
  });

  it('refuses a picked day with no day picked', async () => {
    // Otherwise it would fall through to today -- a reminder due on a day the
    // owner did not choose, which is worse than the refusal.
    expect(await refusal(against('customer', customerId, { when: 'date' }))).toMatch(
      /pick the day it is due/,
    );
    expect(await refusal(against('customer', customerId, { when: 'date', dueOn: 'Thursday' })))
      .toMatch(/not a date/);
    expect(await countReminders()).toBe(0);
  });

  it('refuses a kind the picker does not offer', async () => {
    // `quote_expiring` belongs to the rule that reads a quote's valid_until. A
    // hand-written one would assert an expiry nothing checked.
    expect(await refusal(against('quote', quoteId, { kind: 'quote_expiring' }))).toMatch(
      /what kind of reminder/,
    );
    expect(await countReminders()).toBe(0);
  });

  it('refuses a record type outside the enum, whatever the form said', async () => {
    // A narrowed form is a hint. This is the refusal.
    expect(await refusal(against('vendor', customerId))).toMatch(/record type is not valid/);
    expect(await refusal(against('organization', customerId))).toMatch(
      /record type is not valid/,
    );
  });

  it('refuses an id that is not a uuid', async () => {
    expect(await refusal(against('customer', 'the-basement-one'))).toMatch(
      /record id is not valid/,
    );
  });

  /**
   * `entity_type`/`entity_id` is a polymorphic reference and no foreign key
   * enforces it, so a reminder pointing at nothing would insert happily and
   * then sit on the screen for ever with nowhere to press.
   */
  it('refuses a record that is not there, and writes nothing', async () => {
    const missing = '00000000-0000-4000-8000-0000000000ff';
    expect(await refusal(against('customer', missing))).toMatch(/could not be found/);
    expect(await countReminders()).toBe(0);
  });

  it('refuses a real id of the wrong type', async () => {
    // The project exists; there is no CUSTOMER with that id, and the pair is
    // what the reminder is filed under.
    expect(await refusal(against('customer', projectId))).toMatch(/could not be found/);
    expect(await countReminders()).toBe(0);
  });

  it('refuses a role that may not change a priced record', async () => {
    identity.email = 'books@example.invalid';
    expect(await refusal(against('customer', customerId))).toMatch(/does not permit/);
    expect(await countReminders()).toBe(0);
  });

  it('refuses a request that carries no verified identity', async () => {
    identity.email = null;
    expect(await refusal(against('customer', customerId))).toMatch(/no verified identity/);
    expect(await countReminders()).toBe(0);
  });

  it('refuses somebody with no account at all', async () => {
    identity.email = 'stranger@example.invalid';
    expect(await refusal(against('customer', customerId))).toMatch(/no account/);
    expect(await countReminders()).toBe(0);
  });
});
