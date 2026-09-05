'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { logActivityAction } from '@/app/activity/actions';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
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
 *
 * A BUTTON over the timeline, and the form in a `Sheet` over a blurred page --
 * the owner's ask, and the same idiom the worksheet already uses. It was a
 * `<details>` sitting permanently open above the log, which meant the record
 * he came to the screen to read started two hundred pixels below a form he was
 * not filling in. The form is not smaller for being behind a press: it is the
 * same fields, with nothing on the page competing for the screen while they
 * are on it.
 */
export function LogActivityForm({
  entityType,
  entityId,
  today,
}: {
  entityType: EntityType;
  entityId: string;
  /** The tenant's today, so a backdated entry starts from the right day. */
  today: string;
}) {
  /**
   * The moment of the press, doubling as the sheet's `key`.
   *
   * Every open is therefore a fresh form: a new `useActionState`, no "Logged."
   * left over from the last entry, and no half-typed body from an entry that
   * was abandoned. Closing this sheet is the one moment somebody expects what
   * was in it to be gone.
   */
  const [openedAt, setOpenedAt] = useState<number | null>(null);

  return (
    <>
      <Button variant="primary" onClick={() => setOpenedAt(Date.now())}>
        Log a call, email, visit or note
      </Button>

      {openedAt === null ? null : (
        <LogActivitySheet
          key={openedAt}
          entityType={entityType}
          entityId={entityId}
          today={today}
          onClose={() => setOpenedAt(null)}
        />
      )}
    </>
  );
}

const DISCARD = 'Throw away what you have typed here? It has not been logged yet.';

function LogActivitySheet({
  entityType,
  entityId,
  today,
  onClose,
}: {
  entityType: EntityType;
  entityId: string;
  today: string;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(logActivityAction, null);
  const form = useRef<HTMLFormElement>(null);
  /**
   * `autoFocus` does not land here. React applies it imperatively during
   * commit rather than rendering the attribute, and `Sheet`'s own effect --
   * which focuses the panel when nothing inside has claimed focus -- wins that
   * race. A child's effects run before its parent's, and `Sheet` is this
   * component's child, so focusing from HERE runs strictly after the shell has
   * had its go.
   */
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);

  // Logged, so the sheet gets out of the way: the confirmation is the entry
  // appearing in the timeline underneath, which the action's own
  // `revalidatePath` puts there. A "Logged." notice inside a panel that is
  // still covering the log would be the app telling somebody about a row it is
  // hiding from them.
  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  /**
   * Escape and a backdrop click both dismiss a sheet, and a pasted email is
   * exactly the thing nobody wants to retype after a mis-aimed click. Only the
   * three free-text fields count: `kind` and `occurredOn` open on a default
   * and changing one is not work anybody would mourn.
   */
  function requestClose() {
    const element = form.current;
    if (element) {
      const values = new FormData(element);
      const typed = ['subject', 'body', 'durationMinutes'].some(
        (name) => String(values.get(name) ?? '').trim() !== '',
      );
      if (typed && !window.confirm(DISCARD)) return;
    }
    onClose();
  }

  // Stable and unique on the page without `useId`, whose value is not a name
  // anything else can be written against. One record, one form.
  const formId = `log-activity-${entityId}`;

  return (
    <Sheet
      label="Log a call, email, visit or note"
      title="Log what happened"
      subtitle="It goes on the timeline under the day it happened, not the day you typed it."
      // A form, not a pair of measurement boxes: at the narrow default the two
      // columns and the pasted-email textarea were a phone layout on a desktop.
      size="lg"
      onClose={requestClose}
      footer={
        <>
          {/* `form` rather than nesting: the submit is pinned below the
              scrolling body, where it stays reachable on a phone without
              scrolling past four fields to find it. */}
          <Button
            type="submit"
            form={formId}
            variant="primary"
            size="lg"
            pending={pending}
            pendingLabel="Logging…"
          >
            Log it
          </Button>
          <Button type="button" variant="secondary" size="lg" onClick={requestClose}>
            Cancel
          </Button>
        </>
      }
    >
      <form ref={form} id={formId} action={formAction} className="grid gap-3 pb-1">
        <input type="hidden" name="entityType" value={entityType} />
        <input type="hidden" name="entityId" value={entityId} />

        <FormError error={state && !state.ok ? state.error : null} />

        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            ref={first}
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
          hint="Paste the email here rather than describing it — the record of the conversation."
        />

        <Field
          label="Minutes"
          name="durationMinutes"
          type="number"
          min={0}
          max={1440}
          step={1}
          numeric
          hint="Optional — mainly for a call or visit you may need to account for."
        />
      </form>
    </Sheet>
  );
}
