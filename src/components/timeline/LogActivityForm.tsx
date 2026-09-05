'use client';

import { useActionState, useEffect, useRef } from 'react';
import { logActivityAction } from '@/app/activity/actions';
import { Button } from '@/components/ui/Button';
import { Field, FormError, SelectField, TextAreaField } from '@/components/detail/Fields';
import { ACTIVITY_KINDS, ACTIVITY_KIND_ORDER } from '@/components/reminders/labels';
import type { EntityType } from '@/lib/reminders/types';

/**
 * Writing down what happened.
 *
 * The whole phase turns on whether this gets used. A quote sent and never
 * chased is indistinguishable from one that was declined, and both show up as
 * silence -- so the form has to be one press away from the timeline it feeds,
 * and short enough to fill in while the call is still in the owner's head.
 *
 * It is also the log-an-email action, which is what Phase 2 ships instead of
 * sending mail. An `email_out` row with the body pasted into it is a record of
 * what was said; a mail job on a mini PC in an office that happens to be
 * unplugged sends nothing while looking exactly like one that works.
 */
export function LogActivityForm({
  entityType,
  entityId,
  today,
  startOpen,
}: {
  entityType: EntityType;
  entityId: string;
  /** The tenant's today, so a backdated entry starts from the right day. */
  today: string;
  /** Open on a record with no history yet: the first entry is the hard one. */
  startOpen: boolean;
}) {
  const [state, formAction, pending] = useActionState(logActivityAction, null);
  const form = useRef<HTMLFormElement>(null);

  // Cleared on success so the next call can be logged straight away. A form
  // that keeps the last call's notes is a form whose next entry is a
  // half-edited copy of the previous one.
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);

  return (
    <details className="no-print" open={startOpen}>
      <summary className="flex min-h-11 cursor-pointer items-center t-small font-semibold text-accent-text">
        Log a call, email, visit or note
      </summary>

      <form ref={form} action={formAction} className="mt-2 grid gap-3">
        <input type="hidden" name="entityType" value={entityType} />
        <input type="hidden" name="entityId" value={entityId} />

        <FormError error={state && !state.ok ? state.error : null} />
        {state?.ok ? (
          <p role="status" className="t-small text-positive">
            Logged.
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="What happened"
            name="kind"
            required
            defaultValue="call_out"
            options={ACTIVITY_KIND_ORDER.map((kind) => ({
              value: kind,
              label: ACTIVITY_KINDS[kind],
            }))}
          />
          {/* WHEN IT HAPPENED, not when it was typed. Tuesday's call logged on
              Thursday belongs under Tuesday, and the timeline orders by this. */}
          <Field
            label="When"
            name="occurredOn"
            type="date"
            defaultValue={today}
            max={today}
            numeric
            hint="Backdate it freely — the timeline reads this, not the day you typed it."
          />
        </div>

        <Field label="Subject" name="subject" maxLength={300} placeholder="Left a message about the basement quote" />

        <TextAreaField
          label="What was said"
          name="body"
          rows={4}
          maxLength={20_000}
          hint="Paste an email here rather than describing it — this is the record of the conversation."
        />

        <Field
          label="Minutes"
          name="durationMinutes"
          type="number"
          min={0}
          max={1440}
          step={1}
          numeric
          hint="Optional. Only worth filling in for a call or a visit you may have to account for."
        />

        <div>
          <Button type="submit" variant="primary" size="lg" pending={pending} pendingLabel="Logging…">
            Log it
          </Button>
        </div>
      </form>
    </details>
  );
}
