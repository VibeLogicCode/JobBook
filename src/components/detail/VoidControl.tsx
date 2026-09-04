'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { FormError, TextAreaField } from '@/components/detail/Fields';
import type { FormAction } from '@/components/detail/form-state';

/**
 * Closing a record out.
 *
 * There is no delete here and there is none anywhere else either: the
 * application role holds no DELETE privilege, so an accidental delete is a
 * permission error rather than a destroyed tax record. Voiding is what
 * replaces it, and it always takes a reason -- a voided record with no
 * explanation is the same audit gap as a missing one, except it looks fine.
 */
export function VoidControl({
  action,
  recordId,
  description,
  submitLabel,
  blockers,
  blockerLead,
}: {
  action: FormAction;
  recordId: string;
  description: string;
  submitLabel: string;
  /** Records that must be dealt with first. Named, because "cannot void this"
   *  without saying what is in the way is a dead end. */
  blockers: { href: string; label: string }[];
  blockerLead: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const blocked = blockers.length > 0;

  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="id" value={recordId} />

      <p className="t-small text-muted">{description}</p>

      {blocked ? (
        <div className="rounded-[4px] border border-warning bg-warning-soft px-3 py-2 t-small text-warning-soft-fg">
          <p>{blockerLead}</p>
          <ul className="mt-1 grid gap-1">
            {blockers.map((blocker) => (
              <li key={blocker.href}>
                <Link href={blocker.href} className="underline">
                  {blocker.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <FormError error={state && !state.ok ? state.error : null} />

      <TextAreaField
        label="Reason"
        name="reason"
        required
        rows={2}
        maxLength={500}
        disabled={blocked}
        hint="Kept on the record permanently."
      />

      <div>
        <button
          type="submit"
          disabled={pending || blocked}
          className="min-h-11 rounded-[4px] border border-negative bg-negative-soft px-4 text-negative-soft-fg hover:border-negative-soft-fg disabled:opacity-60"
        >
          {pending ? 'Voiding…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
