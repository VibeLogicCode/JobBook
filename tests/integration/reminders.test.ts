import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { db } from '@/db/client';
import {
  activities, auditLog, customers, organization, companies, projects, quotes, reminderRules, reminders, users,
} from '@/db/schema';
import { DEFAULT_REMINDER_RULES, seedDefaultReminderRules } from '@/db/seed/reminder-rules';
import { addDays, tenantToday } from '@/lib/quote/dates';
import { isDue, isOverdue } from '@/lib/reminders/rules';
import {
  completeReminder,
  createReminder,
  dismissReminder,
  listReminders,
  listTimeline,
  logActivity,
  rescheduleReminder,
  runReminderEvaluation,
  snoozeReminder,
  voidReminder,
} from '@/lib/reminders/repository';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { seedDeployment } from '../support/organization';

/**
 * The reminder spine, against a real database.
 *
 * No `next/cache` or `next/headers` mock here, unlike `stage.test.ts`: this
 * slice ships no server action, so nothing request-scoped is on the path. The
 * actor is passed in explicitly, which is the seam the guarded action fills
 * with `allowed.actor.id` when the screen lands.
 *
 * The block that matters most is the last one. Everything else can be right
 * and the feature still fails if an hourly job writes the same reminder
 * twenty-four times a day.
 */

const TIMEZONE = 'America/Toronto';

let actorId: string;
let customerId: string;
let projectId: string;
let today: string;

/** Drizzle wraps a driver error; the real PostgresError hangs off `cause`. */
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

async function countReminders(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(reminders);
  return row!.n;
}

function ruleFor(trigger: string): string {
  const rule = DEFAULT_REMINDER_RULES.find((candidate) => candidate.trigger === trigger);
  if (!rule) throw new Error(`no seeded rule for ${trigger}`);
  return rule.id;
}

async function remindersFromRule(ruleId: string) {
  return db
    .select({ id: reminders.id, title: reminders.title, status: reminders.status })
    .from(reminders)
    .where(and(eq(reminders.generatedByRuleId, ruleId), eq(reminders.recordStatus, 'active')));
}

/** A quote that has gone out. The anchor for two of the five seeded rules. */
async function sendQuote(sentDaysAgo: number, validUntil: string): Promise<string> {
  const [quote] = await db
    .insert(quotes)
    .values({
      projectId,
      quoteNumber: 'QT-0001',
      kind: 'estimate',
      sequence: 1,
      version: 1,
      status: 'sent',
      quoteDate: addDays(today, -sentDaysAgo),
      validUntil,
      sentAt: sql`((${addDays(today, -sentDaysAgo)})::timestamp at time zone ${TIMEZONE})`,
    })
    .returning({ id: quotes.id });
  return quote!.id;
}

beforeEach(async () => {
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

  const [owner] = await db
    .insert(users)
    .values({
      email: 'owner@example.invalid',
      displayName: 'Test Owner',
      role: 'owner',
      isActive: true,
    })
    .returning({ id: users.id });
  actorId = owner!.id;

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
});

/* ------------------------------------------------------------------------- */

describe('the seeded rules', () => {
  it('loads five, all active', async () => {
    const loaded = await seedDefaultReminderRules();
    expect(loaded).toBe(5);

    const rows = await db.select().from(reminderRules);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.isActive)).toBe(true);
  });

  it('loads nothing the second time, so a boot loop cannot multiply them', async () => {
    await seedDefaultReminderRules();
    expect(await seedDefaultReminderRules()).toBe(0);
    expect(await db.select().from(reminderRules)).toHaveLength(5);
  });

  it('never restores a rule the owner switched off', async () => {
    await seedDefaultReminderRules();
    await db
      .update(reminderRules)
      .set({ isActive: false, titleTemplate: 'Chase {customer} about the quote' })
      .where(eq(reminderRules.id, ruleFor('quote_sent')));

    await seedDefaultReminderRules();

    const [row] = await db
      .select()
      .from(reminderRules)
      .where(eq(reminderRules.id, ruleFor('quote_sent')));
    expect(row!.isActive).toBe(false);
    expect(row!.titleTemplate).toBe('Chase {customer} about the quote');
  });
});

