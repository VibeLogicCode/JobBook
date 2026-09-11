import type { TradePack } from '@/db/seed/packs/types';

/**
 * Electrical.
 *
 * ---------------------------------------------------------------------------
 * WHAT A READER SHOULD CHECK BEFORE TRUSTING THIS
 * ---------------------------------------------------------------------------
 *
 * The SHAPE is right: an electrical company runs a service side and a
 * construction side, the service side is dispatched and billed once, and the
 * construction side is signed, drawn and billed in draws. That split is why
 * `posture` exists and it came from how these businesses actually organise
 * themselves.
 *
 * The CONTENT is a first draft by somebody who is not an electrician. The
 * codes and units are conventional rather than authoritative, and the list is
 * deliberately short -- ten items a contractor edits beats forty he deletes.
 * Every row is his to rename, reorder or retire, and nothing here ever
 * updates itself.
 *
 * NO PRICES. See `types.ts` for why zero is not the safe middle either.
 */

const T = 'e1000000-0000-4a00-9000-0000000000';
const C = 'e2000000-0000-4a00-9000-0000000000';
const R = 'e3000000-0000-4a00-9000-0000000000';
const G = 'e4000000-0000-4a00-9000-0000000000';
const S = 'e5000000-0000-4a00-9000-0000000000';
const M = 'e6000000-0000-4a00-9000-0000000000';

