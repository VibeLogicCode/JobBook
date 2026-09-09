import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  companies, costCodes, customers, projectTypes, projects, quotes, rateItems,
  scopeTemplateItems, scopeTemplates, taxRates,
} from '@/db/schema';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { createBlankQuote, createQuoteFromTemplate } from '@/lib/quote/repository';
import { flagsForProject, offeredTypes, typeIsOffered } from '@/lib/posture/read';
import { seedDeployment } from '../support/organization';

/**
 * A service job's quote does not withhold a holdback nobody agreed to.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS SHORT AND STILL THE MOST IMPORTANT ONE HERE
 * ---------------------------------------------------------------------------
 *
 * `lib/quote/repository.ts` copies the issuing company's default holdback onto
 * every new quote. Without the project-type check, a service job's accepted
 * quote carries 10% and its final invoice withholds it -- silently, on a
 * document the customer signs, with the arithmetic entirely innocent.
 *
 * That is the same failure class as a quote printing holdback terms on a job
 * that withheld nothing, and as two companies charging 26% tax: correct code
 * fed a row nobody refused.
 */

const SERVICE_TYPE = 'aaaaaaaa-0000-4a00-9000-00000000f001';
const CONTRACT_TYPE = 'aaaaaaaa-0000-4a00-9000-00000000f002';

let serviceProjectId: string;
let contractProjectId: string;

beforeEach(async () => {
  await db.execute(sql`
    truncate table audit_log, stage_history, quote_taxes, quote_lines, quotes,
      scope_template_items, scope_templates, rate_items, cost_codes, tax_rates,
      projects, customers, organization, companies, document_sequences
    restart identity cascade
  `);

  await seedDeployment({
    legalName: 'Northgate Electric Ltd.',
    displayName: 'Northgate Electric',
    timezone: 'America/Toronto',
    // 10% in ten-thousandths. The figure a contract job should carry and a
    // service job must not.
    defaultHoldbackPctTenThou: 100000n,
    holdbackTermsText: 'A 10% statutory holdback is retained on each payment.',
    quoteValidityDays: 30,
  });

  await db.insert(taxRates).values({
    companyId: FIRST_COMPANY_ID,
    label: 'HST',
    rateTenThou: 130000n,
    effectiveFrom: '2010-07-01',
    sortOrder: 1,
  });

  // Two types that differ in ONE flag, so nothing else can explain the
  // difference in what their quotes carry.
  /**
   * UPSERTED on fixed ids, because `project_types` is deliberately NOT in the
   * truncate list above: the nine rows migration 0018 created have to survive
   * for the last test in this file, which asserts they still carry today's
   * behaviour. A plain insert clashes on the second test in the file.
   */
  const serviceType = {
    id: SERVICE_TYPE,
    name: 'Service call',
    posture: 'service' as const,
    holdback: false,
    progressInvoicing: false,
    scheduleTemplate: false,
    constructionActDates: false,
    scopeInputs: false,
    isActive: true,
    sortOrder: 5,
  };
  const contractType = {
    id: CONTRACT_TYPE,
    name: 'Rewire',
    posture: 'contract' as const,
    isActive: true,
    sortOrder: 6,
  };
  await db.insert(projectTypes).values(serviceType)
    .onConflictDoUpdate({ target: projectTypes.id, set: serviceType });
  await db.insert(projectTypes).values(contractType)
    .onConflictDoUpdate({ target: projectTypes.id, set: contractType });

  const [customer] = await db
    .insert(customers)
    .values({ name: 'Sample Client', customerType: 'residential' })
    .returning({ id: customers.id });

  const [service] = await db
    .insert(projects)
    .values({
      name: 'Panel would not reset',
      projectNumber: 'P-2026-9001',
      customerId: customer!.id,
      companyId: FIRST_COMPANY_ID,
      projectTypeId: SERVICE_TYPE,
    })
    .returning({ id: projects.id });
  serviceProjectId = service!.id;

  const [contract] = await db
    .insert(projects)
    .values({
      name: 'Whole-house rewire',
      projectNumber: 'P-2026-9002',
      customerId: customer!.id,
      companyId: FIRST_COMPANY_ID,
      projectTypeId: CONTRACT_TYPE,
    })
    .returning({ id: projects.id });
  contractProjectId = contract!.id;
});

