import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  costCodes, customers, organization, projects, quoteLines, quoteTaxes, quotes, rateItems,
  scopeTemplateItems, scopeTemplates, taxRates,
} from '@/db/schema';
import {
  contractValueCents, createQuoteFromTemplate, reviseQuote, voidQuote,
} from '@/lib/quote/repository';

let projectId: string;
let templateId: string;
let demoItemId: string;

const SCOPE = {
  areaSqftMilli: 1240500n,
  washroomCount: 1,
  kitchenCount: 0,
  bedroomCount: 2,
};

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
  demoItemId = demo!.id;

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
      rateItemId: demoItemId,
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
      rateItemId: overhead!.id,
      qtySource: 'fixed',
      lineGroup: 'Overhead',
      sortOrder: 3,
    },
  ]);
});

const create = (over: { quoteDate?: string } = {}) =>
  createQuoteFromTemplate({
    projectId,
    scopeTemplateId: templateId,
    scope: SCOPE,
    quoteDate: '2026-09-01',
    ...over,
  });

async function linesOf(quoteId: string) {
  return db
    .select()
    .from(quoteLines)
    .where(eq(quoteLines.quoteId, quoteId))
    .orderBy(asc(quoteLines.sortOrder));
}

describe('createQuoteFromTemplate', () => {
  it('writes the header, lines, and snapshotted tax in one go', async () => {
    const { quoteId, quoteNumber } = await create();
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));

    expect(quoteNumber).toBe('QT-2026-0001');
    expect(quote?.status).toBe('draft');
    // 1240.5 sqft x $4.0000 = $4,962.00, plus 10% overhead = $5,458.20.
    expect(quote?.subtotalCents).toBe(545820);
    expect(quote?.taxTotalCents).toBe(70957);
    expect(quote?.totalCents).toBe(616777);
    // valid_until is quote_date + the tenant's configured validity days.
    expect(quote?.validUntil).toBe('2026-10-01');

    const taxes = await db.select().from(quoteTaxes).where(eq(quoteTaxes.quoteId, quoteId));
    expect(taxes).toHaveLength(1);
    expect(taxes[0]?.registrationNumber).toBe('80000 0000 RT0001');
  });

  it('excludes the optional upgrade from the total and prices it grossed up', async () => {
    const { quoteId } = await create();
    const lines = await linesOf(quoteId);
    const upgrade = lines.find((line) => line.code === 'FIN-09');
    expect(upgrade?.isIncluded).toBe(false);
    // $420 raw, and accepting it also attracts the 10% overhead.
    expect(upgrade?.lineTotalCents).toBe(42000);
  });

  it('carries provenance onto every line', async () => {
    const { quoteId } = await create();
    const lines = await linesOf(quoteId);
    const demo = lines.find((line) => line.code === 'DEM-01');
    expect(demo?.rateItemId).toBe(demoItemId);
    expect(demo?.costCodeId).not.toBeNull();
  });

  it('snapshots the rate, so raising it later does not move the quote', async () => {
    const { quoteId } = await create();
    const [before] = await db.select().from(quotes).where(eq(quotes.id, quoteId));

    await db
      .update(rateItems)
      .set({ sellRateTenThou: 80000n })
      .where(eq(rateItems.id, demoItemId));

    const [after] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    const lines = await linesOf(quoteId);
    expect(after?.totalCents).toBe(before?.totalCents);
    expect(lines.find((line) => line.code === 'DEM-01')?.unitPriceTenThou).toBe(40000n);
  });

  it('defaults holdback and terms from the organization', async () => {
    const { quoteId } = await create();
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(quote?.holdbackPctTenThou).toBe(1000n);
    expect(quote?.terms).toBe('Payable on completion.');
  });

  it('charges no tax to an exempt customer', async () => {
    await db.update(customers).set({ isTaxExempt: true });
    const { quoteId } = await create();
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(quote?.taxTotalCents).toBe(0);
    expect(quote?.totalCents).toBe(quote?.subtotalCents);
    const taxes = await db.select().from(quoteTaxes).where(eq(quoteTaxes.quoteId, quoteId));
    expect(taxes).toEqual([]);
  });

  it('numbers consecutive quotes without a gap', async () => {
    const first = await create();
    const second = await create();
    expect([first.quoteNumber, second.quoteNumber]).toEqual(['QT-2026-0001', 'QT-2026-0002']);
  });

  it('gives a second estimate on one project its own sequence', async () => {
    // The basement and the deck are separate decisions the customer makes
    // separately. Versions count within a sequence, so a second estimate at
    // version 1 would collide on (project, kind, sequence, version).
    const first = await create();
    const second = await create();
    const rows = await db
      .select({ sequence: quotes.sequence, version: quotes.version })
      .from(quotes)
      .where(eq(quotes.projectId, projectId))
      .orderBy(asc(quotes.sequence));
    expect(rows).toEqual([
      { sequence: 1, version: 1 },
      { sequence: 2, version: 1 },
    ]);
    expect(first.quoteId).not.toBe(second.quoteId);
  });

  it('burns no number when the project does not exist', async () => {
    await expect(
      createQuoteFromTemplate({
        projectId: '11111111-1111-1111-1111-111111111111',
        scopeTemplateId: templateId,
        scope: SCOPE,
        quoteDate: '2026-09-01',
      }),
    ).rejects.toThrow(/not found/i);
    const { quoteNumber } = await create();
    expect(quoteNumber).toBe('QT-2026-0001');
  });
});

