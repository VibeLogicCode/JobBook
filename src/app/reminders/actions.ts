'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { timelineEntityTypeEnum } from '@/db/enums';
import type { FormResult } from '@/components/detail/form-state';
import {
  DUE_VALUES, ON_A_DATE, REMINDER_KIND_CHOICES, dueOffsetDays,
} from '@/components/reminders/new-reminder';
import { guard } from '@/lib/auth/guard';
import { addDays, tenantToday } from '@/lib/quote/dates';
import {
  completeReminder, createReminder, describeEntities, dismissReminder, entityKey,
  rescheduleReminder, snoozeReminder,
} from '@/lib/reminders/repository';
import type { EntityType, ReminderKind } from '@/lib/reminders/types';

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

/**
 * The record types a reminder may hang off, read from the enum the column is
 * declared with rather than restated here.
 *
 * `entity_type`/`entity_id` is a polymorphic reference and the database cannot
 * enforce it, so this is the only place the pair is checked at all -- and a
 * list retyped in an action is a list that goes stale the day a fourth type
 * lands. The cast is the tuple shape `z.enum` wants; the values are the
 * enum's.
 */
const ENTITY_TYPES = timelineEntityTypeEnum.enumValues as readonly [EntityType, ...EntityType[]];

/**
 * And the kinds a PERSON may pick, which is a shorter list than the enum on
 * purpose -- see `REMINDER_KIND_CHOICES`. Validated against the same constant
 * the dropdown renders from, so the form and the action cannot disagree.
 */
const KINDS = REMINDER_KIND_CHOICES as readonly [ReminderKind, ...ReminderKind[]];

const DUE = DUE_VALUES as readonly [string, ...string[]];

const createFields = z
  .object({
    entityType: z.enum(ENTITY_TYPES, 'that record type is not valid'),
    entityId: z.string().uuid('that record id is not valid'),
    title: z
      .string()
      .trim()
      .min(1, 'say what the reminder is for')
      .max(300, 'that title is too long'),
    /**
     * Days, not a date, for the reason `snoozeFields` gives above: the offset
     * is resolved against `tenantToday` below, so a device whose clock is a
     * day out cannot file a reminder on a day nobody meant.
     */
    when: z.enum(DUE, 'say when this is due'),
    dueOn: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value === undefined || value === '' ? undefined : value))
      .refine(
        (value) => value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value),
        'that is not a date',
      ),
    kind: z.enum(KINDS, 'say what kind of reminder this is'),
    detail: z
      .string()
      .trim()
      .max(20_000, 'that is longer than this field will hold')
      .optional()
      .transform((value) => (value === undefined || value === '' ? null : value)),
  })
  // The date field only means anything on the one choice that asks for it, and
  // a form posted with 'On a date' and nothing in the box would otherwise fall
  // through to today -- a reminder due on a day the owner did not pick.
  .refine(
    (value) => value.when !== ON_A_DATE || value.dueOn !== undefined,
    'pick the day it is due',
  );

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

/**
 * A reminder somebody wrote by hand, against the record he was looking at.
 *
 * The four actions above are what the screen does to a reminder a RULE
 * produced. This is the one that puts a reminder there in the first place, and
 * without it the whole screen is a list of things the machine thought of --
 * which is not the list the owner keeps in his head. "Call Dave back Thursday"
 * has no rule and never will.
 *
 * `generated_by_rule_id` stays NULL, which `createReminder` guarantees and
 * this action deliberately offers no way to set. That is what keeps the row
 * outside `reminders_one_open_per_rule` -- PostgreSQL treats nulls as distinct
 * -- so the same reminder may be written twice, and the hourly evaluation
 * never mistakes one of these for its own work.
 */
export async function createReminderAction(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const parsed = createFields.safeParse(fields(formData));
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };

  const { entityType, entityId, title, when, dueOn, kind, detail } = parsed.data;

  let href: string;
  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    // WHICH DAY, decided here rather than in the browser. `tenantToday` reads
    // the organization's zone out of PostgreSQL; `new Date()` in a UTC
    // container after 7pm Toronto is already tomorrow, and "today" would file
    // the reminder a day late every evening.
    const today = await db.transaction((tx) => tenantToday(tx));
    const offset = dueOffsetDays(when);
    const due = offset === null ? dueOn! : addDays(today, offset);

    // The pair is polymorphic, so nothing in the schema refuses a reminder
    // pointing at a row that is not there. A stale tab and a hand-made POST
    // both arrive here, and a reminder against a deleted-in-spirit record
    // would sit on the screen for ever with nothing to open.
    const found = await describeEntities([{ entityType, entityId }]);
    const entity = found.get(entityKey(entityType, entityId));
    if (!entity) return { ok: false, error: 'that record could not be found' };
    href = entity.href;

    await createReminder({
      entityType,
      entityId,
      title,
      dueOn: due,
      kind,
      detail,
      actorId: allowed.actor.id,
    });
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  // The record it was written against, as well as the two reminder screens:
  // the panel on that page counts open reminders, and a count that has not
  // moved is how the owner concludes the button did nothing.
  revalidatePath(href);
  revalidateReminderScreens();
  return { ok: true };
}
