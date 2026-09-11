/**
 * Wire shapes for the worksheet.
 *
 * Scaled integers cross to the client as strings. A bigint cannot be
 * serialized into a React payload at all, and a Number would round a rate the
 * moment it got long enough to matter -- which is the whole reason the engine
 * holds them as integers.
 */

export interface WireLine {
  id: string;
  sortOrder: number;
  lineGroup: string;
  code: string;
  description: string;
  calcMode: 'qty' | 'flat' | 'percent';
  unitLabel: string;
  qtyMilli: string;
  unitCostTenThou: string;
  unitPriceTenThou: string;
  lineCostCents: number;
  lineTotalCents: number;
  displayPriceCents: number;
  isTaxable: boolean;
  isAllowance: boolean;
  isOptional: boolean;
  isIncluded: boolean;
}

/**
 * One saved exclusion or assumption, offered as a suggestion.
 *
 * Text and not an id on the quote: tapping one APPENDS its sentence, so the
 * quote keeps the words that were printed even if the library is reworded
 * later. See `ClauseSheet.tsx`.
 */
export interface WireClause {
  id: string;
  kind: 'exclusion' | 'assumption';
  clauseText: string;
}

export interface WireTax {
  label: string;
  registrationNumber: string | null;
  rateTenThou: string;
  taxableBaseCents: number;
  taxAmountCents: number;
}

export interface WireQuote {
  id: string;
  quoteNumber: string;
  kind: 'estimate' | 'change_order';
  version: number;
  sequence: number;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'superseded';
  recordStatus: 'active' | 'void';
  quoteDate: string;
  validUntil: string;
  expired: boolean;
  projectName: string;
  customerName: string;
  siteAddress: string | null;
  /**
    * What the price does NOT include, and what it assumes, as the owner typed
    * them.
    *
    * On the quote rather than on the company, because they are facts about
    * this job: "price assumes the existing panel has spare capacity" is true
    * of one quote and not the next. The company-wide boilerplate is
    * `quoteTermsText`, which prints separately and says something different.
    */
  exclusionsText: string | null;
  assumptionsText: string | null;
  areaSqftMilli: string | null;
  washroomCount: number | null;
  kitchenCount: number | null;
  bedroomCount: number | null;
  subtotalCents: number;
  taxTotalCents: number;
  totalCents: number;
  totalCostCents: number;
  marginBp: number;
  optionalTotalCents: number;
  targetMarginBp: number | null;
  areaUnit: string;
  /**
   * The project's commercial arrangement, not the quote's own field -- a
   * quote has no opinion on this, it only prints what the project was told.
   * Null means undecided, which the print document must never guess at.
   */
  contractType: 'lump_sum' | 'unit_price' | 'cost_plus' | 'time_and_material' | null;
  /**
   * What this contract withholds, as a raw ten-thousandths string, or null.
   *
   * Here because the print document has to decide whether to say anything
   * about holdback, and without it that decision was made from the
   * ORGANIZATION default -- so a job withholding nothing told the customer
   * that ten percent was being retained. Null means the contract withholds
   * nothing, which is the meaning `lib/invoice/repository.ts` fixes.
   *
   * Not a cost, so it crosses to the browser without the concern the
   * estimator design raises about `unitCostTenThou` and `marginBp`: this
   * figure is printed on the customer's own document.
   */
  holdbackPctTenThou: string | null;
}

export interface WireRateItem {
  id: string;
  code: string;
  description: string;
  unitLabel: string;
  sellRateTenThou: string;
}

/** Why a change order was raised. Mirrors the `change_reason` enum. */
export type WireChangeReason =
  | 'customer_request'
  | 'site_condition'
  | 'design_change'
  | 'code_requirement'
  | 'error_omission'
  | 'allowance_reconciliation';

/** Enough of another quote to name it and link to it. */
export interface WireQuoteRef {
  id: string;
  quoteNumber: string;
  sequence: number;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'superseded';
  reason: WireChangeReason | null;
  scheduleImpactDays: number | null;
  totalCents: number;
}

/**
 * What this quote is attached to.
 *
 * Kept out of `WireQuote` because it is not part of the document: a change
 * order's parent and an estimate's change orders are navigation, loaded beside
 * the quote rather than folded into the record the engine computed.
 */
export interface WireRelations {
  /** The estimate a change order amends. Null on an estimate. */
  parent: WireQuoteRef | null;
  /** Change orders raised against this estimate, in project sequence. */
  changeOrders: WireQuoteRef[];
  /**
   * This quote's own amendment facts. Null on an estimate, which amends
   * nothing. Loaded here rather than on `WireQuote` because they describe the
   * quote's relationship to another one, not the document the engine computed.
   */
  amendment: { reason: WireChangeReason | null; scheduleImpactDays: number | null } | null;
  /** The scope template this quote was built from, if any. */
  templateName: string | null;
}
