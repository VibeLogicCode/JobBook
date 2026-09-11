import type { TradePack } from '@/db/seed/packs/types';

/**
 * Heating, ventilation and air conditioning.
 *
 * Same shape and same caveat as the electrical and plumbing packs: the split
 * is right, the content is a first draft by somebody who is not an HVAC
 * contractor. This trade leans harder on the service side than the other two
 * -- maintenance visits and seasonal calls are most of the year -- which is
 * why three of its seven types are service and two more are `both`.
 *
 * `H-10` upward, not MasterFormat's `23`, for the licensing reason in
 * `types.ts`.
 *
 * NO PRICES.
 */

const T = 'a1000000-0000-4a00-9000-0000000000';
const C = 'a2000000-0000-4a00-9000-0000000000';
const R = 'a3000000-0000-4a00-9000-0000000000';
const G = 'a4000000-0000-4a00-9000-0000000000';
const S = 'a5000000-0000-4a00-9000-0000000000';
const M = 'a6000000-0000-4a00-9000-0000000000';

const SERVICE_FLAGS = {
  holdback: false,
  progressInvoicing: false,
  scheduleTemplate: false,
  constructionActDates: false,
  scopeInputs: false,
} as const;

export const HVAC_PACK: TradePack = {
  trade: 'hvac',

  projectTypes: [
    { id: `${T}01`, name: 'Service call', posture: 'service', sortOrder: 10, ...SERVICE_FLAGS },
    {
      id: `${T}02`,
      name: 'Seasonal maintenance',
      posture: 'service',
      sortOrder: 20,
      ...SERVICE_FLAGS,
    },
    { id: `${T}03`, name: 'Repair', posture: 'service', sortOrder: 30, ...SERVICE_FLAGS },
    {
      // A same-day swap for a homeowner, a contract line for a builder. Same
      // words, both sides -- which is what `both` is for.
      id: `${T}04`,
      name: 'Furnace replacement',
      posture: 'both',
      sortOrder: 40,
    },
    { id: `${T}05`, name: 'Air conditioner replacement', posture: 'both', sortOrder: 50 },
    { id: `${T}06`, name: 'Ductwork', posture: 'contract', sortOrder: 60 },
    { id: `${T}07`, name: 'New installation', posture: 'contract', sortOrder: 70 },
  ],

  costCodes: [
    { id: `${C}01`, code: 'H-10', name: 'Labour', sortOrder: 10 },
    { id: `${C}02`, code: 'H-20', name: 'Heating equipment', sortOrder: 20 },
    { id: `${C}03`, code: 'H-30', name: 'Cooling equipment', sortOrder: 30 },
    { id: `${C}04`, code: 'H-40', name: 'Ducting and grilles', sortOrder: 40 },
    { id: `${C}05`, code: 'H-50', name: 'Controls and thermostats', sortOrder: 50 },
    { id: `${C}06`, code: 'H-60', name: 'Permits and inspection', sortOrder: 60 },
    { id: `${C}07`, code: 'H-90', name: 'Subcontracted work', sortOrder: 90 },
  ],

  rateItems: [
    {
      id: `${R}01`, code: 'LAB-HV', description: 'HVAC technician, hourly',
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
      id: `${R}04`, code: 'MAINT', description: 'Seasonal maintenance visit',
      unitLabel: 'visit', calcMode: 'flat', costCodeId: `${C}01`, sortOrder: 40,
    },
    {
      id: `${R}05`, code: 'FURN', description: 'Furnace, supply and install',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}02`, sortOrder: 50,
    },
    {
      id: `${R}06`, code: 'AC-SPL', description: 'Air conditioner, supply and install',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}03`, sortOrder: 60,
    },
    {
      id: `${R}07`, code: 'DUCT-R', description: 'Ducting, rectangular, run',
      unitLabel: 'ft', calcMode: 'qty', costCodeId: `${C}04`, sortOrder: 70,
    },
    {
      id: `${R}08`, code: 'REG', description: 'Register or grille, supply and install',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}04`, sortOrder: 80,
    },
    {
      id: `${R}09`, code: 'TSTAT', description: 'Thermostat, supply and install',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}05`, sortOrder: 90,
    },
    {
      id: `${R}10`, code: 'PERMIT', description: 'Mechanical permit and inspection',
      unitLabel: 'job', calcMode: 'flat', costCodeId: `${C}06`, sortOrder: 100,
    },
    {
      // `percent` mode, which the zero-price guard exempts: the rate IS the
      // percentage, so zero means "no uplift" and is a legitimate thing to
      // state on a quote.
      id: `${R}11`, code: 'OH-SUB', description: 'Overhead on subcontracted work',
      unitLabel: '%', calcMode: 'percent', costCodeId: `${C}07`, sortOrder: 110,
    },
  ],

  lineGroups: [
    { id: `${G}01`, name: 'Labour', sortOrder: 10 },
    { id: `${G}02`, name: 'Equipment', sortOrder: 20 },
    { id: `${G}03`, name: 'Ductwork', sortOrder: 30 },
    { id: `${G}04`, name: 'Controls', sortOrder: 40 },
    { id: `${G}05`, name: 'Permits', sortOrder: 50 },
    { id: `${G}06`, name: 'Available upgrades', sortOrder: 90 },
  ],

  trades: [
    { id: `${S}01`, name: 'Electrical', sortOrder: 10 },
    { id: `${S}02`, name: 'Gas fitting', sortOrder: 20 },
    { id: `${S}03`, name: 'Sheet metal', sortOrder: 30 },
    { id: `${S}04`, name: 'Drywall patching', sortOrder: 40 },
    { id: `${S}05`, name: 'Crane or lift hire', sortOrder: 50 },
  ],

  /**
   * Three jobs an HVAC contractor quotes most weeks, and the maintenance visit
   * is deliberately one line.
   *
   * A seasonal maintenance call is a single flat charge. A template of one line
   * looks like it is not worth shipping until you count how many times a year
   * it is quoted -- it is the most repeated document in this trade, and it
   * carries the same holdback-free, draw-free paperwork as the service call.
   *
   * NO PRICES.
   */
  scopeTemplates: [
    {
      id: `${M}01`,
      name: 'Service call',
      projectTypeId: `${T}01`,
      description: 'A call-out and the time on site.',
      items: [
        { rateItemId: `${R}03`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Labour', sortOrder: 10 },
        { rateItemId: `${R}01`, qtySource: 'manual', lineGroup: 'Labour', sortOrder: 20 },
      ],
    },
    {
      id: `${M}02`,
      name: 'Seasonal maintenance visit',
      projectTypeId: `${T}02`,
      description: 'One visit, one charge. The document you write most often.',
      items: [
        { rateItemId: `${R}04`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Labour', sortOrder: 10 },
      ],
    },
    {
      id: `${M}03`,
      name: 'Furnace replacement',
      projectTypeId: `${T}04`,
      description: 'Furnace, labour and permit, with a thermostat and ducting offered as upgrades.',
      items: [
        { rateItemId: `${R}05`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Equipment', sortOrder: 10 },
        { rateItemId: `${R}01`, qtySource: 'manual', lineGroup: 'Labour', sortOrder: 20 },
        { rateItemId: `${R}10`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Permits', sortOrder: 30 },
        { rateItemId: `${R}09`, qtySource: 'fixed', fixedQtyMilli: 1_000n, isOptional: true, lineGroup: 'Available upgrades', sortOrder: 40 },
        { rateItemId: `${R}07`, qtySource: 'manual', isOptional: true, lineGroup: 'Available upgrades', sortOrder: 50 },
      ],
    },
  ],
};
