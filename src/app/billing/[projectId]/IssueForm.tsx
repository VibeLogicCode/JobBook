'use client';

import { useActionState } from 'react';
import { issueCustomerInvoice } from '@/app/billing/[projectId]/actions';
import { CheckField, FormError, TextAreaField } from '@/components/detail/Fields';
import { Button } from '@/components/ui/Button';
import { formatCents } from '@/lib/money/format';

/**
 * The commit half of the screen.
 *
 * It carries the SAME three fields the preview above it was priced from --
 * kind, percent, issue date -- as hidden inputs, so pressing the button asks
 * for exactly what is on screen. It does not carry a single amount: every
 * figure is derived again inside the writing transaction, because the browser
 * has been holding these numbers for as long as the page has been open and a
 * draw is not something to bill from a stale tab.
 *
 * `useActionState` rather than an onClick, so the form still posts on a phone
 * whose JavaScript has not finished loading -- the refusals are sentences the
 * server writes, and they render either way.
 */
export function IssueForm({
  projectId,
  kind,
  percent,
  issueDate,
  amountDueCents,
}: {
  projectId: string;
  kind: 'progress' | 'final';
  /** The raw text the person typed, passed back untouched; the server parses it. */
  percent: string;
  issueDate: string;
  /** For the button's own label only. Never posted, never billed. */
  amountDueCents: number;
}) {
  const [state, formAction, pending] = useActionState(issueCustomerInvoice, null);

  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="percent" value={percent} />
      <input type="hidden" name="issueDate" value={issueDate} />

      <FormError error={state && !state.ok ? state.error : null} />

      <TextAreaField
        label="Note on the invoice"
        name="notes"
        rows={2}
        maxLength={2000}
        hint="Optional. It prints on the document."
      />

      <CheckField
        label="Mark it sent"
        name="markSent"
        value="1"
        hint="Leave off to keep it a draft — paid/part-paid come from payments, not here."
      />

      <div>
        {/* The figure is in the label because this is the irreversible press,
            and a button that says only "Issue" asks the person to remember
            what they read four rows up. Correcting an invoice afterwards means
            voiding it with a reason, which is the record of the mistake. */}
        <Button type="submit" size="lg" pending={pending} pendingLabel="Issuing…">
          Issue this invoice — {formatCents(amountDueCents)} due
        </Button>
      </div>
    </form>
  );
}
