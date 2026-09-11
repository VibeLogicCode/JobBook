import { DEFAULT_PROJECT_TYPES, PROJECT_TYPE_IDS } from '@/db/seed/project-lists';
import { DEFAULT_LINE_GROUPS } from '@/db/seed/line-groups';
import { DEFAULT_TRADES } from '@/db/seed/vendor-lists';
import type { TradePack } from '@/db/seed/packs/types';

/**
 * General contracting and renovation.
 *
 * ---------------------------------------------------------------------------
 * THIS PACK IS NOT FREE, WHICH AN EARLIER DRAFT GOT WRONG
 * ---------------------------------------------------------------------------
 *
 * That draft called it "today's list, unchanged and therefore free". It is
 * not. No cost codes and no rate items ship to a real installation today --
 * `db/seed/schedule-templates.ts` says so in as many words. The only
 * general-contracting rate book in this repository is the DEMO TENANT's
 * (`db/seed/demo.ts`), and it carries prices and MasterFormat division numbers
 * (`01-00`, `03-30`, `22-00`, `26-00`), which violates both hard rules in
 * `types.ts`. So the codes and items below are authored here like the other
 * three packs.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES REUSE, AND WHY THAT IS SAFE
 * ---------------------------------------------------------------------------
 *
 * The project types, line groups and trades come from the EXISTING seeds, with
 * their existing fixed ids. That is deliberate and it is the reason the
 * general pack has no retirement work to do: the nine types migration 0018
 * created ARE this pack's types, so `loadPack` finds nothing to retire, and
 * the lazy `ensureVendorLists` / `ensureLineGroups` seeds would be a no-op
 * against the same ids even if the marker did not stand them down.
 *
 * Importing them rather than copying the ids is what keeps that true. A second
 * list of the same eleven line groups would drift the first time somebody
 * edited one.
 *
 * NO PRICES.
 */

const C = 'c9000000-0000-4a00-9000-0000000000';
const R = 'ca000000-0000-4a00-9000-0000000000';
const M = 'cb000000-0000-4a00-9000-0000000000';

/**
 * Plain-language divisions with our own numbering.
 *
 * `G-10` upward, deliberately unlike MasterFormat's two-digit divisions. The
 * words themselves are not protectable -- nobody owns "Concrete" -- but the
 * selection, numbering and arrangement of a published list are, which is why
 * these are eight of our own headings in build order rather than a subset of
 * somebody's sixteen.
 */
