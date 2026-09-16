import { and, desc, eq, gte, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { activityKindEnum } from '@/db/enums';
import {
  activities, customers, organization, projects, quotes, reminderRules, reminders,
} from '@/db/schema';
import { seedDefaultReminderRules } from '@/db/seed/reminder-rules';
import { searchCondition } from '@/lib/list/search';
import { tenantToday } from '@/lib/quote/dates';
import type { Tx } from '@/lib/quote/repository';
import { evaluateRules } from '@/lib/reminders/rules';
import {
  reminderKey,
  type EntityType,
  type ReminderDraft,
  type ReminderKind,
  type ReminderRule,
  type TriggerFact,
} from '@/lib/reminders/types';

/**
 * Derived from the enum rather than declared again.
 *
 * `types.ts` declares its own unions because the evaluator is pure and has to
 * compile without a schema. Nothing in the evaluator reasons about an
 * activity, so this one has no reason to exist twice -- and a member added to
 * the enum is then automatically a member here.
 */
export type ActivityKind = (typeof activityKindEnum.enumValues)[number];

/**
 * Persistence for the reminder engine.
 *
 * The division of labour is deliberate and load-bearing: `rules.ts` decides
 * and this file gathers and stores. The evaluator never queries, so every
 * interesting case -- the day a quote expires, the day a threshold is crossed
 * -- is testable at its boundary without a database. This file never decides,
 * so there is one implementation of "when is it due" rather than two that
 * disagree the first time somebody edits one of them.
 *
 * TIMEZONE. Every date in here is the tenant's, from `tenantToday`, and every
 * conversion between a stored instant and a day is done by PostgreSQL against
 * `organization.timezone`. Nothing calls `new Date()`: in a UTC container
 * after 7pm Toronto the server's day and the tenant's day are different, and a
 * reminder due "today" that appears tomorrow reads as the system being broken.
 */

/**
 * The whole vocabulary a title template may use.
 *
 * A closed set resolved server-side, and it must stay one. The moment a
 * template can reach an arbitrary field it is a template language, and a
 * template language in a settings form is an expression evaluator somebody
 * will eventually point at the database. `unknownPlaceholders` in `rules.ts`
 * validates against this list when a rule is SAVED, which is where a mistyped
 * field should fail -- not at 3am when it fires.
 */
export const TITLE_FIELDS = ['customer', 'project', 'number', 'address', 'stage', 'date'] as const;

export interface EvaluationSummary {
  /** The tenant's date the run was evaluated against. */
  today: string;
  rulesConsidered: number;
  factsGathered: number;
  /** What the evaluator proposed after the application-level idempotency check. */
  drafted: number;
  /**
   * What the database actually accepted. Lower than `drafted` only when the
   * unique index caught a race the application check could not -- two
   * evaluations after a restart, say -- which is exactly the case it exists
   * for.
   */
  inserted: number;
}

/* -------------------------------------------------------------------------
   Tenant time
   ------------------------------------------------------------------------- */

async function tenantTimezone(tx: Tx): Promise<string> {
  const [row] = await tx
    .select({ timezone: organization.timezone })
    .from(organization)
    .where(eq(organization.id, 1));
  if (!row) throw new Error('organization row is missing; run setup first');
  return row.timezone;
}

/** An ISO date, read off a stored instant in the tenant's zone. */
function localDate(column: PgColumn | SQL, timezone: string): SQL<string> {
  return sql<string>`to_char((${column} at time zone ${timezone})::date, 'YYYY-MM-DD')`;
}

/**
 * The instant an ISO date begins in the tenant's zone.
 *
 * The conversion happens in PostgreSQL rather than in JavaScript because it is
 * the only party here that holds a timezone database. Building the instant
 * from a `Date` would be right in Toronto in August and an hour out in
 * November.
 */
function atTenantStartOfDay(isoDate: string, timezone: string): SQL {
  return sql`((${isoDate})::timestamp at time zone ${timezone})`;
}

/* -------------------------------------------------------------------------
   Gathering
   ------------------------------------------------------------------------- */

type FactRow = Record<string, string | null>;

async function rawRows(tx: Tx, query: SQL): Promise<FactRow[]> {
  return (await tx.execute(query)) as unknown as FactRow[];
}

/** A site address a person would recognise, or the job name when there is none. */
function addressOf(row: { line1: string | null; city: string | null; project: string }): string {
  const parts = [row.line1, row.city].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : row.project;
}

/**
 * Everything that could trigger a rule today, as plain facts.
 *
 * Gathered for every trigger regardless of which rules exist, because the
 * volumes here are a contractor's -- tens of open quotes, not millions -- and
 * a gatherer that branches on the rule set is a gatherer that silently returns
 * nothing the first time somebody adds a rule for a trigger it forgot.
 */
export async function gatherFacts(tx: Tx, today: string, timezone: string): Promise<TriggerFact[]> {
  const facts: TriggerFact[] = [];

  /* --- Quotes that went out, and quotes about to run out ----------------- */

  const sentQuotes = await tx
    .select({
      id: quotes.id,
      number: quotes.quoteNumber,
      sentOn: localDate(quotes.sentAt, timezone),
      validUntil: quotes.validUntil,
      customer: customers.name,
      project: projects.name,
    })
    .from(quotes)
    .innerJoin(projects, eq(quotes.projectId, projects.id))
    .innerJoin(customers, eq(projects.customerId, customers.id))
    .where(and(
      eq(quotes.status, 'sent'),
      eq(quotes.recordStatus, 'active'),
      isNotNull(quotes.sentAt),
    ));

  for (const quote of sentQuotes) {
    const fields = {
      customer: quote.customer,
      project: quote.project,
      number: quote.number,
      address: quote.project,
      stage: 'quote_sent',
      date: quote.sentOn,
    };

    facts.push({
      trigger: 'quote_sent',
      entityType: 'quote',
      entityId: quote.id,
      anchorDate: quote.sentOn,
      fields,
    });

    // A quote that expired two months ago and is still marked sent produces no
    // expiry fact. "Quote QT-0007 expires in 5 days" would be a false
    // statement, and a reminder that lies about its own reason is the first
    // one the owner learns to ignore. Chasing it is what the follow-up rule
    // above is for.
    if (quote.validUntil >= today) {
      facts.push({
        trigger: 'quote_expiring',
        entityType: 'quote',
        entityId: quote.id,
        anchorDate: quote.validUntil,
        fields: { ...fields, date: quote.validUntil },
      });
    }
  }

  /* --- Site visits, which are the appointments somebody has to drive to -- */

  const visits = await tx
    .select({
      id: projects.id,
      project: projects.name,
      scheduledStart: projects.scheduledStart,
      line1: projects.siteAddressLine1,
      city: projects.siteCity,
      customer: customers.name,
    })
    .from(projects)
    .innerJoin(customers, eq(projects.customerId, customers.id))
    .where(and(
      eq(projects.stage, 'site_visit'),
      eq(projects.recordStatus, 'active'),
      isNotNull(projects.scheduledStart),
      gte(projects.scheduledStart, today),
    ));

  for (const visit of visits) {
    facts.push({
      trigger: 'site_visit_scheduled',
      entityType: 'project',
      entityId: visit.id,
      anchorDate: visit.scheduledStart!,
      fields: {
        customer: visit.customer,
        project: visit.project,
        number: visit.project,
        address: addressOf({ line1: visit.line1, city: visit.city, project: visit.project }),
        stage: 'site_visit',
        date: visit.scheduledStart!,
      },
    });
  }

  /* --- Stage changes, read from the history the trigger already writes --- */

  // The LATEST entry per project, not every entry. A rule watching a stage
  // should fire for a job that is in that stage now; firing again for one it
  // passed through in March would put a reminder about a finished step on a
  // job that has moved on twice since.
  const entered = await rawRows(tx, sql`
    select distinct on (h.project_id)
      h.project_id                                as project_id,
      h.to_stage::text                            as stage,
      to_char((h.changed_at at time zone ${timezone})::date, 'YYYY-MM-DD') as entered_on,
      p.name                                      as project,
      c.name                                      as customer,
      p.site_address_line1                        as line1,
      p.site_city                                 as city
    from stage_history h
    join projects p on p.id = h.project_id and p.record_status = 'active'
    join customers c on c.id = p.customer_id
    order by h.project_id, h.changed_at desc, h.id desc
  `);

  for (const row of entered) {
    const project = row.project ?? '';
    const fields = {
      customer: row.customer ?? '',
      project,
      number: project,
      address: addressOf({ line1: row.line1, city: row.city, project }),
      stage: row.stage ?? '',
      date: row.entered_on ?? today,
    };

    facts.push({
      trigger: 'stage_entered',
      entityType: 'project',
      entityId: row.project_id!,
      anchorDate: row.entered_on ?? today,
      stage: row.stage ?? undefined,
      fields,
    });

    // `project_won` is a named trigger of its own rather than a stage rule the
    // owner has to write, because winning is the one transition that always
    // has a next action behind it -- and a rule he has to discover is a rule
    // that is not there on the first day.
    if (row.stage === 'won') {
      facts.push({
        trigger: 'project_won',
        entityType: 'project',
        entityId: row.project_id!,
        anchorDate: row.entered_on ?? today,
        fields,
      });
    }
  }

  /* --- Customers nobody has spoken to ----------------------------------- */

  // The expensive rule: the only trigger that scans rather than reacting to an
  // event, and the one most likely to make noise as the customer list grows.
  //
  // Narrowed to customers with LIVE work -- an open opportunity or a job in
  // flight. Without that it fires against every name ever entered, and a
  // fourteen-day silence with somebody whose basement was finished in 2019 is
  // not a fact worth a row on the screen.
  //
  // Activity counts wherever it was logged: against the customer, against one
  // of their projects, or against a quote on one of those projects. An owner
  // logs a call where he happens to be standing, and a rule that only reads
  // one of the three would chase a customer he spoke to yesterday.
  const quiet = await rawRows(tx, sql`
    select
      c.id   as customer_id,
      c.name as customer,
      to_char(
        (coalesce(max(a.occurred_at), c.created_at) at time zone ${timezone})::date,
        'YYYY-MM-DD'
      ) as last_contact
    from customers c
    join projects p
      on p.customer_id = c.id
     and p.record_status = 'active'
     and p.stage not in ('lost', 'complete')
    left join quotes q on q.project_id = p.id and q.record_status = 'active'
    left join activities a
      on a.record_status = 'active'
     and (
          (a.entity_type = 'customer' and a.entity_id = c.id)
       or (a.entity_type = 'project'  and a.entity_id = p.id)
       or (a.entity_type = 'quote'    and a.entity_id = q.id)
     )
    where c.record_status = 'active'
    group by c.id, c.name, c.created_at
  `);

  for (const row of quiet) {
    facts.push({
      trigger: 'no_activity',
      entityType: 'customer',
      entityId: row.customer_id!,
      anchorDate: row.last_contact!,
      fields: {
        customer: row.customer ?? '',
        project: '',
        number: '',
        address: '',
        stage: '',
        date: row.last_contact!,
      },
    });
  }

  return facts;
}

/* -------------------------------------------------------------------------
   Evaluation
   ------------------------------------------------------------------------- */

async function loadRules(tx: Tx): Promise<ReminderRule[]> {
  // `record_status` is filtered here rather than in the evaluator, which knows
  // nothing about it: a voided rule is a rule that should never have existed,
  // and it must not fire even though `is_active` may still say true.
  const rows = await tx
    .select({
      id: reminderRules.id,
      name: reminderRules.name,
      trigger: reminderRules.trigger,
      triggerStage: reminderRules.triggerStage,
      offsetDays: reminderRules.offsetDays,
      reminderKind: reminderRules.reminderKind,
      titleTemplate: reminderRules.titleTemplate,
      isActive: reminderRules.isActive,
    })
    .from(reminderRules)
    .where(eq(reminderRules.recordStatus, 'active'));

  return rows;
}

/**
 * The keys of every reminder a rule already has open.
 *
 * This is the FRIENDLY half of idempotency. It is what makes a second
 * evaluation a quiet no-op, and it is not the guard: between this SELECT and
 * the INSERT that follows, another evaluation can insert the same row. The
 * unique partial index `reminders_one_open_per_rule` is what actually holds,
 * and the insert below leans on it.
 */
async function loadOpenKeys(tx: Tx): Promise<Set<string>> {
  const rows = await tx
    .select({
      ruleId: reminders.generatedByRuleId,
      entityType: reminders.entityType,
      entityId: reminders.entityId,
    })
    .from(reminders)
    .where(and(
      eq(reminders.status, 'open'),
      eq(reminders.recordStatus, 'active'),
      isNotNull(reminders.generatedByRuleId),
    ));

  return new Set(rows.map((row) => reminderKey(row.ruleId!, row.entityType, row.entityId)));
}

async function insertDrafts(
  tx: Tx,
  drafts: readonly ReminderDraft[],
  timezone: string,
): Promise<number> {
  if (drafts.length === 0) return 0;

  const inserted = await tx
    .insert(reminders)
    .values(drafts.map((draft) => ({
      entityType: draft.entityType,
      entityId: draft.entityId,
      title: draft.title,
      kind: draft.kind,
      dueAt: atTenantStartOfDay(draft.dueOn, timezone),
      status: 'open' as const,
      generatedByRuleId: draft.ruleId,
    })))
    // Names the partial index by repeating its predicate, which is how
    // PostgreSQL is told WHICH index to infer. Without the WHERE it cannot
    // match a partial index and the statement fails outright -- so this clause
    // is not decoration, it is the difference between a quiet no-op and a job
    // that dies every hour.
    .onConflictDoNothing({
      target: [reminders.generatedByRuleId, reminders.entityType, reminders.entityId],
      where: sql`status = 'open' and record_status = 'active'`,
    })
    .returning({ id: reminders.id });

  return inserted.length;
}

/**
 * One pass of the scheduler.
 *
 * Runs hourly, and the property that matters is that running it twice against
 * unchanged state creates nothing the second time. An hourly job without that
 * writes twenty-four duplicates a day, and the owner stops opening the screen
 * -- which is the only failure mode that matters, because a reminder system
 * nobody trusts is worse than no reminder system.
 *
 * Everything is one transaction: the facts, the open keys and the insert see
 * one state of the database. Gathering outside it would let a quote be
 * accepted between the read and the write, and the follow-up reminder for a
 * job already won would appear with nothing to explain it.
 */
export async function runReminderEvaluation(): Promise<EvaluationSummary> {
  return db.transaction(async (tx) => {
    // The defaults are seeded here rather than in `scripts/seed.ts`, which
    // only runs for the demo tenant. A real installation would otherwise reach
    // its first evaluation with no rules and produce nothing, silently. The
    // insert is keyed on fixed ids and does nothing when they exist, so a rule
    // the owner has edited or switched off is never restored.
    await seedDefaultReminderRules(tx);

    const today = await tenantToday(tx);
    const timezone = await tenantTimezone(tx);

    const rules = await loadRules(tx);
    const facts = await gatherFacts(tx, today, timezone);
    const openKeys = await loadOpenKeys(tx);

    const drafts = evaluateRules(rules, facts, { today, openKeys });
    const inserted = await insertDrafts(tx, drafts, timezone);

    return {
      today,
      rulesConsidered: rules.length,
      factsGathered: facts.length,
      drafted: drafts.length,
      inserted,
    };
  });
}

/* -------------------------------------------------------------------------
   Reading
   ------------------------------------------------------------------------- */

export interface ReminderRow {
  id: string;
  entityType: EntityType;
  entityId: string;
  title: string;
  detail: string | null;
  kind: ReminderKind;
  status: 'open' | 'done' | 'dismissed';
  /** The tenant's date it is due on, which is what `isDue` compares. */
  dueOn: string;
  /** The tenant's date it comes back on, or null. The due date does not move. */
  snoozedUntil: string | null;
  assignedTo: string | null;
  generatedByRuleId: string | null;
}

export interface ListRemindersOptions {
  status?: 'open' | 'done' | 'dismissed';
  entity?: { type: EntityType; id: string };
  /**
   * Free text, matched in SQL over the title and the detail.
   *
   * In SQL rather than over the returned array, per the rule the list screens
   * already follow: filtering in the browser is only correct while the whole
   * list is in it, which stops being true the first time this needs a page.
   */
  search?: string;
  /**
   * How many rows at most. Absent means every one, which is correct for the
   * evaluator and wrong for a screen -- see `/reminders`, which is why this
   * exists: `reminders` is machine-written by the hourly job and grows faster
   * than any table an owner types into.
   */
  limit?: number;
}

/**
 * Reminders, with their dates already resolved into the tenant's zone.
 *
 * Resolved here rather than by the caller so that `isDue` and `isOverdue` in
 * `rules.ts` -- which compare ISO date strings -- are handed values that mean
 * what they say. A screen doing its own `toISOString()` on `due_at` would show
 * tomorrow's reminders after 7pm.
 */
export async function listReminders(
  options: ListRemindersOptions = {},
  executor: Tx | null = null,
): Promise<ReminderRow[]> {
  const run = async (tx: Tx): Promise<ReminderRow[]> => {
    const timezone = await tenantTimezone(tx);
    const conditions = [eq(reminders.recordStatus, 'active')];
    if (options.status) conditions.push(eq(reminders.status, options.status));
    if (options.entity) {
      conditions.push(eq(reminders.entityType, options.entity.type));
      conditions.push(eq(reminders.entityId, options.entity.id));
    }
    const search = searchCondition(options.search ?? '', [reminders.title, reminders.detail]);
    if (search) conditions.push(search);

    return tx
      .select({
        id: reminders.id,
        entityType: reminders.entityType,
        entityId: reminders.entityId,
        title: reminders.title,
        detail: reminders.detail,
        kind: reminders.kind,
        status: reminders.status,
        dueOn: localDate(reminders.dueAt, timezone),
        snoozedUntil: sql<string | null>`case when ${reminders.snoozedUntil} is null then null else ${localDate(reminders.snoozedUntil, timezone)} end`,
        assignedTo: reminders.assignedTo,
        generatedByRuleId: reminders.generatedByRuleId,
      })
      .from(reminders)
      .where(and(...conditions))
      .orderBy(reminders.dueAt, reminders.id)
      .limit(options.limit ?? Number.MAX_SAFE_INTEGER);
  };

  return executor ? run(executor) : db.transaction(run);
}

/**
 * What a reminder is ABOUT, in words a person recognises.
 *
 * A reminder carries `entity_type` and `entity_id` and nothing else, which is
 * the right shape for the engine and useless on a screen: "Follow up on quote
 * to Sample Client" beside a uuid tells the owner nothing about which job, and
 * gives him nowhere to press. Resolved here, in one pass over the whole list,
 * rather than per row -- a list of twenty reminders should cost three queries,
 * not sixty.
 */
export interface EntityRef {
  type: EntityType;
  id: string;
  /** The thing itself: the job's name, or the customer's. */
  label: string;
  /** Who it is for, and the document number when there is one. */
  sub: string | null;
  href: string;
}

/** The key both sides of the lookup agree on. */
export function entityKey(type: EntityType, id: string): string {
  return `${type}:${id}`;
}

export async function describeEntities(
  refs: readonly { entityType: EntityType; entityId: string }[],
  executor: Tx | typeof db = db,
): Promise<Map<string, EntityRef>> {
  const found = new Map<string, EntityRef>();
  const idsOf = (type: EntityType): string[] =>
    [...new Set(refs.filter((ref) => ref.entityType === type).map((ref) => ref.entityId))];

  const customerIds = idsOf('customer');
  if (customerIds.length > 0) {
    const rows = await executor
      .select({ id: customers.id, name: customers.name, company: customers.companyName })
      .from(customers)
      .where(inArray(customers.id, customerIds));
    for (const row of rows) {
      found.set(entityKey('customer', row.id), {
        type: 'customer',
        id: row.id,
        label: row.name,
        sub: row.company,
        href: `/customers/${row.id}`,
      });
    }
  }

  const projectIds = idsOf('project');
  if (projectIds.length > 0) {
    const rows = await executor
      .select({
        id: projects.id,
        name: projects.name,
        number: projects.projectNumber,
        customer: customers.name,
      })
      .from(projects)
      .innerJoin(customers, eq(projects.customerId, customers.id))
      .where(inArray(projects.id, projectIds));
    for (const row of rows) {
      found.set(entityKey('project', row.id), {
        type: 'project',
        id: row.id,
        label: row.name,
        sub: `${row.customer} · ${row.number}`,
        href: `/projects/${row.id}`,
      });
    }
  }

  const quoteIds = idsOf('quote');
  if (quoteIds.length > 0) {
    const rows = await executor
      .select({
        id: quotes.id,
        number: quotes.quoteNumber,
        project: projects.name,
        customer: customers.name,
      })
      .from(quotes)
      .innerJoin(projects, eq(quotes.projectId, projects.id))
      .innerJoin(customers, eq(projects.customerId, customers.id))
      .where(inArray(quotes.id, quoteIds));
    for (const row of rows) {
      found.set(entityKey('quote', row.id), {
        type: 'quote',
        id: row.id,
        label: row.project,
        sub: `${row.customer} · ${row.number}`,
        href: `/quotes/${row.id}`,
      });
    }
  }

  return found;
}

export interface ActivityRow {
  id: string;
  entityType: EntityType;
  entityId: string;
  kind: ActivityKind;
  occurredAt: Date;
  subject: string | null;
  body: string | null;
  durationMinutes: number | null;
  userId: string | null;
}

/**
 * One entity's timeline, newest first.
 *
 * Ordered by `occurred_at`, never `created_at`. An owner who logs Tuesday's
 * call on Thursday must see it under Tuesday, or the timeline is a record of
 * his typing rather than of the job.
 */
export async function listTimeline(
  entityType: EntityType,
  entityId: string,
  executor: Tx | typeof db = db,
): Promise<ActivityRow[]> {
  return executor
    .select({
      id: activities.id,
      entityType: activities.entityType,
      entityId: activities.entityId,
      kind: activities.kind,
      occurredAt: activities.occurredAt,
      subject: activities.subject,
      body: activities.body,
      durationMinutes: activities.durationMinutes,
      userId: activities.userId,
    })
    .from(activities)
    .where(and(
      eq(activities.entityType, entityType),
      eq(activities.entityId, entityId),
      eq(activities.recordStatus, 'active'),
    ))
    .orderBy(desc(activities.occurredAt), desc(activities.id));
}

/* -------------------------------------------------------------------------
   Writing
   ------------------------------------------------------------------------- */

/**
 * Attributes the write to a person for the audit trigger.
 *
 * The trigger reads `app.user_id` and falls back to `created_by`, which exists
 * only on an insert. Without this an UPDATE -- dismissing a reminder, say --
 * lands in the audit log with a null actor, and the log cannot answer the one
 * question it is kept for. `set_config(..., true)` is transaction-local, so it
 * cannot leak into the next request on a pooled connection.
 */
async function attribute(tx: Tx, actorId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.user_id', ${actorId}, true)`);
}

async function loadReminder(tx: Tx, id: string) {
  const [row] = await tx.select().from(reminders).where(eq(reminders.id, id));
  if (!row) throw new Error(`reminder ${id} not found`);
  return row;
}

/** Only an open, live reminder can be acted on. Says which of the two it failed. */
function assertActionable(row: { status: string; recordStatus: string }, verb: string): void {
  if (row.recordStatus !== 'active') throw new Error(`a void reminder cannot be ${verb}`);
  if (row.status !== 'open') throw new Error(`this reminder is already ${row.status}`);
}

export interface CreateReminderArgs {
  entityType: EntityType;
  entityId: string;
  title: string;
  /** An ISO date in the tenant's zone. */
  dueOn: string;
  kind: ReminderKind;
  actorId: string;
  detail?: string | null;
  assignedTo?: string | null;
}

/**
 * A reminder somebody wrote by hand.
 *
 * `generated_by_rule_id` stays NULL, which puts the row outside
 * `reminders_one_open_per_rule` entirely -- PostgreSQL treats nulls as
 * distinct. The owner may write "call Dave" twice if he wants to. That is a
 * person repeating himself, not the machine duplicating itself, and the
 * database has no business refusing it.
 */
export async function createReminder(args: CreateReminderArgs): Promise<{ id: string }> {
  const title = args.title.trim();
  if (title.length === 0) throw new Error('a reminder needs a title');

  return db.transaction(async (tx) => {
    await attribute(tx, args.actorId);
    const timezone = await tenantTimezone(tx);

    const [row] = await tx
      .insert(reminders)
      .values({
        entityType: args.entityType,
        entityId: args.entityId,
        title,
        detail: args.detail ?? null,
        kind: args.kind,
        dueAt: atTenantStartOfDay(args.dueOn, timezone),
        status: 'open',
        assignedTo: args.assignedTo ?? null,
        generatedByRuleId: null,
        createdBy: args.actorId,
      })
      .returning({ id: reminders.id });

    return { id: row!.id };
  });
}

/**
 * Done.
 *
 * Completing releases the row from the unique index, so the rule that produced
 * it may produce another later. That is correct rather than a leak: a quote
 * followed up in March and still open in June should be chased again, and a
 * rule that fires exactly once per entity for all time would go quiet on
 * precisely the jobs that need chasing most.
 */
export async function completeReminder(args: { id: string; actorId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    await attribute(tx, args.actorId);
    const row = await loadReminder(tx, args.id);
    assertActionable(row, 'completed');

    // `updated_at` is absent on purpose: the trigger maintains it, and setting
    // it here would be a second authority that disagrees the first time
    // somebody writes a stale value.
    await tx
      .update(reminders)
      .set({ status: 'done', completedAt: new Date(), completedBy: args.actorId })
      .where(eq(reminders.id, args.id));
  });
}

