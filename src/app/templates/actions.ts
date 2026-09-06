'use server';

import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db/client';
import { rateItems, scheduleTemplates, scopeTemplateItems, scopeTemplates } from '@/db/schema';
import { requireCapability } from '@/app/settings/actor';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import {
  checkbox,
  formValues,
  invalid,
  optionalText,
  requiredInt,
  requiredText,
} from '@/app/settings/validate';
import {
  fixedQtyField,
  multiplierField,
  projectTypeField,
  qtySourceField,
  timesPhrase,
} from '@/app/templates/schema';

/**
 * Scope templates: the standardisation the product exists for.
 *
 * The owner picks a template, enters the measurements, and a consistent line
 * set generates -- then he adjusts it. Without templates every quote is typed
 * from memory, which is where a forgotten trade turns into a loss.
 *
 * Editing a template never touches a quote already built from it. Quote lines
 * snapshot their rates, their description and their cost code at creation, so
 * a template is a starting point and not a live reference.
 */

const templateLabels = {
  name: 'Name',
  projectType: 'Project type',
  description: 'Description',
};

const createSchema = z.object({
  name: requiredText(200),
  projectType: projectTypeField,
  description: optionalText(1000),
});

export async function createTemplate(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('scopeTemplates.edit');
  if (!guard.ok) return guard.result;

  const parsed = createSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, templateLabels);

  const [created] = await db
    .insert(scopeTemplates)
    .values({ ...parsed.data, createdBy: guard.actor.id })
    .returning({ id: scopeTemplates.id });
  if (!created) return refused('The template was not saved.');

  revalidatePath('/templates');
  // Straight to the record rather than a "created" notice on the list: the
  // next thing anybody does with a fresh template is add lines to it, and the
  // list behind the create sheet never had a row for one to click.
  redirect(`/templates/${created.id}`);
}

/**
 * The schedule-template half of the same create sheet (design spec §4: "Add
 * asks the kind first"). Same three fields as `createTemplate` -- the two
 * tables are identical up to `is_active` on purpose
 * (`src/db/schema/schedule-templates.ts`'s own docblock) -- but a different
 * table, a different guard resource, and a different landing page.
 *
 * Reuses the `scopeTemplates.edit` capability rather than inventing a
 * `scheduleTemplates.edit` one: the design spec (§8) calls that rename correct
 * eventually, but also records that today it maps to the same `rates:edit`
 * check with identical role coverage, so a new capability name would decide
 * nothing yet. Renaming is left for whoever does that split.
 */
export async function createScheduleTemplate(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('scopeTemplates.edit');
  if (!guard.ok) return guard.result;

  const parsed = createSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, templateLabels);

  const [created] = await db
    .insert(scheduleTemplates)
    .values({ ...parsed.data, createdBy: guard.actor.id })
    .returning({ id: scheduleTemplates.id });
  if (!created) return refused('The template was not saved.');

  revalidatePath('/templates');
  redirect(`/templates/schedule/${created.id}`);
}

const updateSchema = createSchema.extend({ id: z.string().uuid() });

export async function updateTemplate(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('scopeTemplates.edit');
  if (!guard.ok) return guard.result;

  const parsed = updateSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, templateLabels);
  const { id, ...patch } = parsed.data;

  const rows = await db
    .update(scopeTemplates)
    .set(patch)
    .where(eq(scopeTemplates.id, id))
    .returning({ id: scopeTemplates.id });

  if (rows.length === 0) return refused('That template no longer exists.');

  revalidatePath('/templates');
  revalidatePath(`/templates/${id}`);
  return saved(`${patch.name} saved.`);
}

const activeSchema = z.object({
  id: z.string().uuid(),
  isActive: z.stringbool(),
});

/**
 * Retires a template, or brings it back. Nothing is deleted: a quote records
 * which template it came from, and that reference has to keep resolving.
 */
