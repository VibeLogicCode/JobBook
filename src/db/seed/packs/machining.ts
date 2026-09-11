import type { ProjectTypeFlags } from '@/lib/posture/types';
import type { TradePack } from '@/db/seed/packs/types';

/**
 * Machine shop and fabrication: CNC milling and turning, wire EDM, welding.
 *
 * ---------------------------------------------------------------------------
 * WHY A FIFTH PACK, WHEN THE DESIGN SAID FOUR
 * ---------------------------------------------------------------------------
 *
 * `2026-09-09-service-and-contract-work-design.md` §9 lists "more than four
 * packs" as out of scope, and the reason given was a good one: each pack wants
 * somebody who does that trade to read it, and lists nobody has checked are
 * worse than fewer that have been.
 *
 * This one is added at the owner's request -- *"can we add another starter kit
 * for small manufacturing shop? example cnc wire or any other u can think
 * off?"* -- and it is a different case from the excluded four. Landscaping and
 * roofing are more construction trades, and the argument for waiting was that
 * the existing packs already show the shape. A machine shop is a different
 * SHAPE of quote, and the shape is the thing worth proving: setup once, run
 * per piece, material by weight, outside processing by the lot.
 *
 * ---------------------------------------------------------------------------
 * HOLDBACK AND THE CONSTRUCTION ACT DO NOT APPLY HERE, AND THAT IS EXPLICIT
 * ---------------------------------------------------------------------------
 *
 * Every project type below states its flags rather than taking the posture
 * defaults, and that is not belt-and-braces. Ontario's Construction Act
 * governs an IMPROVEMENT TO LAND: statutory holdback, substantial performance,
 * publication and last-supply dates are all facts about construction. Selling
 * a machined part is a sale of goods. It has no holdback, no substantial
 * performance date and nothing to publish.
 *
 * Left to the defaults, a shop that answered "Both" or "Contract work" at
 * setup would get job types carrying a 10% holdback and a set of statutory
 * date fields -- on a quote for fifty brackets. So `holdback` and
 * `constructionActDates` are off on every row here regardless of what the
 * company answered, which is exactly what the per-type flags exist for.
 *
 * `progressInvoicing` is the one that varies: a long-term supply agreement is
 * genuinely billed in stages against releases, and tooling is often half up
 * front. Those two say so; nothing else does.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CANNOT DO YET
 * ---------------------------------------------------------------------------
 *
 * A part quote is quantity-driven the way a renovation is area-driven, and
 * `qty_source` has no `pieces`: the sources are area, washrooms, kitchens,
 * bedrooms, fixed and manual. So the run line, the material and the inspection
 * are `manual` -- the estimator types the number, which is what he does today
 * on every quote anyway. A `pieces` source with a piece count beside the floor
 * area would let a template price the whole job from one figure, and it is the
 * obvious next thing here.
 *
 * `M-10` upward, our own numbering. Nothing standard is being copied.
 *
 * NO PRICES. A shop rate is the most closely held number in the business and a
 * guessed one is worse than none.
 */

const T = 'd1000000-0000-4a00-9000-0000000000';
const C = 'd2000000-0000-4a00-9000-0000000000';
const R = 'd3000000-0000-4a00-9000-0000000000';
const G = 'd4000000-0000-4a00-9000-0000000000';
const S = 'd5000000-0000-4a00-9000-0000000000';
const M = 'd6000000-0000-4a00-9000-0000000000';
const X = 'd7000000-0000-4a00-9000-0000000000';

/**
 * A part order: one invoice, no holdback, no statutory dates, no schedule
 * template, and no floor area.
 */
const PART: ProjectTypeFlags = {
  holdback: false,
  progressInvoicing: false,
  scheduleTemplate: false,
  constructionActDates: false,
  scopeInputs: false,
};

/** The same, but billed in stages. Still not a construction holdback. */
const STAGED: ProjectTypeFlags = { ...PART, progressInvoicing: true };

