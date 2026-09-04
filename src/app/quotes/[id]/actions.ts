'use server';

import { and, asc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { quoteLines, quotes, rateItems } from '@/db/schema';
import { parseQtyToMilli, parseRateToTenThou } from '@/lib/money/format';
import { recalculateQuote } from '@/lib/quote/recalculate';

/**
 * Every action re-reads the quote and refuses anything but a draft. The
 * triggers refuse it too, but a clear error beats a database exception in the
 * user's face.
 */
async function requireDraft(quoteId: string) {
  const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
  if (!quote) throw new Error('quote not found');
  if (quote.recordStatus !== 'active') throw new Error('this quote is void');
  if (quote.status !== 'draft') {
    throw new Error(`a ${quote.status} quote cannot be edited; revise it instead`);
  }
  return quote;
}

const editSchema = z.object({
  quoteId: z.string().uuid(),
  lineId: z.string().uuid(),
  qty: z.string().optional(),
  unitPrice: z.string().optional(),
  unitCost: z.string().optional(),
  description: z.string().max(500).optional(),
  isIncluded: z.boolean().optional(),
});

export type EditResult = { ok: true } | { ok: false; error: string };

/** Commits one line edit, then recomputes the quote. */
export async function editLine(input: z.input<typeof editSchema>): Promise<EditResult> {
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'that edit did not make sense' };
  const { quoteId, lineId, qty, unitPrice, unitCost, description, isIncluded } = parsed.data;

  try {
    await requireDraft(quoteId);

    const patch: Record<string, unknown> = {};

    if (qty !== undefined) {
      const value = parseQtyToMilli(qty);
      if (value === null) return { ok: false, error: `"${qty}" is not a quantity` };
      patch.qtyMilli = value;
    }
    if (unitPrice !== undefined) {
      const value = parseRateToTenThou(unitPrice);
      if (value === null) return { ok: false, error: `"${unitPrice}" is not a rate` };
      patch.unitPriceTenThou = value;
    }
    if (unitCost !== undefined) {
      const value = parseRateToTenThou(unitCost);
      if (value === null) return { ok: false, error: `"${unitCost}" is not a rate` };
      patch.unitCostTenThou = value;
    }
    if (description !== undefined) patch.description = description;
    if (isIncluded !== undefined) patch.isIncluded = isIncluded;

    if (Object.keys(patch).length === 0) return { ok: true };

    await db
      .update(quoteLines)
      .set(patch)
      .where(and(eq(quoteLines.id, lineId), eq(quoteLines.quoteId, quoteId)));

    await recalculateQuote(quoteId);
    revalidatePath(`/quotes/${quoteId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'that edit failed' };
  }
}

const voidSchema = z.object({
  quoteId: z.string().uuid(),
  lineId: z.string().uuid(),
  reason: z.string().optional(),
});

/**
 * Removes a line by voiding it.
 *
 * A draft's removal supplies its own reason. Demanding one from the user for a
 * line on a quote nobody has seen is what makes a void model absurd.
 */
export async function voidLine(input: z.input<typeof voidSchema>): Promise<EditResult> {
  const parsed = voidSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'that removal did not make sense' };
  const { quoteId, lineId, reason } = parsed.data;

  try {
    await requireDraft(quoteId);
    await db
      .update(quoteLines)
      .set({
        recordStatus: 'void',
        voidedAt: new Date(),
        voidReason: reason?.trim() || 'Removed while the quote was a draft',
      })
      .where(and(eq(quoteLines.id, lineId), eq(quoteLines.quoteId, quoteId)));

    await recalculateQuote(quoteId);
    revalidatePath(`/quotes/${quoteId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'that removal failed' };
  }
}

const addSchema = z.object({
  quoteId: z.string().uuid(),
  rateItemId: z.string().uuid(),
  qty: z.string().default('1'),
});

/** Adds a line from the rate list, snapshotting its rates on the way in. */
export async function addLine(input: z.input<typeof addSchema>): Promise<EditResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'that line did not make sense' };
  const { quoteId, rateItemId, qty } = parsed.data;

  try {
    await requireDraft(quoteId);

    const [item] = await db.select().from(rateItems).where(eq(rateItems.id, rateItemId));
    if (!item) return { ok: false, error: 'that rate item no longer exists' };

    const qtyMilli = parseQtyToMilli(qty) ?? 1000n;

    // Voided lines keep their sort order, so the next one goes after them all.
    const existing = await db
      .select({ sortOrder: quoteLines.sortOrder })
      .from(quoteLines)
      .where(eq(quoteLines.quoteId, quoteId));
    const nextSort = existing.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 1;

    await db.insert(quoteLines).values({
      quoteId,
      sortOrder: nextSort,
      lineGroup: 'Added',
      code: item.code,
      description: item.description,
      calcMode: item.calcMode,
      unitLabel: item.unitLabel,
      rateItemId: item.id,
      costCodeId: item.costCodeId,
      qtyMilli,
      // Snapshot: read once, never referenced again.
      unitCostTenThou: item.costRateTenThou,
      unitPriceTenThou: item.sellRateTenThou,
      lineCostCents: 0,
      lineTotalCents: 0,
      isTaxable: item.isTaxable,
      isAllowance: item.isAllowance,
    });

    await recalculateQuote(quoteId);
    revalidatePath(`/quotes/${quoteId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'that line failed' };
  }
}

const statusSchema = z.object({
  quoteId: z.string().uuid(),
  status: z.enum(['sent', 'accepted', 'declined']),
  acceptedByName: z.string().max(200).optional(),
});

/** Moves a quote along. Only the whitelisted header columns change. */
export async function setQuoteStatus(input: z.input<typeof statusSchema>): Promise<EditResult> {
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'that status did not make sense' };
  const { quoteId, status, acceptedByName } = parsed.data;

  try {
    const now = new Date();
    const patch: Record<string, unknown> = { status };
    if (status === 'sent') patch.sentAt = now;
    if (status === 'accepted') {
      patch.acceptedAt = now;
      if (acceptedByName) patch.acceptedByName = acceptedByName;
    }
    if (status === 'declined') patch.declinedAt = now;

    await db.update(quotes).set(patch).where(eq(quotes.id, quoteId));
    revalidatePath(`/quotes/${quoteId}`);
    revalidatePath('/quotes');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'that change failed' };
  }
}
