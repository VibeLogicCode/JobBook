import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { db } from '@/db/client';
import {
  costCodes, customers, organization, projects, quoteLines, quotes, rateItems,
  scopeTemplateItems, scopeTemplates, stageHistory, taxRates,
} from '@/db/schema';
import { acceptQuoteLines } from '@/lib/quote/accept';
import { createChangeOrder } from '@/lib/quote/change-order';
import { contractValueCents, createQuoteFromTemplate, voidQuote } from '@/lib/quote/repository';

/**
 * The figures are chosen to divide cleanly, so a wrong answer is obvious rather
 * than plausible: 1000 sqft at $4.0000 and $6.0000 is $4,000 and $6,000, ten
 * per cent overhead on that is $1,000, and thirteen per cent of the $11,000
 * subtotal is exactly $1,430 with nothing to round.
 */
let projectId: string;
let templateId: string;

const SCOPE = {
  areaSqftMilli: 1000000n,
  washroomCount: 1,
  kitchenCount: 0,
  bedroomCount: 2,
};

const WHO = 'Site owner';

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, stage_history, sessions, user_identities, quote_taxes, quote_lines,
    quotes, scope_template_items, scope_templates, rate_items, cost_codes, tax_rates,
    projects, customers, users, organization, document_sequences
    restart identity cascade
  `);

  await db.insert(organization).values({
    id: 1,
    legalName: 'Test Company Ltd',
    displayName: 'Test Company',
    timezone: 'America/Toronto',
    quoteValidityDays: 30,
    defaultHoldbackPctTenThou: 1000n,
    quoteTermsText: 'Payable on completion.',
  });
  await db.insert(taxRates).values({
    label: 'Sales tax',
    rateTenThou: 1300n,
    effectiveFrom: '2010-07-01',
    sortOrder: 1,
  });

  const [customer] = await db
    .insert(customers)
    .values({ name: 'Test Customer', customerType: 'residential' })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      customerId: customer!.id,
      projectNumber: 'P-0001',
      name: 'Lower level fit-out',
      projectTypeId: PROJECT_TYPE_IDS.basement,
      stage: 'quote_sent',
    })
    .returning();
  projectId = project!.id;

  const [code] = await db.insert(costCodes).values({ code: '02-40', name: 'Demolition' }).returning();

  const [demo] = await db
    .insert(rateItems)
    .values({
      code: 'DEM-01',
      description: 'Strip the existing finishes',
      costCodeId: code!.id,
      calcMode: 'qty',
      unitLabel: 'sqft',
      costRateTenThou: 20000n,
      sellRateTenThou: 40000n,
    })
    .returning();
  const [frame] = await db
    .insert(rateItems)
    .values({
      code: 'FRM-02',
      description: 'Frame the partitions',
      costCodeId: code!.id,
      calcMode: 'qty',
      unitLabel: 'sqft',
      costRateTenThou: 30000n,
      sellRateTenThou: 60000n,
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
    .values({ name: 'Lower Level', projectTypeId: PROJECT_TYPE_IDS.basement })
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
      rateItemId: frame!.id,
      qtySource: 'area',
      lineGroup: 'Framing',
      sortOrder: 2,
    },
    {
      scopeTemplateId: templateId,
      rateItemId: upgrade!.id,
      qtySource: 'fixed',
      fixedQtyMilli: 1000n,
      isOptional: true,
      lineGroup: 'Upgrades',
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

const create = (over: { quoteDate?: string } = {}) =>
  createQuoteFromTemplate({
    projectId,
    scopeTemplateId: templateId,
    scope: SCOPE,
    quoteDate: '2026-09-01',
    ...over,
  });

async function send(quoteId: string) {
  await db
    .update(quotes)
    .set({ status: 'sent', sentAt: new Date() })
    .where(eq(quotes.id, quoteId));
}

async function linesOf(quoteId: string) {
  return db
    .select()
    .from(quoteLines)
    .where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.recordStatus, 'active')))
    .orderBy(asc(quoteLines.sortOrder));
}

async function idsFor(quoteId: string, codes: string[]): Promise<string[]> {
  const lines = await linesOf(quoteId);
  return codes.map((code) => {
    const line = lines.find((row) => row.code === code);
    if (!line) throw new Error(`fixture has no ${code} line`);
    return line.id;
  });
}

const header = async (quoteId: string) => {
  const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
  return row!;
};

/** A sent quote and the ids of the two work lines the customer was quoted. */
async function sentQuote() {
  const { quoteId } = await create();
  await send(quoteId);
  const [demo, frame, upgrade] = await idsFor(quoteId, ['DEM-01', 'FRM-02', 'FIN-09']);
  return { quoteId, demo: demo!, frame: frame!, upgrade: upgrade! };
}

describe('accepting every line', () => {
  it('accepts the version that exists and writes no second version', async () => {
    // The whole point: nothing about the document changed, so a version 2 would
    // leave the customer's signed page and the record differing by a number.
    const { quoteId, demo, frame } = await sentQuote();

    const result = await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo, frame],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    expect(result.revised).toBe(false);
    expect(result.acceptedQuoteId).toBe(quoteId);
    expect(result.version).toBe(1);
    expect(result.supersededQuoteId).toBeNull();

    const versions = await db.select().from(quotes).where(eq(quotes.projectId, projectId));
    expect(versions).toHaveLength(1);

    const row = await header(quoteId);
    expect(row.status).toBe('accepted');
    expect(row.acceptedByName).toBe(WHO);
    expect(row.acceptedAt).not.toBeNull();
    // Untouched, because there was nothing to recompute.
    expect(row.subtotalCents).toBe(1100000);
    expect(row.taxTotalCents).toBe(143000);
    expect(row.totalCents).toBe(1243000);
  });

  it('turns the opportunity into a job, and records the transition once', async () => {
    const { quoteId, demo, frame } = await sentQuote();
    await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo, frame],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project?.stage).toBe('won');

    // stage_history is trigger-populated. Exactly one row for this move proves
    // the application is not writing a second copy of it.
    const history = await db
      .select()
      .from(stageHistory)
      .where(eq(stageHistory.projectId, projectId))
      .orderBy(asc(stageHistory.changedAt));
    expect(history.filter((row) => row.toStage === 'won')).toHaveLength(1);
    expect(history.at(-1)?.fromStage).toBe('quote_sent');
  });

  it('leaves a job already under way where it is', async () => {
    // Dragging an in-progress job back to 'won' would make the stage disagree
    // with the site and record a regression that never happened.
    const { quoteId, demo, frame } = await sentQuote();
    await db.update(projects).set({ stage: 'in_progress' }).where(eq(projects.id, projectId));

    await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo, frame],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project?.stage).toBe('in_progress');
  });

  it('accepts a draft nobody marked sent, and invents no send timestamp', async () => {
    // Owners hand over a printed quote and never press the button. Refusing the
    // signature would teach them to record a send that did not happen.
    const { quoteId } = await create();
    const [demo, frame] = await idsFor(quoteId, ['DEM-01', 'FRM-02']);

    await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo!, frame!],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    const row = await header(quoteId);
    expect(row.status).toBe('accepted');
    expect(row.sentAt).toBeNull();
  });

  it('makes the accepted total the contract value', async () => {
    const { quoteId, demo, frame } = await sentQuote();
    expect(await contractValueCents(projectId)).toBe(0);

    await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo, frame],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    expect(await contractValueCents(projectId)).toBe(1243000);
  });
});

describe('accepting a subset', () => {
  it('writes an accepted next version and supersedes the one that was sent', async () => {
    const { quoteId, demo } = await sentQuote();

    const result = await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    expect(result.revised).toBe(true);
    expect(result.version).toBe(2);
    expect(result.supersededQuoteId).toBe(quoteId);
    expect(result.acceptedQuoteId).not.toBe(quoteId);

    expect((await header(quoteId)).status).toBe('superseded');

    const accepted = await header(result.acceptedQuoteId);
    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedByName).toBe(WHO);
    // The same document, one version on: the number is what the customer holds.
    expect(accepted.quoteNumber).toBe((await header(quoteId)).quoteNumber);
    expect(accepted.sequence).toBe(1);
  });

  it('gives the accepted version totals equal to the sum of its own lines', async () => {
    const { quoteId, demo } = await sentQuote();
    const { acceptedQuoteId } = await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    const lines = await linesOf(acceptedQuoteId);
    const accepted = await header(acceptedQuoteId);

    const sum = lines.reduce((total, line) => total + line.lineTotalCents, 0);
    expect(accepted.subtotalCents).toBe(sum);
    expect(accepted.totalCents).toBe(accepted.subtotalCents + accepted.taxTotalCents);
    // $4,000 of demolition, plus 10% overhead, plus 13% on the $4,400.
    expect(accepted.subtotalCents).toBe(440000);
    expect(accepted.taxTotalCents).toBe(57200);
    expect(accepted.totalCents).toBe(497200);
    expect(await contractValueCents(projectId)).toBe(497200);
  });

  it('carries the percent line and re-resolves it against the smaller base', async () => {
    // A percent line is arithmetic, not scope: dropping it because nobody
    // ticked it would delete the overhead recovery from a job still to be run.
    const { quoteId, demo } = await sentQuote();
    const { acceptedQuoteId } = await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    const lines = await linesOf(acceptedQuoteId);
    const carried = lines.find((line) => line.code === 'OH-01');
    expect(carried).toBeDefined();
    // 10% of the $4,000 that is left, not the $10,000 that was quoted.
    expect(carried?.lineTotalCents).toBe(40000);
    expect(lines.map((line) => line.code)).toEqual(['DEM-01', 'OH-01']);
  });

  it('leaves the superseded version saying exactly what it said', async () => {
    const { quoteId, demo } = await sentQuote();
    const before = await header(quoteId);
    const beforeLines = await linesOf(quoteId);

    await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    const after = await header(quoteId);
    expect(after.subtotalCents).toBe(before.subtotalCents);
    expect(after.totalCents).toBe(before.totalCents);
    expect(await linesOf(quoteId)).toHaveLength(beforeLines.length);
  });

  it('copies the line prices rather than re-pricing them at the current rate', async () => {
    const { quoteId, demo } = await sentQuote();
    await db.update(rateItems).set({ sellRateTenThou: 999999n }).where(eq(rateItems.code, 'DEM-01'));

    const { acceptedQuoteId } = await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    const lines = await linesOf(acceptedQuoteId);
    expect(lines.find((line) => line.code === 'DEM-01')?.unitPriceTenThou).toBe(40000n);
  });

  it('taxes the contract at the rate in force on the quote date, not today', async () => {
    // The divergence from reviseQuote, which re-dates its copy because it is a
    // new offer. This version is the page that was signed, so a rate change
    // landing between the quote and the signature must not reach it.
    const { quoteId } = await create({ quoteDate: '2026-01-01' });
    await send(quoteId);
    await db.update(taxRates).set({ effectiveTo: '2026-06-30' }).where(eq(taxRates.label, 'Sales tax'));
    await db.insert(taxRates).values({
      label: 'Sales tax',
      rateTenThou: 1500n,
      effectiveFrom: '2026-07-01',
      sortOrder: 1,
    });

    const [demo] = await idsFor(quoteId, ['DEM-01']);
    const { acceptedQuoteId } = await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo!],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    // 13% of $4,400, not the 15% that is in force now.
    expect((await header(acceptedQuoteId)).taxTotalCents).toBe(57200);
  });
});

describe('optional lines', () => {
  it('counts an accepted upgrade toward the contract', async () => {
    // An accepted upgrade that silently does not count is an under-billed job.
    const { quoteId, demo, frame, upgrade } = await sentQuote();

    const { acceptedQuoteId, revised } = await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo, frame, upgrade],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    // Taking an upgrade changes the document, so it cannot be accepted in place.
    expect(revised).toBe(true);

    const lines = await linesOf(acceptedQuoteId);
    const taken = lines.find((line) => line.code === 'FIN-09');
    expect(taken?.isIncluded).toBe(true);
    expect(taken?.isOptional).toBe(false);

    const accepted = await header(acceptedQuoteId);
    // $11,000 plus the upgrade's grossed-up price of $462 -- $420 of work and
    // the 10% overhead it now attracts, which is exactly what the quote
    // printed as the upgrade's price.
    expect(accepted.subtotalCents).toBe(1146200);
    expect(accepted.taxTotalCents).toBe(149006);
    expect(await contractValueCents(projectId)).toBe(accepted.totalCents);
  });

  it('does not carry an upgrade the customer did not take', async () => {
    const { quoteId, demo } = await sentQuote();
    const { acceptedQuoteId } = await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    const lines = await linesOf(acceptedQuoteId);
    expect(lines.some((line) => line.code === 'FIN-09')).toBe(false);
    // And it is still readable on the version that offered it.
    expect((await linesOf(quoteId)).some((line) => line.code === 'FIN-09')).toBe(true);
  });

  it('accepts in place when every quoted line is won and no upgrade is taken', async () => {
    // The untaken upgrade was never part of the price, so nothing changed and
    // the document stands as it is.
    const { quoteId, demo, frame } = await sentQuote();
    const result = await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo, frame],
      declineSiblings: false,
      acceptedByName: WHO,
    });
    expect(result.revised).toBe(false);
  });
});

describe('siblings on the opportunity', () => {
  /** A second, competing price on the same job. */
  async function secondEstimate() {
    const { quoteId } = await create();
    await send(quoteId);
    return quoteId;
  }

  it('declines the other estimates when asked', async () => {
    const first = await sentQuote();
    const second = await secondEstimate();

    const result = await acceptQuoteLines({
      quoteId: first.quoteId,
      wonLineIds: [first.demo, first.frame],
      declineSiblings: true,
      acceptedByName: WHO,
    });

    expect(result.declined.map((row) => row.id)).toEqual([second]);
    const row = await header(second);
    expect(row.status).toBe('declined');
    expect(row.declinedAt).not.toBeNull();
    expect(row.sequence).toBe(2);
  });

  it('leaves them alone when not asked, because two quotes on one house can both be won', async () => {
    const first = await sentQuote();
    const second = await secondEstimate();

    const result = await acceptQuoteLines({
      quoteId: first.quoteId,
      wonLineIds: [first.demo, first.frame],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    expect(result.declined).toEqual([]);
    expect((await header(second)).status).toBe('sent');
  });

  it('never touches an estimate that was already accepted', async () => {
    // Contract value is the sum of the accepted quotes, so declining one would
    // quietly reduce the value of a job already under way.
    const second = await secondEstimate();
    const [otherDemo, otherFrame] = await idsFor(second, ['DEM-01', 'FRM-02']);
    await acceptQuoteLines({
      quoteId: second,
      wonLineIds: [otherDemo!, otherFrame!],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    const first = await sentQuote();
    const result = await acceptQuoteLines({
      quoteId: first.quoteId,
      wonLineIds: [first.demo, first.frame],
      declineSiblings: true,
      acceptedByName: WHO,
    });

    expect(result.declined).toEqual([]);
    expect((await header(second)).status).toBe('accepted');
    // Both stand, and the job is worth both of them.
    expect(await contractValueCents(projectId)).toBe(1243000 * 2);
  });

  it('never touches a change order', async () => {
    // A change order amends a contract rather than competing with an estimate,
    // and declining a pending one would cancel agreed extras nobody named.
    const first = await sentQuote();
    await acceptQuoteLines({
      quoteId: first.quoteId,
      wonLineIds: [first.demo, first.frame],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    const order = await createChangeOrder({
      parentQuoteId: first.quoteId,
      reason: 'site_condition',
      lines: [
        {
          code: 'FRM-02',
          description: 'Move the bearing wall',
          lineGroup: 'Change',
          calcMode: 'flat',
          unitLabel: '',
          qtyMilli: 1000n,
          unitCostTenThou: 500000n,
          unitPriceTenThou: 800000n,
        },
      ],
    });

    const second = await secondEstimate();
    const [otherDemo, otherFrame] = await idsFor(second, ['DEM-01', 'FRM-02']);
    await acceptQuoteLines({
      quoteId: second,
      wonLineIds: [otherDemo!, otherFrame!],
      declineSiblings: true,
      acceptedByName: WHO,
    });

    expect((await header(order.quoteId)).status).toBe('draft');
  });

  it('offers nothing to decline when the job carries one estimate', async () => {
    const first = await sentQuote();
    const result = await acceptQuoteLines({
      quoteId: first.quoteId,
      wonLineIds: [first.demo, first.frame],
      declineSiblings: true,
      acceptedByName: WHO,
    });
    expect(result.declined).toEqual([]);
  });
});

describe('the accepted slot', () => {
  it('never holds two rows at one sequence, and says so rather than colliding', async () => {
    const { quoteId, demo } = await sentQuote();
    const { acceptedQuoteId } = await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    const accepted = await header(acceptedQuoteId);
    const [line] = await linesOf(acceptedQuoteId);

    // A hand-made third version at the same sequence, which is the only way to
    // reach the state the partial unique index exists to forbid.
    const [third] = await db
      .insert(quotes)
      .values({
        projectId,
        quoteNumber: accepted.quoteNumber,
        kind: 'estimate',
        sequence: accepted.sequence,
        version: 3,
        status: 'draft',
        quoteDate: accepted.quoteDate,
        validUntil: accepted.validUntil,
      })
      .returning();
    const [thirdLine] = await db
      .insert(quoteLines)
      .values({
        quoteId: third!.id,
        sortOrder: 1,
        lineGroup: line!.lineGroup,
        code: line!.code,
        description: line!.description,
        calcMode: line!.calcMode,
        unitLabel: line!.unitLabel,
        qtyMilli: line!.qtyMilli,
        unitCostTenThou: line!.unitCostTenThou,
        unitPriceTenThou: line!.unitPriceTenThou,
        lineCostCents: line!.lineCostCents,
        lineTotalCents: line!.lineTotalCents,
      })
      .returning();

    await expect(
      acceptQuoteLines({
        quoteId: third!.id,
        wonLineIds: [thirdLine!.id],
        declineSiblings: false,
        acceptedByName: WHO,
      }),
    ).rejects.toThrow(/already stands accepted/i);

    const standing = await db
      .select()
      .from(quotes)
      .where(
        and(
          eq(quotes.projectId, projectId),
          eq(quotes.kind, 'estimate'),
          eq(quotes.sequence, accepted.sequence),
          eq(quotes.status, 'accepted'),
          eq(quotes.recordStatus, 'active'),
        ),
      );
    expect(standing).toHaveLength(1);
  });

  it('refuses a second acceptance of the version it just accepted', async () => {
    const { quoteId, demo, frame } = await sentQuote();
    await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo, frame],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    await expect(
      acceptQuoteLines({
        quoteId,
        wonLineIds: [demo, frame],
        declineSiblings: false,
        acceptedByName: WHO,
      }),
    ).rejects.toThrow(/this quote is accepted/i);
  });

  it('refuses the version it superseded on the way', async () => {
    const { quoteId, demo } = await sentQuote();
    await acceptQuoteLines({
      quoteId,
      wonLineIds: [demo],
      declineSiblings: false,
      acceptedByName: WHO,
    });

    await expect(
      acceptQuoteLines({
        quoteId,
        wonLineIds: [demo],
        declineSiblings: false,
        acceptedByName: WHO,
      }),
    ).rejects.toThrow(/this quote is superseded/i);
  });
});

describe('refusals', () => {
  it('refuses a declined quote, which is revised before it is signed', async () => {
    const { quoteId, demo, frame } = await sentQuote();
    await db.update(quotes).set({ status: 'declined' }).where(eq(quotes.id, quoteId));

    await expect(
      acceptQuoteLines({
        quoteId,
        wonLineIds: [demo, frame],
        declineSiblings: false,
        acceptedByName: WHO,
      }),
    ).rejects.toThrow(/this quote is declined/i);
  });

  it('refuses a void record', async () => {
    const { quoteId, demo, frame } = await sentQuote();
    await voidQuote({ quoteId, reason: 'Quoted the wrong address' });

    await expect(
      acceptQuoteLines({
        quoteId,
        wonLineIds: [demo, frame],
        declineSiblings: false,
        acceptedByName: WHO,
      }),
    ).rejects.toThrow(/void quote cannot be accepted/i);
  });

  it('refuses a change order, which is accepted whole', async () => {
    const first = await sentQuote();
    await acceptQuoteLines({
      quoteId: first.quoteId,
      wonLineIds: [first.demo, first.frame],
      declineSiblings: false,
      acceptedByName: WHO,
    });
    const order = await createChangeOrder({
      parentQuoteId: first.quoteId,
      reason: 'customer_request',
      lines: [
        {
          code: 'FRM-02',
          description: 'Add a bulkhead',
          lineGroup: 'Change',
          calcMode: 'flat',
          unitLabel: '',
          qtyMilli: 1000n,
          unitCostTenThou: 100000n,
          unitPriceTenThou: 160000n,
        },
      ],
    });
    const [orderLine] = await linesOf(order.quoteId);

    await expect(
      acceptQuoteLines({
        quoteId: order.quoteId,
        wonLineIds: [orderLine!.id],
        declineSiblings: false,
        acceptedByName: WHO,
      }),
    ).rejects.toThrow(/change order is accepted as a whole/i);
  });

  it('refuses an empty selection, because accepting nothing is declining', async () => {
    const { quoteId } = await sentQuote();
    await expect(
      acceptQuoteLines({
        quoteId,
        wonLineIds: [],
        declineSiblings: false,
        acceptedByName: WHO,
      }),
    ).rejects.toThrow(/nothing was selected/i);
  });

  it('refuses a line that belongs to another quote', async () => {
    const first = await sentQuote();
    const other = await create();
    const [stranger] = await idsFor(other.quoteId, ['DEM-01']);

    await expect(
      acceptQuoteLines({
        quoteId: first.quoteId,
        wonLineIds: [first.demo, stranger!],
        declineSiblings: false,
        acceptedByName: WHO,
      }),
    ).rejects.toThrow(/does not belong to this quote/i);
  });

  it('refuses a percent line on its own, because it is arithmetic and not scope', async () => {
    const { quoteId, demo } = await sentQuote();
    const [overhead] = await idsFor(quoteId, ['OH-01']);

    await expect(
      acceptQuoteLines({
        quoteId,
        wonLineIds: [demo, overhead!],
        declineSiblings: false,
        acceptedByName: WHO,
      }),
    ).rejects.toThrow(/carries forward automatically/i);
  });

  it('refuses an acceptance with nobody named against it', async () => {
    const { quoteId, demo, frame } = await sentQuote();
    await expect(
      acceptQuoteLines({
        quoteId,
        wonLineIds: [demo, frame],
        declineSiblings: false,
        acceptedByName: '   ',
      }),
    ).rejects.toThrow(/who accepted it/i);
  });

  it('refuses a quote that does not exist', async () => {
    await expect(
      acceptQuoteLines({
        quoteId: '11111111-1111-1111-1111-111111111111',
        wonLineIds: ['22222222-2222-2222-2222-222222222222'],
        declineSiblings: false,
        acceptedByName: WHO,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('changes nothing at all when it refuses', async () => {
    // A refusal that had already moved the project stage or declined a sibling
    // would be worse than the collision it avoided.
    const first = await sentQuote();
    const second = await create();
    await send(second.quoteId);

    await expect(
      acceptQuoteLines({
        quoteId: first.quoteId,
        wonLineIds: [first.demo, second.quoteId],
        declineSiblings: true,
        acceptedByName: WHO,
      }),
    ).rejects.toThrow();

    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project?.stage).toBe('quote_sent');
    expect((await header(second.quoteId)).status).toBe('sent');
    expect((await header(first.quoteId)).status).toBe('sent');
    expect(await contractValueCents(projectId)).toBe(0);
  });
});