export const ELECTRICAL_PACK: TradePack = {
  trade: 'electrical',

  projectTypes: [
    {
      // Dispatched, one visit, one invoice. A fault call is maintenance, not
      // an improvement, so nothing here withholds or schedules.
      id: `${T}01`,
      name: 'Service call',
      posture: 'service',
      sortOrder: 10,
      holdback: false,
      progressInvoicing: false,
      scheduleTemplate: false,
      constructionActDates: false,
      scopeInputs: false,
    },
    {
      id: `${T}02`,
      name: 'Repair or fault finding',
      posture: 'service',
      sortOrder: 20,
      holdback: false,
      progressInvoicing: false,
      scheduleTemplate: false,
      constructionActDates: false,
      scopeInputs: false,
    },
    {
      /**
       * `both`, and the reason this pack is one list rather than a matrix.
       *
       * A panel upgrade is a day's work billed once for a homeowner and a line
       * item on a signed contract for a builder. Same words, both sides. It
       * keeps the full paperwork so the contract case is not short-changed;
       * the service case simply leaves the extra fields empty.
       */
      id: `${T}03`,
      name: 'Panel upgrade',
      posture: 'both',
      sortOrder: 30,
    },
    { id: `${T}04`, name: 'Rewire', posture: 'contract', sortOrder: 40 },
    { id: `${T}05`, name: 'New installation', posture: 'contract', sortOrder: 50 },
    { id: `${T}06`, name: 'Generator or backup supply', posture: 'contract', sortOrder: 60 },
  ],

  /**
   * Plain-language divisions with our own numbering. NOT MasterFormat: the
   * owner declined to license it, and `26` would be its Electrical division.
   * These are `E-10` upward, which cannot be mistaken for it.
   */
  costCodes: [
    { id: `${C}01`, code: 'E-10', name: 'Labour', sortOrder: 10 },
    { id: `${C}02`, code: 'E-20', name: 'Wire and cable', sortOrder: 20 },
    { id: `${C}03`, code: 'E-30', name: 'Devices and fittings', sortOrder: 30 },
    { id: `${C}04`, code: 'E-40', name: 'Panels and breakers', sortOrder: 40 },
    { id: `${C}05`, code: 'E-50', name: 'Lighting', sortOrder: 50 },
    { id: `${C}06`, code: 'E-60', name: 'Permits and inspection', sortOrder: 60 },
    { id: `${C}07`, code: 'E-90', name: 'Subcontracted work', sortOrder: 90 },
  ],

  rateItems: [
    {
      id: `${R}01`, code: 'LAB-EL', description: 'Electrician, hourly',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}01`, sortOrder: 10,
    },
    {
      id: `${R}02`, code: 'LAB-APP', description: 'Apprentice, hourly',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}01`, sortOrder: 20,
    },
    {
      // Flat, because the first hour of a call out is how this trade charges
      // whether the fault takes ten minutes or fifty.
      id: `${R}03`, code: 'CALL-1', description: 'Service call, first hour',
      unitLabel: 'call', calcMode: 'flat', costCodeId: `${C}01`, sortOrder: 30,
    },
    {
      id: `${R}04`, code: 'RCPT', description: 'Receptacle, supply and install',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}03`, sortOrder: 40,
    },
    {
      id: `${R}05`, code: 'SW-1', description: 'Switch, supply and install',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}03`, sortOrder: 50,
    },
    {
      id: `${R}06`, code: 'LT-POT', description: 'Recessed light, supply and install',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}05`, sortOrder: 60,
    },
    {
      id: `${R}07`, code: 'CIR-15', description: '15A circuit, run and terminate',
      unitLabel: 'circuit', calcMode: 'qty', costCodeId: `${C}02`, sortOrder: 70,
    },
    {
      id: `${R}08`, code: 'PNL-200', description: '200A panel, supply and install',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}04`, sortOrder: 80,
    },
    {
      id: `${R}09`, code: 'PERMIT', description: 'Electrical permit and inspection',
      unitLabel: 'job', calcMode: 'flat', costCodeId: `${C}06`, sortOrder: 90,
    },
    {
      /**
       * `percent`, which `lib/quote/unpriced.ts` exempts from the zero-price
       * refusal: the rate IS the percentage, so zero means "no uplift" and is
       * a thing somebody may legitimately state on a quote.
       */
      id: `${R}10`, code: 'OH-SUB', description: 'Overhead on subcontracted work',
      unitLabel: '%', calcMode: 'percent', costCodeId: `${C}07`, sortOrder: 100,
    },
  ],

  lineGroups: [
    { id: `${G}01`, name: 'Labour', sortOrder: 10 },
    { id: `${G}02`, name: 'Materials', sortOrder: 20 },
    { id: `${G}03`, name: 'Fixtures', sortOrder: 30 },
    { id: `${G}04`, name: 'Permits', sortOrder: 40 },
    { id: `${G}05`, name: 'Available upgrades', sortOrder: 90 },
  ],

  /**
   * Who an electrical contractor actually hires. Short on purpose: he is the
   * electrician, so the general-contracting list of twelve trades is somebody
   * else's list.
   */
  trades: [
    { id: `${S}01`, name: 'Drywall patching', sortOrder: 10 },
    { id: `${S}02`, name: 'Concrete cutting', sortOrder: 20 },
    { id: `${S}03`, name: 'Fire alarm', sortOrder: 30 },
    { id: `${S}04`, name: 'Low voltage and data', sortOrder: 40 },
    { id: `${S}05`, name: 'Crane or lift hire', sortOrder: 50 },
  ],

  /**
   * Three jobs an electrical contractor quotes most weeks.
   *
   * The service call is two lines and is the point: a call-out plus the hours,
   * and the hours are `manual` because nobody knows them until they have
   * looked at the job. The rewire shows what the measurements are FOR -- a
   * circuit per 500 square feet and three receptacles a bedroom is how that
   * quote is actually estimated, and it is arithmetic nobody should be doing
   * on a notepad in a customer's hallway.
   *
   * NO PRICES, like everything else in this file. The quote arrives as a
   * worklist of prices to fill in, and cannot be sent until they are filled.
   */
  scopeTemplates: [
    {
      id: `${M}01`,
      name: 'Service call',
      projectTypeId: `${T}01`,
      description: 'A call-out and the time on site. Add materials as you use them.',
      items: [
        { rateItemId: `${R}03`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Labour', sortOrder: 10 },
        { rateItemId: `${R}01`, qtySource: 'manual', lineGroup: 'Labour', sortOrder: 20 },
        { rateItemId: `${R}04`, qtySource: 'manual', lineGroup: 'Materials', sortOrder: 30 },
      ],
    },
    {
      id: `${M}02`,
      name: 'Panel upgrade',
      projectTypeId: `${T}03`,
      description: 'A 200A panel, the labour, the circuits moved over, and the permit.',
      items: [
        { rateItemId: `${R}08`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Materials', sortOrder: 10 },
        { rateItemId: `${R}01`, qtySource: 'manual', lineGroup: 'Labour', sortOrder: 20 },
        { rateItemId: `${R}07`, qtySource: 'manual', lineGroup: 'Materials', sortOrder: 30 },
        // The line that gets forgotten and then absorbed. On the template, so
        // that leaving it out takes an action rather than an oversight.
        { rateItemId: `${R}09`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Permits', sortOrder: 40 },
      ],
    },
    {
      id: `${M}03`,
      name: 'Rewire, by floor area',
      projectTypeId: `${T}04`,
      description: 'Circuits from the floor area, devices from the bedroom count. Check both against the plan.',
      items: [
        // One 15A circuit per 500 sqft. 1/500 is 0.002, which is 20n.
        { rateItemId: `${R}07`, qtySource: 'area', qtyMultiplierTenThou: 20n, lineGroup: 'Materials', sortOrder: 10 },
        // Three receptacles a bedroom, and one switch.
        { rateItemId: `${R}04`, qtySource: 'bedrooms', qtyMultiplierTenThou: 30_000n, lineGroup: 'Materials', sortOrder: 20 },
        { rateItemId: `${R}05`, qtySource: 'bedrooms', lineGroup: 'Materials', sortOrder: 30 },
        { rateItemId: `${R}01`, qtySource: 'manual', lineGroup: 'Labour', sortOrder: 40 },
        { rateItemId: `${R}09`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Permits', sortOrder: 50 },
        /**
         * OPTIONAL, so it starts excluded and prints as something the customer
         * may add. An optional line cannot silently inflate a quote, which is
         * what lets a shipped template offer an upgrade at all.
         */
        { rateItemId: `${R}06`, qtySource: 'manual', isOptional: true, lineGroup: 'Available upgrades', sortOrder: 60 },
      ],
    },
  ],
};