describe('the holdback a new quote carries', () => {
  it('writes none on a service-type job', async () => {
    const { quoteId } = await createBlankQuote({ projectId: serviceProjectId });
    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));

    /**
     * NULL, not 0n. `contractOf` in lib/invoice/repository.ts reads absence as
     * "the contract withholds nothing" and refuses to fall back to a company
     * default, and `lib/quote/holdback-notice.ts` refuses to print the
     * paragraph on a null. Writing 0n would be a second representation of one
     * fact and both would then have two shapes to refuse.
     */
    expect(row!.holdbackPctTenThou).toBeNull();
  });

  it('still writes it on a contract-type job', async () => {
    const { quoteId } = await createBlankQuote({ projectId: contractProjectId });
    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row!.holdbackPctTenThou).toBe(100000n);
  });

  it('does the same through the template path', async () => {
    // Two call sites copy the default, and both had to be intercepted. A test
    // on one of them would have passed while the other went on withholding.
    const [code] = await db.insert(costCodes)
      .values({ code: '26-00', name: 'Electrical' })
      .returning({ id: costCodes.id });
    const [item] = await db.insert(rateItems).values({
      code: 'SVC-01',
      description: 'Service call, first hour',
      unitLabel: 'hour',
      calcMode: 'qty',
      sellRateTenThou: 1450000n,
      costRateTenThou: 600000n,
      costCodeId: code!.id,
    }).returning({ id: rateItems.id });

    const [template] = await db.insert(scopeTemplates)
      .values({ name: 'Service call', projectTypeId: SERVICE_TYPE })
      .returning({ id: scopeTemplates.id });
    await db.insert(scopeTemplateItems).values({
      scopeTemplateId: template!.id,
      rateItemId: item!.id,
      lineGroup: 'Labour',
      sortOrder: 1,
      qtySource: 'fixed',
      fixedQtyMilli: 1000n,
    });

    const { quoteId } = await createQuoteFromTemplate({
      projectId: serviceProjectId,
      scopeTemplateId: template!.id,
      // A service type has `scopeInputs` off, so nothing reads these -- but
      // the type is required and zeroes are the honest value for "no scope".
      scope: { areaSqftMilli: 0n, washroomCount: 0, kitchenCount: 0, bedroomCount: 0 },
    });
    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row!.holdbackPctTenThou).toBeNull();
  });

  it('does not invent a statutory default when the company has none', async () => {
    /**
     * An earlier draft promised "sane statutory defaults" when the holdback
     * settings are hidden. WITHDRAWN: a 10% fallback would be a jurisdiction
     * assumption wearing a number that both `invoices.ts` and `holdback.ts`
     * refuse. The override sets the column explicitly or there is no holdback.
     */
    await db.update(companies)
      .set({ defaultHoldbackPctTenThou: null })
      .where(eq(companies.id, FIRST_COMPANY_ID));

    const { quoteId } = await createBlankQuote({ projectId: contractProjectId });
    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row!.holdbackPctTenThou).toBeNull();
  });
});

describe('the flags come from the job, not the company', () => {
  it('reads a project type through its project', async () => {
    expect(await flagsForProject(db, serviceProjectId)).toEqual({
      holdback: false,
      progressInvoicing: false,
      scheduleTemplate: false,
      constructionActDates: false,
      scopeInputs: false,
    });
  });

  it('keeps a signed job withholding after the company turns service-only', async () => {
    // The whole reason the flags are on the TYPE. Switching the company
    // changes what is OFFERED on new work and nothing about work in flight --
    // the alternative would silently change the terms of a signed contract.
    const { quoteId } = await createBlankQuote({ projectId: contractProjectId });
    await db.update(companies).set({ workPosture: 'service' })
      .where(eq(companies.id, FIRST_COMPANY_ID));

    const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(row!.holdbackPctTenThou).toBe(100000n);
    expect((await flagsForProject(db, contractProjectId)).holdback).toBe(true);
  });

  it('fails OPEN on a project it cannot read', async () => {
    // Posture is not a permission: it shortens forms. An unreachable row must
    // not silently drop the holdback from a job that agreed to one.
    const flags = await flagsForProject(db, '11111111-1111-1111-1111-111111111111');
    expect(flags.holdback).toBe(true);
  });
});