describe('evaluation', () => {
  it('follows up a quote three days after it went out, naming the customer', async () => {
    await sendQuote(0, addDays(today, 30));
    const summary = await runReminderEvaluation();
    expect(summary.today).toBe(today);

    const [row] = await remindersFromRule(ruleFor('quote_sent'));
    expect(row!.title).toBe('Follow up on quote to Sample Client');

    const [full] = await listReminders({ status: 'open' });
    expect(full!.dueOn).toBe(addDays(today, 3));
  });

  it('warns five days before a quote expires', async () => {
    await sendQuote(0, addDays(today, 30));
    await runReminderEvaluation();

    const open = await listReminders({ status: 'open' });
    const warning = open.find((row) => row.generatedByRuleId === ruleFor('quote_expiring'));
    expect(warning!.title).toBe('Quote QT-0001 expires in 5 days');
    expect(warning!.dueOn).toBe(addDays(today, 25));
  });

  /**
   * "Quote QT-0001 expires in 5 days" against a quote that expired in March is
   * a false statement, and a reminder that lies about its own reason is the
   * first one the owner learns to scroll past.
   */
  it('says nothing about a quote that has already expired', async () => {
    await sendQuote(90, addDays(today, -30));
    await runReminderEvaluation();

    expect(await remindersFromRule(ruleFor('quote_expiring'))).toHaveLength(0);
    // The follow-up rule still fires: an old quote nobody answered is exactly
    // the thing worth a phone call.
    expect(await remindersFromRule(ruleFor('quote_sent'))).toHaveLength(1);
  });

  it('reminds the day before a site visit, at the site address', async () => {
    await db
      .update(projects)
      .set({ stage: 'site_visit', scheduledStart: addDays(today, 4) })
      .where(eq(projects.id, projectId));

    await runReminderEvaluation();

    const [row] = await remindersFromRule(ruleFor('site_visit_scheduled'));
    expect(row!.title).toBe('Site visit tomorrow at 12 Sample Street, Sample City');
    const open = await listReminders({ status: 'open' });
    expect(open.find((r) => r.id === row!.id)!.dueOn).toBe(addDays(today, 3));
  });

  it('chases a won job for a start date the next day', async () => {
    await db.update(projects).set({ stage: 'won' }).where(eq(projects.id, projectId));
    await runReminderEvaluation();

    const [row] = await remindersFromRule(ruleFor('project_won'));
    // The title leads with the VERB and names no project. It used to read
    // "Won Basement finish — confirm start date and deposit", which repeated
    // the pipeline card's own heading and buried the only new word in the
    // middle of the line. The project is not lost: the reminder resolves to
    // the record, and both screens show it.
    expect(row!.title).toBe('Confirm the start date and deposit');
  });

  /**
   * The retrospective rule. "No contact with Sample Client in 14 days" is a
   * FALSE statement for thirteen of those days, so creating it early would put
   * a permanently wrong row against every customer in the book.
   */
  it('leaves a customer alone until the silence is real', async () => {
    await logActivity({
      entityType: 'customer',
      entityId: customerId,
      kind: 'call_out',
      actorId,
      subject: 'Talked through the scope',
    });

    await runReminderEvaluation();
    expect(await remindersFromRule(ruleFor('no_activity'))).toHaveLength(0);
  });

  it('chases one nobody has spoken to in a fortnight', async () => {
    await logActivity({
      entityType: 'project',
      entityId: projectId,
      kind: 'call_out',
      actorId,
      occurredOn: addDays(today, -20),
      subject: 'Last call about the basement',
    });

    await runReminderEvaluation();

    const [row] = await remindersFromRule(ruleFor('no_activity'));
    expect(row!.title).toBe('No contact with Sample Client in 14 days');
    const open = await listReminders({ status: 'open' });
    expect(isOverdue(open.find((r) => r.id === row!.id)!, today)).toBe(true);
  });

  /**
   * The owner logs a call wherever he happens to be standing. A rule that read
   * only activities filed against the customer would chase somebody he spoke
   * to yesterday about the job.
   */
  it('counts a call logged against the project as contact with the customer', async () => {
    await logActivity({
      entityType: 'project',
      entityId: projectId,
      kind: 'call_in',
      actorId,
      occurredOn: addDays(today, -2),
    });

    await runReminderEvaluation();
    expect(await remindersFromRule(ruleFor('no_activity'))).toHaveLength(0);
  });

  it('fires a stage rule only for the stage it watches', async () => {
    await seedDefaultReminderRules();
    const [rule] = await db
      .insert(reminderRules)
      .values({
        name: 'Chase a job put on hold',
        trigger: 'stage_entered',
        triggerStage: 'on_hold',
        offsetDays: 7,
        reminderKind: 'follow_up',
        titleTemplate: 'Still on hold: {project}',
      })
      .returning({ id: reminderRules.id });

    await runReminderEvaluation();
    expect(await remindersFromRule(rule!.id)).toHaveLength(0);

    await db.update(projects).set({ stage: 'on_hold' }).where(eq(projects.id, projectId));
    await runReminderEvaluation();

    const [row] = await remindersFromRule(rule!.id);
    expect(row!.title).toBe('Still on hold: Basement finish');
  });

  it('ignores a rule that has been voided, whatever is_active still says', async () => {
    await sendQuote(0, addDays(today, 30));
    await seedDefaultReminderRules();
    await db
      .update(reminderRules)
      .set({ recordStatus: 'void', voidReason: 'Added in error' })
      .where(eq(reminderRules.id, ruleFor('quote_sent')));

    await runReminderEvaluation();
    expect(await remindersFromRule(ruleFor('quote_sent'))).toHaveLength(0);
  });
});