/**
 * Not now.
 *
 * The due date DOES NOT MOVE. A reminder snoozed past its deadline comes back
 * overdue, which is the honest outcome: if snoozing pushed the deadline, a
 * quote follow-up could be deferred indefinitely and still look on time, and
 * the screen would report a clean week that never happened.
 */
export async function snoozeReminder(
  args: { id: string; actorId: string; until: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await attribute(tx, args.actorId);
    const timezone = await tenantTimezone(tx);
    const today = await tenantToday(tx);
    if (args.until <= today) throw new Error('snooze it to a day after today, or it changes nothing');

    const row = await loadReminder(tx, args.id);
    assertActionable(row, 'snoozed');

    await tx
      .update(reminders)
      .set({ snoozedUntil: atTenantStartOfDay(args.until, timezone) })
      .where(eq(reminders.id, args.id));
  });
}

/**
 * Not doing it.
 *
 * Dismissal is a decision about the task; `record_status = 'void'` is a
 * statement that the row should never have existed. Two different events, and
 * the schema keeps them in two columns for that reason.
 *
 * There is no dismissal reason, because the table has no column for one and
 * borrowing `void_reason` would put two meanings in a field the void path
 * already owns. Who dismissed it and when is in the audit log, which is why
 * this table carries the audit trigger at all.
 */
