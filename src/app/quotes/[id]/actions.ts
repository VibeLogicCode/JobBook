'use server';

import { and, asc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { quoteLines, quotes, rateItems } from '@/db/schema';
import type { WireChangeReason } from '@/components/worksheet/types';
import { guard } from '@/lib/auth/guard';
import { parseQtyToMilli, parseRateToTenThou } from '@/lib/money/format';
import { acceptQuoteLines } from '@/lib/quote/accept';
import {
  changeOrderLinesFromRateItems,
  createChangeOrder,
  type ChangeReason,
} from '@/lib/quote/change-order';
import { recalculateQuote } from '@/lib/quote/recalculate';
import {
  regenerateFromTemplate,
  setScopeInputs,
  type RegenerateSummary,
} from '@/lib/quote/regenerate';
import type { ScopeInputs } from '@/lib/quote/template';

/**
 * Every action opens with two checks, in this order.
 *
 * First `guard(capability)`: authorization is a separate lookup from
 * authentication, performed on every request that changes anything, against
 * the user's role and never against anything the browser sent. It comes before
 * any argument is read, so a branch added later cannot slip in above it.
 *
 * Then `requireDraft`: mutability is defined by status. The database triggers
 * refuse a non-draft write as well, but a sentence beats a database exception
 * in somebody's face.
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
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

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
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

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
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

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
    const allowed = await guard('quote:transition');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    const now = new Date();

    // An ESTIMATE cannot be accepted here, and the refusal is server-side
    // rather than only a hidden button: this action writes the status and
    // nothing else -- no line selection, no project stage, no decision about
    // the other quotes on the opportunity. The result is a quote that reads
    // ACCEPTED while the opportunity is still a lead, no job exists, contract
    // value appears out of nowhere and nothing explains why. That happened on
    // the first real attempt, which is why a hidden control was not enough.
    //
    // A change order still comes through here: it is one already-agreed
    // change, has no optional lines by construction, and accepting it neither
    // wins the job nor puts any other quote out of the running.
    if (status === 'accepted') {
      const [subject] = await db
        .select({ kind: quotes.kind })
        .from(quotes)
        .where(eq(quotes.id, quoteId));
      if (!subject) return { ok: false, error: 'that quote no longer exists' };
      if (subject.kind === 'estimate') {
        return {
          ok: false,
          error:
            'An estimate is won through the acceptance panel below the worksheet, which asks ' +
            'which lines the customer agreed to and turns the opportunity into a job. Marking ' +
            'the status alone would leave a quote that says accepted with no job behind it.',
        };
      }
    }

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

const acceptSchema = z.object({
  quoteId: z.string().uuid(),
  wonLineIds: z.array(z.string().uuid()).min(1),
  declineSiblings: z.boolean(),
  acceptedByName: z.string().min(1).max(200),
});

export type AcceptResult =
  | {
      ok: true;
      projectId: string;
      acceptedQuoteId: string;
      version: number;
      revised: boolean;
      declined: { id: string; quoteNumber: string }[];
    }
  | { ok: false; error: string };

/**
 * Wins the quote: accepts the chosen lines and turns the opportunity into a job.
 *
 * Guarded on `quote:transition` rather than `quote:write`, because nothing
 * about the document is being edited -- a contract is coming into existence,
 * which is the same class of decision as sending or declining one, and a
 * bookkeeper holds neither.
 *
 * The actor's id becomes `created_by` on everything the transaction writes. The
 * customer's name arrives from the form and lands in `accepted_by_name`; the
 * two are different people and are never conflated.
 */
export async function acceptQuote(
  input: z.input<typeof acceptSchema>,
): Promise<AcceptResult> {
  const parsed = acceptSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'that acceptance needs at least one line and a name' };
  }
  const { quoteId, wonLineIds, declineSiblings, acceptedByName } = parsed.data;

  try {
    const allowed = await guard('quote:transition');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    const outcome = await acceptQuoteLines({
      quoteId,
      wonLineIds,
      declineSiblings,
      acceptedByName,
      createdBy: allowed.actor.id,
    });

    // The job list, the opportunity that just became a job, the quote that was
    // superseded and the version that now stands accepted all say something
    // different from what they said a moment ago.
    revalidatePath('/quotes');
    revalidatePath('/projects');
    revalidatePath(`/quotes/${quoteId}`);
    revalidatePath(`/quotes/${outcome.acceptedQuoteId}`);
    revalidatePath(`/projects/${outcome.projectId}`);
    for (const quote of outcome.declined) revalidatePath(`/quotes/${quote.id}`);

    return {
      ok: true,
      projectId: outcome.projectId,
      acceptedQuoteId: outcome.acceptedQuoteId,
      version: outcome.version,
      revised: outcome.revised,
      declined: outcome.declined,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'that acceptance failed',
    };
  }
}

const scopeSchema = z.object({
  quoteId: z.string().uuid(),
  areaSqft: z.string().optional(),
  washroomCount: z.string().optional(),
  kitchenCount: z.string().optional(),
  bedroomCount: z.string().optional(),
});

/**
 * A count is a whole number of rooms, so it is parsed here rather than through
 * the money helpers: `parseQtyToMilli('2')` is 2000n, which is the right answer
 * to a different question.
 */
