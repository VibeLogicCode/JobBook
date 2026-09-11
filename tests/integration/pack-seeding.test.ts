import { eq, inArray, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  costCodes, customers, lineGroups, projectTypes, projects, quoteLines, rateItems,
  scopeTemplateItems, scopeTemplates, trades, vendorTypes,
} from '@/db/schema';
import { DEFAULT_PROJECT_TYPES, PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import {
  DEFAULT_TRADES, DEFAULT_VENDOR_TYPES, ensureVendorLists, seedVendorLists, seedVendorTypes,
} from '@/db/seed/vendor-lists';
import { ensureLineGroups } from '@/db/seed/line-groups';
import { addStarterPack, loadPack, retiredByPack } from '@/db/seed/packs/load';
import { loadedPack, packHasSeededLists } from '@/db/seed/packs/marker';
import { PACKS } from '@/db/seed/packs/registry';
import { packRowFlags, TRADES } from '@/db/seed/packs/types';
import { unpricedLineCodes, unpricedProblem, unsendableProblem } from '@/lib/quote/unpriced';
import { createQuoteFromTemplate } from '@/lib/quote/repository';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { seedDeployment } from '../support/organization';
import { offeredTypes } from '@/lib/posture/read';

/**
 * Trade starter packs.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS THAT MAKE THIS HARD
 * ---------------------------------------------------------------------------
 *
 * The design's §5.8 named them, and each one breaks the feature silently
 * rather than loudly:
 *
 * 1. Migration 0018 puts NINE builder project types in every database before
 *    the wizard runs. An electrician would see his five PLUS all nine.
 * 2. `ensureVendorLists` and `ensureLineGroups` seed the general-contracting
 *    lists LAZILY, on first visit to four screens. They would append twelve
 *    trades over his five the first time he opened Vendors.
 * 3. Fixed ids per row, so loading twice is a no-op and a row he has since
 *    edited is never restored to the shipped wording.
 *
 * Plus the rule that makes shipping a rate book safe at all: no prices, and
 * not zero prices either -- `lib/quote/unpriced.ts` refuses an unpriced line
 * on a quote, so an item nobody has got to yet cannot reach a customer.
 */

beforeEach(async () => {
  /**
   * `project_types` is truncated here, unlike everywhere else, and then the
   * nine are restored -- because these tests are about what a pack does to the
   * migration's own rows, so they have to start in the state the migration
   * leaves.
   */
  await db.execute(sql`
    truncate table audit_log, quote_taxes, quote_lines, quotes, scope_template_items,
      scope_templates, rate_items, cost_codes, projects, customers, organization, companies,
      document_sequences, settings, line_groups, trades, vendor_types, project_types
    restart identity cascade
  `);
  await db.insert(projectTypes).values(DEFAULT_PROJECT_TYPES.map((type) => ({
    id: type.id,
    name: type.name,
    sortOrder: type.sortOrder,
    isActive: true,
  })));
});

describe('a pack retires the builder types it did not bring', () => {
  it('retires Custom home for an electrician', async () => {
    await db.transaction((tx) => loadPack(tx, 'electrical'));

    const [customHome] = await db.select().from(projectTypes)
      .where(eq(projectTypes.id, PROJECT_TYPE_IDS.customHome));
    // Retired, not deleted and not voided: a job already filed as a Custom
    // home must go on reading that on its own record forever.
    expect(customHome!.isActive).toBe(false);
    expect(customHome!.recordStatus).toBe('active');
  });

  it('keeps Other, so an odd job still has somewhere to go', async () => {
    await db.transaction((tx) => loadPack(tx, 'electrical'));
    const [other] = await db.select().from(projectTypes)
      .where(eq(projectTypes.id, PROJECT_TYPE_IDS.other));
    // An installation with no way to file an odd job is one where somebody
    // invents a type to get past the form.
    expect(other!.isActive).toBe(true);
  });

  it('leaves the general pack with nothing to retire', async () => {
    // Its types ARE the migration's nine, by the same ids -- which is why it
    // imports them rather than copying them.
    expect(retiredByPack('general')).toEqual([]);
    await db.transaction((tx) => loadPack(tx, 'general'));
    const rows = await db.select().from(projectTypes)
      .where(inArray(projectTypes.id, DEFAULT_PROJECT_TYPES.map((type) => type.id)));
    expect(rows.every((row) => row.isActive)).toBe(true);
  });

  it('offers the electrician his own list and not the builder one', async () => {
    await db.transaction((tx) => loadPack(tx, 'electrical'));
    const names = (await offeredTypes('both')).map((row) => row.name);
    expect(names).toContain('Service call');
    expect(names).toContain('Rewire');
    expect(names).toContain('Other');
    expect(names).not.toContain('Custom home');
    expect(names).not.toContain('Basement');
  });

  it('filters his list again by his posture', async () => {
    await db.transaction((tx) => loadPack(tx, 'electrical'));
    const service = (await offeredTypes('service')).map((row) => row.name);
    expect(service).toContain('Service call');
    // `Panel upgrade` is tagged `both`: one row serving both sides, which is
    // why a pack is one list rather than a trade x posture matrix.
    expect(service).toContain('Panel upgrade');
    expect(service).not.toContain('Rewire');
  });
});

describe('the lazy seeds stand down once a pack is loaded', () => {
  it('does not append the general-contracting trades when Vendors is opened', async () => {
    await db.transaction((tx) => loadPack(tx, 'electrical'));
    const before = await db.select().from(trades);

    // What `/vendors`, `/settings/trades` and `/settings/vendor-types` each
    // call on every render.
    await ensureVendorLists();

    const after = await db.select().from(trades);
    /**
     * THE §5.8 item 2 test, and the one that matters most here: without the
     * marker an electrician's five trades quietly became seventeen the first
     * time he opened Vendors, with nothing on the page saying where the twelve
     * came from.
     */
    expect(after).toHaveLength(before.length);
    expect(after.map((row) => row.name)).not.toContain('Excavation');
  });

  it('does not append the general-contracting line groups either', async () => {
    await db.transaction((tx) => loadPack(tx, 'electrical'));
    const before = await db.select().from(lineGroups);
    await ensureLineGroups();
    const after = await db.select().from(lineGroups);
    expect(after).toHaveLength(before.length);
    expect(after.map((row) => row.name)).not.toContain('Framing');
  });

  it('still seeds the lists on a deployment that loaded no pack at all', async () => {
    /**
     * The behaviour that must NOT break. An installation predating packs -- or
     * one whose wizard has not reached the trade step -- reaching its vendor
     * form with an empty type list is an installation where no vendor can be
     * added at all, which is why these seeds are lazy in the first place.
     *
     * `seedVendorLists` and not `ensureVendorLists`, deliberately: the
     * `ensure` wrapper memoises its promise for the life of the PROCESS, so
     * once another test in this file has called it the answer is fixed and
     * this assertion would only be testing the memo. The gate itself is
     * asserted by the two tests above, which run against a loaded pack; this
     * one asserts the other half -- that with no pack the seed still writes.
     */
    expect(await packHasSeededLists()).toBe(false);
    await seedVendorLists();
    const rows = await db.select().from(trades);
    expect(rows.length).toBe(DEFAULT_TRADES.length);
  });

  it('records which pack was loaded', async () => {
    await db.transaction((tx) => loadPack(tx, 'plumbing'));
    expect(await loadedPack()).toBe('plumbing');
    expect(await packHasSeededLists()).toBe(true);
  });

  it('still supplies the vendor KINDS, which no pack ships', async () => {
    /**
     * The bug this file's own stand-down created.
     *
     * `ensureVendorLists` seeded vendor types and trades together, and stood
     * both down behind the pack marker -- so after any pack, `vendor_types`
     * was empty forever. `app/vendors/schema.ts` requires `vendorTypeId` on
     * every vendor, which made a pack install one where no vendor could be
     * added at all: exactly the failure the seed's own docblock says it is
     * there to prevent.
     *
     * The four kinds are not trade-specific. An electrician buys material,
     * hires subs, rents a lift and pays an accountant like anybody else.
     */
    await db.transaction((tx) => loadPack(tx, 'electrical'));

    // Loading the pack alone is enough: the wizard must leave a database that
    // works without waiting for somebody to open the right screen.
    const afterPack = await db.select().from(vendorTypes);
    expect(afterPack.length).toBe(DEFAULT_VENDOR_TYPES.length);
    expect(afterPack.map((row) => row.name)).toContain('Subcontractor');

    // And the lazy seed keeps supplying them even with a marker in place,
    // while still refusing to append the twelve general-contracting trades.
    await seedVendorTypes();
    expect((await db.select().from(vendorTypes)).length).toBe(DEFAULT_VENDOR_TYPES.length);
    expect((await db.select().from(trades)).map((row) => row.name)).not.toContain('Excavation');
  });

  it('counts the plain start as a choice, not as nothing', async () => {
    await db.transaction((tx) => loadPack(tx, 'none'));
    // Somebody who chose to start empty said so. Appending twelve trades to
    // his list would be overruling him.
    expect(await packHasSeededLists()).toBe(true);
    await ensureVendorLists();
    expect(await db.select().from(trades)).toHaveLength(0);
  });
});

/**
 * What the posture answer actually does to a pack's rows.
 *
 * It did nothing at all for two of the five packs, and they are the two a
 * small shop is most likely to pick. The general and `none` packs tag every
 * row `both` -- a bathroom renovation really is either kind of job depending
 * on how it was sold -- and a `both` row with no stated flags fell through to
 * the column defaults, which are a builder's full paperwork. So a one-van
 * renovator answered "Service work" and got holdback, draws, a schedule,
 * Construction Act dates and four measurement boxes on all nine types.
 */
describe('the posture decides what paperwork a pack row arrives with', () => {
  it('strips the builder paperwork from the general pack for a service-only shop', async () => {
    await db.transaction((tx) => loadPack(tx, 'general', 'service'));

    const rows = await db
      .select({
        name: projectTypes.name, holdback: projectTypes.holdback,
        progressInvoicing: projectTypes.progressInvoicing,
        scheduleTemplate: projectTypes.scheduleTemplate,
        constructionActDates: projectTypes.constructionActDates,
        scopeInputs: projectTypes.scopeInputs,
      })
      .from(projectTypes)
      .where(inArray(projectTypes.id, DEFAULT_PROJECT_TYPES.map((type) => type.id)));

    expect(rows.length).toBe(DEFAULT_PROJECT_TYPES.length);
    for (const row of rows) {
      expect(row.holdback, row.name).toBe(false);
      expect(row.progressInvoicing, row.name).toBe(false);
      expect(row.scheduleTemplate, row.name).toBe(false);
      expect(row.constructionActDates, row.name).toBe(false);
      expect(row.scopeInputs, row.name).toBe(false);
    }
  });

  it('leaves the same pack with everything on for a builder', async () => {
    // `both` and `contract` are identical here, and deliberately: they differ
    // in which types are OFFERED, never in what a contract job's forms carry.
    await db.transaction((tx) => loadPack(tx, 'general', 'contract'));
    const [row] = await db.select().from(projectTypes)
      .where(eq(projectTypes.id, PROJECT_TYPE_IDS.customHome));
    expect(row!.holdback).toBe(true);
    expect(row!.scopeInputs).toBe(true);
  });

  it('defaults to today behaviour when no posture is given', async () => {
    // The parameter is optional so a caller that does not know the posture
    // cannot accidentally strip a builder's paperwork.
    await db.transaction((tx) => loadPack(tx, 'general'));
    const [row] = await db.select().from(projectTypes)
      .where(eq(projectTypes.id, PROJECT_TYPE_IDS.customHome));
    expect(row!.holdback).toBe(true);
  });

  it('keeps a contract-tagged row a contract row even under a service company', async () => {
    /**
     * `Rewire` is tagged `contract`, so its flags come from its own tag and
     * not from the company's answer. It is not OFFERED to a service-only
     * company -- `offeredWork` keeps it out of the pickers -- but it is here,
     * with full paperwork, for the day the owner switches to Both or takes one
     * rewire a year and turns it on himself.
     */
    await db.transaction((tx) => loadPack(tx, 'electrical', 'service'));

    const rows = await db
      .select({ name: projectTypes.name, posture: projectTypes.posture,
        holdback: projectTypes.holdback })
      .from(projectTypes)
      .where(eq(projectTypes.isActive, true));

    const contract = rows.filter((row) => row.posture === 'contract');
    expect(contract.length).toBeGreaterThan(0);
    for (const row of contract) expect(row.holdback, row.name).toBe(true);

    // And its service rows stay off, which they said themselves.
    const service = rows.filter((row) => row.posture === 'service');
    expect(service.length).toBeGreaterThan(0);
    for (const row of service) expect(row.holdback, row.name).toBe(false);
  });

  it('gives a service-only shop a plain start with the none pack too', async () => {
    await db.transaction((tx) => loadPack(tx, 'none', 'service'));
    const [row] = await db.select().from(projectTypes)
      .where(eq(projectTypes.id, PROJECT_TYPE_IDS.other));
    // The catch-all every pack keeps. A service shop filing an odd job is not
    // filing a job that withholds a holdback.
    expect(row!.holdback).toBe(false);
    expect(row!.isActive).toBe(true);
  });
});

/**
 * The starter scope templates, which are what turns a rate book into something
 * that writes a quote.
 *
 * Without them "Build the lines from" offers nothing on a fresh install and
 * every quote is assembled line by line by somebody standing in a customer's
 * basement. The rate book is a list of prices; a template is the knowledge of
 * what a job CONSISTS of -- that a water heater swap is the tank, the labour
 * and the permit, and that forgetting the permit is how the job loses money.
 */
/**
 * Adding a SECOND trade's lists to a deployment that is already running.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ARE ACTUALLY ABOUT
 * ---------------------------------------------------------------------------
 *
 * One thing: what `addStarterPack` refuses to touch. The trade question was
 * asked once, by a wizard that closes itself for good, so a plumber who picked
 * "start empty" had no route to the plumbing lists ever again -- and the
 * reason it was left out is still true of half of what a pack load does.
 * Loading a pack over a rate book somebody has priced from for a year must
 * never retire his job types or rewrite their paperwork rules.
 *
 * So every assertion below is either "the rows arrived" or "the thing that was
 * already here is exactly as it was".
 */
/**
 * The machine shop pack, and the one thing about it that is a correctness
 * question rather than a content question.
 *
 * Ontario's Construction Act governs an IMPROVEMENT TO LAND. Statutory
 * holdback, substantial performance, publication and last-supply dates are all
 * facts about construction; selling a machined part is a sale of goods. So a
 * manufacturing job type must never carry them, whatever the shop answered
 * about service and contract work -- and left to the posture defaults, a shop
 * that answered "Both" would have got a 10% holdback on a quote for fifty
 * brackets.
 */
describe('the machine shop pack', () => {
  it('never carries holdback or Construction Act dates, under any posture', async () => {
    for (const posture of ['both', 'service', 'contract'] as const) {
      for (const type of PACKS.machining.projectTypes) {
        const flags = packRowFlags(type, posture);
        expect(flags.holdback, `${type.name} under ${posture}`).toBe(false);
        expect(flags.constructionActDates, `${type.name} under ${posture}`).toBe(false);
        // A part order has no floor area and no critical path either.
        expect(flags.scopeInputs, `${type.name} under ${posture}`).toBe(false);
        expect(flags.scheduleTemplate, `${type.name} under ${posture}`).toBe(false);
      }
    }
  });

  it('bills tooling and a supply agreement in stages, and nothing else', async () => {
    // The one flag that genuinely varies here: a fixture is often half up
    // front, and a supply agreement is billed against releases over a year.
    const staged = PACKS.machining.projectTypes
      .filter((type) => packRowFlags(type, 'both').progressInvoicing)
      .map((type) => type.name);
    expect(staged.sort()).toEqual(['Supply agreement', 'Tooling or fixture']);
  });

  it('charges setup once on every template', async () => {
    /**
     * The line that makes a run of five expensive per piece and a run of five
     * hundred cheap. Leaving it off is the commonest way a short run loses
     * money, so it is `fixed` at one on all four templates rather than left to
     * be remembered.
     */
    for (const template of PACKS.machining.scopeTemplates) {
      const setup = template.items.find((item) => item.rateItemId.endsWith('01'));
      expect(setup, template.name).toBeDefined();
      expect(setup!.qtySource, template.name).toBe('fixed');
      expect(setup!.fixedQtyMilli, template.name).toBe(1_000n);
    }
  });

  it('loads into the database, flags and all', async () => {
    await db.transaction((tx) => loadPack(tx, 'machining', 'contract'));

    const rows = await db
      .select()
      .from(projectTypes)
      .where(inArray(projectTypes.id, PACKS.machining.projectTypes.map((type) => type.id)));
    expect(rows).toHaveLength(PACKS.machining.projectTypes.length);
    // `contract` posture, and still no holdback anywhere: the pack states the
    // flags rather than taking the defaults.
    for (const row of rows) {
      expect(row.holdback, row.name).toBe(false);
      expect(row.constructionActDates, row.name).toBe(false);
    }

    const codes = (await db.select().from(costCodes)).map((row) => row.code);
    expect(codes).toContain('M-30');
    const items = (await db.select().from(rateItems)).map((row) => row.code);
    expect(items).toContain('EDM-WIRE');
    expect(items).toContain('SETUP');
  });

  it('retires the builder types on a first run, like every other pack', async () => {
    await db.transaction((tx) => loadPack(tx, 'machining', 'service'));

    const builder = await db
      .select({ name: projectTypes.name, isActive: projectTypes.isActive })
      .from(projectTypes)
      .where(inArray(projectTypes.id, retiredByPack('machining')));
    expect(builder.length).toBeGreaterThan(0);
    for (const row of builder) expect(row.isActive, row.name).toBe(false);

    // `Other` survives every pack: an installation with no way to file an odd
    // job is one where somebody invents a type to get past the form.
    const [other] = await db
      .select().from(projectTypes).where(eq(projectTypes.id, PROJECT_TYPE_IDS.other));
    expect(other!.isActive).toBe(true);
  });
});

describe('adding a trade after setup', () => {
  it('brings the lists without retiring anything', async () => {
    /**
     * The nine migration-0018 types stay ACTIVE, unlike at first run.
     *
     * By now jobs may be filed under them, and retiring one stops new work
     * being booked to a type the owner is using. At setup the same call does
     * retire them, because there nothing is filed under anything yet.
     */
    await addStarterPack(db, 'electrical', 'both');

    const builder = await db
      .select({ id: projectTypes.id, isActive: projectTypes.isActive })
      .from(projectTypes)
      .where(inArray(projectTypes.id, DEFAULT_PROJECT_TYPES.map((type) => type.id)));
    expect(builder).toHaveLength(DEFAULT_PROJECT_TYPES.length);
    for (const row of builder) expect(row.isActive, row.id).toBe(true);

    // And the pack's own rows did arrive.
    const codes = (await db.select().from(costCodes)).map((row) => row.code);
    expect(codes).toContain('E-10');
    const items = (await db.select().from(rateItems)).map((row) => row.code);
    expect(items).toContain('LAB-EL');
    const names = (await db.select().from(projectTypes)).map((row) => row.name);
    expect(names).toContain('Panel upgrade');
  });

  it('leaves the paperwork rules of an existing job type alone', async () => {
    /**
     * The destructive half, and the reason this is a separate function.
     *
     * The general and `none` packs name the nine shared ids, so the flag
     * UPDATE at first run writes onto rows that already exist -- correct
     * there, because they are migration seed rows. Here they are the owner's,
     * possibly tuned by hand on the job-types screen, and a pack added later
     * must not reach them. A renovator who turned holdback off on `Bathroom`
     * would otherwise find it back on because he added a trade.
     */
    await db
      .update(projectTypes)
      .set({ holdback: false, progressInvoicing: false })
      .where(eq(projectTypes.id, PROJECT_TYPE_IDS.bathroom));

    await addStarterPack(db, 'general', 'both');

    const [row] = await db
      .select()
      .from(projectTypes)
      .where(eq(projectTypes.id, PROJECT_TYPE_IDS.bathroom));
    expect(row!.holdback).toBe(false);
    expect(row!.progressInvoicing).toBe(false);
  });

  it('still sets the posture flags on a type it creates', async () => {
    // A row this call inserts is new, so it takes its defaults from what kind
    // of work the company does -- exactly as at first run.
    await addStarterPack(db, 'electrical', 'service');

    const [row] = await db
      .select()
      .from(projectTypes)
      .where(eq(projectTypes.name, 'Panel upgrade'));
    // `Panel upgrade` is tagged `both`, so under a service-only company it
    // arrives with a service company's paperwork: none of it.
    expect(row!.holdback).toBe(false);
    expect(row!.scopeInputs).toBe(false);
  });

  it('does not take over a rate item the owner already had under that code', async () => {
    await db.insert(rateItems).values({
      code: 'LAB-EL',
      description: 'My own electrician rate',
      unitLabel: 'hour',
      calcMode: 'qty',
      sellRateTenThou: 1_250_000n,
      costRateTenThou: 800_000n,
      isActive: true,
    });

    await addStarterPack(db, 'electrical', 'both');

    const rows = await db.select().from(rateItems).where(eq(rateItems.code, 'LAB-EL'));
    // One row, still the owner's, still priced. A pack must never take a row
    // over -- and never overwrite a price.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe('My own electrician rate');
    expect(rows[0]!.sellRateTenThou).toBe(1_250_000n);
  });

  it('adds nothing back that the owner has since retired', async () => {
    await addStarterPack(db, 'plumbing', 'both');
    const [code] = await db.select().from(costCodes).where(eq(costCodes.code, 'P-10'));
    await db.update(costCodes).set({ isActive: false }).where(eq(costCodes.id, code!.id));

    await addStarterPack(db, 'plumbing', 'both');

    const [again] = await db.select().from(costCodes).where(eq(costCodes.id, code!.id));
    expect(again!.isActive).toBe(false);
  });

  it('is safe to press twice', async () => {
    await addStarterPack(db, 'hvac', 'both');
    const first = {
      types: (await db.select().from(projectTypes)).length,
      codes: (await db.select().from(costCodes)).length,
      items: (await db.select().from(rateItems)).length,
      templates: (await db.select().from(scopeTemplateItems)).length,
    };

    await addStarterPack(db, 'hvac', 'both');

    expect((await db.select().from(projectTypes)).length).toBe(first.types);
    expect((await db.select().from(costCodes)).length).toBe(first.codes);
    expect((await db.select().from(rateItems)).length).toBe(first.items);
    expect((await db.select().from(scopeTemplateItems)).length).toBe(first.templates);
  });

  it('records the pack, so the lazy seeds stand down for it too', async () => {
    await addStarterPack(db, 'hvac', 'both');
    expect(await loadedPack()).toBe('hvac');
  });

  it('adds a second trade alongside the first', async () => {
    // The real case: an electrician who has taken on HVAC work. Both lists,
    // both sets of cost codes, nothing lost from either.
    await db.transaction((tx) => loadPack(tx, 'electrical', 'both'));
    await addStarterPack(db, 'hvac', 'both');

    const codes = (await db.select().from(costCodes)).map((row) => row.code);
    expect(codes).toContain('E-10');
    expect(codes).toContain('H-10');

    const names = (await db.select().from(projectTypes))
      .filter((row) => row.isActive)
      .map((row) => row.name);
    expect(names).toContain('Panel upgrade');
    expect(names).toContain('Furnace replacement');
  });
});

describe('the starter scope templates', () => {
  it('ships three for each of the four trades and none for the plain start', async () => {
    for (const trade of TRADES) {
      const pack = PACKS[trade];
      if (trade === 'none') {
        // A template names rate items and this pack ships none. An empty
        // template offered from a picker is worse than an empty picker.
        expect(pack.scopeTemplates, trade).toHaveLength(0);
        continue;
      }
      expect(pack.scopeTemplates.length, trade).toBeGreaterThanOrEqual(3);
    }
  });

  it('names only its own project types and its own rate items', async () => {
    /**
     * The failure this catches is a first-run CRASH:
     * `scope_template_items.rate_item_id` is NOT NULL with a foreign key, so a
     * template naming an item no pack inserts would raise a constraint
     * violation inside the wizard's transaction, on somebody's first five
     * minutes, with the step left incomplete.
     */
    for (const trade of TRADES) {
      const pack = PACKS[trade];
      const itemIds = new Set(pack.rateItems.map((item) => item.id));
      const typeIds = new Set(pack.projectTypes.map((type) => type.id));

      for (const template of pack.scopeTemplates) {
        expect(typeIds.has(template.projectTypeId), `${trade}: ${template.name}`).toBe(true);
        expect(template.items.length, `${trade}: ${template.name}`).toBeGreaterThan(0);
        for (const item of template.items) {
          expect(itemIds.has(item.rateItemId), `${trade}: ${template.name}`).toBe(true);
        }
      }
    }
  });

  it('carries a line group its own pack ships', async () => {
    // `scope_template_items.line_group` is free text, and a group nobody has
    // heard of appears as a heading on a printed quote.
    for (const trade of TRADES) {
      const pack = PACKS[trade];
      const names = new Set(pack.lineGroups.map((group) => group.name));
      for (const template of pack.scopeTemplates) {
        for (const item of template.items) {
          expect(names.has(item.lineGroup), `${trade}: ${item.lineGroup}`).toBe(true);
        }
      }
    }
  });

  it('states a fixed quantity wherever it says fixed', async () => {
    // `fixed` with no `fixedQtyMilli` derives zero, and a zero-derived line is
    // DROPPED by `expandTemplate` -- so the permit line would silently not be
    // on the quote, which is the exact mistake the template exists to prevent.
    for (const trade of TRADES) {
      for (const template of PACKS[trade].scopeTemplates) {
        for (const item of template.items) {
          if (item.qtySource === 'fixed') {
            expect(item.fixedQtyMilli, `${trade}: ${template.name}`).toBeGreaterThan(0n);
          }
        }
      }
    }
  });

  it('loads them into the database with their lines', async () => {
    await db.transaction((tx) => loadPack(tx, 'plumbing', 'both'));

    const templates = await db
      .select({ id: scopeTemplates.id, name: scopeTemplates.name })
      .from(scopeTemplates);
    expect(templates.map((row) => row.name)).toContain('Water heater replacement');

    const heater = templates.find((row) => row.name === 'Water heater replacement')!;
    const items = await db
      .select({ lineGroup: scopeTemplateItems.lineGroup, qtySource: scopeTemplateItems.qtySource })
      .from(scopeTemplateItems)
      .where(eq(scopeTemplateItems.scopeTemplateId, heater.id));

    // Tank, labour, permit.
    expect(items).toHaveLength(3);
    expect(items.map((row) => row.lineGroup)).toContain('Permits');
    expect(items.map((row) => row.qtySource)).toContain('manual');
  });

  it('expands into a real quote whose lines all need a price', async () => {
    /**
     * The end-to-end shape of a first hour: pick the trade, start a quote from
     * a starter template, and get a worklist of the prices to put in.
     *
     * `unpricedLineCodes` is what the worksheet warns from and what
     * `setQuoteStatus` refuses to send on, so this asserts the template is
     * safe to ship: every line arrives unpriced and the quote cannot go out
     * until they are dealt with.
     */
    await db.transaction((tx) => loadPack(tx, 'plumbing', 'both'));
    await seedDeployment({
      legalName: 'Sample Plumbing Ltd.',
      displayName: 'Sample Plumbing',
      timezone: 'America/Toronto',
      quoteValidityDays: 30,
    });

    const [template] = await db
      .select({ id: scopeTemplates.id, projectTypeId: scopeTemplates.projectTypeId })
      .from(scopeTemplates)
      .where(eq(scopeTemplates.name, 'Water heater replacement'));

    const [customer] = await db
      .insert(customers)
      .values({ name: 'Sample Client', customerType: 'residential' })
      .returning({ id: customers.id });
    const [project] = await db
      .insert(projects)
      .values({
        name: 'Tank replacement',
        projectNumber: 'P-2026-8001',
        customerId: customer!.id,
        companyId: FIRST_COMPANY_ID,
        projectTypeId: template!.projectTypeId,
      })
      .returning({ id: projects.id });

    const { quoteId } = await createQuoteFromTemplate({
      projectId: project!.id,
      scopeTemplateId: template!.id,
      // No measurements: this template needs none. The counts are numbers and
      // the area is the raw string the form sends.
      scope: { areaSqftMilli: 0n, washroomCount: 0, kitchenCount: 0, bedroomCount: 0 },
    });

    const lines = await db
      .select({
        code: quoteLines.code,
        calcMode: quoteLines.calcMode,
        unitPriceTenThou: quoteLines.unitPriceTenThou,
        isAllowance: quoteLines.isAllowance,
      })
      .from(quoteLines)
      .where(eq(quoteLines.quoteId, quoteId));

    // The tank and the labour and the permit reached the quote...
    expect(lines.map((row) => row.code).sort()).toEqual(['LAB-PL', 'PERMIT', 'WH-40']);
    // ...and every one of them is waiting for a price, named so the owner can
    // go and put one in rather than hunting a column of zeros.
    expect(unpricedLineCodes(lines).sort()).toEqual(['LAB-PL', 'PERMIT', 'WH-40']);
    expect(unsendableProblem(lines)).toContain('WH-40');
  });

  it('withholds a measurement template from a company that measures nothing', async () => {
    /**
     * The renovation templates are driven by floor area. Under a service-only
     * company every general-pack type has `scope_inputs` off, so no area is
     * collected -- and `expandTemplate` drops a zero-derived line, which would
     * leave the demolition, drywall, flooring and painting quietly absent from
     * a quote that still looked complete.
     */
    await db.transaction((tx) => loadPack(tx, 'general', 'service'));
    expect(await db.select().from(scopeTemplates)).toHaveLength(0);
  });

  it('ships them to a builder, who does measure', async () => {
    await db.transaction((tx) => loadPack(tx, 'general', 'both'));
    const names = (await db.select().from(scopeTemplates)).map((row) => row.name);
    expect(names).toContain('Bathroom renovation');
    expect(names).toContain('Basement finishing');
  });

  it('does not duplicate the lines when a pack is loaded twice', async () => {
    // `scope_templates` has no unique index on its name, so the second load
    // skips on the id -- and appending this run's items again would silently
    // double every line on a template the owner may have since edited.
    await db.transaction((tx) => loadPack(tx, 'hvac', 'both'));
    const first = await db.select().from(scopeTemplateItems);
    await db.transaction((tx) => loadPack(tx, 'hvac', 'both'));
    const second = await db.select().from(scopeTemplateItems);
    expect(second).toHaveLength(first.length);
  });

  it('skips a template whose rate item the owner already had under that code', async () => {
    /**
     * The crash this read-back prevents. A pack's insert skips on a code
     * collision, so the pack's id is not in the database -- and a template
     * naming it would violate the foreign key inside the wizard's own
     * transaction.
     *
     * `MAINT` here stands for a row the owner created before reaching the
     * trade step, which is the real sequence: the seasonal maintenance
     * template is one line, so losing that line leaves nothing to write and
     * the template is skipped rather than written empty.
     */
    await db.insert(rateItems).values({
      code: 'MAINT',
      description: 'My own maintenance visit',
      unitLabel: 'visit',
      calcMode: 'flat',
      sellRateTenThou: 1_500_000n,
      costRateTenThou: 0n,
      isActive: true,
    });

    await db.transaction((tx) => loadPack(tx, 'hvac', 'both'));

    const names = (await db.select().from(scopeTemplates)).map((row) => row.name);
    expect(names).not.toContain('Seasonal maintenance visit');
    // The other two are unaffected, and nothing threw.
    expect(names).toContain('Furnace replacement');
  });
});

describe('loading twice changes nothing', () => {
  it('is idempotent on every list', async () => {
    await db.transaction((tx) => loadPack(tx, 'hvac'));
    const first = {
      types: await db.select().from(projectTypes),
      codes: await db.select().from(costCodes),
      items: await db.select().from(rateItems),
      groups: await db.select().from(lineGroups),
      subs: await db.select().from(trades),
    };

    await db.transaction((tx) => loadPack(tx, 'hvac'));

    expect(await db.select().from(projectTypes)).toHaveLength(first.types.length);
    expect(await db.select().from(costCodes)).toHaveLength(first.codes.length);
    expect(await db.select().from(rateItems)).toHaveLength(first.items.length);
    expect(await db.select().from(lineGroups)).toHaveLength(first.groups.length);
    expect(await db.select().from(trades)).toHaveLength(first.subs.length);
  });

  it('never restores a row the owner has edited', async () => {
    await db.transaction((tx) => loadPack(tx, 'hvac'));
    const [item] = await db.select().from(rateItems);

    // What an owner does first: put his own price on it and call it his own
    // name.
    await db.update(rateItems)
      .set({ description: 'My own wording', sellRateTenThou: 1250000n })
      .where(eq(rateItems.id, item!.id));

    await db.transaction((tx) => loadPack(tx, 'hvac'));

    const [after] = await db.select().from(rateItems).where(eq(rateItems.id, item!.id));
    /**
     * `onConflictDoNothing` on fixed ids, and this is what it is FOR. A
     * mechanism that refreshed seeded rows would overwrite a contractor's own
     * prices, which is the most destructive thing this product could do. A
     * pack improved later reaches only new installations. That is correct; the
     * alternative is worse.
     */
    expect(after!.description).toBe('My own wording');
    expect(after!.sellRateTenThou).toBe(1250000n);
  });
});

describe('the packs themselves', () => {
  it('ships no prices in any pack', async () => {
    for (const trade of TRADES) {
      await db.execute(sql`truncate table rate_items, cost_codes restart identity cascade`);
      await db.transaction((tx) => loadPack(tx, trade));
      const items = await db.select().from(rateItems);
      for (const item of items) {
        /**
         * Not "no invented prices" -- NO prices. A rate book of numbers this
         * software guessed looks authoritative, and quoting at one loses the
         * job or loses money with nothing tracing back to a seed file.
         */
        expect(item.sellRateTenThou).toBe(0n);
        expect(item.costRateTenThou).toBe(0n);
      }
    }
  });

  it('cannot put its own unpriced items on a quote', async () => {
    await db.transaction((tx) => loadPack(tx, 'electrical'));
    const items = await db.select().from(rateItems);

    for (const item of items) {
      const problem = unpricedProblem({
        code: item.code,
        calcMode: item.calcMode,
        sellRateTenThou: item.sellRateTenThou,
        isAllowance: item.isAllowance,
      });
      if (item.calcMode === 'percent') {
        // The rate IS the percentage, so zero means "no uplift" -- a thing
        // somebody may legitimately state on a quote.
        expect(problem).toBeNull();
      } else {
        /**
         * This is what makes shipping unpriced items SAFE rather than merely
         * honest. A zero-sell line adds nothing to the subtotal, reads 0.00%
         * margin, and does not print at all under the default pricing display
         * -- so the customer would get a document silently missing the price of
         * real work. The guard refuses it structurally.
         */
        expect(problem).not.toBeNull();
        expect(problem).toContain(item.code);
      }
    }
  });

  it('uses no MasterFormat division numbering', async () => {
    for (const trade of TRADES) {
      for (const code of PACKS[trade].costCodes) {
        /**
         * MasterFormat's shape is `03-30`, `22-00`, `26-00` -- two digits, a
         * separator, two digits. Its compilation is copyrighted and the owner
         * declined to license it, so a pack's codes must not be mistakable for
         * a division list. `E-10` and `G-20` cannot be.
         */
        expect(code.code).not.toMatch(/^\d{2}[-\s]?\d{2}$/);
      }
    }
  });

  it('keeps its cost codes shallow', () => {
    for (const trade of TRADES) {
      for (const code of PACKS[trade].costCodes) {
        // A deep hierarchy nobody asked for is the first thing a new user
        // deletes. `PackCostCode` has no parent field at all, which this
        // asserts by shape rather than by hope.
        expect(code).not.toHaveProperty('parentId');
      }
    }
  });

  it('gives every pack both a service and a contract way in', () => {
    for (const trade of ['general', 'electrical', 'plumbing', 'hvac'] as const) {
      const postures = new Set(PACKS[trade].projectTypes.map((type) => type.posture));
      const servesService = postures.has('service') || postures.has('both');
      const servesContract = postures.has('contract') || postures.has('both');
      // Otherwise the pack is useless to half the businesses in that trade,
      // which is the thing the posture tag exists to avoid.
      expect(servesService).toBe(true);
      expect(servesContract).toBe(true);
    }
  });

  it('ships no vendors and no customers', () => {
    for (const trade of TRADES) {
      const pack = PACKS[trade] as unknown as Record<string, unknown>;
      /**
       * Vendors and customers are the owner's real relationships, and
       * inventing them would put fictional companies in a real business's
       * records. The demo tenant does that deliberately; a production install
       * must never.
       */
      expect(pack).not.toHaveProperty('vendors');
      expect(pack).not.toHaveProperty('customers');
      expect(pack).not.toHaveProperty('taxRates');
    }
  });

  it('names its rate items against its own cost codes', () => {
    for (const trade of TRADES) {
      const pack = PACKS[trade];
      const codeIds = new Set(pack.costCodes.map((code) => code.id));
      for (const item of pack.rateItems) {
        // A dangling cost code id would fail the foreign key at load time --
        // inside the wizard's transaction, on somebody's first run.
        expect(codeIds.has(item.costCodeId)).toBe(true);
      }
    }
  });

  it('uses a distinct id for every row across every pack', () => {
    // Two packs sharing an id would make `onConflictDoNothing` silently skip
    // the second one's row, which reads as a pack that half-loaded.
    const seen = new Map<string, string>();
    for (const trade of TRADES) {
      const pack = PACKS[trade];
      for (const row of [...pack.costCodes, ...pack.rateItems]) {
        const previous = seen.get(row.id);
        // Project types, line groups and trades are deliberately SHARED
        // between the general and none packs, so only the authored rows are
        // checked here.
        expect(previous === undefined || previous === trade).toBe(true);
        seen.set(row.id, trade);
      }
    }
  });
});
