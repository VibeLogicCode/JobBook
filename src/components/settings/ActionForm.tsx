'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionResult, FormAction } from '@/app/settings/result';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { restoreInto } from '@/lib/forms/restore-values';

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
  pendingLabel,
  children,
  disabled,
  disabledNote,
  resetOnSuccess,
  destructive,
}: {
  action: FormAction;
  submitLabel: string;
  /**
   * The verb for what is actually happening, when "Saving…" is the wrong
   * word. `Submit` has taken one of these since it was written; nothing could
   * reach it, because this component never passed it on.
   */
  pendingLabel?: string;
  children: React.ReactNode;
  /** True when the signed-in role may read this screen but not change it. */
  disabled?: boolean;
  disabledNote?: React.ReactNode;
  resetOnSuccess?: boolean;
  destructive?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  /**
   * What was typed, kept so a refusal can put it back.
   *
   * React resets an uncontrolled form once its action settles, and it cannot
   * know the action REFUSED -- so a server-side "that code is already taken"
   * arrived with every field wiped. The person was told what was wrong with
   * work they could no longer see, on forms running to a dozen fields.
   *
   * Restoring here rather than making every field controlled is deliberate:
   * the fields are server-rendered HTML on purpose, and threading value and
   * onChange through all of them to solve a problem that belongs to the form
   * would turn this whole area client-side.
   */
  const submitted = useRef<FormData | null>(null);

  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    async (previous, formData) => {
      submitted.current = formData;
      return action(previous, formData);
    },
    null,
  );

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

    // A refusal is not a reason to lose the typing. Runs after React's own
    // reset, which is what makes this a restore rather than a race.
    if (state && !state.ok) restoreInto(form, submitted.current);
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
        <Submit
          label={submitLabel}
          pendingLabel={pendingLabel}
          disabled={disabled}
          destructive={destructive}
        />
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
    // `lg`, matching the 48px `.field` these forms are built from -- a form's
    // submit is the same size as the boxes above it. It was 44 here and 48 on
    // every other form in the product, which was the drift rather than a
    // decision.
    <Button
      type="submit"
      size="lg"
      variant={destructive ? 'danger' : 'primary'}
      disabled={disabled}
      pending={pending}
      // A destructive action does not report "Saving". Pressing Remove and
      // being told the app is saving describes the opposite of what is
      // happening; a caller with a better verb passes pendingLabel.
      pendingLabel={pendingLabel ?? (destructive ? 'Working…' : 'Saving…')}
    >
      {label}
    </Button>
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
    // A row control, so it stays at the 44px floor rather than taking the
    // form submit's 48: this one sits inside a table cell beside five others.
    <Button
      type="submit"
      variant={destructive ? 'danger' : 'secondary'}
      className="t-small"
      disabled={disabled}
      title={title}
      pending={pending}
      pendingLabel="…"
    >
      {label}
    </Button>
  );
}
