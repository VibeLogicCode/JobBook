'use server';

import { count, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { vendorTypes, vendors } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  VENDOR_TYPE_LABELS,
  isDuplicateName,
  newVendorTypeFields,
  toVendorTypeColumns,
  vendorTypeFields,
} from '@/app/settings/vendor-lists';

/**
 * The vendor type list's write side.
 *
 * The three rules that run through `app/settings/cost-codes/actions.ts` run
 * through this file, for the same reasons.
 *
 * 1. **Authorization is a separate lookup, per request.** `guard(...)` reads
 *    the role out of `users` every time; nothing is taken from a form field or
 *    a claim. The refusal lives here rather than only in the screen, because a
 *    disabled button is a hint and a stale tab is not obliged to read it.
 * 2. **Nothing is deleted, and retiring is not voiding.** `is_active = false`
 *    says "do not offer this on new vendors". `record_status = 'void'` says
 *    "this row should never have existed". They are separate controls with
 *    separate wording, and either way every vendor filed under the row goes on
 *    resolving it: `vendors.vendor_type_id` is a foreign key to a row that
 *    never leaves. The database role holds no DELETE privilege at all.
 * 3. **A void is refused for a row that is doing work**, counted inside the
 *    writing transaction, because the screen was rendered before the vendor
 *    that now sits on this type was added.
 *
 * What is different here, and is the point of the whole screen: there is no
 * path that writes `is_subcontractor`. `createVendorType` sets it once from
 * the form; `updateVendorType` parses a shape that does not contain it and
 * writes a column map that cannot express it. That is not timidity. Three
 * things and nothing else turn on `vendors.is_subcontractor` -- who receives a
 * T5018 slip, who needs current WSIB clearance before a cheque is written, and
 * who may be assigned to a scheduled task -- and a flag that could be flipped
 * on a type would restate all three for every vendor under it, silently, with
 * nothing on any screen saying a vendor had changed. A type whose flag is
 * wrong is retired and replaced, exactly as a cost code that now means a
 * different trade is.
 *
 * `rates:edit` is the capability for adding, editing and retiring, and
 * `record:void` gates voiding. Both follow the cost code list and the vendor
 * directory: this is a reference list the vendor form is built against, and an
 * `admin` who can add a vendor but not the type he needs for it is refused
 * halfway through hiring somebody.
 */

const REFUSAL = 'Your role does not permit changing the vendor type list.';

/** A void refused because the row is doing work, carried out as a sentence. */
class InUseError extends Error {}

function failureText(error: unknown): string {
  if (error instanceof InUseError) return error.message;
  // Deliberately NOT `error.message`. Drizzle wraps a driver error in a
  // DrizzleQueryError whose message is the failed SQL and its bound
  // parameters. Putting that on the screen tells the owner nothing he can act
  // on and shows him the schema; the server log still has the whole thing.
  return 'That change could not be saved. Nothing was written.';
}

/**
 * Why a name is already taken, said in full.
 *
 * The unique index is on `lower(name)` and not on the live rows, so the row
 * holding the name may be retired, or void, and therefore not on the part of
 * the screen the person was looking at. Telling him only "that name is taken"
 * sends him hunting a row he cannot see.
 */
async function takenBy(name: string): Promise<string> {
  const [row] = await db
    .select({
      name: vendorTypes.name,
      isActive: vendorTypes.isActive,
      recordStatus: vendorTypes.recordStatus,
      isSubcontractor: vendorTypes.isSubcontractor,
    })
    .from(vendorTypes)
    .where(sql`lower(${vendorTypes.name}) = lower(${name})`);

  if (!row) return `${name} is already taken.`;
  const counts = row.isSubcontractor
    ? 'counts its vendors as subcontractors'
    : 'does not count its vendors as subcontractors';

  if (row.recordStatus === 'void') {
    // Not "edit that one": a void row is kept as a record and is not edited.
    return `${row.name} is held by a voided row. Voiding does not free a name, because the unique index is on the column and not on the live rows, so a corrected type needs a name of its own.`;
  }
  if (!row.isActive) {
    return `${row.name} is already on the list as a retired type, and it ${counts}. Bring that one back if it is the same kind of counterparty; add a differently named type if it is not.`;
  }
  return `${row.name} is already on the list, and it ${counts}. Edit that one, or choose another name.`;
}

/* -------------------------------------------------------------------------
   One type at a time
   ------------------------------------------------------------------------- */

/**
 * Adds a type, and this is the ONLY place `is_subcontractor` is ever decided.
 *
 * Once, at creation, and never again -- which is what makes the list
 * maintainable without making the tax rule editable.
 */
export async function createVendorType(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = newVendorTypeFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, VENDOR_TYPE_LABELS);
  const input = parsed.data;

  try {
    await db.insert(vendorTypes).values({
      name: input.name,
      sortOrder: input.sortOrder,
      isSubcontractor: input.isSubcontractor,
      createdBy: allowed.actor.id,
    });
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(input.name));
    return refused(failureText(error));
  }

  revalidatePath('/settings/vendor-types');
  revalidatePath('/vendors');
  return saved(
    input.isSubcontractor
      ? `${input.name} added, and vendors on it count as subcontractors: each is asked for a trade, receives a T5018 slip, needs current WSIB clearance before payment, and appears where work is assigned. That cannot be changed later — a type set wrongly is retired and replaced.`
      : `${input.name} added. Vendors on it are not subcontractors, so none is asked for a trade, filed on a T5018 or asked for a WSIB clearance. That cannot be changed later — a type set wrongly is retired and replaced.`,
  );
}

