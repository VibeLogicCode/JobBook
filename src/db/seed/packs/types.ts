import {
  POSTURE_DEFAULTS,
  type ProjectTypeFlags,
  type WorkPosture,
} from '@/lib/posture/types';

/**
 * A trade starter pack: what a fresh installation begins with instead of five
 * empty lists.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * An empty rate book is why estimating software gets abandoned in week one.
 * The owner asked for it in as many words: *"based on selection in company
 * setup (construction, electrical, plumbing and other generic trades) we give
 * them sample code list and other data pre populated."*
 *
 * ---------------------------------------------------------------------------
 * IT IS A COPY, NEVER A LINK
 * ---------------------------------------------------------------------------
 *
 * Loading a pack writes ordinary rows the owner can rename, reorder, retire or
 * void. **No mechanism ever updates a seeded row**, and there must not be one:
 * "refresh your rate book from the latest pack" would overwrite a
 * contractor's own prices, which is the most destructive thing this product
 * could do. A pack improved later reaches only new installations. That is
 * correct; the alternative is worse.
 *
 * ---------------------------------------------------------------------------
 * NO PRICES. AND NOT ZERO PRICES EITHER.
 * ---------------------------------------------------------------------------
 *
 * `rateItems` here carry codes, descriptions and units. Never a dollar figure.
 * A rate book of invented numbers looks authoritative, and a contractor
 * quoting at prices this software guessed loses the job or loses money with
 * nothing tracing back to a seed file.
 *
 * Zero is not the safe middle, which is the part that is easy to get wrong: a
 * zero-sell line adds nothing to the subtotal, `marginBasisPoints` returns 0
 * on zero revenue so the gauge reads like a badly-priced job rather than a
 * broken one, and under `pricingDisplay`'s `group_totals` default the line
 * does not print AT ALL. The customer receives a document silently missing the
 * price of real work.
 *
 * `lib/quote/unpriced.ts` refuses such a line structurally, which is what
 * makes shipping unpriced items safe rather than merely honest. Without that
 * guard this whole feature would be a hazard.
 *
 * ---------------------------------------------------------------------------
 * NO MASTERFORMAT, NO NAHB CHART
 * ---------------------------------------------------------------------------
 *
 * MasterFormat is the CSI/CSC construction cost-code numbering -- the
 * `03 Concrete` / `22 Plumbing` / `26 Electrical` system -- and NAHB's Chart of
 * Accounts is the residential equivalent. Both are published and sold with
 * copyright asserted on the compilation: the selection, numbering and
 * arrangement. Individual words are not protectable; nobody owns "Concrete".
 *
 * Owner's decision, 2026-09-09: *"no i dont want to buy it."* So these are
 * plain-language divisions with our own numbering, and a pack's cost codes
 * must not look like a MasterFormat division list.
 */

/** Which trades have a pack. `none` is the deliberate plain start. */
export type Trade = 'general' | 'electrical' | 'plumbing' | 'hvac' | 'none';

export const TRADES: readonly Trade[] = ['general', 'electrical', 'plumbing', 'hvac', 'none'];

export const TRADE_LABELS: Record<Trade, string> = {
  general: 'General contracting and renovation',
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  hvac: 'Heating, ventilation and air conditioning',
  none: 'Something else, or start empty',
};

export const TRADE_SUMMARIES: Record<Trade, string> = {
  general: 'Job types, cost codes and a rate-book skeleton for building and renovating.',
  electrical: 'Service calls through to full rewires.',
  plumbing: 'Repairs, fixtures, rough-in and re-piping.',
  hvac: 'Service, replacement and new installations.',
  none: 'Job types and line groups only. Everything else you build as you go.',
};

/**
 * A project type a pack ships.
 *
 * `posture` is what makes one list serve both kinds of work: an electrical
 * pack holds `Service call` (service), `Rewire` (contract) and
 * `Panel upgrade` (both). ONE list per trade with rows tagged, and not a
 * trade x posture matrix -- adding a posture later must not multiply content.
 */
export interface PackProjectType {
  id: string;
  name: string;
  posture: WorkPosture;
  sortOrder: number;
  /** Everything on unless the pack says otherwise. Service rows say otherwise. */
  holdback?: boolean;
  progressInvoicing?: boolean;
  scheduleTemplate?: boolean;
  constructionActDates?: boolean;
  scopeInputs?: boolean;
}

/**
 * A cost code.
 *
 * SHALLOW -- no `parentId` in any pack. A deep hierarchy nobody asked for is
 * the first thing a new user deletes, and `2026-09-07-generated-codes-design.md`
 * §2 is right that a chart of accounts has to agree with the accountant's. A
 * seeded code is a starting SUGGESTION the owner renames or retires, not an
 * assertion; that tension is real and is owned rather than hidden.
 */
export interface PackCostCode {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
}

/**
 * A rate item, with NO price. See the header.
 *
 * `unitLabel` and `calcMode` are the useful half: they say the work is priced
 * by the hour, by the metre or as a flat job, which is the thing a contractor
 * would otherwise type a hundred times.
 */
export interface PackRateItem {
  id: string;
  code: string;
  description: string;
  unitLabel: string;
  calcMode: 'flat' | 'qty' | 'percent';
  /** Which cost code, by the pack's own id. */
  costCodeId: string;
  sortOrder: number;
}

