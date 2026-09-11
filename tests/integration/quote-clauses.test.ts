import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `revalidatePath` and `headers` are request-scoped Next APIs and there is no
 * request here. Mocked rather than avoided, for the reason `stage.test.ts`
 * gives: the actions genuinely must call them, and a test that routed around
 * them would be testing a different function.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-identity-email': 'owner@example.invalid' }),
}));

import { db } from '@/db/client';
import { customers, projects, quoteClauses, quotes, users } from '@/db/schema';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { PACKS } from '@/db/seed/packs/registry';
import { TRADES } from '@/db/seed/packs/types';
import { loadPack } from '@/db/seed/packs/load';
// After the mocks above, deliberately: this pulls in the database client.
import { seedDeployment } from '../support/organization';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { saveQuoteClauses } from '@/app/quotes/[id]/actions';
import { createClause, setClauseActive, updateClause, voidClause } from '@/app/settings/clauses/actions';

/**
 * What the price does not include.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * `quotes.exclusions_text` and `assumptions_text` have been in the schema
 * since the first migration and `quote_clauses` since not long after. Nothing
 * read or wrote any of the three, so no quote this product printed had ever
 * said what it left out -- while "I assumed that was included" is the
 * commonest argument on a job.
 *
 * The property worth asserting hardest is the one that makes the list safe to
 * maintain: a quote COPIES the words, so nothing done to the library can alter
 * a document already printed.
 */