function parseCount(raw: string): number | null {
  if (!/^\d{1,4}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/**
 * Records what was measured. It does NOT rebuild the line list.
 *
 * Regeneration is the explicit second step. Changing the square footage must
 * not silently discard ten minutes of hand adjustment -- the owner measures
 * 1,240, generates, corrects the drywall line for the stairwell, and a later
 * correction to the area figure has no business undoing that.
 */
export async function saveScopeInputs(
  input: z.input<typeof scopeSchema>,
): Promise<EditResult> {
  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'those measurements did not make sense' };
  const { quoteId, areaSqft, washroomCount, kitchenCount, bedroomCount } = parsed.data;

  const scope: Partial<ScopeInputs> = {};

  // A blank field leaves the figure as it was. The sheet arrives pre-filled, so
  // an empty box means the owner cleared it rather than measured zero, and
  // writing a zero over a measurement nobody touched loses information.
  if (areaSqft !== undefined && areaSqft.trim() !== '') {
    const value = parseQtyToMilli(areaSqft);
    if (value === null) return { ok: false, error: `"${areaSqft}" is not an area` };
    scope.areaSqftMilli = value;
  }

  type CountKey = 'washroomCount' | 'kitchenCount' | 'bedroomCount';
  const counts: [string | undefined, CountKey, string][] = [
    [washroomCount, 'washroomCount', 'washrooms'],
    [kitchenCount, 'kitchenCount', 'kitchens'],
    [bedroomCount, 'bedroomCount', 'bedrooms'],
  ];
  for (const [raw, key, label] of counts) {
    if (raw === undefined || raw.trim() === '') continue;
    const value = parseCount(raw);
    if (value === null) return { ok: false, error: `"${raw}" is not a number of ${label}` };
    scope[key] = value;
  }

  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    await setScopeInputs({ quoteId, scope });
    revalidatePath(`/quotes/${quoteId}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'those measurements did not save',
    };
  }
}

const regenerateSchema = z.object({ quoteId: z.string().uuid() });

export type RegenerateResult =
  | { ok: true; summary: RegenerateSummary }
  | { ok: false; error: string };

/**
 * Rebuilds the template-derived lines at the quote's current measurements.
 *
 * The summary comes straight back to the caller because the screen has to
 * report what happened: an operation that replaces lines and says nothing is
 * indistinguishable from one that did nothing.
 */
export async function regenerateLines(
  input: z.input<typeof regenerateSchema>,
): Promise<RegenerateResult> {
  const parsed = regenerateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'that regeneration did not make sense' };

  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    const summary = await regenerateFromTemplate({ quoteId: parsed.data.quoteId });
    revalidatePath(`/quotes/${parsed.data.quoteId}`);
    return { ok: true, summary };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'that regeneration failed',
    };
  }
}

/**
 * The six reasons, as the database spells them.
 *
 * `satisfies` proves every member is a real `change_reason`, and the two
 * assertions below prove the list is complete and that the union the client
 * component carries is the same union: a reason added to the enum without a
 * human wording would otherwise reach production as a blank menu entry.
 */
const CHANGE_REASONS = [
  'customer_request',
  'site_condition',
  'design_change',
  'code_requirement',
  'error_omission',
  'allowance_reconciliation',
] as const satisfies readonly ChangeReason[];

type AssertNever<T extends never> = T;
type _EveryReasonOffered = AssertNever<Exclude<ChangeReason, (typeof CHANGE_REASONS)[number]>>;
type _WireReasonsMatch = AssertNever<
  Exclude<ChangeReason, WireChangeReason> | Exclude<WireChangeReason, ChangeReason>
>;

const changeOrderSchema = z.object({
  parentQuoteId: z.string().uuid(),
  reason: z.enum(CHANGE_REASONS),
  scheduleImpactDays: z.string().optional(),
  notes: z.string().max(2000).optional(),
  lines: z
    .array(
      z.object({
        rateItemId: z.string().uuid(),
        qty: z.string(),
        deductive: z.boolean().optional(),
      }),
    )
    .min(1),
});

export type ChangeOrderResult =
  | { ok: true; quoteId: string; quoteNumber: string; sequence: number }
  | { ok: false; error: string };

/**
 * Raises a change order against an accepted quote.
 *
 * A deduction is not a separate kind of line: `changeOrderLinesFromRateItems`
 * turns the toggle into a negative rate, and the engine already carries
 * negatives through the subtotal, the percent base and the taxable base.
 */
export async function raiseChangeOrder(
  input: z.input<typeof changeOrderSchema>,
): Promise<ChangeOrderResult> {
  const parsed = changeOrderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'that change order needs a reason and at least one line' };
  }
  const { parentQuoteId, reason, scheduleImpactDays, notes, lines } = parsed.data;

  let days: number | undefined;
  if (scheduleImpactDays !== undefined && scheduleImpactDays.trim() !== '') {
    const value = parseCount(scheduleImpactDays);
    if (value === null) {
      return { ok: false, error: `"${scheduleImpactDays}" is not a number of days` };
    }
    days = value;
  }

  const picks: { rateItemId: string; qtyMilli: bigint; deductive: boolean }[] = [];
  for (const line of lines) {
    const qtyMilli = parseQtyToMilli(line.qty);
    if (qtyMilli === null) return { ok: false, error: `"${line.qty}" is not a quantity` };
    picks.push({ rateItemId: line.rateItemId, qtyMilli, deductive: line.deductive ?? false });
  }

  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    const built = await changeOrderLinesFromRateItems(picks);
    const created = await createChangeOrder({
      parentQuoteId,
      reason,
      scheduleImpactDays: days,
      lines: built,
      notes: notes?.trim() || undefined,
    });

    revalidatePath('/quotes');
    revalidatePath(`/quotes/${parentQuoteId}`);
    revalidatePath(`/quotes/${created.quoteId}`);
    return { ok: true, ...created };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'that change order failed',
    };
  }
}
