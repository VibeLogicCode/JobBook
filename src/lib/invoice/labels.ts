import type { InvoiceKind } from '@/lib/invoice/types';

/**
 * What each invoice kind is called on screen.
 *
 * Lifted out of `projects/[id]/billing/page.tsx` when the cross-job Invoices
 * list arrived: two screens naming the same five rows is two places for the
 * words to drift, and "Holdback release" on one and "Release" on the other
 * reads as two different documents to the person holding both.
 *
 * Every kind the engine can bill, so a row written by any path still reads.
 */
export const INVOICE_KINDS: Record<InvoiceKind, string> = {
  deposit: 'Deposit',
  progress: 'Progress',
  final: 'Final',
  holdback_release: 'Holdback release',
  change_order: 'Change order',
};

/**
 * Whether an invoice is past its due date.
 *
 * DERIVED, never stored, and that is deliberate: `invoice_status` deliberately
 * has no `overdue` member because a stored one is wrong the moment the clock
 * passes it, with nobody there to notice -- the same rule `expired` follows on
 * a quote.
 *
 * A paid invoice is never overdue however old it is, and an invoice with no
 * due date cannot be: the column is nullable because Ontario's prompt-payment
 * clock is 28 days and other jurisdictions differ, so a deployment with no
 * stated terms has no date to be late against.
 */
export function isOverdue(
  invoice: { status: string; dueDate: string | null },
  today: string,
): boolean {
  if (invoice.status === 'paid') return false;
  return invoice.dueDate !== null && invoice.dueDate < today;
}
