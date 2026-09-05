'use client';

import { useActionState } from 'react';
import {
  completeReminderAction,
  dismissReminderAction,
  rescheduleReminderAction,
  snoozeReminderAction,
} from '@/app/reminders/actions';
import { Button } from '@/components/ui/Button';
import { SNOOZE_CHOICES } from '@/components/reminders/labels';
import type { FormResult } from '@/components/detail/form-state';

/**
 * The controls on one reminder row.
 *
 * Four separate `<form>` elements rather than one form with four submit
 * buttons, because forms cannot nest and each of these posts a different set
 * of fields to a different action. Each carries the reminder id as a hidden
 * input, so no row identifier travels through client state and a row that
 * moves between renders cannot take a stale id with it.
 *
 * Every one works before its JavaScript has loaded: a plain form post, an
 * action that validates and answers, and the answer rendered. On a phone in a
 * basement with a half-loaded page, that is the difference between a button
 * and a picture of a button.
 *
 * DONE is the only control in the row proper. Snooze, reschedule and dismiss
 * live behind one disclosure, because a list where every row shows four
 * buttons is a list whose primary action is not obvious -- and the primary
 * action here is almost always "I dealt with it".
 */

function errorOf(state: FormResult | null): string | null {
  return state && !state.ok ? state.error : null;
}

/**
 * `compact` is the Today panel: Done and nothing else.
 *
 * That screen answers one question -- what has to happen before the day is out
 * -- and the answer to a row on it is almost always "I dealt with it". Snooze,
 * reschedule and dismiss are decisions about the SHAPE of the list, which is
 * what the reminders screen is for. Carrying all four onto a panel of three
 * rows cost 276px a row on a phone and pushed the figures underneath off the
 * screen entirely.
 */
export function ReminderActions({
  id,
  dueOn,
  compact = false,
}: {
  id: string;
  dueOn: string;
  compact?: boolean;
}) {
  const [doneState, done, doneRunning] = useActionState(completeReminderAction, null);
  const [snoozeState, snooze, snoozeRunning] = useActionState(snoozeReminderAction, null);
  const [moveState, move, moveRunning] = useActionState(rescheduleReminderAction, null);
  const [dropState, drop, dropRunning] = useActionState(dismissReminderAction, null);

  const problem =
    errorOf(doneState) ?? errorOf(snoozeState) ?? errorOf(moveState) ?? errorOf(dropState);

  return (
    <div className="no-print grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <form action={done}>
          <input type="hidden" name="id" value={id} />
          <Button type="submit" variant="primary" className="t-small" pending={doneRunning} pendingLabel="Marking…">
            Done
          </Button>
        </form>

        {compact ? null : (
        <>
        {/* Days rather than a date: the offset is resolved against the
            tenant's today on the server, so a device with a wrong clock
            cannot snooze something into yesterday. */}
        <form action={snooze} className="flex items-center gap-2">
          <input type="hidden" name="id" value={id} />
          <select name="days" aria-label="Snooze until" defaultValue="1" className="field min-h-11 w-auto">
            {SNOOZE_CHOICES.map((choice) => (
              <option key={choice.days} value={choice.days}>
                {choice.label}
              </option>
            ))}
          </select>
          <Button type="submit" variant="secondary" className="shrink-0 t-small" pending={snoozeRunning} pendingLabel="…">
            Snooze
          </Button>
        </form>

        <details className="min-w-0">
          <summary className="flex min-h-11 cursor-pointer items-center t-small font-semibold text-accent-text">
            Other
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <form action={move} className="flex items-center gap-2">
              <input type="hidden" name="id" value={id} />
              <label className="flex items-center gap-2 t-small text-muted">
                <span>Due</span>
                <input
                  type="date"
                  name="dueOn"
                  defaultValue={dueOn}
                  required
                  className="field field-num min-h-11 w-auto"
                />
              </label>
              <Button type="submit" variant="secondary" className="shrink-0 t-small" pending={moveRunning} pendingLabel="…">
                Reschedule
              </Button>
            </form>

            {/* Dismissing is a decision about the TASK -- "not doing it". It
                is not voiding the row, which says the reminder should never
                have existed, and the two never share a control. There is no
                void here at all: nothing on this screen was created in error
                by the person reading it. */}
            <form
              action={drop}
              onSubmit={(event) => {
                if (!window.confirm('Dismiss this reminder? It stays on the record, marked as not being done.')) {
                  event.preventDefault();
                }
              }}
            >
              <input type="hidden" name="id" value={id} />
              <Button type="submit" variant="danger" className="t-small" pending={dropRunning} pendingLabel="…">
                Dismiss
              </Button>
            </form>
          </div>
        </details>
        </>
        )}
      </div>

      {problem ? (
        <p role="alert" className="t-small text-negative">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
