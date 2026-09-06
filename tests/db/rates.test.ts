import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { db } from '@/db/client';
import { costCodes, rateItems, scopeTemplateItems, scopeTemplates } from '@/db/schema';

beforeEach(async () => {
  await db.execute(sql`
    truncate table scope_template_items, scope_templates, rate_items, cost_codes
    restart identity cascade
  `);
});

async function seedCostCode() {
  const [code] = await db
    .insert(costCodes)
    .values({ code: '02-40', name: 'Demolition' })
    .returning();
  return code!;
}

describe('rateItems', () => {
  it('carries both a cost and a sell rate so margin is visible per item', async () => {
    const costCode = await seedCostCode();
    const [item] = await db
      .insert(rateItems)
      .values({
        code: 'DEM-01',
        description: 'Strip existing',
        costCodeId: costCode.id,
        calcMode: 'qty',
        unitLabel: 'sqft',
        costRateTenThou: 28000n,
        sellRateTenThou: 40000n,
      })
      .returning();
    expect(item?.costRateTenThou).toBe(28000n);
    expect(item?.sellRateTenThou).toBe(40000n);
    expect(item?.isTaxable).toBe(true);
  });

  it('rejects a duplicate code across the one item list', async () => {
    // There is no rate_cards table, so a code is unique per deployment rather
    // than per card: multiple cards would mean recreating every template
    // against new item rows, and snapshotting already protects old quotes.
    const base = {
      description: 'X',
      calcMode: 'flat' as const,
      unitLabel: '',
      costRateTenThou: 1n,
      sellRateTenThou: 2n,
    };
    await db.insert(rateItems).values({ ...base, code: 'DUP' });
    await expect(db.insert(rateItems).values({ ...base, code: 'DUP' })).rejects.toThrow();
  });

  it('allows a non-taxable pass-through item', async () => {
    const [item] = await db
      .insert(rateItems)
      .values({
        code: 'PRM-01',
        description: 'Building permit',
        calcMode: 'flat',
        unitLabel: '',
        costRateTenThou: 35000000n,
        sellRateTenThou: 35000000n,
        isTaxable: false,
      })
      .returning();
    expect(item?.isTaxable).toBe(false);
  });

  it('allows a negative sell rate, which is how a discount is expressed', async () => {
    const [item] = await db
      .insert(rateItems)
      .values({
        code: 'DIS-01',
        description: 'Repeat customer discount',
        calcMode: 'flat',
        unitLabel: '',
        costRateTenThou: 0n,
        sellRateTenThou: -2500000n,
      })
      .returning();
    expect(item?.sellRateTenThou).toBe(-2500000n);
  });

  it('carries a cost code, which is what Phase 3 costs against', async () => {
    const costCode = await seedCostCode();
    const [item] = await db
      .insert(rateItems)
      .values({
        code: 'DEM-02',
        description: 'Dumpster',
        costCodeId: costCode.id,
        calcMode: 'flat',
        unitLabel: '',
        costRateTenThou: 4500000n,
        sellRateTenThou: 6000000n,
      })
      .returning();
    expect(item?.costCodeId).toBe(costCode.id);
  });
});

describe('scopeTemplateItems', () => {
  async function seedTemplate() {
    const [template] = await db
      .insert(scopeTemplates)
      .values({ name: 'Basement Finish', projectTypeId: PROJECT_TYPE_IDS.basement })
      .returning();
    return template!;
  }

  it('derives quantity from a source and a multiplier, not a formula string', async () => {
    const [item] = await db
      .insert(rateItems)
      .values({
        code: 'ELE-02',
        description: 'Pot lights',
        calcMode: 'qty',
        unitLabel: 'ea',
        costRateTenThou: 900000n,
        sellRateTenThou: 1400000n,
      })
      .returning();
    const template = await seedTemplate();
    const [line] = await db
      .insert(scopeTemplateItems)
      .values({
        scopeTemplateId: template.id,
        rateItemId: item!.id,
        qtySource: 'area',
        qtyMultiplierTenThou: 200n,
        lineGroup: 'Electrical',
        sortOrder: 1,
      })
      .returning();
    expect(line?.qtySource).toBe('area');
    expect(line?.qtyMultiplierTenThou).toBe(200n);
  });

  it('defaults the multiplier to exactly one', async () => {
    const [item] = await db
      .insert(rateItems)
      .values({
        code: 'DRY-01',
        description: 'Drywall',
        calcMode: 'qty',
        unitLabel: 'sqft',
        costRateTenThou: 18000n,
        sellRateTenThou: 26000n,
      })
      .returning();
    const template = await seedTemplate();
    const [line] = await db
      .insert(scopeTemplateItems)
      .values({
        scopeTemplateId: template.id,
        rateItemId: item!.id,
        qtySource: 'area',
        lineGroup: 'Drywall',
      })
      .returning();
    expect(line?.qtyMultiplierTenThou).toBe(10000n);
    expect(line?.isOptional).toBe(false);
  });
});
