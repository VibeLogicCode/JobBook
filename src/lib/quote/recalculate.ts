import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, projects, quoteLines, quoteTaxes, quotes, taxRates } from '@/db/schema';
import { computeQuote } from '@/lib/quote/totals';
import type { LineInput } from '@/lib/quote/types';
import type { TaxRateInput } from '@/lib/quote/tax';

/**
 * Recomputes a draft quote from its own lines and writes the result back.
 *
 * Only drafts. Once a quote is sent its arithmetic is what the customer read,
 * and the mutability triggers refuse the write anyway.
 *
 * Tax rows are updated in place, inserted, or voided -- never deleted. The
 * application role holds no DELETE privilege, so a recompute that deleted its
 * old tax rows would fail as a permission error in production while working
 * fine for a superuser in development.
 */
export async function recalculateQuote(quoteId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [quote] = await tx.select().from(quotes).where(eq(quotes.id, quoteId));
    if (!quote) throw new Error(`quote ${quoteId} not found`);
    if (quote.status !== 'draft') return;

    const [customer] = await tx
      .select({ isTaxExempt: customers.isTaxExempt })
      .from(projects)
      .innerJoin(customers, eq(projects.customerId, customers.id))
      .where(eq(projects.id, quote.projectId));

    const rows = await tx
      .select()
      .from(quoteLines)
      .where(and(eq(quoteLines.quoteId, quoteId), eq(quoteLines.recordStatus, 'active')))
      .orderBy(asc(quoteLines.sortOrder));

    // Keyed by line id, not by position: the write-back below matches each
    // computed line to the row it came from. Positional matching held only
    // while computeQuote preserved length and order, and the day something
    // filtered a line it would write every figure onto its neighbour.
    const inputs: (LineInput & { id: string })[] = rows.map((line) => ({
      id: line.id,
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

    const rateRows = await tx
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.isActive, true), eq(taxRates.recordStatus, 'active')))
      .orderBy(asc(taxRates.sortOrder));

    const rates: TaxRateInput[] = rateRows.map((row) => ({
      label: row.label,
      registrationNumber: row.registrationNumber,
      rateTenThou: row.rateTenThou,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      isCompound: row.isCompound,
      sortOrder: row.sortOrder,
    }));

    const totals = computeQuote(inputs, rates, {
      onDate: quote.quoteDate,
      customerExempt: customer?.isTaxExempt ?? false,
    });

    // Percent lines only know their value once the whole list is known, so
    // their computed totals are written back to the rows they came from.
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const line of totals.lines) {
      const id = (line as LineInput & { id?: string }).id;
      const row = id ? byId.get(id) : undefined;
      if (!row) continue;
      if (row.lineCostCents === line.lineCostCents && row.lineTotalCents === line.lineTotalCents) {
        continue;
      }
      await tx
        .update(quoteLines)
        .set({ lineCostCents: line.lineCostCents, lineTotalCents: line.lineTotalCents })
        .where(eq(quoteLines.id, row.id));
    }

    await tx
      .update(quotes)
      .set({
        subtotalCents: totals.subtotalCents,
        taxTotalCents: totals.taxTotalCents,
        totalCents: totals.totalCents,
        totalCostCents: totals.totalCostCents,
        marginBp: totals.marginBp,
      })
      .where(eq(quotes.id, quoteId));

    const existing = await tx.select().from(quoteTaxes).where(eq(quoteTaxes.quoteId, quoteId));

    for (const [index, tax] of totals.taxes.entries()) {
      const match = existing.find((row) => row.label === tax.label);
      if (match) {
        await tx
          .update(quoteTaxes)
          .set({
            registrationNumber: tax.registrationNumber,
            rateTenThou: tax.rateTenThou,
            taxableBaseCents: tax.taxableBaseCents,
            taxAmountCents: tax.taxAmountCents,
            sortOrder: index,
            recordStatus: 'active',
            voidedAt: null,
            voidReason: null,
          })
          .where(eq(quoteTaxes.id, match.id));
      } else {
        await tx.insert(quoteTaxes).values({
          quoteId,
          label: tax.label,
          registrationNumber: tax.registrationNumber,
          rateTenThou: tax.rateTenThou,
          taxableBaseCents: tax.taxableBaseCents,
          taxAmountCents: tax.taxAmountCents,
          sortOrder: index,
        });
      }
    }

    for (const row of existing) {
      if (totals.taxes.some((tax) => tax.label === row.label)) continue;
      if (row.recordStatus === 'void') continue;
      await tx
        .update(quoteTaxes)
        .set({
          recordStatus: 'void',
          voidedAt: new Date(),
          voidReason: 'No longer applies to this quote',
        })
        .where(eq(quoteTaxes.id, row.id));
    }
  });
}
