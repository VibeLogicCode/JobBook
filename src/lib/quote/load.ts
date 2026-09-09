import { cache } from 'react';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  customers, organization, projects, quoteLines, quoteTaxes, quotes, rateItems,
} from '@/db/schema';
import type {
  WireLine, WireQuote, WireRateItem, WireTax,
} from '@/components/worksheet/types';
import { type Company, companyOf } from '@/lib/company/load';
import { computeQuote } from '@/lib/quote/totals';
import type { LineInput } from '@/lib/quote/types';

/**
 * Loads one quote for the worksheet.
 *
 * The stored figures are authoritative -- they are what the document says --
 * but two display values are not stored: the grossed-up price of an excluded
 * upgrade, and the sum of those upgrades. Both are recomputed here, read-only,
 * so an optional line prints the figure the customer would actually be charged.
 *
 * `cache()`, because both `/quotes/[id]` and `/print/quote/[id]` call this
 * once for `generateMetadata` (the tab title) and once for the page itself --
 * without it, opening a quote would run this whole read twice.
 */
export const loadQuote = cache(async (quoteId: string): Promise<{
  quote: WireQuote;
  lines: WireLine[];
  taxes: WireTax[];
  rateItems: WireRateItem[];
  /** The issuing company, whose letterhead and terms print on the document. */
  company: Company;
} | null> => {
  const [row] = await db
    .select({
      quote: quotes,
      projectName: projects.name,
      contractType: projects.contractType,
      siteAddressLine1: projects.siteAddressLine1,
      siteCity: projects.siteCity,
      customerName: customers.name,
    })
    .from(quotes)
    .innerJoin(projects, eq(quotes.projectId, projects.id))
    .innerJoin(customers, eq(projects.customerId, customers.id))
    .where(eq(quotes.id, quoteId));

  if (!row) return null;

  /**
   * BOTH rows, because this loader wants one field from each.
   *
   * `targetMarginBp` is a fact about a legal person -- two corporations under
   * one owner price to different margins -- and `areaUnit` is a fact about the
   * deployment, since two companies sharing one office measure in the same
   * units. This is the only reader in the codebase that legitimately needs the
   * pair, and naming both here is cheaper than pretending one of them belongs
   * to the other.
   */
  const [org] = await db.select().from(organization).where(eq(organization.id, 1));
  const company = await companyOf(db, row.quote.projectId);

  const lineRows = await db
    .select()
    .from(quoteLines)
    .where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.recordStatus, 'active')))
    .orderBy(asc(quoteLines.sortOrder));

  const taxRows = await db
    .select()
    .from(quoteTaxes)
    .where(and(eq(quoteTaxes.quoteId, quoteId), eq(quoteTaxes.recordStatus, 'active')))
    .orderBy(asc(quoteTaxes.sortOrder));

  const itemRows = await db
    .select()
    .from(rateItems)
    .where(and(eq(rateItems.isActive, true), eq(rateItems.recordStatus, 'active')))
    .orderBy(asc(rateItems.sortOrder));

  const inputs: LineInput[] = lineRows.map((line) => ({
    code: line.code,
    description: line.description,
    lineGroup: line.lineGroup,
    sortOrder: line.sortOrder,
    calcMode: line.calcMode,
    unitLabel: line.unitLabel,
    qtyMilli: line.qtyMilli,
    unitCostTenThou: line.unitCostTenThou,
    unitPriceTenThou: line.unitPriceTenThou,
    isTaxable: line.isTaxable,
    isOptional: line.isOptional,
    isIncluded: line.isIncluded,
    isAllowance: line.isAllowance,
    rateItemId: line.rateItemId,
    costCodeId: line.costCodeId,
  }));

  const display = computeQuote(inputs, [], {
    onDate: row.quote.quoteDate,
    customerExempt: true,
  });

  const site = [row.siteAddressLine1, row.siteCity].filter(Boolean).join(', ') || null;
  const today = new Date().toISOString().slice(0, 10);

  return {
    quote: {
      id: row.quote.id,
      quoteNumber: row.quote.quoteNumber,
      kind: row.quote.kind,
      version: row.quote.version,
      sequence: row.quote.sequence,
      status: row.quote.status,
      recordStatus: row.quote.recordStatus,
      quoteDate: row.quote.quoteDate,
      validUntil: row.quote.validUntil,
      // Expiry is derived, never stored: a stored flag is wrong the moment the
      // clock passes it.
      expired: row.quote.validUntil < today,
      projectName: row.projectName,
      contractType: row.contractType,
    holdbackPctTenThou: row.quote.holdbackPctTenThou?.toString() ?? null,
      customerName: row.customerName,
      siteAddress: site,
      areaSqftMilli: row.quote.areaSqftMilli?.toString() ?? null,
      washroomCount: row.quote.washroomCount,
      kitchenCount: row.quote.kitchenCount,
      bedroomCount: row.quote.bedroomCount,
      subtotalCents: row.quote.subtotalCents,
      taxTotalCents: row.quote.taxTotalCents,
      totalCents: row.quote.totalCents,
      totalCostCents: row.quote.totalCostCents,
      marginBp: row.quote.marginBp,
      optionalTotalCents: display.optionalTotalCents,
      targetMarginBp: company.targetMarginBp,
      areaUnit: org?.areaUnit ?? 'sqft',
    },
    lines: lineRows.map((line, index) => ({
      id: line.id,
      sortOrder: line.sortOrder,
      lineGroup: line.lineGroup,
      code: line.code,
      description: line.description,
      calcMode: line.calcMode,
      unitLabel: line.unitLabel,
      qtyMilli: line.qtyMilli.toString(),
      unitCostTenThou: line.unitCostTenThou.toString(),
      unitPriceTenThou: line.unitPriceTenThou.toString(),
      lineCostCents: line.lineCostCents,
      lineTotalCents: line.lineTotalCents,
      displayPriceCents: display.lines[index]?.displayPriceCents ?? line.lineTotalCents,
      isTaxable: line.isTaxable,
      isAllowance: line.isAllowance,
      isOptional: line.isOptional,
      isIncluded: line.isIncluded,
    })),
    taxes: taxRows.map((tax) => ({
      label: tax.label,
      registrationNumber: tax.registrationNumber,
      rateTenThou: tax.rateTenThou.toString(),
      taxableBaseCents: tax.taxableBaseCents,
      taxAmountCents: tax.taxAmountCents,
    })),
    rateItems: itemRows.map((item) => ({
      id: item.id,
      code: item.code,
      description: item.description,
      unitLabel: item.unitLabel,
      sellRateTenThou: item.sellRateTenThou.toString(),
    })),
    /**
     * The company that issued this quote, returned rather than re-queried.
     *
     * The print route needs the whole letterhead -- name, address, HST
     * registration number, logo, terms -- and it already has to go through this
     * loader to get the quote. A second `companyOf` call there would be a
     * second query for a row this function has already read, and worse, a
     * second PLACE that decides whose letterhead a document carries.
     *
     * Nothing here is confidential: every field prints on the document the
     * customer receives. That distinguishes it from the cost and margin figures
     * `specs/2026-09-05-estimator-role-design.md` is careful about, which must
     * not enter the payload at all.
     */
    company,
  };
});
