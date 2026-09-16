import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { quoteLines, quotes, rateItems, scopeTemplateItems } from '@/db/schema';
import { recalculateQuote } from '@/lib/quote/recalculate';
import { expandTemplate, type ScopeInputs, type TemplateItem } from '@/lib/quote/template';

/**
 * Changing a draft's measurements, and rebuilding its lines from the template.
 *
 * Two operations, deliberately separate. Changing the square footage on its own
 * only records what was measured; it does not silently reprice a quote whose
 * lines the owner has spent ten minutes adjusting by hand. Regeneration is the
 * explicit second step, and it says what it will discard before it does it.
 */

export class RegenerateError extends Error {}

async function requireDraft(quoteId: string) {
  const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
  if (!quote) throw new RegenerateError('quote not found');
  if (quote.recordStatus !== 'active') throw new RegenerateError('this quote is void');
  if (quote.status !== 'draft') {
    throw new RegenerateError(
      `a ${quote.status} quote cannot be changed: revise it, or raise a change order`,
    );
  }
  return quote;
}

/**
 * Records the scope inputs and recomputes, WITHOUT touching the line list.
 *
 * Quantity-derived lines are not re-derived here. A line's quantity is its own
 * value once the line exists -- the owner measures 1,240 sqft, generates, then
 * corrects the drywall line to 1,310 because of the stairwell, and a later
 * change to the area figure must not quietly undo that correction.
 */
export async function setScopeInputs(args: {
  quoteId: string;
  scope: Partial<ScopeInputs>;
}): Promise<void> {
  await requireDraft(args.quoteId);

  const patch: Record<string, unknown> = {};
  if (args.scope.areaSqftMilli !== undefined) patch.areaSqftMilli = args.scope.areaSqftMilli;
  if (args.scope.washroomCount !== undefined) patch.washroomCount = args.scope.washroomCount;
  if (args.scope.kitchenCount !== undefined) patch.kitchenCount = args.scope.kitchenCount;
  if (args.scope.bedroomCount !== undefined) patch.bedroomCount = args.scope.bedroomCount;
  if (Object.keys(patch).length === 0) return;

  await db.update(quotes).set(patch).where(eq(quotes.id, args.quoteId));
}

export interface RegenerateSummary {
  /** Lines voided because regeneration replaced them. */
  replaced: number;
  /** Lines written from the template at the current measurements. */
  created: number;
  /** Lines kept because they were added by hand, not by the template. */
  kept: number;
}

/**
 * Rebuilds the template-derived lines from the quote's current measurements.
 *
 * What it replaces: every active line that came from the template, identified
 * by `rate_item_id` matching one of the template's items. Those are voided
 * with a stated reason, never deleted -- the application role holds no DELETE
 * privilege, and a regeneration that lost the previous figures would leave no
 * record of what the quote said an hour ago.
 *
 * What it keeps: anything the owner added by hand. A line typed straight into
 * the quote, or picked from the rate list outside the template, is the owner's
 * work and the template has no opinion about it.
 *
 * Rates are re-snapshotted at today's values, which is the point: regeneration
 * after a supplier price rise is how the owner picks the rise up.
 */
export async function regenerateFromTemplate(args: {
  quoteId: string;
  createdBy?: string;
}): Promise<RegenerateSummary> {
  const summary = await db.transaction(async (tx) => {
    const [quote] = await tx.select().from(quotes).where(eq(quotes.id, args.quoteId));
    if (!quote) throw new RegenerateError('quote not found');
    if (quote.recordStatus !== 'active') throw new RegenerateError('this quote is void');
    if (quote.status !== 'draft') {
      throw new RegenerateError(
        `a ${quote.status} quote cannot be regenerated: revise it, or raise a change order`,
      );
    }
    if (!quote.scopeTemplateId) {
      throw new RegenerateError(
        'this quote was not built from a template, so there is nothing to regenerate from',
      );
    }

    const templateRows = await tx
      .select({ template: scopeTemplateItems, item: rateItems })
      .from(scopeTemplateItems)
      .innerJoin(rateItems, eq(scopeTemplateItems.rateItemId, rateItems.id))
      .where(
        and(
          eq(scopeTemplateItems.scopeTemplateId, quote.scopeTemplateId),
          eq(scopeTemplateItems.recordStatus, 'active'),
          eq(rateItems.recordStatus, 'active'),
        ),
      )
      .orderBy(asc(scopeTemplateItems.sortOrder));

    if (templateRows.length === 0) {
      throw new RegenerateError('every item on that template has been retired');
    }

    const templateItems: TemplateItem[] = templateRows.map(({ template, item }) => ({
      code: item.code,
      description: item.description,
      lineGroup: template.lineGroup,
      sortOrder: template.sortOrder,
      calcMode: item.calcMode,
      unitLabel: item.unitLabel,
      qtySource: template.qtySource,
      qtyMultiplierTenThou: template.qtyMultiplierTenThou,
      fixedQtyMilli: template.fixedQtyMilli,
      costRateTenThou: item.costRateTenThou,
      sellRateTenThou: item.sellRateTenThou,
      isTaxable: item.isTaxable,
      isOptional: template.isOptional,
      isAllowance: template.isAllowance || item.isAllowance,
      rateItemId: item.id,
      costCodeId: item.costCodeId,
    }));

    const fresh = expandTemplate(templateItems, {
      areaSqftMilli: quote.areaSqftMilli ?? 0n,
      washroomCount: quote.washroomCount ?? 0,
      kitchenCount: quote.kitchenCount ?? 0,
      bedroomCount: quote.bedroomCount ?? 0,
    });

    const templateItemIds = new Set(templateItems.map((item) => item.rateItemId));
    const existing = await tx
      .select()
      .from(quoteLines)
      .where(and(eq(quoteLines.quoteId, args.quoteId), eq(quoteLines.recordStatus, 'active')));

    const fromTemplate = existing.filter(
      (line) => line.rateItemId !== null && templateItemIds.has(line.rateItemId),
    );

    /**
     * ONE statement, not one per line. Every row takes the same three values,
     * so the loop was N serialized round trips inside the transaction to say
     * the same thing N times -- a 40-line template regeneration held the write
     * lock for 40 of them.
     */
    if (fromTemplate.length > 0) {
      await tx
        .update(quoteLines)
        .set({
          recordStatus: 'void',
          voidedAt: new Date(),
          voidReason: 'Replaced by regeneration from the scope template',
        })
        .where(inArray(quoteLines.id, fromTemplate.map((line) => line.id)));
    }

    // Hand-added lines keep their sort order, and the regenerated set is
    // inserted after them rather than renumbering somebody else's work.
    const highestSort = existing.reduce((max, line) => Math.max(max, line.sortOrder), 0);

    if (fresh.length > 0) {
      await tx.insert(quoteLines).values(
        fresh.map((line, index) => ({
          quoteId: args.quoteId,
          sortOrder: highestSort + index + 1,
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
          // Zero, then corrected by the recompute below, which is the only
          // place that can price a percent line: its value depends on the sum
          // of the lines it applies to.
          lineCostCents: 0,
          lineTotalCents: 0,
          isTaxable: line.isTaxable,
          isAllowance: line.isAllowance,
          isOptional: line.isOptional,
          isIncluded: line.isIncluded,
          createdBy: args.createdBy,
        })),
      );
    }

    return {
      replaced: fromTemplate.length,
      created: fresh.length,
      kept: existing.length - fromTemplate.length,
    };
  });

  // Outside the transaction: recalculateQuote opens its own, and nesting would
  // hold the line locks for the duration of a second round trip.
  await recalculateQuote(args.quoteId);
  return summary;
}
