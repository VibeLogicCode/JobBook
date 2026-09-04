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
}

export interface WireRateItem {
  id: string;
  code: string;
  description: string;
  unitLabel: string;
  sellRateTenThou: string;
}
