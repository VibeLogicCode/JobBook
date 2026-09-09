import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { db } from '@/db/client';
import {
  costCodes, customers, organization, projects, quoteLines, quotes, rateItems,
  scopeTemplateItems, scopeTemplates, taxRates,
} from '@/db/schema';
import { regenerateFromTemplate, setScopeInputs } from '@/lib/quote/regenerate';
import { createQuoteFromTemplate } from '@/lib/quote/repository';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { seedDeployment } from '../support/organization';

let projectId: string;
let templateId: string;
let drywallItemId: string;
let handItemId: string;

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, stage_history, sessions, user_identities, quote_taxes, quote_lines,
    quotes, scope_template_items, scope_templates, rate_items, cost_codes, tax_rates,
    projects, customers, users, organization, companies, document_sequences
    restart identity cascade
  `);

  await seedDeployment({
    legalName: 'Acme Ltd',
    displayName: 'Acme',
    timezone: 'America/Toronto',
    quoteValidityDays: 30,
  });
  await db.insert(taxRates).values({ companyId: FIRST_COMPANY_ID,
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
    .values({ companyId: FIRST_COMPANY_ID,
      customerId: customer!.id,
      projectNumber: 'P-0001',
      name: 'Basement finish',
      projectTypeId: PROJECT_TYPE_IDS.basement,
      stage: 'quoting',
    })
    .returning();
  projectId = project!.id;

  const [code] = await db.insert(costCodes).values({ code: '09-20', name: 'Drywall' }).returning();
  const [drywall] = await db
    .insert(rateItems)
    .values({
      code: 'DRY-01',
      description: 'Drywall, tape and prime',
      costCodeId: code!.id,
      calcMode: 'qty',
      unitLabel: 'sqft',
      costRateTenThou: 26000n,
      sellRateTenThou: 41000n,
    })
    .returning();
  drywallItemId = drywall!.id;

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

  // Never on the template: this is what the owner adds by hand.
  const [hand] = await db
    .insert(rateItems)
    .values({
      code: 'MSC-01',
      description: 'Site survey',
      calcMode: 'flat',
      unitLabel: '',
      costRateTenThou: 5000000n,
      sellRateTenThou: 7500000n,
    })
    .returning();
  handItemId = hand!.id;

  const [template] = await db
    .insert(scopeTemplates)
    .values({ name: 'Basement Finish', projectTypeId: PROJECT_TYPE_IDS.basement })
    .returning();
  templateId = template!.id;
  await db.insert(scopeTemplateItems).values([
    {
      scopeTemplateId: templateId,
      rateItemId: drywallItemId,
      qtySource: 'area',
      lineGroup: 'Drywall',
      sortOrder: 1,
    },
    {
      scopeTemplateId: templateId,
      rateItemId: overhead!.id,
      qtySource: 'fixed',
      lineGroup: 'Overhead',
      sortOrder: 2,
    },
  ]);
});

async function seedQuote() {
  const { quoteId } = await createQuoteFromTemplate({
    projectId,
    scopeTemplateId: templateId,
    scope: { areaSqftMilli: 1000000n, washroomCount: 1, kitchenCount: 0, bedroomCount: 2 },
    quoteDate: '2026-09-01',
  });
  return quoteId;
}

const activeLines = (quoteId: string) =>
  db
    .select()
    .from(quoteLines)
    .where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.recordStatus, 'active')));

describe('setScopeInputs', () => {
  it('records the measurement without repricing the lines', async () => {
    // The owner corrects the area figure. A line's quantity is its own value
    // once the line exists: he may have adjusted drywall for the stairwell,
    // and that correction must survive.
    const quoteId = await seedQuote();
    const before = await activeLines(quoteId);
    const drywallBefore = before.find((line) => line.code === 'DRY-01');

    await setScopeInputs({ quoteId, scope: { areaSqftMilli: 1500000n } });

    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    const after = await activeLines(quoteId);
    expect(quote?.areaSqftMilli).toBe(1500000n);
    expect(after.find((line) => line.code === 'DRY-01')?.qtyMilli).toBe(drywallBefore?.qtyMilli);
  });

  it('refuses a quote that is no longer a draft', async () => {
    const quoteId = await seedQuote();
    await db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, quoteId));
    await expect(
      setScopeInputs({ quoteId, scope: { washroomCount: 2 } }),
    ).rejects.toThrow(/change order/i);
  });

  it('does nothing when nothing was passed', async () => {
    const quoteId = await seedQuote();
    await setScopeInputs({ quoteId, scope: {} });
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(quote?.areaSqftMilli).toBe(1000000n);
  });
});

describe('regenerateFromTemplate', () => {
  it('rebuilds template lines at the new measurement and reprices the quote', async () => {
    const quoteId = await seedQuote();
    const [before] = await db.select().from(quotes).where(eq(quotes.id, quoteId));

    await setScopeInputs({ quoteId, scope: { areaSqftMilli: 2000000n } });
    const summary = await regenerateFromTemplate({ quoteId });

    const [after] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    const lines = await activeLines(quoteId);
    expect(summary.created).toBe(2);
    expect(summary.replaced).toBe(2);
    expect(lines.find((line) => line.code === 'DRY-01')?.qtyMilli).toBe(2000000n);
    // Twice the area, so twice the money.
    expect(after?.subtotalCents).toBe(before!.subtotalCents * 2);
  });

  it('voids the replaced lines rather than deleting them', async () => {
    // The application role holds no DELETE privilege, and a regeneration that
    // lost the old figures would leave no record of what the quote said before.
    const quoteId = await seedQuote();
    await regenerateFromTemplate({ quoteId });

    const all = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
    const voided = all.filter((line) => line.recordStatus === 'void');
    expect(voided).toHaveLength(2);
    expect(voided.every((line) => /regeneration/i.test(line.voidReason ?? ''))).toBe(true);
  });

  it('keeps a line the owner added by hand', async () => {
    const quoteId = await seedQuote();
    await db.insert(quoteLines).values({
      quoteId,
      sortOrder: 99,
      lineGroup: 'Added',
      code: 'MSC-01',
      description: 'Site survey',
      calcMode: 'flat',
      unitLabel: '',
      rateItemId: handItemId,
      qtyMilli: 1000n,
      unitCostTenThou: 5000000n,
      unitPriceTenThou: 7500000n,
      lineCostCents: 50000,
      lineTotalCents: 75000,
    });

    const summary = await regenerateFromTemplate({ quoteId });
    const lines = await activeLines(quoteId);

    expect(summary.kept).toBe(1);
    expect(lines.some((line) => line.code === 'MSC-01')).toBe(true);
  });

  it('re-snapshots at the current rate, which is how a price rise is picked up', async () => {
    const quoteId = await seedQuote();
    await db
      .update(rateItems)
      .set({ sellRateTenThou: 52000n })
      .where(eq(rateItems.id, drywallItemId));

    await regenerateFromTemplate({ quoteId });

    const lines = await activeLines(quoteId);
    expect(lines.find((line) => line.code === 'DRY-01')?.unitPriceTenThou).toBe(52000n);
  });

  it('reprices the percent line against the new base', async () => {
    const quoteId = await seedQuote();
    await setScopeInputs({ quoteId, scope: { areaSqftMilli: 2000000n } });
    await regenerateFromTemplate({ quoteId });

    const lines = await activeLines(quoteId);
    const drywall = lines.find((line) => line.code === 'DRY-01');
    const overhead = lines.find((line) => line.code === 'OH-01');
    // 10% of the work, computed after the whole list is known.
    expect(overhead?.lineTotalCents).toBe(Math.round(drywall!.lineTotalCents * 0.1));
  });

  it('refuses a quote that is no longer a draft', async () => {
    const quoteId = await seedQuote();
    await db.update(quotes).set({ status: 'accepted' }).where(eq(quotes.id, quoteId));
    await expect(regenerateFromTemplate({ quoteId })).rejects.toThrow(/change order/i);
  });

  it('refuses a quote that was not built from a template', async () => {
    const quoteId = await seedQuote();
    await db.update(quotes).set({ scopeTemplateId: null }).where(eq(quotes.id, quoteId));
    await expect(regenerateFromTemplate({ quoteId })).rejects.toThrow(/nothing to regenerate/i);
  });

  it('refuses when every item on the template has been retired', async () => {
    const quoteId = await seedQuote();
    await db
      .update(rateItems)
      .set({ recordStatus: 'void', voidReason: 'discontinued' });
    await expect(regenerateFromTemplate({ quoteId })).rejects.toThrow(/retired/i);
  });

  it('drops a line whose derived quantity falls to zero', async () => {
    const quoteId = await seedQuote();
    await setScopeInputs({ quoteId, scope: { areaSqftMilli: 0n } });
    await regenerateFromTemplate({ quoteId });

    const lines = await activeLines(quoteId);
    // Area went to zero, so the area-derived line is gone; the percent line
    // stays, because its quantity was never what priced it.
    expect(lines.some((line) => line.code === 'DRY-01')).toBe(false);
    expect(lines.some((line) => line.code === 'OH-01')).toBe(true);
  });
});