describe('reviseQuote', () => {
  async function sentQuote() {
    const { quoteId } = await create();
    await db.update(quotes).set({ status: 'sent', sentAt: new Date() }).where(eq(quotes.id, quoteId));
    return quoteId;
  }

  it('supersedes the source and copies its lines into a new draft', async () => {
    const sourceId = await sentQuote();
    const { quoteId, version } = await reviseQuote({ quoteId: sourceId });

    const [source] = await db.select().from(quotes).where(eq(quotes.id, sourceId));
    const [copy] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(source?.status).toBe('superseded');
    expect(copy?.status).toBe('draft');
    expect(version).toBe(2);
    // The number carries forward: both versions are the same document.
    expect(copy?.quoteNumber).toBe(source?.quoteNumber);
    expect(await linesOf(quoteId)).toHaveLength((await linesOf(sourceId)).length);
  });

  it('leaves the superseded version saying exactly what it said', async () => {
    const sourceId = await sentQuote();
    const [before] = await db.select().from(quotes).where(eq(quotes.id, sourceId));
    await reviseQuote({ quoteId: sourceId });
    const [after] = await db.select().from(quotes).where(eq(quotes.id, sourceId));
    expect(after?.subtotalCents).toBe(before?.subtotalCents);
    expect(after?.totalCents).toBe(before?.totalCents);
  });

  it('carries only active lines forward', async () => {
    const { quoteId: draftId } = await create();
    const lines = await linesOf(draftId);
    await db
      .update(quoteLines)
      .set({ recordStatus: 'void', voidReason: 'Removed from scope' })
      .where(eq(quoteLines.id, lines[0]!.id));
    await db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, draftId));

    const { quoteId } = await reviseQuote({ quoteId: draftId });
    const copied = await linesOf(quoteId);
    expect(copied).toHaveLength(lines.length - 1);
    expect(copied.map((line) => line.code)).not.toContain(lines[0]!.code);
  });

  it('recomputes tax at the rate in force on the revision date', async () => {
    const sourceId = await sentQuote();
    // Close the 13% rate yesterday and open a 15% rate today.
    const today = (
      (await db.execute(
        sql`select to_char((now() at time zone 'America/Toronto')::date, 'YYYY-MM-DD') as d`,
      )) as unknown as { d: string }[]
    )[0]!.d;
    await db.update(taxRates).set({ effectiveTo: '2026-09-02' });
    await db.insert(taxRates).values({
      label: 'HST',
      rateTenThou: 1500n,
      effectiveFrom: '2026-09-03',
      sortOrder: 1,
    });

    const { quoteId } = await reviseQuote({ quoteId: sourceId });
    const [copy] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    const [tax] = await db.select().from(quoteTaxes).where(eq(quoteTaxes.quoteId, quoteId));
    expect(copy?.quoteDate).toBe(today);
    expect(tax?.rateTenThou).toBe(1500n);
    expect(copy?.taxTotalCents).toBe(81873);
  });

  it('refuses to revise a draft, which edits in place', async () => {
    const { quoteId } = await create();
    await expect(reviseQuote({ quoteId })).rejects.toThrow(/draft edits in place/i);
  });

  it('refuses to revise an accepted quote, which takes a change order', async () => {
    const { quoteId } = await create();
    await db.update(quotes).set({ status: 'accepted' }).where(eq(quotes.id, quoteId));
    await expect(reviseQuote({ quoteId })).rejects.toThrow(/change order/i);
  });

  it('refuses to revise a void quote', async () => {
    const sourceId = await sentQuote();
    await voidQuote({ quoteId: sourceId, reason: 'Sent to the wrong customer' });
    await expect(reviseQuote({ quoteId: sourceId })).rejects.toThrow(/void quote/i);
  });

  it('revises a declined quote, which is the second negotiating case', async () => {
    const { quoteId } = await create();
    await db.update(quotes).set({ status: 'declined' }).where(eq(quotes.id, quoteId));
    const { version } = await reviseQuote({ quoteId });
    expect(version).toBe(2);
  });
});

