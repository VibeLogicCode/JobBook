'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult, FormAction } from '@/app/settings/result';
import { Notice } from '@/components/settings/Notice';

/**
 * A form whose server action returns a result instead of throwing.
 *
 * The client half of this area is deliberately thin: the fields are plain
 * server-rendered HTML, and the only thing that genuinely needs the browser is
 * telling the person whether the save worked and which box was wrong.
 */
export function ActionForm({
  action,
  submitLabel,
  children,
  disabled,
  disabledNote,
  resetOnSuccess,
  destructive,
}: {
  action: FormAction;
  submitLabel: string;
  children: React.ReactNode;
  /** True when the signed-in role may read this screen but not change it. */
  disabled?: boolean;
  disabledNote?: React.ReactNode;
  resetOnSuccess?: boolean;
  destructive?: boolean;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null);
  const formRef = useRef<HTMLFormElement>(null);

  // Marking the offending controls is done here rather than by threading an
  // error prop through every field: the fields are server components, and a
  // per-field error would mean re-rendering the whole tree to move one
  // attribute. The summary above is what a screen reader announces; this is
  // what a sighted user's eye lands on.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    for (const element of form.querySelectorAll('[aria-invalid]')) {
      element.removeAttribute('aria-invalid');
    }
    if (state && !state.ok) {
      for (const fieldError of state.fieldErrors ?? []) {
        const control = form.elements.namedItem(fieldError.field);
        if (control instanceof HTMLElement) control.setAttribute('aria-invalid', 'true');
      }
    }
    if (state?.ok && resetOnSuccess) form.reset();
  }, [state, resetOnSuccess]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      {children}

      {state ? (
        state.ok ? (
          <Notice tone="positive" role="status">
            {state.message}
          </Notice>
        ) : (
          <Notice tone="negative" role="alert" title={state.error}>
            {state.fieldErrors?.length ? (
              <ul className="list-disc pl-5">
                {state.fieldErrors.map((fieldError) => (
                  <li key={`${fieldError.field}-${fieldError.message}`}>
                    <span className="font-semibold">{fieldError.label}</span> {fieldError.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Notice>
        )
      ) : null}

      {disabled && disabledNote ? <Notice tone="warning">{disabledNote}</Notice> : null}

      <div className="flex items-center gap-3">
        <Submit label={submitLabel} disabled={disabled} destructive={destructive} />
      </div>
    </form>
  );
}

/**
 * Separate component so `useFormStatus` reads the enclosing form. Called from
 * the parent it would report nothing -- the hook only sees a form it is
 * rendered inside.
 */
function Submit({
  label,
  pendingLabel,
  disabled,
  destructive,
}: {
  label: string;
  /** Overrides the pending text; a caller with a better verb than the default. */
  pendingLabel?: string;
  disabled?: boolean;
  destructive?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className={`min-h-11 rounded-[4px] px-4 font-semibold disabled:opacity-50 ${
        destructive
          ? 'border border-negative text-negative hover:bg-negative-soft'
          : 'bg-accent text-accent-fg hover:bg-accent-hover'
      }`}
    >
      {/* A destructive action does not report "Saving". Pressing Remove and
          being told the app is saving describes the opposite of what is
          happening; a caller with a better verb passes pendingLabel. */}
      {pending ? (pendingLabel ?? (destructive ? 'Working…' : 'Saving…')) : label}
    </button>
  );
}

/**
 * A one-button form for a row action -- deactivate, reactivate, remove. The
 * hidden inputs the caller supplies carry the row's identity, so no row
 * identifier travels through client state.
 */
export function RowAction({
  action,
  label,
  fields,
  confirm,
  destructive,
  disabled,
  title,
}: {
  action: FormAction;
  label: string;
  fields: Record<string, string>;
  /** Shown by the browser before the action runs. Nothing here is reversible. */
  confirm?: string;
  destructive?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null);

  return (
    <form
      action={formAction}
      className="inline"
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <RowSubmit label={label} disabled={disabled} destructive={destructive} title={title} />
      {state && !state.ok ? (
        <span role="alert" className="block t-small text-negative">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

function RowSubmit({
  label,
  disabled,
  destructive,
  title,
}: {
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      title={title}
      className={`min-h-11 whitespace-nowrap rounded-[4px] border px-3 t-small disabled:opacity-50 ${
        destructive
          ? 'border-negative text-negative hover:bg-negative-soft'
          : 'border-line-strong hover:bg-surface-2'
      }`}
    >
      {pending ? '…' : label}
    </button>
  );
}
