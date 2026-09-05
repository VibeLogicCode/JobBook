'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ActionResult, FormAction } from '@/app/settings/result';
import { restoreInto } from '@/lib/forms/restore-values';
import { FieldGrid, SelectField, TextAreaField, TextField, type Option } from '@/components/settings/Fields';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Pill, type Tone } from '@/components/ui/Pill';
import { Sheet, fieldSnapshot } from '@/components/ui/Sheet';

/**
 * Who is on one task.
 *
 * **A LIST, not a stack of forms.** The first version of this screen put three
 * jobs on one surface -- change somebody, take somebody off, add somebody --
 * each with its own submit, two of them primary, and the one thing the sheet
 * exists for was below the fold. The owner's word for it was "confusing", and
 * he was right: a surface answering three questions has no primary answer, and
 * `Save` sitting directly above `Take them off` is a dangerous adjacency to
 * boot.
 *
 * So the sheet SWAPS VIEWS instead of stacking them, and there is exactly one
 * primary action visible at any moment, pinned in the footer where `Sheet`'s
 * flex column keeps it on screen at any height. Four views, each answering one
 * question: the list, add somebody, change one person, take one person off.
 *
 * **Why swapping rather than revealing a row's fields inline.** Both keep one
 * primary action, and inline disclosure keeps the list visible around the row
 * being edited, which is a real advantage. It loses on the thing that actually
 * went wrong here: a revealed row is a form INSIDE a list, so the footer's
 * primary and the row's own submit are two primaries again the moment anything
 * is open -- or the footer has to reach into whichever row is expanded, which
 * is worse to reason about than a view. Removal decides it. Taking somebody off
 * is the one irreversible-feeling action here, and it earns a surface of its
 * own where the only button is the destructive one and nothing is beside it to
 * mis-hit. A `Sheet` nested in a `Sheet` would have been the other way to get
 * that, and two stacked modals is not a thing this product does.
 *
 * **Why this is a client component when the rest of the schedule is not.** The
 * primary action has to sit in `Sheet`'s pinned footer, and `SheetButton` --
 * which is what every other sheet on this screen uses -- takes no footer. The
 * strings are still computed on the server and passed down whole: this file
 * formats nothing, resolves no name and knows about no timezone, so the rules
 * about the tenant's locale stay where they were.
 */

export interface ClashLine {
  projectId: string;
  projectNumber: string;
  taskName: string;
  days: number;
}

/** One assignment, with every string already resolved by the server. */
export interface AssignmentView {
  id: string;
  /** Already carrying "(you)", "(retired)" or "(voided vendor)" where it applies. */
  name: string;
  response: string;
  responseLabel: string;
  responseTone: Tone;
  /** Formatted money, or null for nothing agreed -- which is not zero. */
  amount: string | null;
  /** The same figure as the box takes it, unlocalised. */
  amountInput: string;
  notes: string | null;
  /** "Confirmed 10 Mar 2026", in the tenant's zone, or null. */
  answeredOn: string | null;
  removed: { on: string; reason: string } | null;
  clashes: ClashLine[];
  clashLabel: string | null;
}

type View =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'edit'; id: string }
  | { kind: 'remove'; id: string };

