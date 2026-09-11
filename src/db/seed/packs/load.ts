import { inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { costCodes, lineGroups, projectTypes, rateItems, settings, trades } from '@/db/schema';
import { PACK_LOADED_KEY } from '@/db/seed/packs/marker';
import { DEFAULT_PROJECT_TYPES } from '@/db/seed/project-lists';
import { seedVendorTypes } from '@/db/seed/vendor-lists';
import { packRowFlags, type Trade, type TradePack } from '@/db/seed/packs/types';
import { FLAG_KEYS, type WorkPosture } from '@/lib/posture/types';
import { PACKS } from '@/db/seed/packs/registry';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Loads a trade pack into the owner's own lists.
 *
 * ---------------------------------------------------------------------------
 * IT RETIRES WHAT IT DOES NOT WANT, AND THAT IS THE HARD PART
 * ---------------------------------------------------------------------------
 *
 * Migration 0018 put NINE builder project types in every database before the
 * wizard ever runs -- Custom home, Basement, Renovation, Kitchen, Bathroom,
 * Addition, Commercial TI, Water leak, Other. So an electrician who loads the
 * electrical pack would see his own five types PLUS all nine of those, which
 * is worse than the empty list the pack was meant to fix.
 *
 * A pack therefore RETIRES the migration-0018 types it does not name.
 * Retiring, never deleting and never voiding: `isActive = false` stops a type
 * being offered on new work while every project, scope template and schedule
 * template already filed under it goes on reading it. That is the rule every
 * maintained list in this product follows.
 *
 * `Other` is deliberately KEPT by every pack. It is a real catch-all a job can
 * genuinely be filed under, and an installation with no way to file an odd job
 * is an installation where somebody invents a type to get past the form.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENT ON FIXED IDS
 * ---------------------------------------------------------------------------
 *
 * Every pack row has a fixed id and every insert is `onConflictDoNothing`, so
 * loading twice is a no-op and -- more importantly -- a row the owner has
 * since edited, retired or voided is never quietly restored to the shipped
 * wording. Not for wizard re-runs, which `readSetupGate` refuses on a live
 * tenant, but for re-submitting a step within one setup and for a later
 * "load a pack" entry point in Settings.
 *
 * ---------------------------------------------------------------------------
 * ONE TRANSACTION
 * ---------------------------------------------------------------------------
 *
 * A half-loaded pack is worse than none: the retirement without the insert
 * leaves an installation with no project types at all, and the insert without
 * the marker leaves the lazy seeds free to append the general-contracting
 * lists on the next screen. Called inside the wizard's own transaction.
 */
/**
 * ---------------------------------------------------------------------------
 * `onConflictDoNothing()` WITH NO TARGET, ON EVERY INSERT BELOW
 * ---------------------------------------------------------------------------
 *
 * Not the id alone. Every one of these tables carries a SECOND unique index --
 * `line_groups` and `trades` on `lower(name)`, `project_types` on
 * `lower(name)`, `cost_codes` and `rate_items` on `code` -- and a bare
 * `onConflictDoNothing()` catches any of them.
 *
 * The id-targeted version was a first-run CRASH waiting to happen, and
 * `tests/integration/pack-seeding.test.ts` found it: `Available upgrades`
 * appears both in `seed/line-groups.ts` and in every pack, under different
 * ids. So an installer who happened to open `/settings/line-groups` before
 * reaching the trade step would have triggered the lazy seed, and the pack's
 * insert would then have failed on the NAME index -- inside the wizard's own
 * transaction, on somebody's first run, with the step left incomplete.
 *
 * Skipping is the right answer rather than merging: a name or code already
 * present means the owner already has that row, and a pack must never take a
 * row over. The trade-off is that the pack's own id is not the one in the
 * database for that row, which nothing depends on -- the rate items reference
 * cost codes by the PACK's id, and if a code was skipped the item referencing
 * it is skipped too, by the same rule, on the same code collision.
 */
/**
 * ---------------------------------------------------------------------------
 * THE POSTURE IS A PARAMETER, AND EVERY ROW STILL GETS INSERTED
 * ---------------------------------------------------------------------------
 *
 * It decides the FLAGS on the rows this pack creates -- see `packRowFlags` --
 * and nothing else. In particular it does NOT filter which rows are written:
 *
 *   - A contract-tagged type under a service-only company stays in the table,
 *     unoffered. Switching to Both later re-offers it, which a pack that never
 *     inserted it could not do. `offeredWork` in `lib/posture/read.ts` is what
 *     keeps it out of the pickers.
 *   - Filtering here would also make the answer to "what did I get" depend on
 *     an answer the owner is told he can change afterwards.
 *
 * Defaults to `both`, which is today's behaviour, so a caller that does not
 * know the posture cannot accidentally strip a builder's paperwork.
 */
export async function loadPack(
  executor: Executor,
  trade: Trade,
  posture: WorkPosture = 'both',
): Promise<void> {
  const pack: TradePack = PACKS[trade];

  if (pack.projectTypes.length > 0) {
    await executor
      .insert(projectTypes)
      .values(pack.projectTypes.map((type) => ({
        id: type.id,
        name: type.name,
        posture: type.posture,
        sortOrder: type.sortOrder,
        ...packRowFlags(type, posture),
        isActive: true,
      })))
      .onConflictDoNothing();

    /**
     * And then the flags again, as an UPDATE. This is not belt-and-braces.
     *
     * The insert above skips on conflict -- it has to, for the reasons in the
     * block comment -- and for the general and `none` packs EVERY row already
     * exists: those packs reuse the nine ids migration 0018 created, which
     * carry the column defaults. So the insert wrote nothing, and a
     * service-only shop got a builder's paperwork on all nine types. That was
     * the whole bug, and it survived the first version of the fix.
     *
     * Scoped to the ids THIS PACK NAMES, so a type the owner created is never
     * touched, and grouped by identical flag sets so nine rows are two
     * statements rather than nine.
     *
     * Safe because `loadPack` runs from the setup wizard, which
     * `readSetupGate` allows only while no company exists that it did not
     * itself create -- there is no owner-tuned flag here to overwrite. A later
     * "load a pack" entry point in Settings would NOT be safe without
     * answering that question first.
     */
    const groups = new Map<string, { posture: WorkPosture; flags: ReturnType<typeof packRowFlags>; ids: string[] }>();
    for (const type of pack.projectTypes) {
      const flags = packRowFlags(type, posture);
      const key = `${type.posture}:${FLAG_KEYS.map((flag) => (flags[flag] ? '1' : '0')).join('')}`;
      const group = groups.get(key);
      if (group) group.ids.push(type.id);
      else groups.set(key, { posture: type.posture, flags, ids: [type.id] });
    }

    for (const group of groups.values()) {
      await executor
        .update(projectTypes)
        .set({ posture: group.posture, ...group.flags })
        .where(inArray(projectTypes.id, group.ids));
    }
  }

  /**
   * Retire the builder types this pack did not bring, except `Other`.
   *
   * Scoped to the migration-0018 ids on purpose: a type the OWNER created is
   * never touched by loading a pack, even one whose name a pack also uses.
   * Retiring somebody's own list because they picked a trade would be the
   * worst kind of surprise.
   */
  const keep = new Set<string>(pack.projectTypes.map((type) => type.id));
  const seededIds = DEFAULT_PROJECT_TYPES.map((type) => type.id);
  const other = DEFAULT_PROJECT_TYPES.find((type) => type.name === 'Other');
  if (other) keep.add(other.id);

  const toRetire = seededIds.filter((id) => !keep.has(id));
  if (toRetire.length > 0) {
    await executor
      .update(projectTypes)
      .set({ isActive: false })
      .where(inArray(projectTypes.id, toRetire));
  }

  /**
   * The four vendor KINDS, which no pack ships and every vendor needs.
   *
   * Here rather than only in the lazy seed so the wizard leaves a COMPLETE
   * database: `app/vendors/schema.ts` requires `vendorTypeId`, and a pack
   * install used to reach the vendor form with an empty list because the
   * marker stood the whole lazy seed down. Trade-specific rows are the pack's;
   * these four are not trade-specific at all.
   */
  await seedVendorTypes(executor);

  if (pack.costCodes.length > 0) {
    await executor
      .insert(costCodes)
      .values(pack.costCodes.map((code) => ({
        id: code.id,
        code: code.code,
        name: code.name,
        sortOrder: code.sortOrder,
        isActive: true,
      })))
      .onConflictDoNothing();
  }

  if (pack.rateItems.length > 0) {
    await executor
      .insert(rateItems)
      .values(pack.rateItems.map((item) => ({
        id: item.id,
        code: item.code,
        description: item.description,
        unitLabel: item.unitLabel,
        calcMode: item.calcMode,
        costCodeId: item.costCodeId,
        /**
         * ZERO, and the only place in this product where that is acceptable.
         *
         * The columns are NOT NULL, so "not priced yet" and "priced at
         * nothing" are the same row -- which is exactly why
         * `lib/quote/unpriced.ts` refuses a zero-sell line on a quote. The
         * pack ships the code, the description and the unit; the owner prices
         * it before it can reach a customer, and the guard is what enforces
         * that rather than hint text nobody reads.
         */
        sellRateTenThou: 0n,
        costRateTenThou: 0n,
        sortOrder: item.sortOrder,
        isActive: true,
      })))
      .onConflictDoNothing();
  }

  if (pack.lineGroups.length > 0) {
    await executor
      .insert(lineGroups)
      .values(pack.lineGroups.map((group) => ({
        id: group.id,
        name: group.name,
        sortOrder: group.sortOrder,
        isActive: true,
      })))
      .onConflictDoNothing();
  }

  if (pack.trades.length > 0) {
    await executor
      .insert(trades)
      .values(pack.trades.map((row) => ({
        id: row.id,
        name: row.name,
        sortOrder: row.sortOrder,
        isActive: true,
      })))
      .onConflictDoNothing();
  }

  /**
   * The marker, LAST.
   *
   * If anything above failed, the transaction rolls back and this was never
   * written -- so the lazy seeds go on behaving as they always did rather than
   * standing down for a pack that is not there.
   */
  await executor
    .insert(settings)
    .values({ key: PACK_LOADED_KEY, value: trade })
    .onConflictDoUpdate({ target: settings.key, set: { value: trade, updatedAt: sql`now()` } });
}


/** Every project type a pack does not name, for the tests to assert against. */
export function retiredByPack(trade: Trade): string[] {
  const pack = PACKS[trade];
  const keep = new Set<string>(pack.projectTypes.map((type) => type.id));
  const other = DEFAULT_PROJECT_TYPES.find((type) => type.name === 'Other');
  if (other) keep.add(other.id);
  return DEFAULT_PROJECT_TYPES.map((type) => type.id).filter((id) => !keep.has(id));
}