export async function setTemplateActive(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('scopeTemplates.edit');
  if (!guard.ok) return guard.result;

  const parsed = activeSchema.safeParse(formValues(formData));
  if (!parsed.success) return refused('That request did not make sense.');

  const rows = await db
    .update(scopeTemplates)
    .set({ isActive: parsed.data.isActive })
    .where(eq(scopeTemplates.id, parsed.data.id))
    .returning({ name: scopeTemplates.name });

  if (rows.length === 0) return refused('That template no longer exists.');

  revalidatePath('/templates');
  revalidatePath(`/templates/${parsed.data.id}`);
  return saved(
    parsed.data.isActive ? `${rows[0]!.name} is available again.` : `${rows[0]!.name} retired.`,
  );
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

const lineLabels = {
  rateItemId: 'Rate item',
  qtySource: 'Quantity from',
  qtyMultiplier: 'Multiplier',
  fixedQty: 'Fixed quantity',
  lineGroup: 'Line group',
  sortOrder: 'Order',
  isOptional: 'Optional',
  isAllowance: 'Allowance',
};

const lineFields = {
  rateItemId: z.string().uuid(),
  qtySource: qtySourceField,
  qtyMultiplier: multiplierField,
  fixedQty: fixedQtyField,
  lineGroup: requiredText(100),
  sortOrder: requiredInt(0, 9999),
  isOptional: checkbox,
  isAllowance: checkbox,
};

/**
 * A `fixed` source with no quantity derives zero, and a zero-quantity line is
 * dropped during expansion -- so the line would simply never appear, with
 * nothing on screen to say why.
 */
const fixedQtyPresent = (value: {
  qtySource: string;
  fixedQty: bigint | null;
}): boolean => value.qtySource !== 'fixed' || value.fixedQty !== null;

const addLineSchema = z
  .object({ scopeTemplateId: z.string().uuid(), ...lineFields })
  .refine(fixedQtyPresent, {
    path: ['fixedQty'],
    message: 'is required when the quantity comes from a fixed value',
  });

export async function addTemplateLine(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('scopeTemplates.edit');
  if (!guard.ok) return guard.result;

  const parsed = addLineSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, lineLabels);
  const { scopeTemplateId, qtyMultiplier, fixedQty, rateItemId, ...rest } = parsed.data;
  if (qtyMultiplier === null) return refused('A multiplier is required.');

  const [item] = await db.select().from(rateItems).where(eq(rateItems.id, rateItemId));
  if (!item) return refused('That rate item no longer exists.');

  await db.insert(scopeTemplateItems).values({
    ...rest,
    scopeTemplateId,
    rateItemId,
    qtyMultiplierTenThou: qtyMultiplier,
    fixedQtyMilli: fixedQty,
    createdBy: guard.actor.id,
  });

  // Two lines of the same item in different groups can be legitimate -- a
  // second flooring line for a different room, priced separately -- so this
  // never refuses the add. It only says so, because a quote built from here
  // will bill the item that many times and nobody asked for that on purpose.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scopeTemplateItems)
    .where(
      and(
        eq(scopeTemplateItems.scopeTemplateId, scopeTemplateId),
        eq(scopeTemplateItems.rateItemId, rateItemId),
        eq(scopeTemplateItems.recordStatus, 'active'),
      ),
    );

  revalidatePath(`/templates/${scopeTemplateId}`);
  return saved(
    count > 1
      ? `${item.description} added to the template. It now appears ${timesPhrase(count)} in this template.`
      : `${item.description} added to the template.`,
  );
}

const updateLineSchema = z
  .object({ id: z.string().uuid(), scopeTemplateId: z.string().uuid(), ...lineFields })
  .refine(fixedQtyPresent, {
    path: ['fixedQty'],
    message: 'is required when the quantity comes from a fixed value',
  });

export async function updateTemplateLine(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('scopeTemplates.edit');
  if (!guard.ok) return guard.result;

  const parsed = updateLineSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, lineLabels);
  const { id, scopeTemplateId, qtyMultiplier, fixedQty, ...rest } = parsed.data;
  if (qtyMultiplier === null) return refused('A multiplier is required.');

  const rows = await db
    .update(scopeTemplateItems)
    .set({
      ...rest,
      qtyMultiplierTenThou: qtyMultiplier,
      fixedQtyMilli: fixedQty,
    })
    .where(eq(scopeTemplateItems.id, id))
    .returning({ id: scopeTemplateItems.id });

  if (rows.length === 0) return refused('That template line no longer exists.');

  revalidatePath(`/templates/${scopeTemplateId}`);
  return saved('Template line saved.');
}

const voidLineSchema = z.object({
  id: z.string().uuid(),
  scopeTemplateId: z.string().uuid(),
  reason: optionalText(500),
});

/**
 * Removes a line by voiding it.
 *
 * There is no DELETE in this application, and the database role is not granted
 * one -- a watermark-based sync physically cannot observe a row that no longer
 * exists, so a hard delete would leave a phantom in the mirror that outlives
 * the record. The reason defaults rather than being demanded: a template line
 * pulled out during setup supplies its own explanation, and forcing a sentence
 * for it is what makes a void model absurd to use.
 */
export async function voidTemplateLine(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('scopeTemplates.edit');
  if (!guard.ok) return guard.result;

  const parsed = voidLineSchema.safeParse(formValues(formData));
  if (!parsed.success) return refused('That removal did not make sense.');

  const rows = await db
    .update(scopeTemplateItems)
    .set({
      recordStatus: 'void',
      voidedAt: new Date(),
      voidedBy: guard.actor.id,
      voidReason: parsed.data.reason ?? 'Removed from the template',
    })
    .where(eq(scopeTemplateItems.id, parsed.data.id))
    .returning({ id: scopeTemplateItems.id });

  if (rows.length === 0) return refused('That template line no longer exists.');

  revalidatePath(`/templates/${parsed.data.scopeTemplateId}`);
  return saved('Line removed.');
}