/**
 * The five flags a pack row arrives with, given what the company answered.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COMPANY'S ANSWER REACHES IN HERE AT ALL
 * ---------------------------------------------------------------------------
 *
 * Because without it, "Service work" meant nothing for two of the five packs.
 * The general and `none` packs tag every row `both` -- correctly, a bathroom
 * renovation is a signed contract with draws or a one-invoice job depending
 * only on how it was sold -- and a `both` row with no explicit flags fell
 * through to the column defaults, which are today's behaviour: holdback on,
 * draws on, schedule on, Construction Act dates on, measurements on.
 *
 * So a one-van renovator answered "Service work", loaded the general pack, and
 * got nine job types with a builder's full paperwork on every one of them. The
 * owner spotted it from the outside: *"type of work should be depended upon
 * trade i am choosing while setting up no?"* The list does depend on the
 * trade. The PAPERWORK depends on the posture, and that half was not wired.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------
 *
 * 1. A flag the pack states wins. An HVAC `Seasonal maintenance` row says
 *    what it is regardless of who loads it.
 * 2. Otherwise the defaults for the row's EFFECTIVE posture: its own tag, or
 *    the company's answer when the tag is `both`.
 *
 * That is the design's own sentence -- *"Posture sets their default for a new
 * type"* -- applied to the rows a pack creates, which are new types.
 *
 * These are DEFAULTS, not rules, and nothing re-derives them later: the
 * settings screen that changes posture deliberately leaves every existing
 * type's flags alone, because a type is where the terms of a signed contract
 * are recorded.
 */
export function packRowFlags(
  type: PackProjectType,
  companyPosture: WorkPosture,
): ProjectTypeFlags {
  const effective = type.posture === 'both' ? companyPosture : type.posture;
  const defaults = POSTURE_DEFAULTS[effective];
  return {
    holdback: type.holdback ?? defaults.holdback,
    progressInvoicing: type.progressInvoicing ?? defaults.progressInvoicing,
    scheduleTemplate: type.scheduleTemplate ?? defaults.scheduleTemplate,
    constructionActDates: type.constructionActDates ?? defaults.constructionActDates,
    scopeInputs: type.scopeInputs ?? defaults.scopeInputs,
  };
}

export interface PackNamedRow {
  id: string;
  name: string;
  sortOrder: number;
}

/**
 * One line of a starter scope template.
 *
 * `qtySource` is the engine's own enum and the reason templates are worth
 * shipping at all: `fixed` for a thing there is one of, `manual` for the hours
 * somebody types after looking at the job, and `area` / `washrooms` /
 * `kitchens` / `bedrooms` for the lines that follow a measurement. A rewire
 * quoted at one circuit per 500 square feet is a multiplier, not arithmetic
 * done in somebody's head at a kitchen table.
 */
export interface PackScopeTemplateItem {
  /** The pack's own rate item id. */
  rateItemId: string;
  qtySource: 'area' | 'washrooms' | 'kitchens' | 'bedrooms' | 'fixed' | 'manual';
  /** 1 is `10000n`. One circuit per 500 sqft is `20n`. Defaults to 1. */
  qtyMultiplierTenThou?: bigint;
  /** Required by `fixed`, meaningless otherwise. 1 is `1000n`. */
  fixedQtyMilli?: bigint;
  /** Starts EXCLUDED, so a template cannot silently inflate a quote. */
  isOptional?: boolean;
  /** A placeholder the customer spends against. Exempt from the price guard. */
  isAllowance?: boolean;
  /** Free text on the line, matching one of the pack's line group names. */
  lineGroup: string;
  sortOrder: number;
}

/**
 * A starter scope template: the shape of a job this trade quotes often.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE MATTER MORE THAN THE RATE BOOK
 * ---------------------------------------------------------------------------
 *
 * A rate book is a list of prices. A template is the KNOWLEDGE of what a job
 * consists of -- that a water heater swap is the tank, the labour and the
 * permit, and that forgetting the permit is how a quote loses money. Without
 * one, "Build the lines from" offers nothing and every quote is assembled
 * from scratch by somebody standing in a customer's basement.
 *
 * ---------------------------------------------------------------------------
 * THEY CARRY NO PRICES EITHER, AND THAT IS SAFE NOW
 * ---------------------------------------------------------------------------
 *
 * The items they name are the pack's own unpriced rate items, so a quote built
 * from one arrives as a worklist of prices to fill in -- which is the most
 * useful first screen this product can show. It is safe because the worksheet
 * names every unpriced line and `setQuoteStatus` refuses to send the quote
 * until they are priced. Before that guard existed, shipping these would have
 * risked a customer receiving a document with the price of real work silently
 * missing.
 *
 * QUANTITIES are not prices and are shipped: a three-piece bathroom rough-in
 * is one per washroom whoever is quoting it.
 */
export interface PackScopeTemplate {
  id: string;
  name: string;
  /** The pack's own project type id. */
  projectTypeId: string;
  description: string;
  items: readonly PackScopeTemplateItem[];
}

export interface TradePack {
  trade: Trade;
  projectTypes: readonly PackProjectType[];
  costCodes: readonly PackCostCode[];
  rateItems: readonly PackRateItem[];
  lineGroups: readonly PackNamedRow[];
  /** Subcontractor kinds this trade actually hires. */
  trades: readonly PackNamedRow[];
  /** The jobs this trade quotes often, as line lists. May be empty. */
  scopeTemplates: readonly PackScopeTemplate[];
}