describe('which types a company is offered', () => {
  it('offers a service company its own types and the shared ones', async () => {
    const names = (await offeredTypes('service')).map((row) => row.name);
    expect(names).toContain('Service call');
    expect(names).not.toContain('Rewire');
  });

  it('offers a contract company the other half', async () => {
    const names = (await offeredTypes('contract')).map((row) => row.name);
    expect(names).toContain('Rewire');
    expect(names).not.toContain('Service call');
  });

  it('offers everything under both, which is today behaviour', async () => {
    const names = (await offeredTypes('both')).map((row) => row.name);
    expect(names).toContain('Service call');
    expect(names).toContain('Rewire');
    // And the nine types migration 0018 created, all tagged `both`.
    expect(names).toContain('Basement');
  });

  it('shows a both-tagged type to every posture', async () => {
    // How a pack ships `Panel upgrade`: one row, offered either way, rather
    // than one row per posture. Adding a posture must not multiply content.
    for (const posture of ['both', 'service', 'contract'] as const) {
      expect(typeIsOffered('both', posture)).toBe(true);
    }
  });

  it('excludes a retired type from what is offered', async () => {
    await db.update(projectTypes).set({ isActive: false })
      .where(eq(projectTypes.id, SERVICE_TYPE));
    const names = (await offeredTypes('service')).map((row) => row.name);
    expect(names).not.toContain('Service call');
    // Retired, not gone: the job already filed under it still reads it.
    expect((await flagsForProject(db, serviceProjectId)).holdback).toBe(false);
  });
});

describe('the nine existing types keep today behaviour', () => {
  it('has every flag on, Water leak and Other included', async () => {
    const rows = await db.select().from(projectTypes);
    const seeded = rows.filter((row) =>
      Object.values(PROJECT_TYPE_IDS).includes(row.id as never));
    expect(seeded).toHaveLength(9);
    for (const row of seeded) {
      /**
       * Deliberately including `Water leak`. A migration that reasoned "a
       * water leak is maintenance, so holdback off" would change the terms of
       * jobs already signed under that type -- quietly, on documents a
       * customer is holding. Turning a flag off is something a person does for
       * new work.
       */
      expect(row.holdback).toBe(true);
      expect(row.progressInvoicing).toBe(true);
      expect(row.scheduleTemplate).toBe(true);
      expect(row.constructionActDates).toBe(true);
      expect(row.scopeInputs).toBe(true);
      expect(row.posture).toBe('both');
    }
  });
});

describe('which invoices a job can raise', () => {
  /**
   * The stranded receivable this design nearly created.
   *
   * An earlier draft removed the `progress` and `holdback_release` kinds at
   * the COMPANY level. Holdback accrues only on draws and is paid out only by
   * a release -- so a contract job under a service-only company would have
   * withheld 10% on its draws and had no invoice kind able to bill it back.
   * Money owed, sitting in the ledger, un-invoiceable.
   *
   * Tying the kinds to the job's own project-type flags is what prevents it,
   * and these assertions are on `flagsForProject` because that is the value
   * the billing action reads.
   */
  it('says a service type does not take draws', async () => {
    expect((await flagsForProject(db, serviceProjectId)).progressInvoicing).toBe(false);
  });

  it('says a contract type does', async () => {
    expect((await flagsForProject(db, contractProjectId)).progressInvoicing).toBe(true);
  });

  it('keeps a contract job billable in draws after the company turns service-only', async () => {
    await db.update(companies).set({ workPosture: 'service' })
      .where(eq(companies.id, FIRST_COMPANY_ID));
    // The flag is on the TYPE, so the job that withheld money can still bill
    // it back. This is the assertion the earlier draft would have failed.
    expect((await flagsForProject(db, contractProjectId)).progressInvoicing).toBe(true);
    expect((await flagsForProject(db, contractProjectId)).holdback).toBe(true);
  });
});
