import { asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';

/**
 * `revalidatePath` and `headers` are request-scoped Next APIs and there is no
 * request here. Mocked rather than avoided, for the same reason
 * `setup.test.ts` mocks the first: the action genuinely must call them, and a
 * test that routed around them would be testing a different function.
 *
 * The identity header is what the proxy writes after it has verified an Access
 * token or read a session, so supplying it here is exactly what a signed-in
 * request looks like to the action.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-identity-email': 'owner@example.invalid' }),
}));

import { db } from '@/db/client';
import {
  customers, organization, projects, quoteLines, quotes, stageHistory, users,
} from '@/db/schema';
// After the mocks above, deliberately: this pulls in the database client,
// and the module under test must not be loaded before they are installed.
import { seedDeployment } from '../support/organization';
import { setProjectStage } from '@/app/projects/actions';
import { setQuoteStatus } from '@/app/quotes/[id]/actions';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';

/**
 * A job can never sit in a pre-sale stage, and `won` is not a stage anybody
 * sets: a job exists BECAUSE a quote on it was accepted.
 *
 * The dropdown narrows itself, but a dropdown is a hint. These assert the
 * refusals in the action, because that is what a stale tab and a hand-made
 * POST both go through.
 */

let opportunityId: string;
let jobId: string;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

function errorOf(result: { ok: boolean } & Record<string, unknown>): string {
  expect(result.ok).toBe(false);
  return String(result.error);
}

async function stageOf(id: string): Promise<string> {
  const [row] = await db.select({ stage: projects.stage }).from(projects).where(eq(projects.id, id));
  return row!.stage;
}

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, stage_history, sessions, user_identities, quote_taxes, quote_lines,
    quotes, scope_template_items, scope_templates, rate_items, cost_codes, tax_rates,
    projects, customers, users, organization, companies, document_sequences
    restart identity cascade
  `);

  await seedDeployment({
    legalName: 'Test Company Ltd',
    displayName: 'Test Company',
    timezone: 'America/Toronto',
  });

  // The action is guarded, so the identity in the mocked header has to resolve
  // to a real active user with a role that carries `quote:write`.
  await db.insert(users).values({
    email: 'owner@example.invalid',
    displayName: 'Test Owner',
    role: 'owner',
    isActive: true,
  });

  const [customer] = await db
    .insert(customers)
    .values({ name: 'Test Customer', customerType: 'residential' })
    .returning();

  const [opportunity] = await db
    .insert(projects)
    .values({ companyId: FIRST_COMPANY_ID,
      customerId: customer!.id,
      projectNumber: 'P-0001',
      name: 'Nothing won yet',
      projectTypeId: PROJECT_TYPE_IDS.basement,
      stage: 'quote_sent',
    })
    .returning();
  opportunityId = opportunity!.id;

  const [job] = await db
    .insert(projects)
    .values({ companyId: FIRST_COMPANY_ID,
      customerId: customer!.id,
      projectNumber: 'P-0002',
      name: 'Work under contract',
      projectTypeId: PROJECT_TYPE_IDS.basement,
      stage: 'won',
    })
    .returning();
  jobId = job!.id;

  // What MAKES the second one a job. The stage alone does not: the rule is
  // derived from an accepted quote existing, so a row whose stage says `won`
  // with nothing accepted behind it would still be treated as an opportunity.
  await db.insert(quotes).values({
    projectId: jobId,
    quoteNumber: 'QT-0001',
    kind: 'estimate',
    sequence: 1,
    version: 1,
    status: 'accepted',
    quoteDate: '2026-01-10',
    validUntil: '2026-02-10',
  });
});

describe('an opportunity', () => {
  it('moves freely among the pre-sale stages', async () => {
    const result = await setProjectStage(null, form({ id: opportunityId, stage: 'site_visit' }));
    expect(result.ok).toBe(true);
    expect(await stageOf(opportunityId)).toBe('site_visit');
  });

  it('cannot be marked won, because winning is what accepting a quote does', async () => {
    const message = errorOf(await setProjectStage(null, form({ id: opportunityId, stage: 'won' })));
    expect(message).toMatch(/accept a quote/i);
    expect(await stageOf(opportunityId)).toBe('quote_sent');
  });

  it('cannot go straight to in progress with nothing sold', async () => {
    const message = errorOf(
      await setProjectStage(null, form({ id: opportunityId, stage: 'in_progress' })),
    );
    expect(message).toMatch(/opportunity/i);
    expect(await stageOf(opportunityId)).toBe('quote_sent');
  });

  it('cannot be completed before it is won', async () => {
    errorOf(await setProjectStage(null, form({ id: opportunityId, stage: 'complete' })));
    expect(await stageOf(opportunityId)).toBe('quote_sent');
  });

  it('records why it was lost', async () => {
    const result = await setProjectStage(
      null,
      form({ id: opportunityId, stage: 'lost', lostReason: 'Priced against a cheaper bid' }),
    );
    expect(result.ok).toBe(true);
    const [row] = await db
      .select({ stage: projects.stage, reason: projects.lostReason })
      .from(projects)
      .where(eq(projects.id, opportunityId));
    expect(row!.stage).toBe('lost');
    expect(row!.reason).toBe('Priced against a cheaper bid');
  });
});

describe('a job', () => {
  it('moves along the delivery stages', async () => {
    const result = await setProjectStage(null, form({ id: jobId, stage: 'in_progress' }));
    expect(result.ok).toBe(true);
    expect(await stageOf(jobId)).toBe('in_progress');
  });

  it('cannot go back to quoting once work has been won', async () => {
    const message = errorOf(await setProjectStage(null, form({ id: jobId, stage: 'quoting' })));
    expect(message).toMatch(/job/i);
    expect(await stageOf(jobId)).toBe('won');
  });

  it('cannot go back to being a lead', async () => {
    errorOf(await setProjectStage(null, form({ id: jobId, stage: 'lead' })));
    expect(await stageOf(jobId)).toBe('won');
  });

  /**
   * Losing a bid and abandoning work already under contract are different
   * events. Folding them together makes the win rate a number nobody can
   * trust, so a job is not allowed to become `lost`.
   */
  it('cannot be marked lost, which is a bid outcome', async () => {
    errorOf(await setProjectStage(null, form({ id: jobId, stage: 'lost', lostReason: 'Cancelled' })));
    expect(await stageOf(jobId)).toBe('won');
  });

  it('can go on hold, which belongs to both halves', async () => {
    const result = await setProjectStage(
      null,
      form({ id: jobId, stage: 'on_hold', holdReason: 'Waiting on the electrical permit' }),
    );
    expect(result.ok).toBe(true);
  });

  /**
   * The reason lands on the transition, not on the project, so a job held
   * twice for different reasons keeps both. A column would overwrite the
   * first one and the history would claim it was always waiting on the second.
   */
  it('records what it is waiting on against that hold', async () => {
    await setProjectStage(
      null,
      form({ id: jobId, stage: 'on_hold', holdReason: 'Waiting on the electrical permit' }),
    );
    await setProjectStage(null, form({ id: jobId, stage: 'in_progress' }));
    await setProjectStage(
      null,
      form({ id: jobId, stage: 'on_hold', holdReason: 'Customer away until the spring' }),
    );

    const notes = await db
      .select({ to: stageHistory.toStage, note: stageHistory.note })
      .from(stageHistory)
      .where(eq(stageHistory.projectId, jobId))
      .orderBy(asc(stageHistory.changedAt), asc(stageHistory.id));

    expect(notes.filter((row) => row.to === 'on_hold').map((row) => row.note)).toEqual([
      'Waiting on the electrical permit',
      'Customer away until the spring',
    ]);
  });

  it('refuses to go on hold with no reason, because a silent hold teaches nothing', async () => {
    const message = errorOf(await setProjectStage(null, form({ id: jobId, stage: 'on_hold' })));
    expect(message).toMatch(/waiting on/i);
    expect(await stageOf(jobId)).toBe('won');
  });
});

describe('the rule follows the accepted quote, not the stage column', () => {
  /**
   * Proof the check is derived rather than reading `stage`. A row parked at
   * `won` with nothing accepted behind it is not a job -- it is the incoherent
   * state the old header button used to produce -- and it must still be able
   * to move back to a pre-sale stage, which is the only way out of it.
   */
  it('treats a row stuck at won with no accepted quote as an opportunity', async () => {
    // Put the quote back to `sent` rather than deleting it: the application
    // role holds no DELETE privilege, so a delete here would fail for a
    // reason that has nothing to do with what is being asserted.
    await db.update(quotes).set({ status: 'sent' }).where(eq(quotes.projectId, jobId));

    const result = await setProjectStage(null, form({ id: jobId, stage: 'quote_sent' }));
    expect(result.ok).toBe(true);
    expect(await stageOf(jobId)).toBe('quote_sent');
  });

  it('stops treating it as a job once the accepted quote is voided', async () => {
    await db
      .update(quotes)
      .set({ recordStatus: 'void', voidReason: 'Accepted in error' })
      .where(eq(quotes.projectId, jobId));

    const result = await setProjectStage(null, form({ id: jobId, stage: 'quoting' }));
    expect(result.ok).toBe(true);
    expect(await stageOf(jobId)).toBe('quoting');
  });
});

/**
 * A quote with a line nobody has priced does not go out.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS GUARD IS LOAD-BEARING NOW
 * ---------------------------------------------------------------------------
 *
 * The trade packs ship a rate book with no prices in it, on purpose -- invented
 * prices are worse -- and they now ship scope templates that reference those
 * items. So the first quote an owner builds from a starter template is a
 * worklist of zero-priced lines, which is the most useful screen a first hour
 * can show him.
 *
 * What it must never be is sendable. `rate_items.sell_rate_ten_thou` is NOT
 * NULL, so "not priced yet" and "priced at nothing" are the same row, and
 * under `pricingDisplay`'s `group_totals` default a zero-priced line does not
 * print AT ALL: the customer would receive a document with the price of real
 * work silently missing, and its arithmetic would be perfectly consistent.
 *
 * The worksheet warns from `unpricedLineCodes` and this action refuses from
 * `unsendableProblem` -- one rule, read twice, so a screen somebody has had
 * open for an hour cannot be the thing that decides.
 */
describe('sending a quote', () => {
  async function draft(): Promise<string> {
    const [row] = await db
      .insert(quotes)
      .values({
        projectId: opportunityId,
        quoteNumber: 'QT-0002',
        kind: 'estimate',
        sequence: 2,
        version: 1,
        status: 'draft',
        quoteDate: '2026-01-10',
        validUntil: '2026-02-10',
      })
      .returning({ id: quotes.id });
    return row!.id;
  }

  async function addLine(
    quoteId: string,
    code: string,
    unitPriceTenThou: bigint,
    over: Partial<{ calcMode: 'qty' | 'flat' | 'percent'; isAllowance: boolean }> = {},
  ): Promise<void> {
    await db.insert(quoteLines).values({
      quoteId,
      lineGroup: 'Labour',
      code,
      description: code,
      calcMode: over.calcMode ?? 'qty',
      unitLabel: 'hour',
      qtyMilli: 1_000n,
      unitCostTenThou: 0n,
      unitPriceTenThou,
      // NOT NULL with no default, and normally written by the engine. Quantity
      // is 1 here, so ten-thousandths to cents is a divide by 100.
      lineCostCents: 0,
      lineTotalCents: Number(unitPriceTenThou / 100n),
      isAllowance: over.isAllowance ?? false,
      sortOrder: 10,
    });
  }

  it('refuses while a line has no price, and names it', async () => {
    const quoteId = await draft();
    await addLine(quoteId, 'WH-40', 0n);
    await addLine(quoteId, 'LAB-PL', 950_000n);

    const result = await setQuoteStatus({ quoteId, status: 'sent' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('WH-40');
    // Named, not counted: "one line needs a price" cannot be acted on.
    expect(result.error).not.toContain('LAB-PL');
    // And it says what to do about it.
    expect(result.error).toMatch(/allowance/i);

    // Still a draft. The refusal is before the write, not after it.
    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row!.status).toBe('draft');
    expect(row!.sentAt).toBeNull();
  });

  it('sends once every line carries a price', async () => {
    const quoteId = await draft();
    await addLine(quoteId, 'WH-40', 1_850_000n);

    const result = await setQuoteStatus({ quoteId, status: 'sent' });
    expect(result.ok).toBe(true);
    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row!.status).toBe('sent');
    expect(row!.sentAt).not.toBeNull();
  });

  it('sends an allowance and a percentage line at zero', async () => {
    /**
     * The two legitimate zeros, and the reason the guard reads the shared
     * helper rather than testing the column: an allowance is a placeholder the
     * customer spends against, and for a percentage line the rate IS the
     * percentage, so zero states "no uplift".
     */
    const quoteId = await draft();
    await addLine(quoteId, 'ALLOW-FIN', 0n, { isAllowance: true, calcMode: 'flat' });
    await addLine(quoteId, 'OH-SUB', 0n, { calcMode: 'percent' });

    expect((await setQuoteStatus({ quoteId, status: 'sent' })).ok).toBe(true);
  });

  it('ignores a voided line that was never priced', async () => {
    // A line struck off the quote is not work the customer is being charged
    // for, so it cannot be what blocks the document.
    const quoteId = await draft();
    await addLine(quoteId, 'GOOD', 500_000n);
    await addLine(quoteId, 'SCRAPPED', 0n);
    await db
      .update(quoteLines)
      .set({ recordStatus: 'void', voidReason: 'not doing this after all' })
      .where(eq(quoteLines.code, 'SCRAPPED'));

    expect((await setQuoteStatus({ quoteId, status: 'sent' })).ok).toBe(true);
  });

  it('lets an empty draft go out, which is the owner\'s business', async () => {
    // Nothing here is a judgement about whether a quote is finished. The guard
    // is about a line whose price is missing, not about a quote with no lines:
    // an empty one is visibly empty to whoever is sending it.
    const quoteId = await draft();
    expect((await setQuoteStatus({ quoteId, status: 'sent' })).ok).toBe(true);
  });
});
