'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db/client';
import { customers, projects, projectTypes } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { allocateDocumentNumber } from '@/lib/quote/numbering';
import { createBlankQuote, createQuoteFromTemplate } from '@/lib/quote/repository';
import { parseQtyToMilli } from '@/lib/money/format';
import type { FormResult } from '@/components/detail/form-state';

/**
 * Starting a quote.
 *
 * This is the front door of the whole product, and for a while it did not
 * exist: `createQuoteFromTemplate` was written and tested, and nothing in the
 * interface called it. The only way to reach a quote was to create a job
 * first, which is backwards -- an owner does not have a job until somebody
 * accepts a price.
 *
 * So one form covers the whole beginning: the customer (existing or new), the
 * opportunity (existing or new), and the quote itself. The opportunity is
 * created behind the scenes at stage `lead`, because the row that holds the
 * customer, the site address and the competing quotes has to exist -- but
 * nobody should have to type a job into being before they can quote.
 */

const SENTINEL_NEW = '__new';

const trimmedOptional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'that value is too long')
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value));

/**
 * A count is a whole number of rooms. It is parsed here rather than through the
 * money helpers because `parseQtyToMilli('2')` is 2000n, which is the correct
 * answer to a different question.
 */
const optionalCount = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? '0' : value))
  .refine((value) => /^\d{1,4}$/.test(value), 'that is not a whole number of rooms')
  .transform(Number);

const schema = z
  .object({
    // Either an existing customer's id, or the sentinel meaning "the fields
    // below describe a new one".
    customerChoice: z.string().min(1, 'choose a customer'),
    newCustomerName: trimmedOptional(200),
    newCustomerCompany: trimmedOptional(200),
    newCustomerPhone: trimmedOptional(40),
    newCustomerEmail: trimmedOptional(200),
    newCustomerType: z.enum(['residential', 'commercial']).optional(),

    opportunityChoice: z.string().min(1, 'choose an opportunity'),
    newOpportunityName: trimmedOptional(200),
    newOpportunityTypeId: z.string().uuid().optional(),
    siteAddressLine1: trimmedOptional(200),
    siteCity: trimmedOptional(120),
    siteProvince: trimmedOptional(40),
    sitePostalCode: trimmedOptional(20),

    // Blank is a first-class choice, not a fallback: there are nine project
    // types and templates exist for a couple of them.
    scopeTemplateId: z.string().optional(),
    areaSqft: trimmedOptional(20),
    washroomCount: optionalCount,
    kitchenCount: optionalCount,
    bedroomCount: optionalCount,
  })
  .refine(
    (v) => v.customerChoice !== SENTINEL_NEW || v.newCustomerName !== null,
    'a new customer needs a name',
  )
  .refine(
    (v) => v.customerChoice !== SENTINEL_NEW || v.newCustomerType !== undefined,
    'choose what kind of customer this is',
  )
  .refine(
    (v) => v.opportunityChoice !== SENTINEL_NEW || v.newOpportunityName !== null,
    'a new opportunity needs a name',
  )
  .refine(
    (v) => v.opportunityChoice !== SENTINEL_NEW || v.newOpportunityTypeId !== undefined,
    'choose what kind of work this is',
  )
  // A new customer has no opportunities yet, so the pair is impossible rather
  // than merely unusual, and saying so beats a foreign key error.
  .refine(
    (v) => !(v.customerChoice === SENTINEL_NEW && v.opportunityChoice !== SENTINEL_NEW),
    'a brand new customer has no existing opportunities to attach this to',
  );

function fields(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : 'the quote was not created';
}