describe('voidQuote', () => {
  it('voids with a reason instead of deleting', async () => {
    const { quoteId } = await create();
    await voidQuote({ quoteId, reason: '  Duplicate of QT-2026-0002  ' });
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(quote?.recordStatus).toBe('void');
    expect(quote?.voidReason).toBe('Duplicate of QT-2026-0002');
    expect(quote?.voidedAt).not.toBeNull();
  });

  it('requires a reason', async () => {
    const { quoteId } = await create();
    await expect(voidQuote({ quoteId, reason: '   ' })).rejects.toThrow(/reason is required/i);
  });

  it('refuses to void a quote with an active change order against it', async () => {
    // Voiding does not cascade: it would silently void records the user never
    // named, and orphaning the change order is worse still.
    const { quoteId } = await create();
    await db.insert(quotes).values({
      projectId,
      quoteNumber: 'CO-2026-0001',
      kind: 'change_order',
      parentQuoteId: quoteId,
      sequence: 1,
      quoteDate: '2026-09-10',
      validUntil: '2026-10-10',
    });
    await expect(voidQuote({ quoteId, reason: 'Wrong scope' })).rejects.toThrow(
      /void the change orders first: CO-2026-0001/,
    );
  });
});

describe('contractValueCents', () => {
  it('sums accepted quotes and ignores everything else', async () => {
    const { quoteId } = await create();
    expect(await contractValueCents(projectId)).toBe(0);

    await db.update(quotes).set({ status: 'accepted' }).where(eq(quotes.id, quoteId));
    const [accepted] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(await contractValueCents(projectId)).toBe(accepted!.totalCents);
  });

  it('adds an accepted change order and subtracts a deductive one', async () => {
    const { quoteId } = await create();
    await db.update(quotes).set({ status: 'accepted' }).where(eq(quotes.id, quoteId));
    const [base] = await db.select().from(quotes).where(eq(quotes.id, quoteId));

    await db.insert(quotes).values([
      {
        projectId,
        quoteNumber: 'CO-2026-0001',
        kind: 'change_order',
        parentQuoteId: quoteId,
        sequence: 1,
        status: 'accepted',
        quoteDate: '2026-09-10',
        validUntil: '2026-10-10',
        totalCents: 150000,
      },
      {
        projectId,
        quoteNumber: 'CO-2026-0002',
        kind: 'change_order',
        parentQuoteId: quoteId,
        sequence: 2,
        status: 'accepted',
        quoteDate: '2026-09-11',
        validUntil: '2026-10-11',
        totalCents: -40000,
      },
    ]);

    expect(await contractValueCents(projectId)).toBe(base!.totalCents + 150000 - 40000);
  });

  it('drops a voided accepted quote out of the value', async () => {
    const { quoteId } = await create();
    await db.update(quotes).set({ status: 'accepted' }).where(eq(quotes.id, quoteId));
    await voidQuote({ quoteId, reason: 'Contract cancelled' });
    expect(await contractValueCents(projectId)).toBe(0);
  });
});

