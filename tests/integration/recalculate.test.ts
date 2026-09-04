import { asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  costCodes, customers, organization, projects, quoteLines, quoteTaxes, quotes, rateItems,
  scopeTemplateItems, scopeTemplates, taxRates,
} from '@/db/schema';
import { createQuoteFromTemplate } from '@/lib/quote/repository';
import { recalculateQuote } from '@/lib/quote/recalculate';

let projectId: string;
let templateId: string;

const SCOPE = {
  areaSqftMilli: 1240500n,
  washroomCount: 1,
  kitchenCount: 0,
  bedroomCount: 2,
};

/** 1240.5 sqft at $4.0000 is $4,962.00; 2481 sqft is exactly double. */
const DEMO_QTY_DOUBLED = 2481000n;

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, stage_history, quote_taxes, quote_lines, quotes,
    scope_template_items, scope_templates, rate_items, cost_codes, tax_rates,
    projects, customers, organization, document_sequences
    restart identity cascade
  `);

  await db.insert(organization).values({
    id: 1,
    legalName: 'Acme Ltd',
    displayName: 'Acme',
    timezone: 'America/Toronto',
    quoteValidityDays: 30,
    taxRegistrationNumber: '80000 0000 RT0001',
    defaultHoldbackPctTenThou: 1000n,
    quoteTermsText: 'Payable on completion.',
  });
  await db.insert(taxRates).values({
    label: 'HST',
    registrationNumber: '80000 0000 RT0001',
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
      stage: 'quoting',
    })
    .returning();
  projectId = project!.id;

  const [costCode] = await db
    .insert(costCodes)
    .values({ code: '02-40', name: 'Demolition' })
    .returning();
  const [demo] = await db
    .insert(rateItems)
    .values({
      code: 'DEM-01',
      description: 'Strip existing',
      costCodeId: costCode!.id,
      calcMode: 'qty',
      unitLabel: 'sqft',
      costRateTenThou: 28000n,
      sellRateTenThou: 40000n,
    })
    .returning();
  const [upgrade] = await db
    .insert(rateItems)
    .values({
      code: 'FIN-09',
      description: 'Wet bar rough-in',
      calcMode: 'flat',
      unitLabel: '',
      costRateTenThou: 3000000n,
      sellRateTenThou: 4200000n,
    })
    .returning();
  // A second included line priced at cost, so editing the demolition quantity
  // shifts the blended margin instead of scaling every figure proportionally.
  const [permit] = await db
    .insert(rateItems)
    .values({
      code: 'PRM-01',
      description: 'Building permit',
      calcMode: 'flat',
      unitLabel: '',
      costRateTenThou: 5000000n,
      sellRateTenThou: 5000000n,
    })
    .returning();
  const [overhead] = await db
    .insert(rateItems)
    .values({
      code: 'OH-01',
      description: 'Overhead',
      calcMode: 'percent',
      unitLabel: '%',
      costRateTenThou: 0n,
      sellRateTenThou: 1000n,
    })
    .returning();

  const [template] = await db
    .insert(scopeTemplates)
    .values({ name: 'Basement Finish', projectType: 'basement' })
    .returning();
  templateId = template!.id;

  await db.insert(scopeTemplateItems).values([
    {
      scopeTemplateId: templateId,
      rateItemId: demo!.id,
      qtySource: 'area',
      lineGroup: 'Demolition',
      sortOrder: 1,
    },
    {
      scopeTemplateId: templateId,
      rateItemId: upgrade!.id,
      qtySource: 'fixed',
      fixedQtyMilli: 1000n,
      isOptional: true,
      lineGroup: 'Upgrades',
      sortOrder: 2,
    },
    {
      scopeTemplateId: templateId,
      rateItemId: permit!.id,
      qtySource: 'fixed',
      lineGroup: 'Permits',
      sortOrder: 3,
    },
    {
      scopeTemplateId: templateId,
      rateItemId: overhead!.id,
      qtySource: 'fixed',
      lineGroup: 'Overhead',
      sortOrder: 4,
    },
  ]);
});

const create = () =>
  createQuoteFromTemplate({
    projectId,
    scopeTemplateId: templateId,
    scope: SCOPE,
    quoteDate: '2026-09-01',
  });

async function header(quoteId: string) {
  const [quote] = await db
    .select({
      status: quotes.status,
      subtotalCents: quotes.subtotalCents,
      taxTotalCents: quotes.taxTotalCents,
      totalCents: quotes.totalCents,
      totalCostCents: quotes.totalCostCents,
      marginBp: quotes.marginBp,
    })
    .from(quotes)
    .where(eq(quotes.id, quoteId));
  return quote!;
}

async function linesOf(quoteId: string) {
  return db
    .select()
    .from(quoteLines)
    .where(eq(quoteLines.quoteId, quoteId))
    .orderBy(asc(quoteLines.sortOrder));
}

async function taxesOf(quoteId: string) {
  return db
    .select()
    .from(quoteTaxes)
    .where(eq(quoteTaxes.quoteId, quoteId))
    .orderBy(asc(quoteTaxes.sortOrder));
}

async function lineByCode(quoteId: string, code: string) {
  return (await linesOf(quoteId)).find((line) => line.code === code);
}

/**
 * Writes a quantity straight onto the line row, the way the worksheet editor
 * does. The stored header stays stale until a recompute runs, which is what
 * every test below is measuring.
 */
async function setQty(quoteId: string, code: string, qtyMilli: bigint) {
  const line = await lineByCode(quoteId, code);
  await db.update(quoteLines).set({ qtyMilli }).where(eq(quoteLines.id, line!.id));
}

/** As created: $4,962.00 demolition + $500.00 permit + 10% overhead, then HST. */
const AS_CREATED = {
  subtotalCents: 600820,
  taxTotalCents: 78107,
  totalCents: 678927,
  totalCostCents: 397340,
  marginBp: 3387,
};

/** The same quote with the demolition quantity doubled to 2,481 sqft. */
const DOUBLED = {
  subtotalCents: 1146640,
  taxTotalCents: 149063,
  totalCents: 1295703,
  totalCostCents: 744680,
  marginBp: 3506,
};

describe('recalculateQuote', () => {
  it('moves every header figure when a line quantity changes', async () => {
    const { quoteId } = await create();
    expect(await header(quoteId)).toMatchObject(AS_CREATED);

    await setQty(quoteId, 'DEM-01', DEMO_QTY_DOUBLED);
    await recalculateQuote(quoteId);

    const after = await header(quoteId);
    expect(after).toMatchObject(DOUBLED);
    expect(after.totalCents).toBe(after.subtotalCents + after.taxTotalCents);
    // The margin moves rather than merely scaling, because the permit sits at
    // cost and its share of the quote shrinks as the demolition grows.
    expect(after.marginBp).toBeGreaterThan(AS_CREATED.marginBp);
  });

  it('recomputes a percent line against the new included base', async () => {
    const { quoteId } = await create();
    expect((await lineByCode(quoteId, 'OH-01'))?.lineTotalCents).toBe(54620);

    await setQty(quoteId, 'DEM-01', DEMO_QTY_DOUBLED);
    await recalculateQuote(quoteId);

    // 10% of $9,924.00 demolition plus the $500.00 permit.
    expect((await lineByCode(quoteId, 'OH-01'))?.lineTotalCents).toBe(104240);
  });

  it('leaves a quote that is not a draft completely untouched', async () => {
    const { quoteId } = await create();
    // Edited as a draft and sent without a recompute, so the stored header
    // disagrees with its own lines. A recompute here would either be refused by
    // the mutability triggers or rewrite the arithmetic the customer read.
    await setQty(quoteId, 'DEM-01', DEMO_QTY_DOUBLED);
    await db
      .update(quotes)
      .set({ status: 'sent', sentAt: new Date() })
      .where(eq(quotes.id, quoteId));

    await expect(recalculateQuote(quoteId)).resolves.toBeUndefined();

    expect(await header(quoteId)).toMatchObject({ status: 'sent', ...AS_CREATED });
    expect((await lineByCode(quoteId, 'OH-01'))?.lineTotalCents).toBe(54620);
    const [tax] = await taxesOf(quoteId);
    expect(tax?.taxAmountCents).toBe(AS_CREATED.taxTotalCents);
    expect(tax?.taxableBaseCents).toBe(AS_CREATED.subtotalCents);
  });

  it('excludes voided lines from the recomputed totals', async () => {
    const { quoteId } = await create();
    const demo = await lineByCode(quoteId, 'DEM-01');
    await db
      .update(quoteLines)
      .set({ recordStatus: 'void', voidReason: 'Removed from scope' })
      .where(eq(quoteLines.id, demo!.id));

    await recalculateQuote(quoteId);

    // Only the $500.00 permit and its 10% overhead are left standing.
    expect(await header(quoteId)).toMatchObject({
      subtotalCents: 55000,
      taxTotalCents: 7150,
      totalCents: 62150,
      totalCostCents: 50000,
      marginBp: 909,
    });
    expect((await lineByCode(quoteId, 'OH-01'))?.lineTotalCents).toBe(5000);
    // The voided line keeps the figures it was priced at: it drops out of the
    // totals, it is not rewritten to zero.
    expect((await lineByCode(quoteId, 'DEM-01'))?.lineTotalCents).toBe(496200);
  });

  it('updates the tax row in place rather than replacing it', async () => {
    const { quoteId } = await create();
    const [before] = await taxesOf(quoteId);
    expect(before?.taxAmountCents).toBe(AS_CREATED.taxTotalCents);

    await setQty(quoteId, 'DEM-01', DEMO_QTY_DOUBLED);
    await recalculateQuote(quoteId);

    const after = await taxesOf(quoteId);
    expect(after).toHaveLength(1);
    // The application role holds no DELETE privilege, so a recompute that
    // dropped and reinserted its tax rows would fail as a permission error in
    // production while passing here, where the suite connects as the owner.
    expect(after[0]?.id).toBe(before?.id);
    expect(after[0]?.taxAmountCents).toBe(DOUBLED.taxTotalCents);
    expect(after[0]?.taxableBaseCents).toBe(DOUBLED.subtotalCents);
    expect(after[0]?.recordStatus).toBe('active');
  });

  it('voids a tax that no longer applies instead of deleting it', async () => {
    const { quoteId } = await create();
    const [before] = await taxesOf(quoteId);

    await db.update(taxRates).set({ isActive: false }).where(eq(taxRates.label, 'HST'));
    await recalculateQuote(quoteId);

    const after = await taxesOf(quoteId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before?.id);
    expect(after[0]?.recordStatus).toBe('void');
    expect(after[0]?.voidedAt).not.toBeNull();
    expect(after[0]?.voidReason).toMatch(/no longer applies/i);
    expect(await header(quoteId)).toMatchObject({ taxTotalCents: 0 });
  });

  it('recomputes a tax exempt customer to zero tax', async () => {
    const { quoteId } = await create();
    await db.update(customers).set({ isTaxExempt: true });

    await recalculateQuote(quoteId);

    const after = await header(quoteId);
    expect(after.taxTotalCents).toBe(0);
    expect(after.totalCents).toBe(after.subtotalCents);
    // Exemption removes the tax, not the work: the subtotal must not move.
    expect(after.subtotalCents).toBe(AS_CREATED.subtotalCents);
    const active = (await taxesOf(quoteId)).filter((tax) => tax.recordStatus === 'active');
    expect(active).toEqual([]);
  });
});