let quoteId: string;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, quote_taxes, quote_lines, quotes, quote_clauses, projects, customers,
      users, organization, companies, document_sequences, settings
    restart identity cascade
  `);

  await seedDeployment({
    legalName: 'Sample Contracting Ltd.',
    displayName: 'Sample Contracting',
    timezone: 'America/Toronto',
    quoteValidityDays: 30,
  });

  await db.insert(users).values({
    email: 'owner@example.invalid',
    displayName: 'Test Owner',
    role: 'owner',
    isActive: true,
  });

  const [customer] = await db
    .insert(customers)
    .values({ name: 'Sample Client', customerType: 'residential' })
    .returning({ id: customers.id });

  const [project] = await db
    .insert(projects)
    .values({
      name: 'Basement',
      projectNumber: 'P-2026-7001',
      customerId: customer!.id,
      companyId: FIRST_COMPANY_ID,
      projectTypeId: PROJECT_TYPE_IDS.basement,
    })
    .returning({ id: projects.id });

  const [quote] = await db
    .insert(quotes)
    .values({
      projectId: project!.id,
      quoteNumber: 'QT-2026-7001',
      kind: 'estimate',
      sequence: 1,
      version: 1,
      status: 'draft',
      quoteDate: '2026-03-01',
      validUntil: '2026-03-31',
    })
    .returning({ id: quotes.id });
  quoteId = quote!.id;
});

describe('writing them on a quote', () => {
  it('saves both, and prints nothing for a blank one', async () => {
    const result = await saveQuoteClauses({
      quoteId,
      exclusionsText: 'Permit fees\nPainting',
      assumptionsText: '   ',
    });
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    // The owner's own line breaks survive: an exclusion list is written as
    // lines and the print document keeps them with `white-space: pre-line`.
    expect(row!.exclusionsText).toBe('Permit fees\nPainting');
    // Blank is NULL, not an empty string, so "nothing excluded" and "never
    // asked" read the same to the document, which prints no heading for either.
    expect(row!.assumptionsText).toBeNull();
  });

  it('refuses once the quote has gone out', async () => {
    /**
     * These print on the copy the customer is holding. Editing them on a sent
     * quote would change the terms of a document somebody is reading, with
     * nothing on either copy to say it had changed -- the same reason the line
     * editor refuses a sent quote.
     */
    await db.update(quotes).set({ status: 'sent', sentAt: new Date() }).where(eq(quotes.id, quoteId));

    const result = await saveQuoteClauses({
      quoteId,
      exclusionsText: 'Something new',
      assumptionsText: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // And it says what to do instead.
    expect(result.error).toMatch(/revise/i);

    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row!.exclusionsText).toBeNull();
  });

  it('refuses on a voided quote', async () => {
    await db
      .update(quotes)
      .set({ recordStatus: 'void', voidReason: 'duplicate' })
      .where(eq(quotes.id, quoteId));

    expect((await saveQuoteClauses({ quoteId, exclusionsText: 'x', assumptionsText: '' })).ok)
      .toBe(false);
  });

  it('refuses text past the column it has to fit in', async () => {
    const result = await saveQuoteClauses({
      quoteId,
      exclusionsText: 'x'.repeat(4001),
      assumptionsText: '',
    });
    expect(result.ok).toBe(false);
  });
});

describe('the saved library', () => {
  async function add(kind: string, text: string): Promise<string> {
    const result = await createClause(null, form({ kind, clauseText: text, sortOrder: '10' }));
    expect(result.ok).toBe(true);
    const [row] = await db.select().from(quoteClauses).where(eq(quoteClauses.clauseText, text));
    return row!.id;
  }

  it('adds one, collapsing it to a single line', async () => {
    // The quote appends each of these AS A LINE, so a clause carrying its own
    // line breaks would arrive as three lines the owner did not add.
    await createClause(
      null,
      form({ kind: 'exclusion', clauseText: '  Permit\n  fees  ', sortOrder: '' }),
    );
    const [row] = await db.select().from(quoteClauses);
    expect(row!.clauseText).toBe('Permit fees');
    expect(row!.sortOrder).toBe(0);
  });

  it('refuses a kind that is not one of the two', async () => {
    const result = await createClause(null, form({ kind: 'warranty', clauseText: 'x', sortOrder: '' }));
    expect(result.ok).toBe(false);
  });

  it('leaves a quote alone when the wording is changed afterwards', async () => {
    /**
     * THE property that makes this list safe to maintain at all.
     *
     * The quote copied the sentence when it was added, so rewording the
     * library reaches the next quote and none of the ones already out. Without
     * this, tidying up a list of exclusions in March would silently restate
     * the terms of every quote sent in February.
     */
    const id = await add('exclusion', 'Painting');
    await saveQuoteClauses({ quoteId, exclusionsText: 'Painting', assumptionsText: '' });

    const result = await updateClause(
      null,
      form({ id, kind: 'exclusion', clauseText: 'Painting and patching', sortOrder: '10' }),
    );
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row!.exclusionsText).toBe('Painting');
  });

  it('retires one without touching what already printed', async () => {
    const id = await add('exclusion', 'Painting');
    await saveQuoteClauses({ quoteId, exclusionsText: 'Painting', assumptionsText: '' });

    expect((await setClauseActive(null, form({ id, isActive: 'false' }))).ok).toBe(true);

    const [clause] = await db.select().from(quoteClauses).where(eq(quoteClauses.id, id));
    expect(clause!.isActive).toBe(false);
    // Retired, not deleted, and the quote is unchanged.
    expect(clause!.recordStatus).toBe('active');
    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row!.exclusionsText).toBe('Painting');
  });

  it('voids one with a reason, and takes it off the list in the same write', async () => {
    const id = await add('assumption', 'Nonsense that should never have been here');

    const result = await voidClause(null, form({ id, reason: 'added by mistake' }));
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(quoteClauses).where(eq(quoteClauses.id, id));
    expect(row!.recordStatus).toBe('void');
    expect(row!.voidReason).toBe('added by mistake');
    // Both, so nothing downstream has to know that one implies the other.
    expect(row!.isActive).toBe(false);
  });

  it('requires a reason to void', async () => {
    const id = await add('exclusion', 'Painting');
    expect((await voidClause(null, form({ id, reason: '   ' }))).ok).toBe(false);
  });
});

describe('what the packs ship', () => {
  it('gives every pack something, the plain start included', async () => {
    for (const trade of TRADES) {
      const pack = PACKS[trade];
      // Even `none`: somebody who picked "something else" is exactly the
      // person with nothing to start from, and the trade-neutral sentences are
      // true of any trade.
      expect(pack.clauses.length, trade).toBeGreaterThanOrEqual(5);
      expect(pack.clauses.some((clause) => clause.kind === 'exclusion'), trade).toBe(true);
      expect(pack.clauses.some((clause) => clause.kind === 'assumption'), trade).toBe(true);
    }
  });

  it('keeps every clause to one line and inside the field it has to fit', async () => {
    for (const trade of TRADES) {
      for (const clause of PACKS[trade].clauses) {
        expect(clause.clauseText, trade).not.toContain('\n');
        // The settings field caps at 500: a paragraph in a tap-to-add button is
        // a button nobody can read on a phone.
        expect(clause.clauseText.length, clause.clauseText).toBeLessThanOrEqual(500);
      }
    }
  });

  it('loads them, and a second load adds nothing', async () => {
    await db.transaction((tx) => loadPack(tx, 'electrical', 'both'));
    const first = await db.select().from(quoteClauses);
    expect(first.length).toBe(PACKS.electrical.clauses.length);
    expect(first.map((row) => row.clauseText)).toContain(
      'Patching, sanding or painting where walls or ceilings were opened',
    );

    await db.transaction((tx) => loadPack(tx, 'electrical', 'both'));
    expect(await db.select().from(quoteClauses)).toHaveLength(first.length);
  });

  it('does not restore one the owner has retired', async () => {
    // Fixed ids and `onConflictDoNothing`, the same rule every other pack row
    // follows: a row somebody has changed is never quietly put back.
    await db.transaction((tx) => loadPack(tx, 'plumbing', 'both'));
    const [row] = await db.select().from(quoteClauses);
    await db.update(quoteClauses).set({ isActive: false }).where(eq(quoteClauses.id, row!.id));

    await db.transaction((tx) => loadPack(tx, 'plumbing', 'both'));
    const [again] = await db.select().from(quoteClauses).where(eq(quoteClauses.id, row!.id));
    expect(again!.isActive).toBe(false);
  });
});
