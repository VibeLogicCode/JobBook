import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  costCodes, customers, organization, projects, quoteLines, quotes, rateItems,
  scopeTemplateItems, scopeTemplates, taxRates,
} from '@/db/schema';
import { changeOrderLinesFromRateItems, createChangeOrder } from '@/lib/quote/change-order';
import { contractValueCents, createQuoteFromTemplate } from '@/lib/quote/repository';

let projectId: string;
let templateId: string;
let extraItemId: string;

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, stage_history, sessions, user_identities, quote_taxes, quote_lines,
    quotes, scope_template_items, scope_templates, rate_items, cost_codes, tax_rates,
    projects, customers, users, organization, document_sequences
    restart identity cascade
  `);

  await db.insert(organization).values({
    id: 1,
    legalName: 'Acme Ltd',
    displayName: 'Acme',
    timezone: 'America/Toronto',
    quoteValidityDays: 30,
    defaultHoldbackPctTenThou: 1000n,
  });
  await db.insert(taxRates).values({
    label: 'HST',
    rateTenThou: 1300n,
    effectiveFrom: '2010-07-01',
    sortOrder: 1,
  });

  const [customer] = await db
    .insert(customers)
    .values({ name: 'Eleanor Vance', customerType: 'residential' })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      customerId: customer!.id,
      projectNumber: 'P-0001',
      name: 'Basement finish',
      projectType: 'basement',
      stage: 'won',
    })
    .returning();
  projectId = project!.id;

  const [code] = await db.insert(costCodes).values({ code: '06-10', name: 'Carpentry' }).returning();
  const [base] = await db
    .insert(rateItems)
    .values({
      code: 'DEM-01',
      description: 'Strip existing',
      costCodeId: code!.id,
      calcMode: 'qty',
      unitLabel: 'sqft',
      costRateTenThou: 28000n,
      sellRateTenThou: 40000n,
    })
    .returning();
  const [extra] = await db
    .insert(rateItems)
    .values({
      code: 'CAR-04',
      description: 'Move the bearing wall',
      costCodeId: code!.id,
      calcMode: 'flat',
      unitLabel: '',
      costRateTenThou: 180000000n,
      sellRateTenThou: 260000000n,
    })
    .returning();
  extraItemId = extra!.id;

  const [template] = await db
    .insert(scopeTemplates)
    .values({ name: 'Basement Finish', projectType: 'basement' })
    .returning();
  templateId = template!.id;
  await db.insert(scopeTemplateItems).values({
    scopeTemplateId: templateId,
    rateItemId: base!.id,
    qtySource: 'area',
    lineGroup: 'Demolition',
    sortOrder: 1,
  });
});

async function acceptedEstimate() {
  const { quoteId } = await createQuoteFromTemplate({
    projectId,
    scopeTemplateId: templateId,
    scope: { areaSqftMilli: 1000000n, washroomCount: 1, kitchenCount: 0, bedroomCount: 2 },
    quoteDate: '2026-09-01',
  });
  await db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, quoteId));
  await db.update(quotes).set({ status: 'accepted' }).where(eq(quotes.id, quoteId));
  return quoteId;
}

const ADDITION = [
  {
    code: 'CAR-04',
    description: 'Move the bearing wall',
    lineGroup: 'Change',
    calcMode: 'flat' as const,
    unitLabel: '',
    qtyMilli: 1000n,
    unitCostTenThou: 180000000n,
    unitPriceTenThou: 260000000n,
  },
];

describe('createChangeOrder', () => {
  it('is a quote with a parent, its own number and its own sequence', async () => {
    const parentId = await acceptedEstimate();
    const first = await createChangeOrder({
      parentQuoteId: parentId,
      reason: 'site_condition',
      lines: ADDITION,
    });

    const [row] = await db.select().from(quotes).where(eq(quotes.id, first.quoteId));
    expect(row?.kind).toBe('change_order');
    expect(row?.parentQuoteId).toBe(parentId);
    expect(row?.status).toBe('draft');
    expect(first.quoteNumber).toMatch(/^CO-\d{4}-0001$/);
    expect(first.sequence).toBe(1);
    // $26,000 plus 13% HST.
    expect(row?.subtotalCents).toBe(2600000);
    expect(row?.taxTotalCents).toBe(338000);
  });

  it('counts sequence within the project, not within one estimate', async () => {
    const parentId = await acceptedEstimate();
    const first = await createChangeOrder({
      parentQuoteId: parentId,
      reason: 'customer_request',
      lines: ADDITION,
    });
    const second = await createChangeOrder({
      parentQuoteId: parentId,
      reason: 'design_change',
      lines: ADDITION,
    });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
  });

  it('records schedule impact separately from price', async () => {
    // A change order that adds four days to a fixed-date job has a real cost
    // even when every line carries full margin.
    const parentId = await acceptedEstimate();
    const { quoteId } = await createChangeOrder({
      parentQuoteId: parentId,
      reason: 'site_condition',
      scheduleImpactDays: 4,
      lines: ADDITION,
    });
    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row?.scheduleImpactDays).toBe(4);
  });

  it('inherits holdback and pricing display from the contract it amends', async () => {
    const parentId = await acceptedEstimate();
    const { quoteId } = await createChangeOrder({
      parentQuoteId: parentId,
      reason: 'customer_request',
      lines: ADDITION,
    });
    const [parent] = await db.select().from(quotes).where(eq(quotes.id, parentId));
    const [child] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(child?.holdbackPctTenThou).toBe(parent?.holdbackPctTenThou);
    expect(child?.pricingDisplay).toBe(parent?.pricingDisplay);
  });

  it('prices a deduction as a negative line', async () => {
    const parentId = await acceptedEstimate();
    const { quoteId } = await createChangeOrder({
      parentQuoteId: parentId,
      reason: 'customer_request',
      lines: [
        {
          ...ADDITION[0]!,
          description: 'Delete the wet bar',
          unitCostTenThou: -30000000n,
          unitPriceTenThou: -42000000n,
        },
      ],
    });
    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row?.subtotalCents).toBe(-420000);
    // Tax follows the sign: a credit reduces the tax owed on the job.
    expect(row?.taxTotalCents).toBe(-54600);
  });

  it('refuses a quote the customer has not accepted', async () => {
    const { quoteId } = await createQuoteFromTemplate({
      projectId,
      scopeTemplateId: templateId,
      scope: { areaSqftMilli: 1000000n, washroomCount: 1, kitchenCount: 0, bedroomCount: 0 },
      quoteDate: '2026-09-01',
    });
    await expect(
      createChangeOrder({ parentQuoteId: quoteId, reason: 'customer_request', lines: ADDITION }),
    ).rejects.toThrow(/revise it instead/i);
  });

  it('refuses to chain a change order onto another change order', async () => {
    // Chaining would make the derived contract value depend on walking a tree
    // rather than summing over the project.
    const parentId = await acceptedEstimate();
    const { quoteId } = await createChangeOrder({
      parentQuoteId: parentId,
      reason: 'customer_request',
      lines: ADDITION,
    });
    await db.update(quotes).set({ status: 'accepted' }).where(eq(quotes.id, quoteId));
    await expect(
      createChangeOrder({ parentQuoteId: quoteId, reason: 'customer_request', lines: ADDITION }),
    ).rejects.toThrow(/not against another change order/i);
  });

  it('refuses an empty change order', async () => {
    const parentId = await acceptedEstimate();
    await expect(
      createChangeOrder({ parentQuoteId: parentId, reason: 'customer_request', lines: [] }),
    ).rejects.toThrow(/at least one line/i);
  });

  it('adds to the contract value only once accepted', async () => {
    const parentId = await acceptedEstimate();
    const [parent] = await db.select().from(quotes).where(eq(quotes.id, parentId));
    const before = await contractValueCents(projectId);
    expect(before).toBe(parent!.totalCents);

    const { quoteId } = await createChangeOrder({
      parentQuoteId: parentId,
      reason: 'site_condition',
      lines: ADDITION,
    });
    // Still a draft: the customer has not agreed to it.
    expect(await contractValueCents(projectId)).toBe(before);

    await db.update(quotes).set({ status: 'accepted' }).where(eq(quotes.id, quoteId));
    const [child] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(await contractValueCents(projectId)).toBe(before + child!.totalCents);
  });

  it('snapshots the rate, so a later rise does not move a signed change order', async () => {
    const parentId = await acceptedEstimate();
    const lines = await changeOrderLinesFromRateItems([
      { rateItemId: extraItemId, qtyMilli: 1000n },
    ]);
    const { quoteId } = await createChangeOrder({
      parentQuoteId: parentId,
      reason: 'site_condition',
      lines,
    });

    await db
      .update(rateItems)
      .set({ sellRateTenThou: 400000000n })
      .where(eq(rateItems.id, extraItemId));

    const [row] = await db
      .select()
      .from(quoteLines)
      .where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.code, 'CAR-04')));
    expect(row?.unitPriceTenThou).toBe(260000000n);
  });
});

describe('changeOrderLinesFromRateItems', () => {
  it('carries provenance and the cost code through', async () => {
    const [line] = await changeOrderLinesFromRateItems([
      { rateItemId: extraItemId, qtyMilli: 2000n },
    ]);
    expect(line?.rateItemId).toBe(extraItemId);
    expect(line?.costCodeId).not.toBeNull();
    expect(line?.qtyMilli).toBe(2000n);
  });

  it('negates both rates for a deduction, rather than inventing a line kind', async () => {
    const [line] = await changeOrderLinesFromRateItems([
      { rateItemId: extraItemId, qtyMilli: 1000n, deductive: true },
    ]);
    expect(line?.unitPriceTenThou).toBe(-260000000n);
    expect(line?.unitCostTenThou).toBe(-180000000n);
  });

  it('refuses a rate item that does not exist', async () => {
    await expect(
      changeOrderLinesFromRateItems([
        { rateItemId: '11111111-1111-1111-1111-111111111111', qtyMilli: 1000n },
      ]),
    ).rejects.toThrow(/not found/i);
  });

  it('returns nothing for no picks', async () => {
    expect(await changeOrderLinesFromRateItems([])).toEqual([]);
  });
});

describe('quote lines on a change order', () => {
  it('are all included, because an undecided upgrade is not a change yet', async () => {
    const parentId = await acceptedEstimate();
    const { quoteId } = await createChangeOrder({
      parentQuoteId: parentId,
      reason: 'customer_request',
      lines: ADDITION,
    });
    const rows = await db
      .select()
      .from(quoteLines)
      .where(eq(quoteLines.quoteId, quoteId))
      .orderBy(asc(quoteLines.sortOrder));
    expect(rows.every((row) => row.isIncluded && !row.isOptional)).toBe(true);
  });
});