export function WhoSheet({
  taskId,
  taskName,
  taskDates,
  rows,
  assigneeOptions,
  responseOptions,
  canEdit,
  disabledNote,
  assignAction,
  updateAction,
  removeAction,
}: {
  taskId: string;
  taskName: string;
  /** The days this task runs, for the sheet's subtitle. */
  taskDates: string;
  rows: AssignmentView[];
  assigneeOptions: Option[];
  responseOptions: Option[];
  canEdit: boolean;
  /** Why not, when the person may read this screen and not change it. */
  disabledNote?: string;
  assignAction: FormAction;
  updateAction: FormAction;
  removeAction: FormAction;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: 'list' });
  /**
   * The last thing that succeeded, shown at the top of the list it returns to.
   *
   * Lifted out of the form on purpose. A save switches back to the list, which
   * unmounts the form -- and a notice that lives inside the form goes with it,
   * so the person presses the button and is told nothing.
   */
  const [flash, setFlash] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const baseline = useRef('');
  /** Focus follows the view, or a keyboard lands nowhere after a swap. */
  const viewRef = useRef<HTMLDivElement | null>(null);
  const firstView = useRef(true);

  useEffect(() => {
    if (!open) return;
    baseline.current = fieldSnapshot(bodyRef.current);
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    viewRef.current?.focus();
  }, [open, view]);

  const live = rows.filter((row) => row.removed === null);
  const editing = view.kind === 'edit' ? rows.find((row) => row.id === view.id) : undefined;
  const removing = view.kind === 'remove' ? rows.find((row) => row.id === view.id) : undefined;

  function goList(message?: string) {
    setFlash(message ?? null);
    setView({ kind: 'list' });
  }

  function requestClose() {
    const dirty = fieldSnapshot(bodyRef.current) !== baseline.current;
    if (
      dirty &&
      !window.confirm('Throw away what you were typing? Nothing has been saved yet.')
    ) {
      return;
    }
    setOpen(false);
    setView({ kind: 'list' });
    setFlash(null);
    firstView.current = true;
  }

  const nothingToAssign = assigneeOptions.length === 0;
  const addNote = nothingToAssign
    ? 'There is nobody to assign yet. Add a subcontractor on the vendor list, or a person under Settings.'
    : disabledNote;

  return (
    <>
      <Button type="button" variant="secondary" className="t-small" onClick={() => setOpen(true)}>
        {live.length === 0 ? 'Assign…' : `Who (${live.length})…`}
      </Button>

      {open ? (
        <Sheet
          label={`Who is on ${taskName}`}
          title={view.kind === 'list' ? `Who is on ${taskName}` : taskName}
          subtitle={taskDates}
          size="lg"
          onClose={requestClose}
          footer={
            view.kind === 'list' ? (
              <Button
                type="button"
                size="lg"
                variant="primary"
                disabled={!canEdit || nothingToAssign}
                onClick={() => {
                  setFlash(null);
                  setView({ kind: 'add' });
                }}
              >
                Put somebody on this task
              </Button>
            ) : (
              <>
                <Button type="button" size="lg" variant="secondary" onClick={() => goList()}>
                  Back to the list
                </Button>
                {/* The one primary, and it submits the form in the body by id.
                    A button carries its form with `form=`, so the action stays
                    pinned at the foot of the panel rather than scrolling away
                    under the fields it belongs to. */}
                <SubmitPrimary view={view} />
              </>
            )
          }
        >
          <div ref={bodyRef}>
            <div ref={viewRef} tabIndex={-1} className="outline-none">
              {view.kind === 'list' ? (
                <ListView
                  rows={rows}
                  flash={flash}
                  canEdit={canEdit}
                  disabledNote={disabledNote}
                  onChange={(id) => {
                    setFlash(null);
                    setView({ kind: 'edit', id });
                  }}
                />
              ) : null}

              {view.kind === 'add' ? (
                <AddView
                  taskId={taskId}
                  options={assigneeOptions}
                  action={assignAction}
                  disabled={!canEdit || nothingToAssign}
                  disabledNote={addNote}
                  onDone={goList}
                />
              ) : null}

              {view.kind === 'edit' && editing ? (
                <EditView
                  row={editing}
                  responseOptions={responseOptions}
                  action={updateAction}
                  disabled={!canEdit}
                  disabledNote={disabledNote}
                  onDone={goList}
                  onRemove={() => setView({ kind: 'remove', id: editing.id })}
                />
              ) : null}

              {view.kind === 'remove' && removing ? (
                <RemoveView
                  row={removing}
                  taskName={taskName}
                  action={removeAction}
                  disabled={!canEdit}
                  disabledNote={disabledNote}
                  onDone={goList}
                />
              ) : null}
            </div>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------
   The footer's submit
   ------------------------------------------------------------------------- */

const FORM_ID = {
  add: 'who-add',
  edit: 'who-edit',
  remove: 'who-remove',
} as const;

/**
 * The footer button for whichever form is open.
 *
 * It reads no pending state: `useFormStatus` sees only a form it is rendered
 * INSIDE, and this one is deliberately outside so it can be pinned. The form
 * disables its own fields while a submit is in flight through `useActionState`,
 * and the busy mark lives on the notice above.
 */
function SubmitPrimary({ view }: { view: View }) {
  if (view.kind === 'add') {
    return (
      <Button type="submit" form={FORM_ID.add} size="lg" variant="primary">
        Assign
      </Button>
    );
  }
  if (view.kind === 'edit') {
    return (
      <Button type="submit" form={FORM_ID.edit} size="lg" variant="primary">
        Save changes
      </Button>
    );
  }
  return (
    <Button type="submit" form={FORM_ID.remove} size="lg" variant="danger">
      Take them off
    </Button>
  );
}

/* -------------------------------------------------------------------------
   The list
   ------------------------------------------------------------------------- */

function ListView({
  rows,
  flash,
  canEdit,
  disabledNote,
  onChange,
}: {
  rows: AssignmentView[];
  flash: string | null;
  canEdit: boolean;
  disabledNote?: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 pb-2">
      {flash ? (
        <Notice tone="positive" role="status">
          {flash}
        </Notice>
      ) : null}
      {!canEdit && disabledNote ? <Notice tone="warning">{disabledNote}</Notice> : null}

      {rows.length === 0 ? (
        <p className="max-w-prose t-small text-subtle">
          Nobody is on this task yet. A trade on the task says who to go looking for; this says who
          is actually coming.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className={`flex flex-wrap items-start justify-between gap-2 rounded-panel border border-line p-3 ${
                row.removed ? 'opacity-70' : ''
              }`}
            >
              <div className="min-w-0">
                <p className="t-small font-semibold">{row.name}</p>
                <p className="mt-1 flex flex-wrap items-center gap-1">
                  <Pill tone={row.removed ? 'neutral' : row.responseTone}>
                    {row.removed ? 'Taken off' : row.responseLabel}
                  </Pill>
                  {row.clashLabel && !row.removed ? (
                    <Pill tone="warning">{row.clashLabel}</Pill>
                  ) : null}
                  {row.amount ? <span className="num t-small text-muted">{row.amount}</span> : null}
                </p>
                {row.removed ? (
                  <p className="mt-1 t-small text-subtle">
                    {row.removed.on} — {row.removed.reason}
                  </p>
                ) : row.answeredOn ? (
                  <p className="mt-1 t-small text-subtle">{row.answeredOn}</p>
                ) : null}
              </div>
              {row.removed ? null : (
                <Button
                  type="button"
                  variant="secondary"
                  className="t-small"
                  disabled={!canEdit}
                  onClick={() => onChange(row.id)}
                >
                  Change…
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
   One form, three uses
   ------------------------------------------------------------------------- */

/**
 * A form whose submit lives in the footer.
 *
 * The refusal notice sits at the TOP of the view rather than above the button,
 * because a message under the fields reads as belonging to whatever control is
 * beneath it instead of to the press that produced it.
 */
function useSheetForm(action: FormAction, onDone: (message: string) => void) {
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef<FormData | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, formData) => {
      submitted.current = formData;
      return action(previous, formData);
    },
    null,
  );

  useEffect(() => {
    const form = formRef.current;
    if (!form || !state) return;
    for (const element of form.querySelectorAll('[aria-invalid]')) {
      element.removeAttribute('aria-invalid');
    }
    if (state.ok) {
      done.current(state.message);
      return;
    }
    for (const fieldError of state.fieldErrors ?? []) {
      const control = form.elements.namedItem(fieldError.field);
      if (control instanceof HTMLElement) control.setAttribute('aria-invalid', 'true');
    }
    // A refusal is not a reason to lose the typing. Runs after React's own
    // reset of the uncontrolled form, which is what makes it a restore.
    restoreInto(form, submitted.current);
  }, [state]);

  return { formRef, state, formAction, pending };
}

function Refusal({ state }: { state: ActionResult | null }) {
  if (!state || state.ok) return null;
  return (
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
  );
}

function AddView({
  taskId,
  options,
  action,
  disabled,
  disabledNote,
  onDone,
}: {
  taskId: string;
  options: Option[];
  action: FormAction;
  disabled: boolean;
  disabledNote?: string;
  onDone: (message: string) => void;
}) {
  const { formRef, state, formAction, pending } = useSheetForm(action, onDone);

  return (
    <div className="flex flex-col gap-3 pb-2">
      <Refusal state={state} />
      {disabled && disabledNote ? <Notice tone="warning">{disabledNote}</Notice> : null}
      <p className="max-w-prose t-small text-subtle">
        Subcontractors and internal people, including you. Suppliers are not offered.
      </p>
      <form id={FORM_ID.add} ref={formRef} action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="scheduleTaskId" value={taskId} />
        <FieldGrid>
          <SelectField
            idPrefix="who-add"
            name="assignee"
            label="Who"
            required
            options={options}
            disabled={disabled || pending}
          />
          <TextField
            idPrefix="who-add"
            name="agreedAmount"
            label="Agreed amount"
            inputMode="decimal"
            numeric
            maxLength={20}
            disabled={disabled || pending}
            hint="Blank means nothing agreed yet."
          />
        </FieldGrid>
        <TextAreaField
          idPrefix="who-add"
          name="notes"
          label="Notes"
          rows={2}
          disabled={disabled || pending}
        />
      </form>
    </div>
  );
}

function EditView({
  row,
  responseOptions,
  action,
  disabled,
  disabledNote,
  onDone,
  onRemove,
}: {
  row: AssignmentView;
  responseOptions: Option[];
  action: FormAction;
  disabled: boolean;
  disabledNote?: string;
  onDone: (message: string) => void;
  onRemove: () => void;
}) {
  const { formRef, state, formAction, pending } = useSheetForm(action, onDone);

  return (
    <div className="flex flex-col gap-3 pb-2">
      <Refusal state={state} />
      {disabled && disabledNote ? <Notice tone="warning">{disabledNote}</Notice> : null}

      <div>
        <h3 className="t-small font-semibold">{row.name}</h3>
        {row.answeredOn ? <p className="t-small text-subtle">{row.answeredOn}</p> : null}
      </div>

      {row.clashes.length > 0 ? (
        <Notice tone="warning">
          {row.clashes.map((clash) => (
            <span key={`${clash.projectId}-${clash.taskName}`} className="block">
              Also on {clash.taskName} for{' '}
              <Link href={`/projects/${clash.projectId}/schedule`} className="underline">
                {clash.projectNumber}
              </Link>{' '}
              — {clash.days} {clash.days === 1 ? 'day' : 'days'} of overlap.
            </span>
          ))}
        </Notice>
      ) : null}

      <form id={FORM_ID.edit} ref={formRef} action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={row.id} />
        <FieldGrid>
          <SelectField
            idPrefix="who-edit"
            name="response"
            label="Have they said yes"
            defaultValue={row.response}
            options={responseOptions}
            disabled={disabled || pending}
            hint="Nothing heard back is not a no."
          />
          <TextField
            idPrefix="who-edit"
            name="agreedAmount"
            label="Agreed amount"
            inputMode="decimal"
            numeric
            maxLength={20}
            defaultValue={row.amountInput}
            disabled={disabled || pending}
            hint="Blank means nothing agreed yet."
          />
        </FieldGrid>
        <TextAreaField
          idPrefix="who-edit"
          name="notes"
          label="Notes"
          rows={2}
          defaultValue={row.notes}
          disabled={disabled || pending}
        />
      </form>

      {/* Deliberately a link rather than a second button. Removal gets its own
          view, so the destructive control is never beside Save. */}
      <p className="t-small">
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="underline text-negative disabled:opacity-60"
        >
          Take them off this task…
        </button>
      </p>
    </div>
  );
}

function RemoveView({
  row,
  taskName,
  action,
  disabled,
  disabledNote,
  onDone,
}: {
  row: AssignmentView;
  taskName: string;
  action: FormAction;
  disabled: boolean;
  disabledNote?: string;
  onDone: (message: string) => void;
}) {
  const { formRef, state, formAction, pending } = useSheetForm(action, onDone);

  return (
    <div className="flex flex-col gap-3 pb-2">
      <Refusal state={state} />
      {disabled && disabledNote ? <Notice tone="warning">{disabledNote}</Notice> : null}

      <div>
        <h3 className="t-small font-semibold">
          Take {row.name} off {taskName}
        </h3>
        <p className="max-w-prose t-small text-subtle">
          The row stays, with the date and your reason on it. That is what frees them up on the day
          without pretending they were never asked.
        </p>
      </div>

      <form id={FORM_ID.remove} ref={formRef} action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={row.id} />
        <TextField
          idPrefix="who-remove"
          name="reason"
          label="Reason"
          required
          maxLength={300}
          disabled={disabled || pending}
          wide
          hint="Kept on the row."
        />
      </form>
    </div>
  );
}
