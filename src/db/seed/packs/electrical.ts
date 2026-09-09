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
};
