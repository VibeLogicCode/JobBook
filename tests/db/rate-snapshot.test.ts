import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  costCodes,
  customers,
  projects,
  quoteLines,
  quotes,
  rateItems,
} from '@/db/schema';
import { lineTotalCents } from '@/lib/money/scale';

/**
 * Editing a rate item must never move the price of a quote already written.
 *
 * This is the single most valuable test around the rate list, because the
 * failure is silent. Nothing would look wrong: the rates screen would show the
 * corrected price, the quote would open, and its total would simply be a
 * different number than the one on the PDF in the customer's inbox. Nobody
 * finds that until somebody argues about an invoice.
 *
 * The mechanism that prevents it is a snapshot, not a rule anyone remembers to
 * follow: `quote_lines` carries its own `description`, `cost_code_id`,
 * `unit_cost_ten_thou`, `unit_price_ten_thou`, `line_cost_cents` and
 * `line_total_cents`. `rate_item_id` is provenance -- what this line came
 * from -- and is never followed to price anything. These tests hold that from
 * both sides: the data does not move, and the code does not reach.
 */

beforeEach(async () => {
  await db.execute(sql`
    truncate table quote_lines, quotes, projects, customers, rate_items, cost_codes
    restart identity cascade
  `);
});

const QTY_MILLI = 1_240_500n; // 1240.5 sqft
const COST_TEN_THOU = 28_000n; // $2.8000
const SELL_TEN_THOU = 40_000n; // $4.0000

async function seedQuoteFromRateItem() {
  const [costCode] = await db
    .insert(costCodes)
    .values({ code: '09-20', name: 'Drywall' })
    .returning();

  const [item] = await db
    .insert(rateItems)
    .values({
      code: 'DRY-01',
      description: 'Board, tape and sand',
      costCodeId: costCode!.id,
      calcMode: 'qty',
      unitLabel: 'sqft',
      costRateTenThou: COST_TEN_THOU,
      sellRateTenThou: SELL_TEN_THOU,
    })
    .returning();

  const [customer] = await db
    .insert(customers)
    .values({ name: 'Sample Client', customerType: 'residential' })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      customerId: customer!.id,
      projectNumber: 'P-0001',
      name: 'Basement finish',
      projectType: 'basement',
      stage: 'quoting',
    })
    .returning();
  const [quote] = await db
    .insert(quotes)
    .values({
      projectId: project!.id,
      quoteNumber: 'Q-0001',
      quoteDate: '2026-09-01',
      validUntil: '2026-10-01',
    })
    .returning();

  // The line is built the way the worksheet builds one: every figure copied
  // off the rate item at this moment, and the two totals computed once, here,
  // from those copies.
  const [line] = await db
    .insert(quoteLines)
    .values({
      quoteId: quote!.id,
      sortOrder: 1,
      lineGroup: 'Drywall',
      code: item!.code,
      description: item!.description,
      calcMode: item!.calcMode,
      unitLabel: item!.unitLabel,
      rateItemId: item!.id,
      costCodeId: item!.costCodeId,
      qtyMilli: QTY_MILLI,
      unitCostTenThou: item!.costRateTenThou,
      unitPriceTenThou: item!.sellRateTenThou,
      lineCostCents: Number(lineTotalCents(QTY_MILLI, item!.costRateTenThou)),
      lineTotalCents: Number(lineTotalCents(QTY_MILLI, item!.sellRateTenThou)),
    })
    .returning();

  // Sent, because that is the state the invariant is about: a document the
  // customer is holding. The line goes on while the quote is still a draft --
  // a trigger refuses a new line on a sent quote, which is a separate rule
  // pulling in the same direction.
  await db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, quote!.id));

  return { item: item!, line: line!, costCode: costCode! };
}

async function readLine(id: string) {
  const [row] = await db.select().from(quoteLines).where(eq(quoteLines.id, id));
  return row!;
}