export async function dismissReminder(args: { id: string; actorId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    await attribute(tx, args.actorId);
    const row = await loadReminder(tx, args.id);
    assertActionable(row, 'dismissed');

    await tx.update(reminders).set({ status: 'dismissed' }).where(eq(reminders.id, args.id));
  });
}

/**
 * A different day.
 *
 * Clears any snooze, because moving the deadline is a decision about when this
 * should be in front of somebody, and a snooze left behind would hide the
 * reminder on the very day the owner just said he wants it.
 */
export async function rescheduleReminder(
  args: { id: string; actorId: string; dueOn: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await attribute(tx, args.actorId);
    const timezone = await tenantTimezone(tx);
    const row = await loadReminder(tx, args.id);
    assertActionable(row, 'rescheduled');

    await tx
      .update(reminders)
      .set({ dueAt: atTenantStartOfDay(args.dueOn, timezone), snoozedUntil: null })
      .where(eq(reminders.id, args.id));
  });
}

/**
 * Created in error.
 *
 * The replacement for a DELETE this application could not issue anyway -- the
 * `quote_app` role holds no DELETE privilege, so a stray delete is a
 * permission error rather than a destroyed record. A reason is required for
 * the same reason a void reason is required everywhere else: a voided row with
 * no explanation is indistinguishable from data loss.
 */
