'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Sheet, fieldSnapshot, type SheetSize } from '@/components/ui/Sheet';
import { FormError } from '@/components/detail/Fields';
import type { FormAction, FormResult } from '@/components/detail/form-state';
import { restoreInto } from '@/lib/forms/restore-values';

/**
 * Editing one record, over the record.
 *
 * The owner's ask: "when I do edit job it should open a form with blurred
 * background -- this is logic across the app". It already was, everywhere the
 * change was small: the rate editor, the cost codes, logging a call, writing a
 * reminder. The two screens that mattered most -- a job and a customer -- were
 * the exception, and not for a reason: `?edit=1` re-rendered the whole detail
 * page AS the form, so pressing Edit made the record you came to read
 * disappear, and Cancel was the only way to see it again.
 *
 * WHAT THIS KEEPS THAT A PLAIN BUTTON WOULD HAVE COST. `?edit=1` was doing two
 * things well and neither is worth trading for a modal: the URL is linkable
 * ("open the job and start editing" is one address you can send yourself), and
 * it survives a reload -- shut the laptop mid-edit, come back, the form is
 * still open. So the sheet opens from the SAME query parameter rather than from
 * client state: the page still reads `edit` on the server and decides, this
 * component only draws the result. Closing is a navigation back to the record's
 * own URL, which is also what the save does -- `updateProject` and
 * `updateCustomer` both redirect to the bare detail path, so a successful save
 * closes the sheet by unmounting it, with no state to keep in step.
 *
 * `scroll: false` on the way out, because the page underneath has not moved and
 * jumping it to the top would be the app losing the reader's place as a parting
 * gift.
 */
export function EditSheet({
  action,
  recordId,
  closeHref,
  label,
  title,
  subtitle,
  size = 'lg',
  submitLabel,
  discardPrompt,
  children,
}: {
  action: FormAction;
  /** Written as the form's hidden `id`, so no row identifier travels in state. */
  recordId: string;
  /** The record's own URL. Where Cancel, Escape and the backdrop all go. */
  closeHref: string;
  /** The dialog's accessible name. Names the record, so which one is never in doubt. */
  label: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  size?: SheetSize;
  submitLabel: string;
  /** Asked before a dismissal throws an edit away, and only when there is one. */
  discardPrompt: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);

  /**
   * What was typed, kept so a refusal can put it back.
   *
   * The same problem `ActionForm` already solved on the settings screens, and
   * the same fix: React resets an uncontrolled form once its action settles and
   * cannot know the server said no, so without this a refused save emptied
   * fourteen fields while telling the person what was wrong with them. Sharper
   * here than there, because the page they would have retyped from is behind a
   * blur.
   */
  const submitted = useRef<FormData | null>(null);

  const [state, formAction, pending] = useActionState(
    async (previous: FormResult | null, data: FormData) => {
      submitted.current = data;
      return action(previous, data);
    },
    null,
  );

  /** What the fields held when the sheet opened. Not re-read on submit -- see below. */
  const baseline = useRef('');
  useEffect(() => {
    baseline.current = fieldSnapshot(form.current);
  }, []);

  useEffect(() => {
    const element = form.current;
    if (!element) return;
    // Runs after React's own reset, which is what makes this a restore rather
    // than a race.
    if (state && !state.ok) restoreInto(element, submitted.current);
  }, [state]);

  /**
   * Escape, the backdrop and Cancel all dismiss the sheet, and a mis-aimed
   * click on the scrim is the cheapest way there is to lose a site address
   * somebody just typed in from a text message.
   *
   * The baseline is deliberately NOT re-taken on submit, unlike `SheetButton`'s.
   * That component re-baselines because its sheets stay open after a save and
   * the saved values stop being unsaved work -- but it means a REFUSED submit
   * re-baselines too, and a dismissal after one drops the values without asking.
   * These sheets close themselves on a successful save (the action redirects),
   * so the only submit they survive is a refused one, and the values on screen
   * after a refusal are exactly the work worth asking about.
   */
  function requestClose() {
    const dirty = fieldSnapshot(form.current) !== baseline.current;
    if (dirty && !window.confirm(discardPrompt)) return;
    router.push(closeHref, { scroll: false });
  }

  // Stable and unique on the page without `useId`, whose value is not a name
  // anything else can be written against. One record, one form.
  const formId = `edit-${recordId}`;

  return (
    <Sheet
      label={label}
      title={title}
      subtitle={subtitle}
      size={size}
      onClose={requestClose}
      footer={
        <>
          {/* `form` rather than nesting: the submit is pinned below the
              scrolling body, so on a phone -- and on a 720px laptop -- Save is
              reachable without scrolling past four groups of fields to find
              it. This is the difference that makes a long form work in a
              sheet at all. */}
          <Button
            type="submit"
            form={formId}
            variant="primary"
            size="lg"
            pending={pending}
            pendingLabel="Saving…"
          >
            {submitLabel}
          </Button>
          <Button type="button" variant="secondary" size="lg" onClick={requestClose}>
            Cancel
          </Button>
        </>
      }
    >
      <form ref={form} id={formId} action={formAction} className="grid gap-6 pb-1">
        <input type="hidden" name="id" value={recordId} />
        <FormError error={state && !state.ok ? state.error : null} />
        {children}
      </form>
    </Sheet>
  );
}