export const MACHINING_PACK: TradePack = {
  trade: 'machining',

  projectTypes: [
    {
      // The first thing a shop quotes, and the one whose setup cost is not
      // amortised over anything.
      id: `${T}01`, name: 'Prototype or first article', posture: 'service', sortOrder: 10, ...PART,
    },
    { id: `${T}02`, name: 'Production run', posture: 'service', sortOrder: 20, ...PART },
    { id: `${T}03`, name: 'Repeat order', posture: 'service', sortOrder: 30, ...PART },
    { id: `${T}04`, name: 'Wire EDM', posture: 'service', sortOrder: 40, ...PART },
    { id: `${T}05`, name: 'Welding or fabrication', posture: 'service', sortOrder: 50, ...PART },
    { id: `${T}06`, name: 'Rework or repair', posture: 'service', sortOrder: 60, ...PART },
    { id: `${T}07`, name: 'Assembly or kitting', posture: 'service', sortOrder: 70, ...PART },
    {
      // Often half up front, half on delivery. `both`, because a shop that
      // calls itself service-only still builds fixtures.
      id: `${T}08`, name: 'Tooling or fixture', posture: 'both', sortOrder: 80, ...STAGED,
    },
    {
      // Billed against releases over a year. The one row here that genuinely
      // wants progress invoicing, and still no holdback.
      id: `${T}09`, name: 'Supply agreement', posture: 'contract', sortOrder: 90, ...STAGED,
    },
  ],

  costCodes: [
    { id: `${C}01`, code: 'M-10', name: 'Setup and programming', sortOrder: 10 },
    { id: `${C}02`, code: 'M-20', name: 'Machining', sortOrder: 20 },
    { id: `${C}03`, code: 'M-30', name: 'Wire EDM', sortOrder: 30 },
    { id: `${C}04`, code: 'M-40', name: 'Welding and fabrication', sortOrder: 40 },
    { id: `${C}05`, code: 'M-50', name: 'Material', sortOrder: 50 },
    { id: `${C}06`, code: 'M-60', name: 'Finishing and outside processing', sortOrder: 60 },
    { id: `${C}07`, code: 'M-70', name: 'Inspection', sortOrder: 70 },
    { id: `${C}08`, code: 'M-80', name: 'Packing and freight', sortOrder: 80 },
    { id: `${C}09`, code: 'M-90', name: 'Outside services', sortOrder: 90 },
  ],

  rateItems: [
    {
      /**
       * The line that makes a small run expensive and a large one cheap, and
       * the one a shop must never leave off. Flat, per job: it is charged once
       * however many pieces follow.
       */
      id: `${R}01`, code: 'SETUP', description: 'Machine setup and first-off, per job',
      unitLabel: 'job', calcMode: 'flat', costCodeId: `${C}01`, sortOrder: 10,
    },
    {
      id: `${R}02`, code: 'PROG', description: 'CAM programming, hourly',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}01`, sortOrder: 20,
    },
    {
      id: `${R}03`, code: 'MILL', description: 'CNC milling, machine hour',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}02`, sortOrder: 30,
    },
    {
      id: `${R}04`, code: 'TURN', description: 'CNC turning, machine hour',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}02`, sortOrder: 40,
    },
    {
      id: `${R}05`, code: 'MILL-PC', description: 'Machining, per piece',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}02`, sortOrder: 50,
    },
    {
      id: `${R}06`, code: 'MAN-MACH', description: 'Manual machining, hourly',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}02`, sortOrder: 60,
    },
    {
      id: `${R}07`, code: 'EDM-WIRE', description: 'Wire EDM, machine hour',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}03`, sortOrder: 70,
    },
    {
      id: `${R}08`, code: 'WELD', description: 'Welding and fabrication, hourly',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}04`, sortOrder: 80,
    },
    {
      id: `${R}09`, code: 'MATL-BAR', description: 'Bar stock, per pound',
      unitLabel: 'lb', calcMode: 'qty', costCodeId: `${C}05`, sortOrder: 90,
    },
    {
      id: `${R}10`, code: 'MATL-PLT', description: 'Plate or sheet, per pound',
      unitLabel: 'lb', calcMode: 'qty', costCodeId: `${C}05`, sortOrder: 100,
    },
    {
      id: `${R}11`, code: 'MATL-CUT', description: 'Sawing and material prep, per piece',
      unitLabel: 'each', calcMode: 'qty', costCodeId: `${C}05`, sortOrder: 110,
    },
    {
      id: `${R}12`, code: 'DEBURR', description: 'Deburr and finishing, hourly',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}06`, sortOrder: 120,
    },
    {
      id: `${R}13`, code: 'HEAT-TR', description: 'Heat treat, outside service, per lot',
      unitLabel: 'lot', calcMode: 'flat', costCodeId: `${C}06`, sortOrder: 130,
    },
    {
      id: `${R}14`, code: 'PLATE-AN', description: 'Anodize, plating or coating, per lot',
      unitLabel: 'lot', calcMode: 'flat', costCodeId: `${C}06`, sortOrder: 140,
    },
    {
      id: `${R}15`, code: 'INSP-FA', description: 'First article inspection report',
      unitLabel: 'each', calcMode: 'flat', costCodeId: `${C}07`, sortOrder: 150,
    },
    {
      id: `${R}16`, code: 'INSP-CMM', description: 'CMM inspection, hourly',
      unitLabel: 'hour', calcMode: 'qty', costCodeId: `${C}07`, sortOrder: 160,
    },
    {
      id: `${R}17`, code: 'CERT', description: 'Material and process certifications',
      unitLabel: 'job', calcMode: 'flat', costCodeId: `${C}07`, sortOrder: 170,
    },
    {
      id: `${R}18`, code: 'PACK', description: 'Packaging and crating',
      unitLabel: 'job', calcMode: 'flat', costCodeId: `${C}08`, sortOrder: 180,
    },
    {
      id: `${R}19`, code: 'FREIGHT', description: 'Freight out',
      unitLabel: 'job', calcMode: 'flat', costCodeId: `${C}08`, sortOrder: 190,
    },
    {
      /**
       * `percent` mode, which the unpriced guard exempts: the rate IS the
       * percentage, so zero is a legitimate thing to state. A rush job that
       * displaces scheduled work costs the shop something real, and a line
       * for it is how that gets charged rather than absorbed.
       */
      id: `${R}20`, code: 'EXPEDITE', description: 'Expedite premium',
      unitLabel: '%', calcMode: 'percent', costCodeId: `${C}09`, sortOrder: 200,
    },
    {
      id: `${R}21`, code: 'OH-OUT', description: 'Handling on outside processing',
      unitLabel: '%', calcMode: 'percent', costCodeId: `${C}09`, sortOrder: 210,
    },
  ],

  lineGroups: [
    { id: `${G}01`, name: 'Setup and programming', sortOrder: 10 },
    { id: `${G}02`, name: 'Machining', sortOrder: 20 },
    { id: `${G}03`, name: 'Material', sortOrder: 30 },
    { id: `${G}04`, name: 'Finishing', sortOrder: 40 },
    { id: `${G}05`, name: 'Inspection', sortOrder: 50 },
    { id: `${G}06`, name: 'Packing and freight', sortOrder: 60 },
    { id: `${G}07`, name: 'Available upgrades', sortOrder: 90 },
  ],

  /** The outside processors a shop actually buys from. */
  trades: [
    { id: `${S}01`, name: 'Heat treating', sortOrder: 10 },
    { id: `${S}02`, name: 'Anodizing and plating', sortOrder: 20 },
    { id: `${S}03`, name: 'Grinding', sortOrder: 30 },
    { id: `${S}04`, name: 'Laser and waterjet cutting', sortOrder: 40 },
    { id: `${S}05`, name: 'Coating and painting', sortOrder: 50 },
    { id: `${S}06`, name: 'Calibration and metrology', sortOrder: 60 },
  ],

  /**
   * Four quotes a shop writes constantly.
   *
   * Setup is `fixed` at one on every single one of them, because it is charged
   * once per job and leaving it off is the commonest way a short run loses
   * money. Everything that scales with the order is `manual`: the estimator
   * types the hours, the pounds and the piece count, which are three different
   * numbers on the same quote and not one figure a template could derive.
   */
  scopeTemplates: [
    {
      id: `${M}01`,
      name: 'Machined part, production run',
      projectTypeId: `${T}02`,
      description: 'Setup once, then hours, material and inspection for the quantity ordered.',
      items: [
        { rateItemId: `${R}01`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Setup and programming', sortOrder: 10 },
        { rateItemId: `${R}02`, qtySource: 'manual', lineGroup: 'Setup and programming', sortOrder: 20 },
        { rateItemId: `${R}09`, qtySource: 'manual', lineGroup: 'Material', sortOrder: 30 },
        { rateItemId: `${R}11`, qtySource: 'manual', lineGroup: 'Material', sortOrder: 40 },
        { rateItemId: `${R}03`, qtySource: 'manual', lineGroup: 'Machining', sortOrder: 50 },
        { rateItemId: `${R}12`, qtySource: 'manual', lineGroup: 'Finishing', sortOrder: 60 },
        { rateItemId: `${R}16`, qtySource: 'manual', lineGroup: 'Inspection', sortOrder: 70 },
        { rateItemId: `${R}18`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Packing and freight', sortOrder: 80 },
        { rateItemId: `${R}19`, qtySource: 'fixed', fixedQtyMilli: 1_000n, isOptional: true, lineGroup: 'Available upgrades', sortOrder: 90 },
        // Offered rather than included: a rush is the customer's choice, and an
        // optional line starts excluded so it cannot silently inflate a price.
        { rateItemId: `${R}20`, qtySource: 'fixed', fixedQtyMilli: 1_000n, isOptional: true, lineGroup: 'Available upgrades', sortOrder: 100 },
      ],
    },
    {
      id: `${M}02`,
      name: 'Prototype or first article',
      projectTypeId: `${T}01`,
      description: 'One-off: programming, material, machining and a first article report.',
      items: [
        { rateItemId: `${R}01`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Setup and programming', sortOrder: 10 },
        { rateItemId: `${R}02`, qtySource: 'manual', lineGroup: 'Setup and programming', sortOrder: 20 },
        { rateItemId: `${R}11`, qtySource: 'manual', lineGroup: 'Material', sortOrder: 30 },
        { rateItemId: `${R}03`, qtySource: 'manual', lineGroup: 'Machining', sortOrder: 40 },
        { rateItemId: `${R}12`, qtySource: 'manual', lineGroup: 'Finishing', sortOrder: 50 },
        // The report is the deliverable on a first article, so it is included
        // rather than offered.
        { rateItemId: `${R}15`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Inspection', sortOrder: 60 },
        { rateItemId: `${R}18`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Packing and freight', sortOrder: 70 },
      ],
    },
    {
      id: `${M}03`,
      name: 'Wire EDM job',
      projectTypeId: `${T}04`,
      description: 'Setup, wire hours and material prep. Certifications offered.',
      items: [
        { rateItemId: `${R}01`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Setup and programming', sortOrder: 10 },
        { rateItemId: `${R}11`, qtySource: 'manual', lineGroup: 'Material', sortOrder: 20 },
        { rateItemId: `${R}07`, qtySource: 'manual', lineGroup: 'Machining', sortOrder: 30 },
        { rateItemId: `${R}12`, qtySource: 'manual', lineGroup: 'Finishing', sortOrder: 40 },
        { rateItemId: `${R}18`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Packing and freight', sortOrder: 50 },
        { rateItemId: `${R}17`, qtySource: 'fixed', fixedQtyMilli: 1_000n, isOptional: true, lineGroup: 'Available upgrades', sortOrder: 60 },
      ],
    },
    {
      id: `${M}04`,
      name: 'Welded assembly',
      projectTypeId: `${T}05`,
      description: 'Plate, cutting, welding and finishing, with coating offered.',
      items: [
        { rateItemId: `${R}01`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Setup and programming', sortOrder: 10 },
        { rateItemId: `${R}10`, qtySource: 'manual', lineGroup: 'Material', sortOrder: 20 },
        { rateItemId: `${R}11`, qtySource: 'manual', lineGroup: 'Material', sortOrder: 30 },
        { rateItemId: `${R}08`, qtySource: 'manual', lineGroup: 'Machining', sortOrder: 40 },
        { rateItemId: `${R}12`, qtySource: 'manual', lineGroup: 'Finishing', sortOrder: 50 },
        { rateItemId: `${R}14`, qtySource: 'fixed', fixedQtyMilli: 1_000n, isOptional: true, lineGroup: 'Available upgrades', sortOrder: 60 },
        { rateItemId: `${R}18`, qtySource: 'fixed', fixedQtyMilli: 1_000n, lineGroup: 'Packing and freight', sortOrder: 70 },
      ],
    },
  ],

  /**
   * What a shop quote assumes, and it is a different list from a trade's.
   *
   * The two that matter most are the drawing revision and the quantity. A
   * price quoted against revision B is not a price for revision C, and a
   * per-piece price for fifty is not the per-piece price for five, because the
   * setup is charged once either way. Both are ordinary misunderstandings that
   * cost a shop real money, and both are settled by a sentence on the quote.
   */
  clauses: [
    { id: `${X}01`, kind: 'exclusion', clauseText: 'Tooling, fixtures and gauges unless listed above', sortOrder: 10 },
    { id: `${X}02`, kind: 'exclusion', clauseText: 'Outside processing not listed above', sortOrder: 20 },
    { id: `${X}03`, kind: 'exclusion', clauseText: 'Material certifications and inspection reports unless listed above', sortOrder: 30 },
    { id: `${X}04`, kind: 'exclusion', clauseText: 'Freight, duties and brokerage unless listed above', sortOrder: 40 },
    { id: `${X}05`, kind: 'exclusion', clauseText: 'Mill surcharges applied to material after the order date', sortOrder: 50 },
    { id: `${X}06`, kind: 'exclusion', clauseText: 'Rework of features or material supplied by the customer', sortOrder: 60 },
    { id: `${X}07`, kind: 'assumption', clauseText: 'The price is for the drawing revision named on this quote', sortOrder: 70 },
    { id: `${X}08`, kind: 'assumption', clauseText: 'The price is based on the quantity quoted; a smaller run changes the setup per piece', sortOrder: 80 },
    { id: `${X}09`, kind: 'assumption', clauseText: 'Tolerances are as drawn, and nothing tighter is assumed', sortOrder: 90 },
    { id: `${X}10`, kind: 'assumption', clauseText: 'Material is available at the price quoted on the order date', sortOrder: 100 },
    { id: `${X}11`, kind: 'assumption', clauseText: 'Customer-supplied material is to size and free of defects', sortOrder: 110 },
  ],
};
