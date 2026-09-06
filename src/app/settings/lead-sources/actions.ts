'use server';

import { count, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { customers, leadSources } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  LEAD_SOURCE_LABELS,
  isDuplicateName,
  leadSourceFields,
  toLeadSourceColumns,
} from '@/app/settings/project-lists';

/**
 * The lead source list's write side. Mirrors `trades/actions.ts` exactly --
 * one consuming column (`customers.lead_source_id`, nullable), one usage
 * count, the same three rules (per-request authorization, nothing deleted,
 * a void refused for a row anything still points at).
 *
 * `rates:edit` for adding, editing and retiring; `record:void` for voiding.
 */

const REFUSAL = 'Your role does not permit changing the lead source list.';

class InUseError extends Error {}

function failureText(error: unknown): string {
  if (error instanceof InUseError) return error.message;
  return 'That change could not be saved. Nothing was written.';
}

async function takenBy(name: string): Promise<string> {
  const [row] = await db
    .select({
      name: leadSources.name,
      isActive: leadSources.isActive,
      recordStatus: leadSources.recordStatus,
    })
    .from(leadSources)
    .where(sql`lower(${leadSources.name}) = lower(${name})`);

  if (!row) return `${name} is already taken.`;
  if (row.recordStatus === 'void') {
    return `${row.name} is held by a voided row. Voiding does not free a name, because the unique index is on the column and not on the live rows, so a corrected lead source needs a name of its own.`;
  }
  if (!row.isActive) {
    return `${row.name} is already on the list as a retired lead source. Bring that one back rather than adding a second row — every customer already filed under it is on the row that exists.`;
  }
  return `${row.name} is already on the list. Edit that one, or choose another name.`;
}

/* -------------------------------------------------------------------------
   One lead source at a time
   ------------------------------------------------------------------------- */

export async function createLeadSource(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = leadSourceFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, LEAD_SOURCE_LABELS);
  const input = parsed.data;

  try {
    await db
      .insert(leadSources)
      .values({ ...toLeadSourceColumns(input), createdBy: allowed.actor.id });
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(input.name));
    return refused(failureText(error));
  }

  revalidatePath('/settings/lead-sources');
  revalidatePath('/customers');
  return saved(`${input.name} added.`);
}

const withId = leadSourceFields.extend({ id: z.uuid('is not a lead source') });

export async function updateLeadSource(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = withId.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, LEAD_SOURCE_LABELS);
  const { id, ...rest } = parsed.data;

  let name: string | undefined;
  try {
    const rows = await db
      .update(leadSources)
      .set(toLeadSourceColumns(rest))
      .where(eq(leadSources.id, id))
      .returning({ name: leadSources.name });
    name = rows[0]?.name;
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(rest.name));
    return refused(failureText(error));
  }

  if (!name) return refused('That lead source no longer exists.');

  revalidatePath('/settings/lead-sources');
  revalidatePath('/customers');
  return saved(`${name} saved.`);
}

const activeFields = z.object({ id: z.uuid(), isActive: z.stringbool() });

export async function setLeadSourceActive(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = activeFields.safeParse(formValues(formData));
  if (!parsed.success) return refused('That request did not make sense.');

  const rows = await db
    .update(leadSources)
    .set({ isActive: parsed.data.isActive })
    .where(eq(leadSources.id, parsed.data.id))
    .returning({ name: leadSources.name });

  const row = rows[0];
  if (!row) return refused('That lead source no longer exists.');

  const [stillOn] = await db
    .select({ n: count() })
    .from(customers)
    .where(eq(customers.leadSourceId, parsed.data.id));

  revalidatePath('/settings/lead-sources');
  revalidatePath('/customers');
  return saved(
    parsed.data.isActive
      ? `${row.name} is back on the list.`
      : `${row.name} is retired.${
          (stillOn?.n ?? 0) > 0
            ? ` ${stillOn?.n} ${stillOn?.n === 1 ? 'customer' : 'customers'} still ${stillOn?.n === 1 ? 'shows' : 'show'} it.`
            : ''
        }`,
  );
}

const voidFields = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

export async function voidLeadSource(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = voidFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, LEAD_SOURCE_LABELS, 'That void needs a reason.');

  let name: string | undefined;
  try {
    name = await db.transaction(async (tx) => {
      const [inUse] = await tx
        .select({ n: count() })
        .from(customers)
        .where(eq(customers.leadSourceId, parsed.data.id));

      if ((inUse?.n ?? 0) > 0) {
        throw new InUseError(
          `${inUse?.n} ${inUse?.n === 1 ? 'customer carries' : 'customers carry'} this lead source, so it is not a row that should never have existed. Retire it instead: that stops it being offered when a new customer is added, and everyone already on it goes on showing it.`,
        );
      }

      const rows = await tx
        .update(leadSources)
        .set({
          recordStatus: 'void',
          voidedAt: new Date(),
          voidedBy: allowed.actor.id,
          voidReason: parsed.data.reason,
        })
        .where(eq(leadSources.id, parsed.data.id))
        .returning({ name: leadSources.name });

      return rows[0]?.name;
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (!name) return refused('That lead source no longer exists.');

  revalidatePath('/settings/lead-sources');
  revalidatePath('/customers');
  return saved(`${name} is void. Its name stays taken.`);
}
