import { db } from '@/db/client';
import { packHasSeededLists } from '@/db/seed/packs/marker';
import { trades, vendorTypes } from '@/db/schema';

/**
 * The vendor types and trades a fresh install starts with.
 *
 * Here rather than in a migration, and here rather than in the screens,
 * because seed data is the only place in this repository a specific list may
 * live -- `tests/ops/white-label.test.ts` enforces that, and the reason is
 * that a list written into a screen ships to every other company that buys the
 * product. Everything below is a generic category of counterparty or a trade a
 * general contractor hires. None of it names a company, a person, a province
 * or a tenant's own vocabulary, and every row is an ordinary record the owner
 * can rename, reorder, retire or void.
 *
 * The ids are fixed so that loading these twice is a no-op and so that a row
 * the owner has already edited, retired or voided is never quietly restored to
 * the shipped wording on the next boot. Nothing is ever deleted here, so the
 * row he changed is the row that is still there.
 *
 * `onConflictDoNothing()` is deliberately untargeted rather than keyed on the
 * id. Migration 0014 promoted every free-text `vendors.trade` value into
 * `trades` -- values a tenant typed, not values this file shipped -- so a
 * default whose NAME is already taken by one of those has to be skipped too.
 * Keyed on the id it would instead hit `trades_name_unique` and throw.
 */

export interface DefaultVendorType {
  id: string;
  name: string;
  /**
   * Whether vendors of this type perform work rather than selling goods.
   *
   * This is the whole reason the list is not just names. `is_subcontractor` on
   * a type decides who receives a T5018 slip, who needs current WSIB clearance
   * before a cheque is written, and who may be assigned to a scheduled task.
   * It is chosen once, when a type is created, and the screen offers no way to
   * edit it afterwards -- so adding a type is free and restating a tax rule by
   * renaming one is not possible.
   *
   * "Professional services" is false on purpose. An engineer, a surveyor or an
   * inspector bills for a service rather than for construction work, and the
   * safe error is leaving somebody off a slip -- which is noticed and fixed --
   * rather than filing one for a counterparty who was never owed it. A
   * deployment that disagrees adds its own type with the flag set.
   */
  isSubcontractor: boolean;
  sortOrder: number;
}

export const DEFAULT_VENDOR_TYPES: readonly DefaultVendorType[] = [
  {
    id: '7c2b4e10-0000-4a00-9000-000000000001',
    name: 'Material supplier',
    isSubcontractor: false,
    sortOrder: 10,
  },
  {
    id: '7c2b4e10-0000-4a00-9000-000000000002',
    name: 'Subcontractor',
    isSubcontractor: true,
    sortOrder: 20,
  },
  {
    id: '7c2b4e10-0000-4a00-9000-000000000003',
    name: 'Equipment rental',
    isSubcontractor: false,
    sortOrder: 30,
  },
  {
    id: '7c2b4e10-0000-4a00-9000-000000000004',
    name: 'Professional services',
    isSubcontractor: false,
    sortOrder: 40,
  },
];

/**
 * The trades, in the order the work happens rather than alphabetically.
 *
 * A list somebody reads while deciding what a sub IS reads better in build
 * order -- site, structure, envelope, services, finishes -- than in an order
 * that puts concrete after painting. The sort numbers leave gaps so a trade
 * inserted later does not need the whole list renumbered.
 *
 * Twelve, not forty. The owner's ask was "what type of subcontractor", not a
 * work-breakdown vocabulary, and a picker long enough to need scrolling is a
 * picker somebody guesses at.
 */
export const DEFAULT_TRADES: readonly { id: string; name: string; sortOrder: number }[] = [
  { id: '9d3c5f20-0000-4a00-9000-000000000001', name: 'Excavation', sortOrder: 10 },
  { id: '9d3c5f20-0000-4a00-9000-000000000002', name: 'Concrete', sortOrder: 20 },
  { id: '9d3c5f20-0000-4a00-9000-000000000003', name: 'Masonry', sortOrder: 30 },
  { id: '9d3c5f20-0000-4a00-9000-000000000004', name: 'Framing', sortOrder: 40 },
  { id: '9d3c5f20-0000-4a00-9000-000000000005', name: 'Roofing', sortOrder: 50 },
  { id: '9d3c5f20-0000-4a00-9000-000000000006', name: 'Windows and doors', sortOrder: 60 },
  { id: '9d3c5f20-0000-4a00-9000-000000000007', name: 'Plumbing', sortOrder: 70 },
  { id: '9d3c5f20-0000-4a00-9000-000000000008', name: 'Electrical', sortOrder: 80 },
  { id: '9d3c5f20-0000-4a00-9000-000000000009', name: 'HVAC', sortOrder: 90 },
  { id: '9d3c5f20-0000-4a00-9000-00000000000a', name: 'Insulation', sortOrder: 100 },
  { id: '9d3c5f20-0000-4a00-9000-00000000000b', name: 'Drywall', sortOrder: 110 },
  { id: '9d3c5f20-0000-4a00-9000-00000000000c', name: 'Painting', sortOrder: 120 },
];

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Loads both lists, idempotently.
 *
 * Safe to call on every render of the screens that read them. A row whose id
 * -- or whose name -- is already present is left exactly as it is.
 */
