import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  companies, costCodes, customers, projectTypes, projects, quotes, rateItems,
  scopeTemplateItems, scopeTemplates, taxRates,
} from '@/db/schema';
import { DEFAULT_PROJECT_TYPES, PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { createBlankQuote, createQuoteFromTemplate } from '@/lib/quote/repository';
import {
  flagsForProject, flagsForQuote, offeredTypes, offeredWork, postureIsOffered, typeIsOffered,
} from '@/lib/posture/read';
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
  /**
   * `project_types` IS truncated and the nine restored, which it did not used
   * to be.
   *
   * It was left out so the last test in this file could assert the nine
   * migration-0018 rows still carry today's behaviour -- but leaving them
   * meant leaving whatever the PREVIOUS test file left, and
   * `pack-seeding.test.ts` runs before this one and ends with a trade pack
   * loaded. Every pack ships a type called `Service call`, and
   * `project_types` has a unique index on `lower(name)`, so this file's own
   * fixture collided with it: 24 failures whose message named a constraint,
   * in a file that had not changed.
   *
   * Truncating and re-inserting the nine is what `pack-seeding.test.ts`
   * already does for the same reason, and it gives the last test here exactly
   * what it was reading before -- nine rows at their column defaults.
   */
  await db.execute(sql`
    truncate table audit_log, stage_history, quote_taxes, quote_lines, quotes,
      scope_template_items, scope_templates, rate_items, cost_codes, tax_rates,
      projects, customers, organization, companies, document_sequences,
      project_types
    restart identity cascade
  `);

  await db.insert(projectTypes).values(DEFAULT_PROJECT_TYPES.map((type) => ({
    id: type.id,
    name: type.name,
    sortOrder: type.sortOrder,
    isActive: true,
  })));

  await seedDeployment({
    legalName: 'Northgate Electric Ltd.',
    displayName: 'Northgate Electric',
    timezone: 'America/Toronto',
    /**
     * 10%, as 1000n.
     *
     * Ten-thousandths of the FRACTION, per `db/columns.ts`: 13% is 1300n. An
     * earlier version of this file used 100000n and asserted 100000n -- self
     * consistent, and a thousand percent. The figure a contract job should
     * carry and a service job must not.
     */
    defaultHoldbackPctTenThou: 1000n,
    holdbackTermsText: 'A 10% statutory holdback is retained on each payment.',
    quoteValidityDays: 30,
  });

  await db.insert(taxRates).values({
    companyId: FIRST_COMPANY_ID,
    label: 'HST',
    rateTenThou: 1300n,
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
    expect(row!.holdbackPctTenThou).toBe(1000n);
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
    expect(row!.holdbackPctTenThou).toBe(1000n);
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

/**
 * What the two new-work PICKERS show, which is the half the design promised
 * and nothing delivered for a while.
 *
 * `offeredTypes` above answers for one company's posture and was correct from
 * the first commit -- and was called by nothing, so `/quotes/new` and
 * `/projects/new` went on listing every type in the table. A service-only
 * electrician who loaded the electrical pack was still offered `Rewire`.
 *
 * The rows stay in the table on purpose: switching back to `Both` re-offers
 * them, which a pack that had never inserted them could not do.
 */
describe('what the new-work pickers offer', () => {
  /** What the pages do: read the rows, then filter them by what is offered. */
  async function offeredNames(): Promise<string[]> {
    const offered = await offeredWork();
    const rows = await db
      .select({ name: projectTypes.name, posture: projectTypes.posture })
      .from(projectTypes)
      .where(eq(projectTypes.isActive, true));
    return rows.filter((row) => postureIsOffered(row.posture, offered)).map((row) => row.name);
  }

  it('hides contract types from a service-only company', async () => {
    await db.update(companies).set({ workPosture: 'service' })
      .where(eq(companies.id, FIRST_COMPANY_ID));

    const names = await offeredNames();
    expect(names).toContain('Service call');
    expect(names).not.toContain('Rewire');
    // The nine migration-0018 types are tagged `both`, so a service company
    // keeps them. This is why the pack retires the ones it does not want --
    // posture alone would leave a solo electrician with 'Custom home'.
    expect(names).toContain('Basement');
  });

  it('hides service types from a contract-only company', async () => {
    await db.update(companies).set({ workPosture: 'contract' })
      .where(eq(companies.id, FIRST_COMPANY_ID));

    const names = await offeredNames();
    expect(names).toContain('Rewire');
    expect(names).not.toContain('Service call');
  });

  it('offers both halves under both, which is today behaviour', async () => {
    // The seeded company is `both` by column default, so this asserts the
    // change is backward compatible by construction.
    const names = await offeredNames();
    expect(names).toContain('Service call');
    expect(names).toContain('Rewire');
  });

  it('leaves a contract type in the table for a service-only company', async () => {
    await db.update(companies).set({ workPosture: 'service' })
      .where(eq(companies.id, FIRST_COMPANY_ID));

    // Not offered, not retired, not gone. Switching back re-offers it, which
    // is the design's own rule about the switch (section 3.2) -- and the
    // in-flight rewire goes on computing its holdback either way.
    const [row] = await db.select().from(projectTypes).where(eq(projectTypes.id, CONTRACT_TYPE));
    expect(row!.isActive).toBe(true);
    expect((await flagsForProject(db, contractProjectId)).holdback).toBe(true);

    await db.update(companies).set({ workPosture: 'both' })
      .where(eq(companies.id, FIRST_COMPANY_ID));
    expect(await offeredNames()).toContain('Rewire');
  });

  it('offers everything when no active company can be read', async () => {
    // Fails OPEN. Posture shortens forms and protects nothing, so a blip must
    // show a builder too many fields rather than hide the ones he needs.
    await db.update(companies).set({ isActive: false })
      .where(eq(companies.id, FIRST_COMPANY_ID));
    const names = await offeredNames();
    expect(names).toContain('Service call');
    expect(names).toContain('Rewire');
  });
});

/**
 * `scope_inputs`, which was a column with a migration, a default, a settings
 * checkbox and no reader at all until the worksheet and the start-quote form
 * began asking for it.
 */
describe('whether a job is measured', () => {
  it('reports the flag through the quote, not just the project', async () => {
    const { quoteId } = await createBlankQuote({ projectId: serviceProjectId });
    const flags = await flagsForQuote(db, quoteId);
    // No floor area, washrooms, kitchens or bedrooms on a service call.
    expect(flags.scopeInputs).toBe(false);
    expect(flags.holdback).toBe(false);
  });

  it('asks for measurements on contract work', async () => {
    const { quoteId } = await createBlankQuote({ projectId: contractProjectId });
    expect((await flagsForQuote(db, quoteId)).scopeInputs).toBe(true);
  });

  it('fails open on a quote it cannot read', async () => {
    // Same direction as `flagsFor` and `flagsForProject`: an unreadable row
    // must not silently drop a measurement the template quantities were
    // built from.
    const flags = await flagsForQuote(db, '11111111-1111-1111-1111-111111111111');
    expect(flags.scopeInputs).toBe(true);
    expect(flags.holdback).toBe(true);
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
