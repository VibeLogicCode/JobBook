'use server';

import { and, count, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db/client';
import { projects, quotes } from '@/db/schema';
import type { FormResult } from '@/components/detail/form-state';
import { guard } from '@/lib/auth/guard';
import { resolvePercentTenThou } from '@/lib/invoice/percent';
import { issueInvoice } from '@/lib/invoice/repository';

/**
 * Issuing a customer invoice.
 *
 * The screen shows a preview first, and the preview is priced by the same
 * function this action commits with -- but the preview is a picture and THIS is
 * the gate. Between the two, another draw can be issued, a change order
 * accepted, an accepted quote voided or a rate changed, so nothing here trusts
 * a figure the browser sent: the request carries a percentage and a date, and
 * every amount is derived again inside the writing transaction.
 */

const issueFields = z.object({
  projectId: z.string().uuid('that job id is not valid'),
  /**
   * Deliberately narrower than `InvoiceKind`. Deposits, change orders and
   * holdback releases are real kinds the engine bills, and each needs figures
   * this screen does not collect; accepting them here from a hand-made POST
   * would issue one with the fields it did collect and silently default the
   * rest.
   */
  kind: z.enum(['progress', 'final'], 'choose what you are billing'),
  /** Typed as a percentage, held as ten-thousandths. Parsed, never rounded. */
  percent: z.string().trim().default(''),
  issueDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'that is not a date'),
  notes: z
    .string()
    .trim()
    .max(2000, 'that note is too long')
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value)),
  /** An unchecked checkbox posts nothing at all, so absence is "not sent". */
  markSent: z.string().optional(),
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
  return error instanceof Error ? error.message : 'that invoice was not issued';
}

export async function issueCustomerInvoice(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const parsed = issueFields.safeParse(fields(formData));
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };
  const { projectId, kind, percent, issueDate, notes, markSent } = parsed.data;

  // Refused HERE, not by the dropdown that produced it. A stale tab holding
  // yesterday's page and a hand-made POST both arrive at this line, and the
  // 150% that has to be refused is the one that never went near the form.
  const percentComplete = resolvePercentTenThou(kind, percent);
  if (!percentComplete.ok) return { ok: false, error: percentComplete.error };

  let invoiceNumber: string;
  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    const [project] = await db
      .select({ recordStatus: projects.recordStatus })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) return { ok: false, error: 'that job no longer exists' };
    if (project.recordStatus !== 'active') {
      return { ok: false, error: 'this job is void, so nothing can be billed against it' };
    }

    /**
     * A job is a project with an accepted quote behind it. There is no `jobs`
     * table and no boolean saying so: the accepted, active quotes ARE the
     * contract, and their absence means there is nothing agreed to bill
     * against.
     *
     * Checked in the action as well as in the repository because this is the
     * refusal a person has to be able to read. The repository throws, and a
     * thrown sentence about a project id is not an answer to "why can I not
     * invoice this?"
     */
    const [{ accepted } = { accepted: 0 }] = await db
      .select({ accepted: count(quotes.id) })
      .from(quotes)
      .where(
        and(
          eq(quotes.projectId, projectId),
          eq(quotes.status, 'accepted'),
          eq(quotes.recordStatus, 'active'),
        ),
      );
    if (Number(accepted) === 0) {
      return {
        ok: false,
        error:
          'This is an opportunity, not a job: nothing has been accepted on it, so there is no ' +
          'contract to bill against. Accept a quote first — that is what sets the contract value.',
      };
    }

    const issued = await issueInvoice({
      projectId,
      kind,
      issueDate,
      percentCompleteTenThou: percentComplete.value,
      notes,
      // Never 'partial' or 'paid': those are derived from the payments against
      // an invoice, and a status set by hand is the figure that disagrees.
      status: markSent === undefined ? 'draft' : 'sent',
      createdBy: allowed.actor.id,
    });
    invoiceNumber = issued.invoiceNumber;
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  revalidatePath(`/billing/${projectId}`);
  revalidatePath(`/projects/${projectId}`);
  // Outside the try, because redirect signals by throwing. It also clears the
  // preview: the job has moved on, and leaving the old figures on screen beside
  // a success message invites a second press on a draw that is now zero.
  redirect(`/billing/${projectId}?issued=${encodeURIComponent(invoiceNumber)}`);
}
