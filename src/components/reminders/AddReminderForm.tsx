'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { createReminderAction } from '@/app/reminders/actions';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { Field, FormError, SelectField, TextAreaField } from '@/components/detail/Fields';
import { REMINDER_KINDS } from '@/components/reminders/labels';
import {
  DEFAULT_DUE_CHOICE, DUE_CHOICES, ON_A_DATE, REMINDER_KIND_CHOICES,
  defaultReminderKind, defaultReminderTitle,
} from '@/components/reminders/new-reminder';
import type { EntityType } from '@/lib/reminders/types';

/**
 * Writing a reminder down by hand.
 *
 * Every reminder in the product until now was produced by a rule, and a rule
 * cannot think of "call Dave back Thursday". A reminder screen the owner
 * cannot add his own to is a screen that shows him the machine's list instead
 * of his, and the whole feature is worth exactly as much as the habit of
 * opening it -- so the thing he actually wants to remember has to be one press
 * away from the record it is about.
 *
 * A button and a `Sheet`, the same idiom as `LogActivityForm` next to it,
 * because the two get used in the same breath: he logs the call that just
 * happened and writes down the one he owes. Two controls that behave
 * differently, side by side on the same panel, is how a person learns to
 * distrust both.
 *
 * It takes only what the page it sits on already knows. Nothing here needs the
 * tenant's today: the due date is chosen as an OFFSET IN DAYS and resolved
 * against the database's idea of today inside the action, which is the only
 * clock in this system worth trusting.
 */
export function AddReminderForm({
  entityType,
  entityId,
  label,
}: {
  entityType: EntityType;
  entityId: string;
  /** What this record is called, for the title the form opens with. */
  label: string;
}) {
  /**
   * The moment of the press, doubling as the sheet's `key`, so every open is a
   * fresh form -- a new `useActionState`, and none of the last reminder's
   * words left in the fields. Closing this is the one moment somebody expects
   * what was in it to be gone.
   */
  const [openedAt, setOpenedAt] = useState<number | null>(null);

  return (
    <>
      <Button variant="secondary" onClick={() => setOpenedAt(Date.now())}>
        Add a reminder
      </Button>

      {openedAt === null ? null : (
        <AddReminderSheet
          key={openedAt}
          entityType={entityType}
          entityId={entityId}
          label={label}
          onClose={() => setOpenedAt(null)}
        />
      )}
    </>
  );
}

const DISCARD = 'Throw away this reminder? It has not been saved yet.';

function AddReminderSheet({
  entityType,
  entityId,
  label,
  onClose,
}: {
  entityType: EntityType;
  entityId: string;
  label: string;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(createReminderAction, null);
  const form = useRef<HTMLFormElement>(null);

  /**
   * Which day-choice is showing, held here only so the date box can appear
   * when it is asked for. The box is rendered either way and merely hidden,
   * so switching back and forth does not throw away a date already picked --
   * and there is one DOM tree rather than two, with the kind field sliding up
   * beside the choice when the box is not needed.
   */
  const [when, setWhen] = useState<string>(DEFAULT_DUE_CHOICE);

  /** The title the form opens with, and the baseline the discard prompt reads. */
  const openingTitle = defaultReminderTitle(entityType, label);

  /**
   * `autoFocus` does not land here -- React applies it during commit and
   * `Sheet`'s own focus effect, running as a child's effect does before its
   * parent's, wins that race. Focusing from here runs strictly after the shell
   * has had its go.
   *
   * The title is what gets focus rather than the day, because it is the field
   * most likely to be edited: the default is a guess about the record, and the
   * day underneath it is already the answer four times out of five.
   */
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);

  // Saved, so the sheet gets out of the way. The confirmation is the reminder
  // appearing on the record underneath, which the action's `revalidatePath`
  // puts there -- a notice inside a panel still covering it would be the app
  // telling somebody about a row it is hiding from them.
  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);

  /**
   * Escape and a backdrop click both dismiss a sheet. Only what somebody
   * TYPED counts as work worth asking about: the day and the kind open on a
   * default, and changing one is not something anybody would mourn.
   */
  function requestClose() {
    const element = form.current;
    if (element) {
      const values = new FormData(element);
      const typed =
        String(values.get('title') ?? '').trim() !== openingTitle.trim() ||
        String(values.get('detail') ?? '').trim() !== '';
      if (typed && !window.confirm(DISCARD)) return;
    }
    onClose();
  }

  // Stable and unique on the page without `useId`, whose value is not a name
  // anything else can be written against. One record, one form.
  const formId = `add-reminder-${entityId}`;

  return (
    <Sheet
      label="Add a reminder"
      title="Remind me to"
      subtitle="It goes on the reminder screen, and on this record. Nothing chases it for you."
      onClose={requestClose}
      footer={
        <>
          {/* `form` rather than nesting: the submit is pinned below the
              scrolling body, where it stays reachable on a phone without
              scrolling past the detail box to find it. */}
          <Button
            type="submit"
            form={formId}
            variant="primary"
            size="lg"
            pending={pending}
            pendingLabel="Saving…"
          >
            Add it
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

        {/* Filled in from the record already, because the owner is doing this
            one-handed between jobs and a blank box is a reminder not written.
            It is a default in an editable field, so anything more specific
            costs only the typing he was going to do anyway. */}
        <Field
          ref={first}
          label="Remind me to"
          name="title"
          required
          maxLength={300}
          defaultValue={openingTitle}
          placeholder="Call back about the basement quote"
        />

        <div className="grid gap-3 sm:grid-cols-2">
          {/* Days rather than a date, and resolved against the tenant's today
              on the server: a phone whose clock is a day out cannot file a
              reminder on a day nobody meant. */}
          <SelectField
            label="When"
            name="when"
            required
            value={when}
            onChange={(event) => setWhen(event.target.value)}
            options={DUE_CHOICES.map((choice) => ({
              value: choice.value,
              label: choice.label,
            }))}
          />

          {/* Rendered either way and hidden until it is asked for, so a date
              already picked survives a change of mind. Not `required`: the
              action refuses an empty one only on the choice that needs it,
              and a hidden required field would block the submit with a
              message pointing at a box nobody can see. */}
          <div hidden={when !== ON_A_DATE}>
            <Field label="Which day" name="dueOn" type="date" numeric />
          </div>

          <SelectField
            label="Kind"
            name="kind"
            required
            defaultValue={defaultReminderKind(entityType)}
            options={REMINDER_KIND_CHOICES.map((kind) => ({
              value: kind,
              label: REMINDER_KINDS[kind],
            }))}
            hint="Only changes how it is labelled on the list."
          />
        </div>

        <TextAreaField
          label="Anything else"
          name="detail"
          rows={3}
          maxLength={20_000}
          hint="Optional. The number to ring, or what you promised him."
        />
      </form>
    </Sheet>
  );
}
