'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { taxRates } from '@/db/schema';
import { requireCapability } from '@/app/settings/actor';
import { percentField } from '@/app/settings/percent-schema';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import {
  checkbox,
  formValues,
  invalid,
  isoDate,
  optionalText,
  requiredInt,
  requiredText,
} from '@/app/settings/validate';
import { addDays } from '@/lib/quote/dates';

/**
 * Tax rates: versioned by effective date, never edited in place.
 *
 * Two mechanisms protect two different things, and neither alone is enough:
 *
 * - The per-quote snapshot in `quote_taxes` protects documents already issued.
 *   A quote sent last spring keeps last spring's tax line forever, exactly as
 *   the customer received it.
 * - Effective dating decides which rate a NEW quote picks up, including one
 *   back-dated during a transition, and answers "what was the rate on this
 *   date" for an audit years later.
 *
 * A snapshot without effective dating cannot price correctly in the weeks
 * around a change; effective dating without a snapshot lets a later edit
 * rewrite history.
 */

const addLabels = {
  label: 'Label',
  shortLabel: 'Short label',
  registrationNumber: 'Registration number',
  rate: 'Rate',
  effectiveFrom: 'Effective from',
  sortOrder: 'Order',
  isCompound: 'Compound',
};

const addSchema = z.object({
  label: requiredText(50),
  shortLabel: optionalText(20),
  registrationNumber: optionalText(50),
  rate: percentField({ min: 0, max: 100, allowBlank: false }),
  effectiveFrom: isoDate,
  sortOrder: requiredInt(0, 999),
  isCompound: checkbox,
});

export async function addTaxRate(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('taxRates.edit');
  if (!guard.ok) return guard.result;

  const parsed = addSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, addLabels);
  const { rate, ...rest } = parsed.data;
  if (rate === null) return refused('A rate is required.');

  await db.insert(taxRates).values({
    ...rest,
    rateTenThou: rate,
    createdBy: guard.actor.id,
  });

  revalidatePath('/settings/tax-rates');
  return saved(`${parsed.data.label} added, in force from ${parsed.data.effectiveFrom}.`);
}

const supersedeLabels = {
  id: 'Rate',
  rate: 'New rate',
  effectiveFrom: 'Takes effect on',
};

const supersedeSchema = z.object({
  id: z.string().uuid(),
  rate: percentField({ min: 0, max: 100, allowBlank: false }),
  effectiveFrom: isoDate,
});

/**
 * The only way a rate changes.
 *
 * The current row is CLOSED with an `effective_to` of the day before the new
 * rate starts, and a new row is inserted carrying the same identity. One
 * transaction, because a closed row with no successor prices new quotes at no
 * tax at all, and a successor with the old row still open makes two rates
 * apply on the same day.
 */
export async function supersedeTaxRate(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('taxRates.edit');
  if (!guard.ok) return guard.result;

  const parsed = supersedeSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, supersedeLabels);
  const { id, rate, effectiveFrom } = parsed.data;
  if (rate === null) return refused('A new rate is required.');

  try {
    const message = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(taxRates).where(eq(taxRates.id, id));
      if (!current) throw new Error('that rate no longer exists');
      if (current.recordStatus !== 'active') throw new Error('that rate row is void');
      if (current.effectiveTo !== null) {
        throw new Error(
          `that row was already closed on ${current.effectiveTo}; supersede the rate that is in force instead`,
        );
      }
      if (effectiveFrom <= current.effectiveFrom) {
        // ISO dates compare correctly as strings, so no Date is constructed:
        // parsing them would drag the host timezone into a decision about
        // which tax a contract was signed under.
        throw new Error(
          `the new rate must start after ${current.effectiveFrom}, which is when the current one took effect`,
        );
      }
      if (current.rateTenThou === rate) {
        throw new Error('that is the rate already in force, so there is nothing to supersede');
      }

      // Inclusive dates: the old row is in force up to and including the day
      // before the new one starts.
      await tx
        .update(taxRates)
        .set({ effectiveTo: addDays(effectiveFrom, -1) })
        .where(eq(taxRates.id, id));

      await tx.insert(taxRates).values({
        label: current.label,
        shortLabel: current.shortLabel,
        registrationNumber: current.registrationNumber,
        rateTenThou: rate,
        effectiveFrom,
        isCompound: current.isCompound,
        sortOrder: current.sortOrder,
        isActive: current.isActive,
        createdBy: guard.actor.id,
      });

      return `${current.label} superseded, new rate from ${effectiveFrom}.`;
    });

    revalidatePath('/settings/tax-rates');
    return saved(message);
  } catch (error) {
    return refused(error instanceof Error ? error.message : 'that change failed');
  }
}

const presentationLabels = {
  id: 'Rate',
  label: 'Label',
  shortLabel: 'Short label',
  registrationNumber: 'Registration number',
  sortOrder: 'Order',
  isCompound: 'Compound',
};

const presentationSchema = z.object({
  id: z.string().uuid(),
  label: requiredText(50),
  shortLabel: optionalText(20),
  registrationNumber: optionalText(50),
  sortOrder: requiredInt(0, 999),
  isCompound: checkbox,
});

/**
 * Corrects what a rate is CALLED and the order it applies in, in place.
 *
 * This is not a loophole in the versioning rule. The rate and the day it takes
 * effect are the priced facts, and they are only ever superseded. A label
 * typo, a registration number, the application order and the compound flag are
 * how the rate is presented and combined -- and every issued document already
 * carries its own snapshot of all four, so correcting them here cannot reach
 * backwards into a quote a customer has signed.
 */
export async function editTaxRatePresentation(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('taxRates.edit');
  if (!guard.ok) return guard.result;

  const parsed = presentationSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, presentationLabels);
  const { id, ...patch } = parsed.data;

  const rows = await db
    .update(taxRates)
    .set(patch)
    .where(eq(taxRates.id, id))
    .returning({ id: taxRates.id });

  if (rows.length === 0) return refused('That rate no longer exists.');

  revalidatePath('/settings/tax-rates');
  return saved(`${patch.label} updated.`);
}

const activeSchema = z.object({
  id: z.string().uuid(),
  isActive: z.stringbool(),
});

/**
 * Retires a rate, or brings it back.
 *
 * Nothing is deleted. A retired row keeps its effective dates, so a quote
 * dated inside its window still answers correctly to an audit, and the row
 * survives in the mirror and in every backup.
 */
export async function setTaxRateActive(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('taxRates.edit');
  if (!guard.ok) return guard.result;

  const parsed = activeSchema.safeParse(formValues(formData));
  if (!parsed.success) return refused('That request did not make sense.');

  const rows = await db
    .update(taxRates)
    .set({ isActive: parsed.data.isActive })
    .where(eq(taxRates.id, parsed.data.id))
    .returning({ label: taxRates.label });

  if (rows.length === 0) return refused('That rate no longer exists.');

  revalidatePath('/settings/tax-rates');
  return saved(
    parsed.data.isActive ? `${rows[0]!.label} is in use again.` : `${rows[0]!.label} retired.`,
  );
}