export async function voidReminder(
  args: { id: string; actorId: string; reason: string },
): Promise<void> {
  const reason = args.reason.trim();
  if (reason.length === 0) throw new Error('a void reason is required');

  await db.transaction(async (tx) => {
    await attribute(tx, args.actorId);
    const row = await loadReminder(tx, args.id);
    if (row.recordStatus !== 'active') throw new Error('this reminder is already void');

    await tx
      .update(reminders)
      .set({
        recordStatus: 'void',
        voidedAt: new Date(),
        voidedBy: args.actorId,
        voidReason: reason,
      })
      .where(eq(reminders.id, args.id));
  });
}

export interface LogActivityArgs {
  entityType: EntityType;
  entityId: string;
  kind: ActivityKind;
  actorId: string;
  /**
   * When it happened, as an ISO date in the tenant's zone, or a full instant.
   * Defaults to now. This is the field the timeline orders by, and it is not
   * `created_at`: Tuesday's call logged on Thursday belongs under Tuesday.
   */
  occurredOn?: string | Date;
  subject?: string | null;
  body?: string | null;
  durationMinutes?: number | null;
  /** Who did the thing, when that is not who is typing. Defaults to the actor. */
  userId?: string | null;
}

/**
 * Writes one thing that happened.
 *
 * This is also the log-an-email action the Phase 2 plan ships INSTEAD of
 * sending mail. Sending is deferred with a trigger rather than cut: the
 * realistic failure mode of an outbound mailer on a mini PC in an office is
 * the machine being unplugged, and a mail job on a dead machine sends nothing
 * while looking exactly like one that works. It is revisited once there is
 * evidence the owner opens the reminder screen at all.
 */