describe('the tenant clock', () => {
  /**
   * The single most likely off-by-one in this subsystem. In a UTC container
   * after 7pm Toronto, `new Date()` is already tomorrow -- so a reminder
   * stored at UTC midnight is a reminder that shows up on the wrong day, and
   * the owner reads that as the system being broken.
   */
  it('stores a due date as midnight in the tenant zone, not in UTC', async () => {
    const { id } = await createReminder({
      entityType: 'customer',
      entityId: customerId,
      title: 'Call about the tile',
      dueOn: '2026-09-10',
      kind: 'callback',
      actorId,
    });

    const rows = await db.execute(sql`
      select to_char(due_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as utc
      from reminders where id = ${id}
    `);
    // Toronto is UTC-4 in September, so the tenant's midnight is 04:00 UTC.
    expect((rows as unknown as { utc: string }[])[0]!.utc).toBe('2026-09-10 04:00');

    const [row] = await listReminders({ entity: { type: 'customer', id: customerId } });
    expect(row!.dueOn).toBe('2026-09-10');
  });
});

describe('activities', () => {
  /**
   * An owner logs Tuesday's call on Thursday. The timeline orders by when it
   * happened; the audit trail keeps when he said so. Conflating the two makes
   * the timeline lie, and it is the kind of lie nobody notices until they are
   * reconstructing a dispute.
   */
  it('orders by when it happened, not by when it was typed', async () => {
    await logActivity({
      entityType: 'customer',
      entityId: customerId,
      kind: 'note',
      actorId,
      subject: 'Typed second, happened first',
      occurredOn: addDays(today, -3),
    });
    await logActivity({
      entityType: 'customer',
      entityId: customerId,
      kind: 'call_in',
      actorId,
      subject: 'Typed first, happened second',
      occurredOn: addDays(today, -1),
    });

    const timeline = await listTimeline('customer', customerId);
    expect(timeline.map((row) => row.subject)).toEqual([
      'Typed first, happened second',
      'Typed second, happened first',
    ]);

    // And the audit trail keeps the other order: both rows were created now.
    const backdated = timeline.find((row) => row.subject === 'Typed second, happened first')!;
    const [stored] = await db.select().from(activities).where(eq(activities.id, backdated.id));
    expect(stored!.occurredAt.getTime()).toBeLessThan(stored!.createdAt.getTime());
  });

  it('records an email as a logged activity, since nothing is sent yet', async () => {
    const { id } = await logActivity({
      entityType: 'quote',
      entityId: customerId,
      kind: 'email_out',
      actorId,
      subject: 'Sent the revised quote',
      durationMinutes: 5,
    });

    const [row] = await db.select().from(activities).where(eq(activities.id, id));
    expect(row!.kind).toBe('email_out');
    // Who did it and who typed it, kept apart on purpose.
    expect(row!.userId).toBe(actorId);
    expect(row!.createdBy).toBe(actorId);
  });

  it('refuses a negative duration', async () => {
    await expect(
      logActivity({
        entityType: 'customer',
        entityId: customerId,
        kind: 'call_in',
        actorId,
        durationMinutes: -10,
      }),
    ).rejects.toThrow(/negative/i);
  });
});

