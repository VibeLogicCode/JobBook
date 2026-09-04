import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  customers, organization, projects, quoteLines, quoteTaxes, quotes, rateItems,
} from '@/db/schema';
import type {
  WireLine, WireQuote, WireRateItem, WireTax,
} from '@/components/worksheet/types';
import { computeQuote } from '@/lib/quote/totals';
import type { LineInput } from '@/lib/quote/types';

/**
 * Loads one quote for the worksheet.
 *
 * The stored figures are authoritative -- they are what the document says --
 * but two display values are not stored: the grossed-up price of an excluded
 * upgrade, and the sum of those upgrades. Both are recomputed here, read-only,
 * so an optional line prints the figure the customer would actually be charged.
 */
export async function loadQuote(quoteId: string): Promise<{
  quote: WireQuote;
  lines: WireLine[];
  taxes: WireTax[];
  rateItems: WireRateItem[];
} | null> {
  const [row] = await db
    .select({
      quote: quotes,
      projectName: projects.name,
      siteAddressLine1: projects.siteAddressLine1,
      siteCity: projects.siteCity,
      customerName: customers.name,
    })
    .from(quotes)
    .innerJoin(projects, eq(quotes.projectId, projects.id))
    .innerJoin(customers, eq(projects.customerId, customers.id))
    .where(eq(quotes.id, quoteId));

  if (!row) return null;

  const [org] = await db.select().from(organization).where(eq(organization.id, 1));

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
      targetMarginBp: org?.targetMarginBp ?? null,
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
  };
}
