'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import type { FormResult } from '@/components/detail/form-state';
import { guard } from '@/lib/auth/guard';
import { addDays, tenantToday } from '@/lib/quote/dates';
import {
  completeReminder, dismissReminder, rescheduleReminder, snoozeReminder,
} from '@/lib/reminders/repository';

/**
 * What the reminder screen may do to a reminder.
 *
 * Every one of these opens with `guard`, and the refusal lives HERE rather
 * than only in the markup that drew the button. A narrowed screen is a hint: a
 * stale tab left open after a role change and a hand-made POST both arrive at
 * this function, and neither of them looked at the page.
 *
 * `quote:write` is the capability, because these actions change a live record
 * about work in progress. The bookkeeper role reads the books and does not
 * hold it, which is the same line the quote and job actions already draw --
 * and a new capability would mean editing the permission matrix, which this
 * screen has no business doing on its own.
 *
 * NOTE what is deliberately absent: there is no void control here. Dismissing
 * a reminder is a decision about the task ("not doing it"); voiding one says
 * the row should never have existed. Two different events, kept in two
 * columns, and a screen that offered them as one button would collapse them
 * back together the first time somebody was in a hurry.
 */

const withId = z.object({ id: z.string().uuid('that reminder id is not valid') });

const snoozeFields = withId.extend({
  // Days, not a date. The browser's clock is not the tenant's, and the offset
  // is resolved against `tenantToday` below so a phone with a wrong date
  // cannot snooze something into yesterday.
  days: z.coerce.number().int().min(1, 'snooze it by at least a day').max(90, 'that is not a snooze'),
});

const rescheduleFields = withId.extend({
  dueOn: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'that is not a date'),
});

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
 * Both screens that draw a reminder, plus the two detail screens that will.
 *
 * Revalidated together because completing one from Today has to empty the row
 * on `/reminders` as well -- a stale count on the other screen is how the
 * owner concludes the button did nothing and presses it again.
 */
function revalidateReminderScreens(): void {
  revalidatePath('/reminders');
  revalidatePath('/');
}

export async function completeReminderAction(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const parsed = withId.safeParse(fields(formData));
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };

  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    await completeReminder({ id: parsed.data.id, actorId: allowed.actor.id });
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  revalidateReminderScreens();
  return { ok: true };
}

/**
 * Not now.
 *
 * The due date does not move -- `snoozeReminder` is emphatic about that, and
 * it is why the list can honestly report a reminder as overdue the day its
 * snooze runs out. Pushing the deadline instead would let a quote follow-up be
 * deferred all summer and still report a clean week.
 */
export async function snoozeReminderAction(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const parsed = snoozeFields.safeParse(fields(formData));
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };

  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    // The tenant's day, from the database, never `new Date()`: in a UTC
    // container after 7pm Toronto those are different days, and "tomorrow"
    // would land on the day after the one the owner meant.
    const today = await db.transaction((tx) => tenantToday(tx));

    await snoozeReminder({
      id: parsed.data.id,
      actorId: allowed.actor.id,
      until: addDays(today, parsed.data.days),
    });
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  revalidateReminderScreens();
  return { ok: true };
}

/** A different day. Clears any snooze, because the new date is the decision. */
export async function rescheduleReminderAction(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const parsed = rescheduleFields.safeParse(fields(formData));
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };

  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    await rescheduleReminder({
      id: parsed.data.id,
      actorId: allowed.actor.id,
      dueOn: parsed.data.dueOn,
    });
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  revalidateReminderScreens();
  return { ok: true };
}

/**
 * Not doing it.
 *
 * A decision about the task, and a different event from voiding the row. It
 * leaves the reminder readable and leaves the rule free to fire again later,
 * which is correct: a follow-up dismissed in March may be worth chasing in
 * June.
 */
export async function dismissReminderAction(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const parsed = withId.safeParse(fields(formData));
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };

  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    await dismissReminder({ id: parsed.data.id, actorId: allowed.actor.id });
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  revalidateReminderScreens();
  return { ok: true };
}