describe('acting on a reminder', () => {
  async function open(): Promise<string> {
    const { id } = await createReminder({
      entityType: 'customer',
      entityId: customerId,
      title: 'Call Dave',
      dueOn: addDays(today, 2),
      kind: 'callback',
      actorId,
    });
    return id;
  }

  it('completes with a time and a person', async () => {
    const id = await open();
    await completeReminder({ id, actorId });

    const [row] = await db.select().from(reminders).where(eq(reminders.id, id));
    expect(row!.status).toBe('done');
    expect(row!.completedBy).toBe(actorId);
    expect(row!.completedAt).not.toBeNull();
  });

  /**
   * Snoozing hides a reminder; it does NOT move the deadline. If it did, a
   * quote follow-up could be deferred forever and still look on time, and the
   * screen would report a clean week that never happened.
   */
  it('snoozes without moving the due date', async () => {
    const { id } = await createReminder({
      entityType: 'customer',
      entityId: customerId,
      title: 'Call Dave',
      dueOn: addDays(today, -2),
      kind: 'callback',
      actorId,
    });

    await snoozeReminder({ id, actorId, until: addDays(today, 3) });

    const [row] = await listReminders({ entity: { type: 'customer', id: customerId } });
    expect(row!.dueOn).toBe(addDays(today, -2));
    expect(row!.snoozedUntil).toBe(addDays(today, 3));
    expect(isDue(row!, today)).toBe(false);
    // And it comes back OVERDUE, which is the honest outcome.
    expect(isOverdue(row!, addDays(today, 3))).toBe(true);
  });

  it('refuses a snooze to today or earlier, which changes nothing', async () => {
    const id = await open();
    await expect(snoozeReminder({ id, actorId, until: today })).rejects.toThrow(/changes nothing/i);
  });

  it('clears a snooze when the due date is moved', async () => {
    const id = await open();
    await snoozeReminder({ id, actorId, until: addDays(today, 5) });
    await rescheduleReminder({ id, actorId, dueOn: addDays(today, 1) });

    const [row] = await listReminders({ entity: { type: 'customer', id: customerId } });
    expect(row!.dueOn).toBe(addDays(today, 1));
    expect(row!.snoozedUntil).toBeNull();
  });

  /**
   * A dismissed reminder is a decision not to do something. A voided one
   * should never have existed. Two different events, and the schema keeps them
   * in two columns so a screen can tell them apart.
   */
  it('keeps dismissal and voiding in separate columns', async () => {
    const dismissed = await open();
    await dismissReminder({ id: dismissed, actorId });
    const [one] = await db.select().from(reminders).where(eq(reminders.id, dismissed));
    expect(one!.status).toBe('dismissed');
    expect(one!.recordStatus).toBe('active');

    const voided = await open();
    await voidReminder({ id: voided, actorId, reason: 'Raised against the wrong customer' });
    const [two] = await db.select().from(reminders).where(eq(reminders.id, voided));
    expect(two!.status).toBe('open');
    expect(two!.recordStatus).toBe('void');
    expect(two!.voidReason).toBe('Raised against the wrong customer');
  });

  it('records who dismissed it, which has no column of its own', async () => {
    const id = await open();
    await dismissReminder({ id, actorId });

    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.recordId, id), eq(auditLog.action, 'update')));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.changedBy).toBe(actorId);
  });

  it('refuses a void with no reason, because that is indistinguishable from data loss', async () => {
    const id = await open();
    await expect(voidReminder({ id, actorId, reason: '  ' })).rejects.toThrow(/reason is required/i);
  });

  it('refuses to act on one that is already done', async () => {
    const id = await open();
    await completeReminder({ id, actorId });
    await expect(completeReminder({ id, actorId })).rejects.toThrow(/already done/i);
    await expect(dismissReminder({ id, actorId })).rejects.toThrow(/already done/i);
  });

  it('advances updated_at by trigger, without the application setting it', async () => {
    const id = await open();
    const [before] = await db.select().from(reminders).where(eq(reminders.id, id));
    await db.execute(sql`select pg_sleep(0.01)`);
    await completeReminder({ id, actorId });

    const [after] = await db.select().from(reminders).where(eq(reminders.id, id));
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it('carries the updated_at trigger on all three new tables', async () => {
    // A mirrored table without one updates without moving the sync cursor and
    // silently stops mirroring after its first change.
    const missing = await db.execute(sql`
      select c.table_name
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.column_name = 'updated_at'
        and c.table_name in ('activities', 'reminders', 'reminder_rules')
        and not exists (
          select 1 from pg_trigger tg
          join pg_class cl on cl.oid = tg.tgrelid
          where cl.relname = c.table_name and tg.tgname = 'touch_' || c.table_name
        )
    `);
    expect(missing).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   The one that matters
   ------------------------------------------------------------------------- */

describe('idempotency', () => {
  /**
   * The property the whole design turns on.
   *
   * A rule that has already produced an open reminder for an entity must not
   * produce a second. Without this an hourly job writes twenty-four duplicates
   * a day, the owner stops opening the screen, and a reminder system nobody
   * trusts is worse than no reminder system at all.
   */
  it('creates nothing on a second run against unchanged state', async () => {
    await sendQuote(0, addDays(today, 30));
    await db.update(projects).set({ stage: 'won' }).where(eq(projects.id, projectId));

    const first = await runReminderEvaluation();
    expect(first.inserted).toBeGreaterThan(0);
    const after = await countReminders();

    const second = await runReminderEvaluation();
    // Nothing was drafted, so the application check caught it and the second
    // run was a quiet no-op rather than an exception the index turned back.
    expect(second.drafted).toBe(0);
    expect(second.inserted).toBe(0);
    // And the same facts were still gathered, so it is not passing because the
    // gatherer quietly returned nothing the second time.
    expect(second.factsGathered).toBe(first.factsGathered);
    expect(await countReminders()).toBe(after);
  });

  it('still creates nothing after a day of hourly runs', async () => {
    await sendQuote(0, addDays(today, 30));
    await runReminderEvaluation();
    const after = await countReminders();

    for (let hour = 0; hour < 24; hour += 1) await runReminderEvaluation();
    expect(await countReminders()).toBe(after);
  });

  /**
   * The application check is the friendly half. THIS is the guard.
   *
   * A SELECT followed by an INSERT is not a guard: two evaluations racing
   * after a restart both read an empty result and both insert. The unique
   * partial index is what survives that, so it is asserted directly, with an
   * INSERT that goes around the application entirely.
   */
  it('refuses a duplicate at the database, not only in the application', async () => {
    await sendQuote(0, addDays(today, 30));
    await runReminderEvaluation();

    const [existing] = await db
      .select()
      .from(reminders)
      .where(eq(reminders.generatedByRuleId, ruleFor('quote_sent')));

    const text = await rejectionText(() => db.execute(sql`
      insert into reminders
        (entity_type, entity_id, title, due_at, kind, status, generated_by_rule_id)
      values (
        ${existing!.entityType}, ${existing!.entityId}, 'A racing duplicate',
        now(), 'follow_up', 'open', ${existing!.generatedByRuleId}
      )
    `));
    expect(text).toMatch(/duplicate key|unique/i);
    expect(text).toContain('reminders_one_open_per_rule');
  });

  /**
   * What the index deliberately ALLOWS. A quote followed up in March and still
   * open in June should be chased again -- a rule that fired exactly once per
   * entity for all time would go quiet on precisely the jobs that need
   * chasing most.
   */
  it('lets the rule fire again once the reminder is completed', async () => {
    await sendQuote(0, addDays(today, 30));
    await runReminderEvaluation();

    const [first] = await remindersFromRule(ruleFor('quote_sent'));
    await completeReminder({ id: first!.id, actorId });

    const again = await runReminderEvaluation();
    expect(again.inserted).toBeGreaterThan(0);

    const rows = await remindersFromRule(ruleFor('quote_sent'));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === 'open')).toHaveLength(1);
  });

  it('lets it fire again once the reminder is voided, since a void row is not open', async () => {
    await sendQuote(0, addDays(today, 30));
    await runReminderEvaluation();

    const [first] = await remindersFromRule(ruleFor('quote_sent'));
    await voidReminder({ id: first!.id, actorId, reason: 'Raised against the wrong quote' });

    await runReminderEvaluation();
    expect(await remindersFromRule(ruleFor('quote_sent'))).toHaveLength(1);
  });

  /**
   * Hand-made reminders carry no rule id, and PostgreSQL treats nulls as
   * distinct in a unique index -- so they sit outside it entirely. The owner
   * may write "call Dave" twice if he wants to. That is a person repeating
   * himself, not the machine duplicating itself.
   */
  it('lets a person write the same reminder twice', async () => {
    await createReminder({
      entityType: 'customer', entityId: customerId, title: 'Call Dave',
      dueOn: addDays(today, 1), kind: 'callback', actorId,
    });
    await createReminder({
      entityType: 'customer', entityId: customerId, title: 'Call Dave',
      dueOn: addDays(today, 1), kind: 'callback', actorId,
    });

    const rows = await listReminders({ entity: { type: 'customer', id: customerId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.generatedByRuleId === null)).toBe(true);
  });
});
