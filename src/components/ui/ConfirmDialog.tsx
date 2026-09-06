'use client';

import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';

/**
 * One confirmation, asked before a press that has a consequence -- built once
 * and reused, rather than a hand-rolled dialog at every call site that fires
 * destructively on a single tap.
 *
 * On `Sheet` rather than a second overlay: the focus trap, Escape, the
 * backdrop blur and the scroll lock already live there, and a confirmation is
 * not a different kind of dialog -- it is a shorter one, with no fields to
 * fill in.
 *
 * WHAT THIS DOES NOT DO. It does not soften "this cannot be undone" into the
 * copy for you, because that sentence is often false here: voiding a line and
 * marking a quote sent are both status changes, not deletions. `detail` is
 * where the caller says what actually happens -- in one line -- and the
 * component enforces nothing about that beyond giving it a line to be short
 * in.
 *
 * The two buttons are asymmetric on purpose. `cancelLabel` takes the wider,
 * `flex-1` slot and claims focus on open (`autoFocus`, which also stops
 * `Sheet`'s own effect from focusing the panel instead -- it only does that
 * when nothing inside has already claimed focus) -- so a mis-aimed tap, an
 * early Enter, or a reflexive second press after the one that opened this
 * all land on the safe answer. The confirm button keeps its own colour
 * (`destructive` -> the same outlined red as every other destructive control
 * in the product) and its own width, no wider than its label -- it is not
 * hidden, only not the one a stray touch reaches first.
 */
export function ConfirmDialog({
  label,
  title,
  detail,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = true,
  confirmPendingLabel,
  pending,
  onClose,
  onConfirm,
}: {
  /** The dialog's accessible name. Names the thing being acted on, so which
   *  one is never in doubt if more than one row could ever open this. */
  label: string;
  /** The question, in one line -- "Void this line?", never "Are you sure?" */
  title: React.ReactNode;
  /** The specifics, in one line: what it is, the number attached to it where
   *  one exists, and what actually happens -- never a claim the press cannot
   *  be undone unless that claim is true. */
  detail?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /**
   * Styles the confirm button `danger` red and defaults its pending label to
   * "Working…" rather than "Saving…" -- the same rule `ActionForm` already
   * applies to a destructive submit. True by default: most presses this
   * primitive exists for are destructive, and a caller confirming something
   * merely consequential (a status that moves forward but removes nothing)
   * opts out.
   */
  destructive?: boolean;
  /** Overrides the pending verb; the default is right for most callers. */
  confirmPendingLabel?: React.ReactNode;
  /** In flight: disables both buttons and marks the confirm button busy. */
  pending?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Sheet
      label={label}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="flex-1"
            autoFocus
            disabled={pending}
            onClick={onClose}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? 'danger' : 'primary'}
            size="lg"
            pending={pending}
            pendingLabel={confirmPendingLabel ?? (destructive ? 'Working…' : 'Saving…')}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {detail ? <p className="t-small pb-2 text-muted">{detail}</p> : null}
    </Sheet>
  );
}
