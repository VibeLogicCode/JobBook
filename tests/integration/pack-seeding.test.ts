import { eq, inArray, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { costCodes, lineGroups, projectTypes, rateItems, trades, vendorTypes } from '@/db/schema';
import { DEFAULT_PROJECT_TYPES, PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import {
  DEFAULT_TRADES, DEFAULT_VENDOR_TYPES, ensureVendorLists, seedVendorLists, seedVendorTypes,
} from '@/db/seed/vendor-lists';
import { ensureLineGroups } from '@/db/seed/line-groups';
import { loadPack, retiredByPack } from '@/db/seed/packs/load';
import { loadedPack, packHasSeededLists } from '@/db/seed/packs/marker';
import { PACKS } from '@/db/seed/packs/registry';
import { TRADES } from '@/db/seed/packs/types';
import { unpricedProblem } from '@/lib/quote/unpriced';
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
      scope_templates, rate_items, cost_codes, projects, settings, line_groups, trades,
      vendor_types, project_types
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
