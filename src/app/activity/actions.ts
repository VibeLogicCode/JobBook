'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { FormResult } from '@/components/detail/form-state';
import { ACTIVITY_KIND_ORDER, type ActivityKindName } from '@/components/reminders/labels';
import { guard } from '@/lib/auth/guard';
import { logActivity } from '@/lib/reminders/repository';

/**
 * Writing down what happened.
 *
 * This is also the log-an-email action the Phase 2 plan ships INSTEAD of
 * sending mail. Nothing here has an SMTP host, a Graph token or a credential
 * of any kind: an `email_out` row with the body pasted into it is a record of
 * a conversation, which is what the follow-up rules and the timeline actually
 * need. Sending is deferred with a trigger -- evidence that the owner opens
 * the reminder screen at all -- and the reasoning is in the plan rather than
 * re-argued here.
 */

// The tuple shape `z.enum` wants, from the one list of kinds the screens
// already order. A second literal list here would be the member somebody adds
// to the form and forgets to accept in the action.
const KIND_NAMES = ACTIVITY_KIND_ORDER as readonly [ActivityKindName, ...ActivityKindName[]];

const logFields = z.object({
  entityType: z.enum(['customer', 'project', 'quote'], 'that record type is not valid'),
  entityId: z.string().uuid('that record id is not valid'),
  kind: z.enum(KIND_NAMES, 'say what kind of contact this was'),
  /**
   * WHEN IT HAPPENED, and not when it was typed. An owner logs Tuesday's call
   * on Thursday: the timeline orders by this, the audit trail keeps
   * `created_at`, and conflating the two makes the timeline a record of his
   * typing rather than of the job.
   *
   * Left as a plain ISO date all the way to the repository, which turns it
   * into the tenant's midnight in PostgreSQL. Parsing it into a `Date` here
   * would make it midnight UTC and file Tuesday's call under Monday evening.
   */
  occurredOn: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value))
    .refine(
      (value) => value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value),
      'that is not a date',
    ),
  subject: z
    .string()
    .trim()
    .max(300, 'that subject is too long')
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),
  body: z
    .string()
    .trim()
    .max(20_000, 'that is longer than this field will hold')
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),
  durationMinutes: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : Number(value)))
    .refine(
      (value) => value === null || (Number.isInteger(value) && value >= 0 && value <= 24 * 60),
      'a length in whole minutes, and not a negative one',
    ),
})
  // An activity with neither a subject nor a body is a row that says a call
  // happened and nothing about it. It still counts against the no-contact
  // rule, which is exactly the accident worth refusing: silence logged as
  // contact is worse than silence.
  .refine(
    (value) => value.subject !== null || value.body !== null,
    'write at least a line about what happened',
  );

function fields(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export async function logActivityAction(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const parsed = logFields.safeParse(fields(formData));
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'that did not make sense' };
  }

  const { entityType, entityId, kind, occurredOn, subject, body, durationMinutes } = parsed.data;

  try {
    // The same guard the quote and job actions open with, for the same reason:
    // authorization is a per-request lookup against the user table, never
    // something the browser told us.
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    await logActivity({
      entityType,
      entityId,
      kind,
      actorId: allowed.actor.id,
      occurredOn,
      subject,
      body,
      durationMinutes,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'that did not save' };
  }

  // The timeline, and the reminder screens: logging a call is what makes the
  // no-contact rule stop chasing this customer, so the counts move with it.
  revalidatePath(`/${entityType === 'customer' ? 'customers' : entityType === 'project' ? 'projects' : 'quotes'}/${entityId}`);
  revalidatePath('/reminders');
  revalidatePath('/');
  return { ok: true };
}