describe('a rate item edit against a quote already written', () => {
  it('leaves the line at the price it was built at when the sell rate changes', async () => {
    const { item, line } = await seedQuoteFromRateItem();
    const before = await readLine(line.id);
    expect(before.unitPriceTenThou).toBe(SELL_TEN_THOU);
    expect(before.lineTotalCents).toBe(496_200); // 1240.5 x $4.0000

    // The supplier put the price up by half. This is the ordinary edit the
    // rates screen exists for, and it is exactly the one that must not reach
    // backwards.
    await db
      .update(rateItems)
      .set({ sellRateTenThou: 60_000n })
      .where(eq(rateItems.id, item.id));

    const after = await readLine(line.id);
    expect(after.unitPriceTenThou).toBe(SELL_TEN_THOU);
    expect(after.lineTotalCents).toBe(496_200);
  });

  it('leaves the cost, and therefore the margin, where it was', async () => {
    const { item, line } = await seedQuoteFromRateItem();
    await db
      .update(rateItems)
      .set({ costRateTenThou: 39_000n })
      .where(eq(rateItems.id, item.id));

    const after = await readLine(line.id);
    expect(after.unitCostTenThou).toBe(COST_TEN_THOU);
    expect(after.lineCostCents).toBe(347_340); // 1240.5 x $2.8000
  });

  it('leaves the words on the customer document alone', async () => {
    const { item, line } = await seedQuoteFromRateItem();
    await db
      .update(rateItems)
      .set({ description: 'Board, tape, sand and prime', unitLabel: 'm2' })
      .where(eq(rateItems.id, item.id));

    const after = await readLine(line.id);
    expect(after.description).toBe('Board, tape and sand');
    expect(after.unitLabel).toBe('sqft');
  });

  it('leaves the cost code the line was costed against alone', async () => {
    // Phase 3 groups actual cost against the line's own cost code. Re-pointing
    // the rate item would silently re-file every historical line with it.
    const { item, line, costCode } = await seedQuoteFromRateItem();
    const [moved] = await db
      .insert(costCodes)
      .values({ code: '09-90', name: 'Finishes' })
      .returning();
    await db
      .update(rateItems)
      .set({ costCodeId: moved!.id })
      .where(eq(rateItems.id, item.id));

    expect((await readLine(line.id)).costCodeId).toBe(costCode.id);
  });

  it('keeps the line whole when the item is retired', async () => {
    const { item, line } = await seedQuoteFromRateItem();
    await db.update(rateItems).set({ isActive: false }).where(eq(rateItems.id, item.id));

    const after = await readLine(line.id);
    expect(after.unitPriceTenThou).toBe(SELL_TEN_THOU);
    // And the provenance still resolves: a retired item is still on the list,
    // which is why retiring is not deleting.
    const [resolved] = await db.select().from(rateItems).where(eq(rateItems.id, item.id));
    expect(resolved?.code).toBe('DRY-01');
  });

  it('keeps the line whole when the item is voided, and the item still resolves', async () => {
    const { item, line } = await seedQuoteFromRateItem();
    await db
      .update(rateItems)
      .set({ recordStatus: 'void', voidedAt: new Date(), voidReason: 'entered twice' })
      .where(eq(rateItems.id, item.id));

    expect((await readLine(line.id)).unitPriceTenThou).toBe(SELL_TEN_THOU);
    const [resolved] = await db.select().from(rateItems).where(eq(rateItems.id, item.id));
    expect(resolved?.recordStatus).toBe('void');
    expect(resolved?.voidReason).toBe('entered twice');
  });

  it('survives every edit at once, which is what a real correction looks like', async () => {
    const { item, line } = await seedQuoteFromRateItem();
    const before = await readLine(line.id);

    await db
      .update(rateItems)
      .set({
        code: 'DRY-01A',
        description: 'Board, tape, sand and prime',
        unitLabel: 'm2',
        calcMode: 'flat',
        costRateTenThou: 1n,
        sellRateTenThou: 2n,
        isTaxable: false,
        isAllowance: true,
        isActive: false,
      })
      .where(eq(rateItems.id, item.id));

    const after = await readLine(line.id);
    // Every column except the audit ones, compared as a whole: a new snapshot
    // column added later is covered by this without anybody remembering to
    // add an assertion for it.
    const priced = ({ createdAt, updatedAt, ...rest }: typeof after) => rest;
    expect(priced(after)).toEqual(priced(before));
  });
});

describe('the rate list never reaches into a quote', () => {
  it('writes no quote table from the rates actions', async () => {
    // The data tests above prove nothing MOVED. This proves nothing in the
    // rate list's own write path could move it -- which is the version of the
    // rule that survives somebody adding a feature here next year.
    const source = await readFile(
      path.resolve(import.meta.dirname, '../../src/app/rates/actions.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\b(quoteLines|quoteTaxes|quoteClauses)\b/);
    // The drizzle call and the statement, not the word in a sentence: the
    // file has every reason to SAY "delete" while never doing one, and the
    // app role holds no DELETE privilege anyway.
    expect(source).not.toMatch(/\.delete\s*\(/);
    expect(source).not.toMatch(/delete\s+from/i);
  });
});
