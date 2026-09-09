import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, projects, quoteLines, quoteTaxes, quotes, rateItems } from '@/db/schema';
import { addDays, tenantToday, yearOf } from '@/lib/quote/dates';
import { companyOf } from '@/lib/company/load';
import { allocateDocumentNumber } from '@/lib/quote/numbering';
import type { TaxRateInput } from '@/lib/quote/tax';
import { computeQuote } from '@/lib/quote/totals';
import type { CalcMode, LineInput } from '@/lib/quote/types';
import { loadTaxRatesFor } from '@/lib/quote/rates';

/**
 * Change orders.
 *
 * A change order IS a quote with a parent: the same lines, taxes, engine, PDF
 * and acceptance flow, with a different heading and its own sequence within
 * the project. Three parallel tables would have duplicated all of it and
 * pushed mid-job extras out to a later phase.
 *
 * Deductive change orders are negative rates. A credit to the customer is not
 * a separate concept, it is a line whose price is below zero, and the engine
 * already carries negatives through the subtotal, the percent base and the
 * taxable base alike.
 */

export interface ChangeOrderLine {
  code: string;
  description: string;
  lineGroup: string;
  calcMode: CalcMode;
  unitLabel: string;
  qtyMilli: bigint;
  unitCostTenThou: bigint;
  /** May be negative: that is what makes a change order deductive. */
  unitPriceTenThou: bigint;
  isTaxable?: boolean;
  isAllowance?: boolean;
  rateItemId?: string | null;
  costCodeId?: string | null;
}

export type ChangeReason =
  | 'customer_request'
  | 'site_condition'
  | 'design_change'
  | 'code_requirement'
  | 'error_omission'
  | 'allowance_reconciliation';

/**
 * Raises a change order against an accepted quote.
 *
 * Only against an accepted one. A quote still out with the customer is revised
 * rather than amended -- there is no contract yet to change -- and the error
 * says so rather than refusing silently.
 */