export const GENERAL_PACK: TradePack = {
  trade: 'general',

  // The nine migration-0018 types, unchanged and all tagged `both`. A general
  // contractor genuinely does both: a warranty visit is service work and a
  // custom home is contract work, and he files them under the same list.
  projectTypes: DEFAULT_PROJECT_TYPES.map((type) => ({
    id: type.id,
    name: type.name,
    posture: 'both' as const,
    sortOrder: type.sortOrder,
  })),

  costCodes: [
    { id: `${C}01`, code: 'G-10', name: 'General requirements', sortOrder: 10 },
    { id: `${C}02`, code: 'G-20', name: 'Demolition and disposal', sortOrder: 20 },
    { id: `${C}03`, code: 'G-30', name: 'Foundations and concrete', sortOrder: 30 },
    { id: `${C}04`, code: 'G-40', name: 'Framing and structure', sortOrder: 40 },
    { id: `${C}05`, code: 'G-50', name: 'Exterior and roofing', sortOrder: 50 },
    { id: `${C}06`, code: 'G-60', name: 'Mechanical, electrical and plumbing', sortOrder: 60 },
    { id: `${C}07`, code: 'G-70', name: 'Interior finishes', sortOrder: 70 },
    { id: `${C}08`, code: 'G-80', name: 'Permits and fees', sortOrder: 80 },
    { id: `${C}09`, code: 'G-90', name: 'Subcontracted work', sortOrder: 90 },
  ],

  rateItems: [
    {
      id: `${R}01`, code: 'LAB-CARP', description: 'Carpenter, hourly',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}04`, sortOrder: 10,
    },
    {
      id: `${R}02`, code: 'LAB-GEN', description: 'General labourer, hourly',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}01`, sortOrder: 20,
    },
    {
      id: `${R}03`, code: 'SUPER', description: 'Site supervision, daily',
      unitLabel: 'day', calcMode: 'qty', costCodeId: `${C}01`, sortOrder: 30,
    },
    {
      id: `${R}04`, code: 'DEMO', description: 'Demolition and haul away',
      unitLabel: 'sqft', calcMode: 'qty', costCodeId: `${C}02`, sortOrder: 40,
    },
    {
      id: `${R}05`, code: 'BIN', description: 'Disposal bin, delivered and hauled',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}02`, sortOrder: 50,
    },
    {
      id: `${R}06`, code: 'FRAME-W', description: 'Wall framing, supply and install',
      unitLabel: 'sqft', calcMode: 'qty', costCodeId: `${C}04`, sortOrder: 60,
    },
    {
      id: `${R}07`, code: 'DRY-BD', description: 'Drywall, board tape and sand',
      unitLabel: 'sqft', calcMode: 'qty', costCodeId: `${C}07`, sortOrder: 70,
    },
    {
      id: `${R}08`, code: 'PAINT', description: 'Painting, two coats',
      unitLabel: 'sqft', calcMode: 'qty', costCodeId: `${C}07`, sortOrder: 80,
    },
    {
      id: `${R}09`, code: 'FLOOR', description: 'Flooring, supply and install',
      unitLabel: 'sqft', calcMode: 'qty', costCodeId: `${C}07`, sortOrder: 90,
    },
    {
      id: `${R}10`, code: 'PERMIT', description: 'Building permit and fees',
      unitLabel: 'job', calcMode: 'flat', costCodeId: `${C}08`, sortOrder: 100,
    },
    {
      /**
       * An ALLOWANCE, which the zero-price guard exempts alongside percent
       * mode: a placeholder the customer spends against and which is
       * reconciled against actual cost later. Nothing about it requires a
       * figure at the moment it is added -- and the owner confirmed an
       * allowance stays visible on a lump-sum quote for exactly that reason.
       *
       * Shipped as an ordinary item because the allowance flag lives on the
       * QUOTE LINE, not on the rate item: the same item can be a fixed price
       * in one template and an allowance in another.
       */
      id: `${R}11`, code: 'ALLOW-FIN', description: 'Finishes allowance',
      unitLabel: 'job', calcMode: 'flat', costCodeId: `${C}07`, sortOrder: 110,
    },
    {
      id: `${R}12`, code: 'OH-SUB', description: 'Overhead on subcontracted work',
      unitLabel: '%', calcMode: 'percent', costCodeId: `${C}09`, sortOrder: 120,
    },
  ],

  // The existing eleven, by their existing ids. See the header.
  lineGroups: DEFAULT_LINE_GROUPS.map((group) => ({
    id: group.id,
    name: group.name,
    sortOrder: group.sortOrder,
  })),

  // The existing twelve, by their existing ids: this IS the trade a general
  // contractor hires from.
  trades: DEFAULT_TRADES.map((trade) => ({
    id: trade.id,
    name: trade.name,
    sortOrder: trade.sortOrder,
  })),

  /**
   * Three renovations, priced from the floor area.
   *
   * ---------------------------------------------------------------------------
   * THE MULTIPLIERS ARE THE CONTENT
   * ---------------------------------------------------------------------------
   *
   * Drywall and paint are taken at THREE TIMES the floor area, because walls
   * and a ceiling are what gets boarded and painted, not the floor. A basement
   * partition run is one and a half times. Those factors are the estimating
   * knowledge a starter template can honestly carry -- they are ratios, not
   * prices, and they are the same ratios whoever is quoting.
   *
   * Every one of them is a STARTING POINT on a row the owner can change on the
   * template or on the quote. A contractor who boards to nine feet will want
   * more; the template's job is to stop the line being forgotten, not to be
   * right about his house.
   *
   * The finishes ALLOWANCE is on each of them on purpose: it is exempt from
   * the unpriced-line guard, because an allowance with no figure yet is what
   * an allowance is, and it is how a renovation quote states "your choice of
   * tile, up to this much" without pretending to know.
   *
   * NO PRICES.
   */
  scopeTemplates: [
    {
      id: `${M}01`,
      name: 'Bathroom renovation',
      projectTypeId: PROJECT_TYPE_IDS.bathroom,
      description: 'Strip out, board, floor and paint, from the room area. Drywall and paint are taken at three times the floor.',
      items: [
        { rateItemId: `${R}04`, qtySource: 'area', lineGroup: 'Demolition', sortOrder: 10 },
        { rateItemId: `${R}05`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Demolition', sortOrder: 20 },
        { rateItemId: `${R}07`, qtySource: 'area', qtyMultiplierTenThou: 30_000n, lineGroup: 'Drywall', sortOrder: 30 },
        { rateItemId: `${R}09`, qtySource: 'area', lineGroup: 'Flooring', sortOrder: 40 },
        { rateItemId: `${R}08`, qtySource: 'area', qtyMultiplierTenThou: 30_000n, lineGroup: 'Finishing', sortOrder: 50 },
        { rateItemId: `${R}01`, qtySource: 'manual', lineGroup: 'General', sortOrder: 60 },
        { rateItemId: `${R}10`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'General', sortOrder: 70 },
        { rateItemId: `${R}11`, qtySource: 'fixed', fixedQtyMilli: 1_000n, isAllowance: true, lineGroup: 'Finishing', sortOrder: 80 },
      ],
    },
    {
      id: `${M}02`,
      name: 'Kitchen renovation',
      projectTypeId: PROJECT_TYPE_IDS.kitchen,
      description: 'Strip out, board, floor and paint, with a finishes allowance for cabinets and counters.',
      items: [
        { rateItemId: `${R}04`, qtySource: 'area', lineGroup: 'Demolition', sortOrder: 10 },
        { rateItemId: `${R}05`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Demolition', sortOrder: 20 },
        { rateItemId: `${R}07`, qtySource: 'area', qtyMultiplierTenThou: 20_000n, lineGroup: 'Drywall', sortOrder: 30 },
        { rateItemId: `${R}09`, qtySource: 'area', lineGroup: 'Flooring', sortOrder: 40 },
        { rateItemId: `${R}08`, qtySource: 'area', qtyMultiplierTenThou: 20_000n, lineGroup: 'Finishing', sortOrder: 50 },
        { rateItemId: `${R}01`, qtySource: 'manual', lineGroup: 'General', sortOrder: 60 },
        { rateItemId: `${R}10`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'General', sortOrder: 70 },
        { rateItemId: `${R}11`, qtySource: 'fixed', fixedQtyMilli: 1_000n, isAllowance: true, lineGroup: 'Finishing', sortOrder: 80 },
      ],
    },
    {
      id: `${M}03`,
      name: 'Basement finishing',
      projectTypeId: PROJECT_TYPE_IDS.basement,
      description: 'Partition walls at one and a half times the floor area, boarded and painted at three times.',
      items: [
        { rateItemId: `${R}06`, qtySource: 'area', qtyMultiplierTenThou: 15_000n, lineGroup: 'Framing', sortOrder: 10 },
        { rateItemId: `${R}07`, qtySource: 'area', qtyMultiplierTenThou: 30_000n, lineGroup: 'Drywall', sortOrder: 20 },
        { rateItemId: `${R}08`, qtySource: 'area', qtyMultiplierTenThou: 30_000n, lineGroup: 'Finishing', sortOrder: 30 },
        { rateItemId: `${R}09`, qtySource: 'area', lineGroup: 'Flooring', sortOrder: 40 },
        { rateItemId: `${R}01`, qtySource: 'manual', lineGroup: 'Framing', sortOrder: 50 },
        { rateItemId: `${R}10`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'General', sortOrder: 60 },
        { rateItemId: `${R}11`, qtySource: 'fixed', fixedQtyMilli: 1_000n, isAllowance: true, lineGroup: 'Finishing', sortOrder: 70 },
      ],
    },
  ],
};

/**
 * "Something else, or start empty."
 *
 * ---------------------------------------------------------------------------
 * IT IS NOT EMPTY, AND MUST NOT BE
 * ---------------------------------------------------------------------------
 *
 * `projects.project_type_id` is NOT NULL, so an installation with no project
 * types is one where no job can be created at all. And a line group list with
 * nothing in it means every heading is typed by hand before the first one can
 * be reused.
 *
 * So this ships the two lists that are load-bearing and nothing else: no cost
 * codes, no rate items, no subcontractor trades. It must be **no worse than
 * today's empty start, only plainer** -- which is why it keeps the nine
 * migration-0018 types rather than inventing three generic ones. A roofer who
 * picks this gets the same start he would have got before packs existed, plus
 * a set of line groups.
 */
export const NONE_PACK: TradePack = {
  trade: 'none',
  projectTypes: DEFAULT_PROJECT_TYPES.map((type) => ({
    id: type.id,
    name: type.name,
    posture: 'both' as const,
    sortOrder: type.sortOrder,
  })),
  costCodes: [],
  rateItems: [],
  lineGroups: DEFAULT_LINE_GROUPS.map((group) => ({
    id: group.id,
    name: group.name,
    sortOrder: group.sortOrder,
  })),
  trades: [],
  /**
   * None, necessarily: a template names rate items and this pack ships none.
   * A template whose lines pointed at nothing would be an empty quote offered
   * from a picker, which is worse than an empty picker.
   */
  scopeTemplates: [],
};

/** Kept so a reader can see the catch-all is deliberate rather than missed. */
export const CATCH_ALL_TYPE_ID = PROJECT_TYPE_IDS.other;