export async function logActivity(args: LogActivityArgs): Promise<{ id: string }> {
  if (args.durationMinutes !== undefined && args.durationMinutes !== null
      && args.durationMinutes < 0) {
    throw new Error('a duration cannot be negative');
  }

  return db.transaction(async (tx) => {
    await attribute(tx, args.actorId);
    const timezone = await tenantTimezone(tx);

    // A bare ISO date means "that day", which is a day in the TENANT's zone --
    // parsing it in JavaScript would make it midnight UTC and file a call
    // logged for Tuesday under Monday evening.
    const occurredAt = args.occurredOn === undefined
      ? sql`now()`
      : args.occurredOn instanceof Date
        ? args.occurredOn
        : atTenantStartOfDay(args.occurredOn, timezone);

    const [row] = await tx
      .insert(activities)
      .values({
        entityType: args.entityType,
        entityId: args.entityId,
        kind: args.kind,
        occurredAt,
        subject: args.subject ?? null,
        body: args.body ?? null,
        durationMinutes: args.durationMinutes ?? null,
        userId: args.userId === undefined ? args.actorId : args.userId,
        createdBy: args.actorId,
      })
      .returning({ id: activities.id });

    return { id: row!.id };
  });
}

/** Logged in error. The same deletion replacement, for the same reason. */
export async function voidActivity(
  args: { id: string; actorId: string; reason: string },
): Promise<void> {
  const reason = args.reason.trim();
  if (reason.length === 0) throw new Error('a void reason is required');

  await db.transaction(async (tx) => {
    await attribute(tx, args.actorId);
    const [row] = await tx.select().from(activities).where(eq(activities.id, args.id));
    if (!row) throw new Error(`activity ${args.id} not found`);
    if (row.recordStatus !== 'active') throw new Error('this activity is already void');

    await tx
      .update(activities)
      .set({
        recordStatus: 'void',
        voidedAt: new Date(),
        voidedBy: args.actorId,
        voidReason: reason,
      })
      .where(eq(activities.id, args.id));
  });
}