export async function seedVendorLists(executor: Executor = db): Promise<void> {
  await seedVendorTypes(executor);
  await seedTrades(executor);
}

/**
 * The four vendor KINDS, which are not trade-specific and never stand down.
 *
 * Material supplier, subcontractor, equipment rental, professional services.
 * Nothing about those four is general contracting -- an electrician buys
 * material, hires subs, rents a lift and pays an accountant exactly like a
 * builder does -- and they are load-bearing: `app/vendors/schema.ts` requires
 * `vendorTypeId` on every vendor, so an empty list is an installation where no
 * vendor can be added at all.
 *
 * Which is what a pack install WAS. `ensureVendorLists` stood both lists down
 * together behind the pack marker, so after any pack -- `none` included --
 * `vendor_types` stayed empty forever and the vendor form could not be
 * completed. The seed's own docblock says it exists to prevent exactly that.
 * Splitting the two is the fix: the TRADES are trade-specific and a pack
 * supplies its own, the KINDS are universal.
 */
export async function seedVendorTypes(executor: Executor = db): Promise<void> {
  await executor
    .insert(vendorTypes)
    .values(
      DEFAULT_VENDOR_TYPES.map((type) => ({
        id: type.id,
        name: type.name,
        isSubcontractor: type.isSubcontractor,
        sortOrder: type.sortOrder,
        isActive: true,
      })),
    )
    .onConflictDoNothing();
}

/**
 * The twelve general-contracting trades, which DO stand down for a pack.
 *
 * An electrician who picked the electrical pack must not have his short list
 * of subcontractor kinds quietly joined by Excavation, Masonry and Roofing the
 * first time he opens a screen that reads them.
 */
export async function seedTrades(executor: Executor = db): Promise<void> {
  await executor
    .insert(trades)
    .values(
      DEFAULT_TRADES.map((trade) => ({
        id: trade.id,
        name: trade.name,
        sortOrder: trade.sortOrder,
        isActive: true,
      })),
    )
    .onConflictDoNothing();
}

/**
 * The same thing, run once per process.
 *
 * The lists are seeded from the screens that read them rather than from
 * `scripts/seed.ts`, for the reason the reminder rules are: the demo seed does
 * not run on a real installation, and an installation that reached its vendor
 * form with an empty type list would be an installation where no vendor can be
 * added at all. Memoised because the alternative is two writes on every render
 * of three screens to discover, every time, that there is nothing to do.
 *
 * A failure clears the memo rather than being cached, so a transient database
 * error does not leave the process permanently believing it has seeded.
 */
let pending: Promise<void> | null = null;

/**
 * Stands down once a trade pack has been loaded.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CHECK IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 *
 * This list is seeded LAZILY, from the screens that read it, and that was
 * right while the general-contracting list was the only list. With trade packs
 * it silently undoes the owner's choice: an electrician who picked the
 * electrical pack would have his short list quietly joined by the full
 * general-contracting set the first time he opened one of these screens, and
 * nothing on the page would say where those rows came from.
 *
 * So a pack marker means "the lists are already supplied". Any pack counts,
 * `none` included -- somebody who chose to start empty said so, and appending
 * to his list would be overruling him. `general` counts too and needs no
 * special case: its pack ships these same rows with these same fixed ids, so
 * the seed would be a no-op anyway.
 *
 * The memo is still set on the stand-down path, because the answer cannot
 * change back: nothing un-loads a pack.
 */
export function ensureVendorLists(): Promise<void> {
  pending ??= (async () => {
    /**
     * The KINDS always. Four universal rows, required on every vendor, and no
     * pack ships them -- so standing them down with the trades left a pack
     * install unable to add a single vendor.
     */
    await seedVendorTypes();
    // The TRADES only while no pack has supplied its own. See above.
    if (await packHasSeededLists()) return;
    await seedTrades();
  })().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}
