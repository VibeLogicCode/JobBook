import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { customers, projects, quoteLines, quotes, quoteTaxes } from '@/db/schema';

beforeEach(async () => {
  await db.execute(sql`
    truncate table quote_taxes, quote_lines, quotes, projects, customers
    restart identity cascade
  `);
});

async function seedProject() {
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
  return project!;
}

function quoteValues(projectId: string, over: Record<string, unknown> = {}) {
  return {
    projectId,
    quoteNumber: 'Q-0001',
    quoteDate: '2026-09-01',
    validUntil: '2026-10-01',
    ...over,
  };
}

describe('quotes', () => {
  it('rejects two rows with the same version of one quote', async () => {
    const project = await seedProject();
    await db.insert(quotes).values(quoteValues(project.id, { version: 1 }));
    await expect(
      db.insert(quotes).values(quoteValues(project.id, { version: 1 })),
    ).rejects.toThrow();
  });

  it('defaults a new quote to a draft estimate shown at group totals', async () => {
    const project = await seedProject();
    const [row] = await db.insert(quotes).values(quoteValues(project.id)).returning();
    expect(row?.status).toBe('draft');
    expect(row?.kind).toBe('estimate');
    // Most residential contractors will not hand a homeowner a document
    // showing quantity times unit rate.
    expect(row?.pricingDisplay).toBe('group_totals');
  });

  it('does not offer expired as a stored status', async () => {
    const project = await seedProject();
    await expect(
      db.execute(sql`
        insert into quotes (project_id, quote_number, quote_date, valid_until, status)
        values (${project.id}, 'Q-0002', '2026-09-01', '2026-10-01', 'expired')
      `),
    ).rejects.toThrow();
  });

  it('holds a change order as a quote with a parent', async () => {
    const project = await seedProject();
    const [estimate] = await db.insert(quotes).values(quoteValues(project.id)).returning();
    const [changeOrder] = await db
      .insert(quotes)
      .values(
        quoteValues(project.id, {
          quoteNumber: 'CO-0001',
          kind: 'change_order',
          parentQuoteId: estimate!.id,
          sequence: 1,
          reason: 'site_condition',
          scheduleImpactDays: 5,
        }),
      )
      .returning();
    expect(changeOrder?.parentQuoteId).toBe(estimate?.id);
    // Unpriced time is still a cost, so a delay is recorded even at zero dollars.
    expect(changeOrder?.scheduleImpactDays).toBe(5);
  });

  it('permits only one accepted version of a quote at a time', async () => {
    const project = await seedProject();
    await db.insert(quotes).values(quoteValues(project.id, { version: 1, status: 'accepted' }));
    await expect(
      db.insert(quotes).values(quoteValues(project.id, { version: 2, status: 'accepted' })),
    ).rejects.toThrow();
  });

  it('permits a second version while the first is superseded', async () => {
    const project = await seedProject();
    await db.insert(quotes).values(quoteValues(project.id, { version: 1, status: 'superseded' }));
    const [v2] = await db
      .insert(quotes)
      .values(quoteValues(project.id, { version: 2, status: 'accepted' }))
      .returning();
    expect(v2?.version).toBe(2);
  });

  it('frees the accepted slot once the accepted version is voided', async () => {
    const project = await seedProject();
    const [v1] = await db
      .insert(quotes)
      .values(quoteValues(project.id, { version: 1, status: 'accepted' }))
      .returning();
    // Voiding, not deleting: a watermark sync cannot observe a row that no
    // longer exists, and these are tax records.
    await db
      .update(quotes)
      .set({ recordStatus: 'void', voidReason: 'Signed the wrong version' })
      .where(eq(quotes.id, v1!.id));
    const [v2] = await db
      .insert(quotes)
      .values(quoteValues(project.id, { version: 2, status: 'accepted' }))
      .returning();
    expect(v2?.status).toBe('accepted');
  });
});

describe('quoteLines', () => {
  async function seedQuote() {
    const project = await seedProject();
    const [quote] = await db.insert(quotes).values(quoteValues(project.id)).returning();
    return quote!;
  }

  const lineValues = (quoteId: string, over: Record<string, unknown> = {}) => ({
    quoteId,
    sortOrder: 1,
    lineGroup: 'Demolition',
    code: 'DEM-01',
    description: 'Strip existing',
    calcMode: 'qty' as const,
    unitLabel: 'sqft',
    qtyMilli: 1240500n,
    unitCostTenThou: 28000n,
    unitPriceTenThou: 40000n,
    lineCostCents: 347340,
    lineTotalCents: 496200,
    isTaxable: true,
    ...over,
  });

  it('snapshots the rate onto the line', async () => {
    const quote = await seedQuote();
    const [line] = await db.insert(quoteLines).values(lineValues(quote.id)).returning();
    expect(line?.unitPriceTenThou).toBe(40000n);
    expect(line?.lineTotalCents).toBe(496200);
  });

  it('accepts provenance without it being required', async () => {
    // The snapshot rule is about prices, not origin: without cost_code_id,
    // Phase 3 job costing has nothing to group actual spend against. An ad-hoc
    // line typed straight into a quote still has to be storable.
    const quote = await seedQuote();
    const [line] = await db.insert(quoteLines).values(lineValues(quote.id)).returning();
    expect(line?.rateItemId).toBeNull();
    expect(line?.costCodeId).toBeNull();
  });

  it('refuses a non-optional line that is excluded', async () => {
    // It would print as an available upgrade the customer cannot buy.
    const quote = await seedQuote();
    await expect(
      db.insert(quoteLines).values(lineValues(quote.id, { isOptional: false, isIncluded: false })),
    ).rejects.toThrow();
  });

  it('allows an optional excluded line', async () => {
    const quote = await seedQuote();
    const [line] = await db
      .insert(quoteLines)
      .values(lineValues(quote.id, { isOptional: true, isIncluded: false }))
      .returning();
    expect(line?.isIncluded).toBe(false);
  });

  it('stores a negative line total for a discount', async () => {
    const quote = await seedQuote();
    const [line] = await db
      .insert(quoteLines)
      .values(
        lineValues(quote.id, {
          code: 'DIS-01',
          calcMode: 'flat',
          unitLabel: '',
          unitPriceTenThou: -2500000n,
          lineCostCents: 0,
          lineTotalCents: -25000,
        }),
      )
      .returning();
    expect(line?.lineTotalCents).toBe(-25000);
  });
});

describe('quoteTaxes', () => {
  it('stores the taxable base beside the rate so a document reconciles later', async () => {
    const project = await seedProject();
    const [quote] = await db.insert(quotes).values(quoteValues(project.id)).returning();
    const [tax] = await db
      .insert(quoteTaxes)
      .values({
        quoteId: quote!.id,
        label: 'HST',
        registrationNumber: '80000 0000 RT0001',
        rateTenThou: 1300n,
        taxableBaseCents: 8430000,
        taxAmountCents: 1095900,
        sortOrder: 1,
      })
      .returning();
    expect(tax?.taxableBaseCents).toBe(8430000);
    expect(tax?.taxAmountCents).toBe(1095900);
  });
});