describe('mutability triggers', () => {
  it('refuses to reprice a line once the quote has been sent', async () => {
    const { quoteId } = await create();
    const lines = await linesOf(quoteId);
    await db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, quoteId));

    await expect(
      db
        .update(quoteLines)
        .set({ unitPriceTenThou: 99000n })
        .where(eq(quoteLines.id, lines[0]!.id)),
    ).rejects.toThrow();
  });

  it('refuses to add a line to a sent quote', async () => {
    const { quoteId } = await create();
    await db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, quoteId));
    await expect(
      db.insert(quoteLines).values({
        quoteId,
        sortOrder: 99,
        lineGroup: 'Extras',
        code: 'X',
        description: 'Snuck in',
        calcMode: 'flat',
        unitLabel: '',
        qtyMilli: 1000n,
        unitCostTenThou: 0n,
        unitPriceTenThou: 500000n,
        lineCostCents: 0,
        lineTotalCents: 5000,
      }),
    ).rejects.toThrow();
  });

  it('still allows a line to be voided on a sent quote', async () => {
    const { quoteId } = await create();
    const lines = await linesOf(quoteId);
    await db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, quoteId));
    await db
      .update(quoteLines)
      .set({ recordStatus: 'void', voidReason: 'Customer removed it' })
      .where(eq(quoteLines.id, lines[0]!.id));
    const [voided] = await db.select().from(quoteLines).where(eq(quoteLines.id, lines[0]!.id));
    expect(voided?.recordStatus).toBe('void');
  });

  it('edits a draft line freely', async () => {
    const { quoteId } = await create();
    const lines = await linesOf(quoteId);
    await db
      .update(quoteLines)
      .set({ unitPriceTenThou: 45000n })
      .where(eq(quoteLines.id, lines[0]!.id));
    const [edited] = await db.select().from(quoteLines).where(eq(quoteLines.id, lines[0]!.id));
    expect(edited?.unitPriceTenThou).toBe(45000n);
  });

  it('refuses to change the total of a sent quote header', async () => {
    const { quoteId } = await create();
    await db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, quoteId));
    await expect(
      db.update(quotes).set({ totalCents: 1 }).where(eq(quotes.id, quoteId)),
    ).rejects.toThrow();
  });

  it('permits the whitelisted header changes on a sent quote', async () => {
    const { quoteId } = await create();
    await db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, quoteId));
    await db
      .update(quotes)
      .set({
        status: 'accepted',
        acceptedAt: new Date(),
        acceptedByName: 'Eleanor Vance',
        pdfPath: '/files/q1.pdf',
        internalNotes: 'Signed at the kitchen table',
      })
      .where(eq(quotes.id, quoteId));
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(quote?.status).toBe('accepted');
    expect(quote?.acceptedByName).toBe('Eleanor Vance');
  });

  it('refuses to alter the snapshotted tax of a sent quote', async () => {
    const { quoteId } = await create();
    await db.update(quotes).set({ status: 'sent' }).where(eq(quotes.id, quoteId));
    await expect(
      db
        .update(quoteTaxes)
        .set({ taxAmountCents: 1 })
        .where(and(eq(quoteTaxes.quoteId, quoteId), eq(quoteTaxes.label, 'HST'))),
    ).rejects.toThrow();
  });
});
