'use server';

import { and, asc, eq, notInArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db/client';
import { customers, projects } from '@/db/schema';
import type { FormResult } from '@/components/detail/form-state';
import { FINISHED_STAGES } from '@/components/detail/labels';

/**
 * An untouched text input posts an empty string; a column wants null.
 *
 * Storing '' would give two representations of "we do not have this phone
 * number", and only one of them answers `is null`. Every optional text field
 * therefore collapses to null on the way in. A field absent from the FormData
 * altogether -- which is what a disabled input is -- collapses the same way, so
 * unticking the exemption box clears its number and reason rather than leaving
 * them behind on a record that is no longer exempt.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'that value is too long')
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value));

const customerFields = z
  .object({
    name: z.string().trim().min(1, 'a customer needs a name').max(200, 'that name is too long'),
    companyName: optionalText(200),
    email: optionalText(200),
    phone: optionalText(40),
    addressLine1: optionalText(200),
    addressLine2: optionalText(200),
    city: optionalText(120),
    // No default and no province list. A default here would hardcode a
    // tenant's region; a list would hardcode a country's.
    province: optionalText(40),
    postalCode: optionalText(20),
    altContactName: optionalText(200),
    altContactEmail: optionalText(200),
    altContactPhone: optionalText(40),
    customerType: z.enum(['residential', 'commercial'], 'choose residential or commercial'),
    leadSource: z
      .enum(['call', 'email', 'referral', 'website', 'repeat', 'other'])
      .optional()
      .or(z.literal(''))
      .transform((value) => (value === '' || value === undefined ? null : value)),
    // An unticked checkbox is absent from the FormData entirely, which is the
    // only reason this is a presence test rather than a boolean parse.
    isTaxExempt: z
      .string()
      .optional()
      .transform((value) => value === 'on'),
    taxExemptNumber: optionalText(80),
    taxExemptReason: optionalText(300),
  })
  // The number and the reason sit beside the flag because an unexplained
  // exemption is an audit gap: somebody has to be able to answer why no tax was
  // charged, years later, without the person who decided it.
  .refine(
    (value) => !value.isTaxExempt || value.taxExemptReason !== null,
    'an exemption needs a reason recorded',
  );

const withId = z.object({ id: z.string().uuid('that customer id is not valid') });

const voidFields = withId.extend({
  reason: z
    .string()
    .trim()
    .min(1, 'voiding a customer needs a reason')
    .max(500, 'that reason is too long'),
});

/** FormData carries File entries too; only the text ones are fields. */
function fields(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function firstProblem(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'that did not make sense';
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : 'that change failed';
}

/**
 * Jobs that are still live for this customer.
 *
 * Voiding the customer is refused while any of these stands: the quotes and
 * the job would go on referring to a customer record marked closed, and the
 * person voiding is usually not the person who knows the job is still running.
 * A complete or lost job does not block it -- that one is history.
 */
async function liveProjects(customerId: string) {
  return db
    .select({ id: projects.id, name: projects.name, projectNumber: projects.projectNumber })
    .from(projects)
    .where(
      and(
        eq(projects.customerId, customerId),
        eq(projects.recordStatus, 'active'),
        notInArray(projects.stage, FINISHED_STAGES),
      ),
    )
    .orderBy(asc(projects.projectNumber));
}

export async function createCustomer(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const parsed = customerFields.safeParse(fields(formData));
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };

  let id: string;
  try {
    const [row] = await db
      .insert(customers)
      .values(parsed.data)
      .returning({ id: customers.id });
    if (!row) return { ok: false, error: 'the customer was not saved' };
    id = row.id;
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  revalidatePath('/customers');
  // Outside the try: redirect signals by throwing, so catching it here would
  // turn a successful save into "that change failed".
  redirect(`/customers/${id}`);
}

export async function updateCustomer(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const raw = fields(formData);
  const id = withId.safeParse(raw);
  if (!id.success) return { ok: false, error: firstProblem(id.error) };

  const parsed = customerFields.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };

  try {
    const [existing] = await db.select().from(customers).where(eq(customers.id, id.data.id));
    if (!existing) return { ok: false, error: 'that customer no longer exists' };
    // A void record is a closed record. Editing one would quietly rewrite
    // history that a quote or a filed return already refers to.
    if (existing.recordStatus !== 'active') {
      return { ok: false, error: 'this customer is void and cannot be edited' };
    }

    await db.update(customers).set(parsed.data).where(eq(customers.id, id.data.id));
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  revalidatePath('/customers');
  revalidatePath(`/customers/${id.data.id}`);
  redirect(`/customers/${id.data.id}`);
}

/**
 * Closes a customer out. Never a delete: the application role holds no DELETE
 * privilege at all, and these records are referenced by tax documents.
 */
export async function voidCustomer(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const parsed = voidFields.safeParse(fields(formData));
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };
  const { id, reason } = parsed.data;

  try {
    const [existing] = await db.select().from(customers).where(eq(customers.id, id));
    if (!existing) return { ok: false, error: 'that customer no longer exists' };
    if (existing.recordStatus !== 'active') {
      return { ok: false, error: 'this customer is already void' };
    }

    // Re-checked here even though the screen already showed the blockers: the
    // page was rendered at some earlier moment, and this is the check that
    // actually decides.
    const live = await liveProjects(id);
    if (live.length > 0) {
      const named = live.map((row) => `${row.projectNumber} ${row.name}`).join(', ');
      return {
        ok: false,
        error: `this customer still has live work: ${named}. Move those jobs to complete or lost first.`,
      };
    }

    await db
      .update(customers)
      .set({ recordStatus: 'void', voidedAt: new Date(), voidReason: reason })
      .where(eq(customers.id, id));
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  revalidatePath('/customers');
  revalidatePath(`/customers/${id}`);
  return { ok: true };
}
