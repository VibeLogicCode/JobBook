import type { WorkPosture } from '@/lib/posture/types';

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

export interface PackNamedRow {
  id: string;
  name: string;
  sortOrder: number;
}

export interface TradePack {
  trade: Trade;
  projectTypes: readonly PackProjectType[];
  costCodes: readonly PackCostCode[];
  rateItems: readonly PackRateItem[];
  lineGroups: readonly PackNamedRow[];
  /** Subcontractor kinds this trade actually hires. */
  trades: readonly PackNamedRow[];
}