const withId = vendorTypeFields.extend({ id: z.uuid('is not a vendor type') });

/**
 * Edits a type in place -- its NAME and its order, and nothing else.
 *
 * In place, and not a supersede-with-dates the way a tax rate works. A tax
 * rate has to answer "what was the rate on this date" years later. A type is a
 * label on a bucket: renaming "Material supplier" to "Suppliers" is the same
 * bucket, and every vendor filed under it should read the new name.
 *
 * What a rename explicitly does NOT do is move anybody on or off a T5018. The
 * shape parsed here has no `isSubcontractor` and the column map cannot express
 * one, so relabelling a type is a wording change and nothing else, whatever
 * the new wording implies.
 */
export async function updateVendorType(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = withId.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, VENDOR_TYPE_LABELS);
  const { id, ...rest } = parsed.data;

  let name: string | undefined;
  try {
    const rows = await db
      .update(vendorTypes)
      // `updated_at` is deliberately absent: a trigger maintains it, and a
      // value written here would be the one the sync cursor trusts.
      .set(toVendorTypeColumns(rest))
      .where(eq(vendorTypes.id, id))
      .returning({ name: vendorTypes.name });
    name = rows[0]?.name;
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(rest.name));
    return refused(failureText(error));
  }

  if (!name) return refused('That vendor type no longer exists.');

  revalidatePath('/settings/vendor-types');
  revalidatePath('/vendors');
  return saved(
    `${name} saved. Every vendor on it reads the new name, and none of them changed standing — whether a type counts as a subcontractor is fixed when it is created.`,
  );
}

const activeFields = z.object({ id: z.uuid(), isActive: z.stringbool() });

/**
 * Retires a type, or brings it back.
 *
 * Not a deletion and not a void. A retired type stays on the list, keeps its
 * name -- which is why re-adding that name is still refused -- and goes on
 * resolving for every vendor filed under it, including the part of it that
 * decides whether those vendors are subcontractors. What changes is that new
 * vendors are no longer offered it.
 */
export async function setVendorTypeActive(
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
    .update(vendorTypes)
    .set({ isActive: parsed.data.isActive })
    .where(eq(vendorTypes.id, parsed.data.id))
    .returning({ name: vendorTypes.name });

  const row = rows[0];
  if (!row) return refused('That vendor type no longer exists.');

  revalidatePath('/settings/vendor-types');
  revalidatePath('/vendors');
  return saved(
    parsed.data.isActive
      ? `${row.name} is back on the list for new vendors.`
      : `${row.name} is retired. It is no longer offered on new vendors, and every vendor already on it keeps it — including whether they count as a subcontractor.`,
  );
}

const voidFields = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/**
 * Marks a type as one that should never have existed.
 *
 * The remedy for a name typed twice, or a type added with the wrong
 * subcontractor answer before any vendor was put on it. It is not a delete and
 * it does not free the name.
 *
 * Refused for a type any vendor sits on, and counted inside the writing
 * transaction rather than read off the screen -- the screen was rendered
 * before the vendor that now uses this type was added. The refusal follows
 * `voidCostCode`: a row that is doing work was not a mistake, and Retire is
 * the control for taking it out of circulation.
 */
export async function voidVendorType(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = voidFields.safeParse(formValues(formData));
  if (!parsed.success) {
    return invalid(parsed.error, VENDOR_TYPE_LABELS, 'That void needs a reason.');
  }

  let name: string | undefined;
  try {
    name = await db.transaction(async (tx) => {
      const [inUse] = await tx
        .select({ n: count() })
        .from(vendors)
        .where(eq(vendors.vendorTypeId, parsed.data.id));

      if ((inUse?.n ?? 0) > 0) {
        throw new InUseError(
          `${inUse?.n} ${inUse?.n === 1 ? 'vendor is' : 'vendors are'} filed under this type, so it is not a row that should never have existed — and voiding it would leave their standing resting on a row the screen calls a mistake. Retire it instead: that stops it being offered on new vendors and leaves everybody already on it exactly as they are.`,
        );
      }

      const rows = await tx
        .update(vendorTypes)
        .set({
          recordStatus: 'void',
          voidedAt: new Date(),
          voidedBy: allowed.actor.id,
          voidReason: parsed.data.reason,
          // `is_active` is deliberately left alone, as `voidCostCode` leaves
          // it alone. The two columns answer two different questions, and a
          // void row has not answered the retirement one; every picker filters
          // on BOTH, which is what keeps them from needing to agree.
        })
        .where(eq(vendorTypes.id, parsed.data.id))
        .returning({ name: vendorTypes.name });

      return rows[0]?.name;
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (!name) return refused('That vendor type no longer exists.');

  revalidatePath('/settings/vendor-types');
  revalidatePath('/vendors');
  return saved(`${name} is void. Its name stays taken, so a corrected type needs a name of its own.`);
}