export async function createChangeOrder(args: {
  parentQuoteId: string;
  reason: ChangeReason;
  /**
   * Days this adds to the schedule. Priced separately from the lines because a
   * change order that adds four days to a fixed-date job has a real cost even
   * when every line on it carries full margin -- unpriced time is the most
   * common way a contractor loses money while appearing to break even.
   */
  scheduleImpactDays?: number;
  lines: ChangeOrderLine[];
  notes?: string;
  createdBy?: string;
}): Promise<{ quoteId: string; quoteNumber: string; sequence: number }> {
  if (args.lines.length === 0) {
    throw new Error('a change order needs at least one line');
  }

  return db.transaction(async (tx) => {
    const [parent] = await tx.select().from(quotes).where(eq(quotes.id, args.parentQuoteId));
    if (!parent) throw new Error(`quote ${args.parentQuoteId} not found`);
    if (parent.recordStatus !== 'active') {
      throw new Error('a void quote cannot take a change order');
    }
    if (parent.kind !== 'estimate') {
      // A change order amends the contract, not another amendment. Chaining
      // them would make the derived contract value depend on a walk up a tree
      // rather than a sum over the project.
      throw new Error('a change order is raised against an estimate, not against another change order');
    }
    if (parent.status !== 'accepted') {
      throw new Error(
        `this quote is ${parent.status}: revise it instead. A change order amends work the customer has already accepted`,
      );
    }

    const [customer] = await tx
      .select({ isTaxExempt: customers.isTaxExempt })
      .from(projects)
      .innerJoin(customers, eq(projects.customerId, customers.id))
      .where(eq(projects.id, parent.projectId));

    // Sequence counts change orders within the project, so CO-2 is the second
    // change on the job rather than the second on one estimate.
    const siblings = await tx
      .select({ sequence: quotes.sequence })
      .from(quotes)
      .where(and(eq(quotes.projectId, parent.projectId), eq(quotes.kind, 'change_order')));
    const sequence = siblings.reduce((max, row) => Math.max(max, row.sequence), 0) + 1;

    /**
     * The change order is issued by whoever issued the quote it amends.
     *
     * Read from the parent's project rather than a fixed row, and read BEFORE
     * the rates because the rates are this company's rates: a change order
     * priced against the other corporation's HST would be a wrong number on a
     * signed amendment, and the validity window below would be the wrong
     * company's too.
     */
    const company = await companyOf(tx, parent.projectId);

    const quoteDate = await tenantToday(tx);
    const rates: TaxRateInput[] = await loadTaxRatesFor(tx, company.id);

    const inputs: LineInput[] = args.lines.map((line, index) => ({
      code: line.code,
      description: line.description,
      lineGroup: line.lineGroup,
      sortOrder: index + 1,
      calcMode: line.calcMode,
      unitLabel: line.unitLabel,
      qtyMilli: line.qtyMilli,
      unitCostTenThou: line.unitCostTenThou,
      unitPriceTenThou: line.unitPriceTenThou,
      isTaxable: line.isTaxable ?? true,
      // A change order has no optional lines. An upgrade the customer has not
      // decided on is not a change to the contract yet.
      isOptional: false,
      isIncluded: true,
      isAllowance: line.isAllowance ?? false,
      rateItemId: line.rateItemId ?? null,
      costCodeId: line.costCodeId ?? null,
    }));

    const totals = computeQuote(inputs, rates, {
      onDate: quoteDate,
      customerExempt: customer?.isTaxExempt ?? false,
    });

    const quoteNumber = await allocateDocumentNumber(tx, 'change_order', company, yearOf(quoteDate));

    const [changeOrder] = await tx
      .insert(quotes)
      .values({
        projectId: parent.projectId,
        quoteNumber,
        kind: 'change_order',
        parentQuoteId: parent.id,
        sequence,
        reason: args.reason,
        scheduleImpactDays: args.scheduleImpactDays ?? null,
        version: 1,
        quoteDate,
        validUntil: addDays(quoteDate, company.quoteValidityDays),
        subtotalCents: totals.subtotalCents,
        taxTotalCents: totals.taxTotalCents,
        totalCents: totals.totalCents,
        totalCostCents: totals.totalCostCents,
        marginBp: totals.marginBp,
        // Inherited so the amendment carries the same holdback and the same
        // level of pricing detail as the contract it changes.
        holdbackPctTenThou: parent.holdbackPctTenThou,
        pricingDisplay: parent.pricingDisplay,
        paymentTermsText: parent.paymentTermsText,
        notes: args.notes,
        createdBy: args.createdBy,
      })
      .returning();

    await tx.insert(quoteLines).values(
      totals.lines.map((line) => ({
        quoteId: changeOrder!.id,
        sortOrder: line.sortOrder,
        lineGroup: line.lineGroup,
        code: line.code,
        description: line.description,
        calcMode: line.calcMode,
        unitLabel: line.unitLabel,
        rateItemId: line.rateItemId,
        costCodeId: line.costCodeId,
        qtyMilli: line.qtyMilli,
        unitCostTenThou: line.unitCostTenThou,
        unitPriceTenThou: line.unitPriceTenThou,
        lineCostCents: line.lineCostCents,
        lineTotalCents: line.lineTotalCents,
        isTaxable: line.isTaxable,
        isAllowance: line.isAllowance,
        isOptional: false,
        isIncluded: true,
        createdBy: args.createdBy,
      })),
    );

    if (totals.taxes.length > 0) {
      await tx.insert(quoteTaxes).values(
        totals.taxes.map((tax, index) => ({
          quoteId: changeOrder!.id,
          label: tax.label,
          registrationNumber: tax.registrationNumber,
          rateTenThou: tax.rateTenThou,
          taxableBaseCents: tax.taxableBaseCents,
          taxAmountCents: tax.taxAmountCents,
          sortOrder: index,
          createdBy: args.createdBy,
        })),
      );
    }

    return { quoteId: changeOrder!.id, quoteNumber, sequence };
  });
}

/**
 * A change order built from rate items rather than typed lines, which is what
 * the worksheet's picker produces.
 *
 * The rates are snapshotted here exactly as they are for an estimate: read
 * once, never referenced again, so raising a rate tomorrow cannot rewrite a
 * change order the customer signed today.
 */
export async function changeOrderLinesFromRateItems(
  picks: { rateItemId: string; qtyMilli: bigint; lineGroup?: string; deductive?: boolean }[],
): Promise<ChangeOrderLine[]> {
  if (picks.length === 0) return [];

  const ids = picks.map((pick) => pick.rateItemId);
  const items = await db
    .select()
    .from(rateItems)
    .where(eq(rateItems.recordStatus, 'active'))
    .orderBy(asc(rateItems.sortOrder));

  const byId = new Map(items.filter((item) => ids.includes(item.id)).map((item) => [item.id, item]));

  return picks.map((pick) => {
    const item = byId.get(pick.rateItemId);
    if (!item) throw new Error(`rate item ${pick.rateItemId} not found`);

    // A deduction is the same item at a negative price, not a separate kind of
    // line: the engine already carries negatives through every base.
    const sign = pick.deductive ? -1n : 1n;

    return {
      code: item.code,
      description: item.description,
      lineGroup: pick.lineGroup ?? 'Change',
      calcMode: item.calcMode,
      unitLabel: item.unitLabel,
      qtyMilli: pick.qtyMilli,
      unitCostTenThou: item.costRateTenThou * sign,
      unitPriceTenThou: item.sellRateTenThou * sign,
      isTaxable: item.isTaxable,
      isAllowance: item.isAllowance,
      rateItemId: item.id,
      costCodeId: item.costCodeId,
    };
  });
}