export async function startQuote(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const parsed = schema.safeParse(fields(formData));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'that did not make sense' };
  }
  const input = parsed.data;

  let quoteId: string;
  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    let areaSqftMilli = 0n;
    if (input.areaSqft !== null) {
      const measured = parseQtyToMilli(input.areaSqft);
      if (measured === null) return { ok: false, error: 'that floor area is not a number' };
      areaSqftMilli = measured;
    }

    // The customer and the opportunity are created together, so a failure
    // half way leaves neither.
    const projectId = await db.transaction(async (tx) => {
      let customerId = input.customerChoice;

      if (customerId === SENTINEL_NEW) {
        const [created] = await tx
          .insert(customers)
          .values({
            name: input.newCustomerName!,
            companyName: input.newCustomerCompany,
            customerType: input.newCustomerType!,
            phone: input.newCustomerPhone,
            email: input.newCustomerEmail,
            createdBy: allowed.actor.id,
          })
          .returning({ id: customers.id });
        if (!created) throw new Error('the customer was not saved');
        customerId = created.id;
      } else {
        const [existing] = await tx
          .select({ recordStatus: customers.recordStatus })
          .from(customers)
          .where(eq(customers.id, customerId));
        if (!existing) throw new Error('that customer no longer exists');
        if (existing.recordStatus !== 'active') {
          throw new Error('that customer is void, so no new work can be booked to it');
        }
      }

      if (input.opportunityChoice !== SENTINEL_NEW) {
        const [existing] = await tx
          .select({ recordStatus: projects.recordStatus, customerId: projects.customerId })
          .from(projects)
          .where(eq(projects.id, input.opportunityChoice));
        if (!existing) throw new Error('that opportunity no longer exists');
        if (existing.recordStatus !== 'active') {
          throw new Error('that opportunity is void, so nothing can be quoted against it');
        }
        // Belt and braces against a stale form: the list was filtered by
        // customer when it rendered, and the customer may have changed since.
        if (existing.customerId !== customerId) {
          throw new Error('that opportunity belongs to a different customer');
        }
        return input.opportunityChoice;
      }

      // Read inside the transaction rather than trusted from the form: the
      // picker was rendered before this type might have been voided.
      const [projectType] = await tx
        .select({ recordStatus: projectTypes.recordStatus })
        .from(projectTypes)
        .where(eq(projectTypes.id, input.newOpportunityTypeId!));
      if (!projectType) throw new Error('that type of work is not on the list');
      if (projectType.recordStatus === 'void') {
        throw new Error('that type of work is void, so nothing new can be filed under it');
      }

      // Allocated inside the transaction, so an opportunity that fails to save
      // does not burn a number out of the series.
      const projectNumber = await allocateDocumentNumber(tx, 'project');
      const [created] = await tx
        .insert(projects)
        .values({
          customerId,
          projectNumber,
          name: input.newOpportunityName!,
          projectTypeId: input.newOpportunityTypeId!,
          siteAddressLine1: input.siteAddressLine1,
          siteCity: input.siteCity,
          siteProvince: input.siteProvince,
          sitePostalCode: input.sitePostalCode,
          // An opportunity, not a job. It becomes a job when a quote on it is
          // accepted, and not before.
          stage: 'lead',
          createdBy: allowed.actor.id,
        })
        .returning({ id: projects.id });
      if (!created) throw new Error('the opportunity was not saved');
      return created.id;
    });

    // A separate transaction, because the repository functions open their own
    // and calling one inside this transaction would take a second connection
    // rather than nest. The worst case is therefore an opportunity with no
    // quote on it -- visible in the list, harmless, and re-quotable -- which is
    // a better failure than a quote whose customer was rolled out from under
    // it. The message below names it so it is not a mystery.
    try {
      const template = input.scopeTemplateId;
      const created = template
        ? await createQuoteFromTemplate({
            projectId,
            scopeTemplateId: template,
            scope: {
              areaSqftMilli,
              washroomCount: input.washroomCount,
              kitchenCount: input.kitchenCount,
              bedroomCount: input.bedroomCount,
            },
            createdBy: allowed.actor.id,
          })
        : await createBlankQuote({ projectId, createdBy: allowed.actor.id });
      quoteId = created.quoteId;
    } catch (error) {
      return {
        ok: false,
        error:
          `The opportunity was saved but the quote was not: ${failureText(error)}. ` +
          'The opportunity is in the list, so try quoting against it rather than starting again.',
      };
    }
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  revalidatePath('/quotes');
  revalidatePath('/projects');
  // Outside the try, because redirect signals by throwing.
  redirect(`/quotes/${quoteId}`);
}
