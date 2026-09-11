import type { TradePack } from '@/db/seed/packs/types';

/**
 * Plumbing.
 *
 * Same shape as the electrical pack and the same caveat: the SPLIT is right --
 * a plumbing company runs a service side and a construction side -- and the
 * CONTENT is a first draft by somebody who is not a plumber. Conventional
 * rather than authoritative, short on purpose, and every row is the owner's to
 * rename or retire.
 *
 * `P-10` upward and not MasterFormat's `22`, for the licensing reason in
 * `types.ts`.
 *
 * NO PRICES.
 */

const T = 'f1000000-0000-4a00-9000-0000000000';
const C = 'f2000000-0000-4a00-9000-0000000000';
const R = 'f3000000-0000-4a00-9000-0000000000';
const G = 'f4000000-0000-4a00-9000-0000000000';
const S = 'f5000000-0000-4a00-9000-0000000000';
const M = 'f6000000-0000-4a00-9000-0000000000';

const SERVICE_FLAGS = {
  holdback: false,
  progressInvoicing: false,
  scheduleTemplate: false,
  constructionActDates: false,
  scopeInputs: false,
} as const;

export const PLUMBING_PACK: TradePack = {
  trade: 'plumbing',

  projectTypes: [
    { id: `${T}01`, name: 'Service call', posture: 'service', sortOrder: 10, ...SERVICE_FLAGS },
    {
      // The example the Construction Act reasoning turns on: a leaking tap is
      // maintenance, not an improvement, so it withholds nothing.
      id: `${T}02`, name: 'Leak or blockage', posture: 'service', sortOrder: 20, ...SERVICE_FLAGS,
    },
    {
      id: `${T}03`, name: 'Fixture replacement', posture: 'service', sortOrder: 30,
      ...SERVICE_FLAGS,
    },
    {
      // A tank swap for a homeowner, or a line on a builder's contract.
      id: `${T}04`, name: 'Water heater', posture: 'both', sortOrder: 40,
    },
    { id: `${T}05`, name: 'Bathroom rough-in', posture: 'contract', sortOrder: 50 },
    { id: `${T}06`, name: 'Re-pipe', posture: 'contract', sortOrder: 60 },
    { id: `${T}07`, name: 'New installation', posture: 'contract', sortOrder: 70 },
  ],

  costCodes: [
    { id: `${C}01`, code: 'P-10', name: 'Labour', sortOrder: 10 },
    { id: `${C}02`, code: 'P-20', name: 'Pipe and fittings', sortOrder: 20 },
    { id: `${C}03`, code: 'P-30', name: 'Fixtures', sortOrder: 30 },
    { id: `${C}04`, code: 'P-40', name: 'Water heaters', sortOrder: 40 },
    { id: `${C}05`, code: 'P-50', name: 'Drains and venting', sortOrder: 50 },
    { id: `${C}06`, code: 'P-60', name: 'Permits and inspection', sortOrder: 60 },
    { id: `${C}07`, code: 'P-90', name: 'Subcontracted work', sortOrder: 90 },
  ],

  rateItems: [
    {
      id: `${R}01`, code: 'LAB-PL', description: 'Plumber, hourly',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}01`, sortOrder: 10,
    },
    {
      id: `${R}02`, code: 'LAB-APP', description: 'Apprentice, hourly',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}01`, sortOrder: 20,
    },
    {
      id: `${R}03`, code: 'CALL-1', description: 'Service call, first hour',
      unitLabel: 'call', calcMode: 'flat', costCodeId: `${C}01`, sortOrder: 30,
    },
    {
      id: `${R}04`, code: 'DRAIN', description: 'Drain clearing, machine',
      unitLabel: 'job', calcMode: 'flat', costCodeId: `${C}05`, sortOrder: 40,
    },
    {
      id: `${R}05`, code: 'TOIL', description: 'Toilet, supply and install',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}03`, sortOrder: 50,
    },
    {
      id: `${R}06`, code: 'FAUC', description: 'Faucet, supply and install',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}03`, sortOrder: 60,
    },
    {
      id: `${R}07`, code: 'WH-40', description: 'Water heater, supply and install',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}04`, sortOrder: 70,
    },
    {
      id: `${R}08`, code: 'PIPE-CU', description: 'Copper supply line, run',
      unitLabel: 'ft', calcMode: 'qty', costCodeId: `${C}02`, sortOrder: 80,
    },
    {
      id: `${R}09`, code: 'ROUGH-B', description: 'Bathroom rough-in, three piece',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}02`, sortOrder: 90,
    },
    {
      id: `${R}10`, code: 'PERMIT', description: 'Plumbing permit and inspection',
      unitLabel: 'job', calcMode: 'flat', costCodeId: `${C}06`, sortOrder: 100,
    },
    {
      id: `${R}11`, code: 'OH-SUB', description: 'Overhead on subcontracted work',
      unitLabel: '%', calcMode: 'percent', costCodeId: `${C}07`, sortOrder: 110,
    },
  ],

  lineGroups: [
    { id: `${G}01`, name: 'Labour', sortOrder: 10 },
    { id: `${G}02`, name: 'Materials', sortOrder: 20 },
    { id: `${G}03`, name: 'Fixtures', sortOrder: 30 },
    { id: `${G}04`, name: 'Permits', sortOrder: 40 },
    { id: `${G}05`, name: 'Available upgrades', sortOrder: 90 },
  ],

  trades: [
    { id: `${S}01`, name: 'Drywall patching', sortOrder: 10 },
    { id: `${S}02`, name: 'Concrete cutting', sortOrder: 20 },
    { id: `${S}03`, name: 'Excavation', sortOrder: 30 },
    { id: `${S}04`, name: 'Tile', sortOrder: 40 },
    { id: `${S}05`, name: 'Gas fitting', sortOrder: 50 },
  ],

  /**
   * Three jobs a plumber quotes most weeks.
   *
   * The water heater is the one worth shipping: a tank, the labour and the
   * permit. Quoting it without the permit is how a same-day job loses its
   * margin, and a template is what makes leaving it out deliberate.
   *
   * The rough-in is per WASHROOM, which is the measurement that drives it, and
   * the fixtures are optional because whether the customer supplies his own is
   * the first thing he asks.
   *
   * NO PRICES.
   */
  scopeTemplates: [
    {
      id: `${M}01`,
      name: 'Service call',
      projectTypeId: `${T}01`,
      description: 'A call-out and the time on site, with drain clearing offered if it turns out to be that.',
      items: [
        { rateItemId: `${R}03`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Labour', sortOrder: 10 },
        { rateItemId: `${R}01`, qtySource: 'manual', lineGroup: 'Labour', sortOrder: 20 },
        { rateItemId: `${R}04`, qtySource: 'fixed', fixedQtyMilli: 1_000n, isOptional: true, lineGroup: 'Available upgrades', sortOrder: 30 },
      ],
    },
    {
      id: `${M}02`,
      name: 'Water heater replacement',
      projectTypeId: `${T}04`,
      description: 'Tank, labour and permit. The permit is the line that gets forgotten.',
      items: [
        { rateItemId: `${R}07`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Fixtures', sortOrder: 10 },
        { rateItemId: `${R}01`, qtySource: 'manual', lineGroup: 'Labour', sortOrder: 20 },
        { rateItemId: `${R}10`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Permits', sortOrder: 30 },
      ],
    },
    {
      id: `${M}03`,
      name: 'Bathroom rough-in',
      projectTypeId: `${T}05`,
      description: 'One three-piece rough-in per washroom, with the fixtures offered separately.',
      items: [
        { rateItemId: `${R}09`, qtySource: 'washrooms', lineGroup: 'Materials', sortOrder: 10 },
        { rateItemId: `${R}08`, qtySource: 'manual', lineGroup: 'Materials', sortOrder: 20 },
        { rateItemId: `${R}01`, qtySource: 'manual', lineGroup: 'Labour', sortOrder: 30 },
        { rateItemId: `${R}10`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Permits', sortOrder: 40 },
        // Optional because "are you supplying the fixtures" is the first thing
        // the customer asks, and the answer is often no.
        { rateItemId: `${R}05`, qtySource: 'washrooms', isOptional: true, lineGroup: 'Available upgrades', sortOrder: 50 },
        { rateItemId: `${R}06`, qtySource: 'washrooms', isOptional: true, lineGroup: 'Available upgrades', sortOrder: 60 },
      ],
    },
  ],
};
