'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { moveTaskDates } from '@/app/projects/[id]/schedule/actions';
import { dayFormatter, type MoveState } from '@/app/projects/[id]/schedule/schema';
import { FieldGrid } from '@/components/settings/Fields';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';

/**
 * Moving a task's planned dates, in two presses.
 *
 * The plan calls this the single most important interaction in the feature:
 * *a drag that silently shifts nine tasks is how somebody loses a schedule
 * they spent an evening building.* So the first press asks the question and
 * the second answers it. Nothing is written until the owner has read a
 * sentence naming what moves and a line per task saying where it goes.
 *
 * The order on screen is deliberate. The sentence first, because it is the
 * thing he actually decides on; then the rows, because that is what he checks
 * it against; then the button, which only says "Move them" once there is
 * something to say yes to.
 *
 * There is no drag, and no calendar to drop a bar on. Two date boxes and a
 * confirm answer the same question, work on a phone in a driveway, and cannot
 * shift something by a day because a finger landed a pixel off.
 */
export function MoveDates({
  taskId,
  taskName,
  plannedStart,
  plannedEnd,
  isMilestone,
  locale,
  disabled,
  disabledNote,
}: {
  taskId: string;
  taskName: string;
  plannedStart: string;
  plannedEnd: string;
  isMilestone: boolean;
  /** The tenant's own locale, so the preview reads in the dates he uses. */
  locale: string;
  disabled: boolean;
  disabledNote?: string;
}) {
  const [state, formAction] = useActionState<MoveState | null, FormData>(moveTaskDates, null);
  /**
   * Controlled, and that is not a style preference.
   *
   * React resets an uncontrolled field after a form action completes, so the
   * first press -- the one that asks for the preview -- put the task's
   * ORIGINAL dates back in the boxes. The second press then submitted those,
   * and the action correctly answered "those are the dates it already has".
   * The bug was invisible in every unit test and took one run in a browser to
   * find, which is exactly what a browser run is for.
   *
   * Holding the pair in state is also what makes the confirm honest: editing a
   * date after reading a preview drops `confirming` back to false, so the
   * button returns to asking rather than committing a move nobody was shown.
   * The action checks the same thing server-side, because a guarantee that
   * lives only in the browser is not one.
   */
  const [start, setStart] = useState(plannedStart);
  const [end, setEnd] = useState(plannedEnd);
  const preview = state?.status === 'preview' ? state : null;
  const confirming =
    preview !== null && preview.plannedStart === start && preview.plannedEnd === end;
  const day = dayFormatter(locale);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={taskId} />
      {/* Empty until a preview has been read. Its presence IS the confirmation. */}
      <input type="hidden" name="fingerprint" value={preview?.fingerprint ?? ''} />
      <input type="hidden" name="previewedStart" value={preview?.plannedStart ?? ''} />
      <input type="hidden" name="previewedEnd" value={preview?.plannedEnd ?? ''} />

      <FieldGrid>
        <DateField
          id={`move-${taskId}-plannedStart`}
          name="plannedStart"
          label="Starts"
          value={start}
          onChange={setStart}
          disabled={disabled}
        />
        <DateField
          id={`move-${taskId}-plannedEnd`}
          name="plannedEnd"
          label="Finishes"
          value={end}
          onChange={setEnd}
          disabled={disabled}
          hint={
            isMilestone
              ? 'Milestones are a single day — use the same date as the start.'
              : 'Inclusive, calendar days — weekends count.'
          }
        />
      </FieldGrid>

      {preview ? (
        <Notice
          tone={preview.stale ? 'warning' : 'info'}
          role="status"
          title={
            preview.stale
              ? 'The schedule changed while you were reading this'
              : 'Before anything moves'
          }
        >
          <p>{preview.sentence}</p>
          {preview.stale ? (
            <p className="mt-1">
              Somebody else edited this job, so the preview you read is no longer what would
              happen. This is what would happen now. Nothing has been written.
            </p>
          ) : null}

          {preview.rows.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {preview.rows.map((row) => (
                <li key={row.name} className="t-small">
                  <span className="font-semibold">{row.name}</span>
                  {row.cause === 'pushed' ? ' (waits on it)' : ''}
                  {': '}
                  <span className="num">
                    {day(row.fromStart)} – {day(row.fromEnd)}
                  </span>
                  {' → '}
                  <span className="num font-semibold">
                    {day(row.toStart)} – {day(row.toEnd)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {preview.held.map((held) => (
            <p key={held.name} className="mt-2 t-small">
              <span className="font-semibold">{held.name}</span> has already started, so its plan
              stays where it is
              {held.downstreamNames.length > 0
                ? `, and so ${held.downstreamNames.length === 1 ? 'does' : 'do'} ${held.downstreamNames.join(
                    ', ',
                  )} behind it`
                : ''}
              . Moving the plan under work that has begun would erase the difference between what
              was planned and what happened.
            </p>
          ))}
        </Notice>
      ) : null}

      {state?.status === 'saved' ? (
        <Notice tone="positive" role="status">
          {state.message}
        </Notice>
      ) : null}

      {state?.status === 'refused' ? (
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
      ) : null}

      {disabled && disabledNote ? <Notice tone="warning">{disabledNote}</Notice> : null}

      <Submit confirming={confirming} disabled={disabled} taskName={taskName} />
    </form>
  );
}

/**
 * The one controlled field in the product, written here rather than added to
 * `components/settings/Fields.tsx`.
 *
 * Those fields are server components -- a form built from them keeps working
 * while the page's JavaScript is still on its way -- and a server component
 * cannot take an `onChange`. Rather than split that primitive in two for one
 * caller, this repeats its markup: the `.field` token class, the same label
 * treatment, and the hint wired to `aria-describedby`.
 */
function DateField({
  id,
  name,
  label,
  value,
  onChange,
  disabled,
  hint,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  hint?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="t-small font-semibold">
        {label}
        <span className="text-negative" aria-hidden>
          {' *'}
        </span>
      </label>
      <input
        id={id}
        name={name}
        type="date"
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={`field ${disabled ? 'opacity-60' : ''}`}
      />
      {hint ? (
        <p id={`${id}-hint`} className="t-small text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Separate, so `useFormStatus` reads the form it is rendered inside. */
function Submit({
  confirming,
  disabled,
  taskName,
}: {
  confirming: boolean;
  disabled: boolean;
  taskName: string;
}) {
  const { pending } = useFormStatus();
  return (
    <div className="flex items-center gap-3">
      <Button
        type="submit"
        size="lg"
        variant={confirming ? 'primary' : 'secondary'}
        disabled={disabled}
        pending={pending}
        pendingLabel={confirming ? 'Moving…' : 'Working it out…'}
      >
        {confirming ? 'Move them' : 'See what moves'}
      </Button>
      {confirming ? null : (
        <span className="t-small text-subtle">
          Nothing is written until you have read what {taskName} takes with it.
        </span>
      )}
    </div>
  );
}
