'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult, FormAction } from '@/app/settings/result';
import type { Option } from '@/components/settings/Fields';

/**
 * A select and a button, inside a table row.
 *
 * Deliberately NOT submit-on-change. A role is a permission; changing one on
 * the way past with a scroll wheel over a focused select is exactly the
 * accident the confirm-by-button shape prevents.
 */
export function InlineSelectForm({
  action,
  name,
  label,
  options,
  defaultValue,
  hidden,
  submitLabel,
  disabled,
  disabledTitle,
}: {
  action: FormAction;
  name: string;
  /** Announced to a screen reader: the column header is not enough on a card. */
  label: string;
  options: Option[];
  defaultValue: string;
  hidden: Record<string, string>;
  submitLabel: string;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null);

  return (
    <form action={formAction} className="flex min-w-0 flex-col gap-1">
      {Object.entries(hidden).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <span className="flex items-center gap-2">
        <select
          name={name}
          aria-label={label}
          defaultValue={defaultValue}
          disabled={disabled}
          title={disabled ? disabledTitle : undefined}
          className={`field ${disabled ? 'opacity-60' : ''}`}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Apply label={submitLabel} disabled={disabled} />
      </span>
      {state ? (
        <span
          role={state.ok ? 'status' : 'alert'}
          className={`t-small ${state.ok ? 'text-positive' : 'text-negative'}`}
        >
          {state.ok ? state.message : state.error}
        </span>
      ) : null}
    </form>
  );
}

function Apply({ label, disabled }: { label: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="min-h-11 shrink-0 rounded-[4px] border border-line-strong px-3 t-small disabled:opacity-50"
    >
      {pending ? '…' : label}
    </button>
  );
}
