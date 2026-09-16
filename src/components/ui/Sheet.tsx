'use client';

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { REFUSED_EVENT, SAVED_EVENT } from '@/components/ui/saved-event';
import { isDirty, openBaseline, refused, submitted, type DirtyBaseline } from '@/components/ui/dirty-baseline';
import { Button, type ButtonVariant } from '@/components/ui/Button';

/**
 * The bottom sheet, and the same panel centred on a wide screen.
 *
 * One component for both because the difference is a media query, not a
 * behaviour: a phone gets a grab handle and the full width at the bottom edge,
 * a desktop gets a 6px-radius panel in the middle, and the content inside knows
 * about neither.
 *
 * The modal behaviour below is ported from the sibling project's `RowDialog`,
 * which had already learned it the hard way. What is NOT taken is its shape:
 * that component is centred at every width, and a centred box is the wrong
 * answer on a phone held one-handed in a basement, which is where this one is
 * actually used. So the behaviour is theirs and the geometry stays ours.
 */

/**
 * Nothing hand-rolled keeps Tab inside an overlay on its own -- only a native
 * `<dialog>.showModal()` does, and this product hand-rolls its overlays rather
 * than take a dialog library for one component.
 *
 * `input[type="hidden"]` is excluded even though the bare `input` selector
 * would otherwise match it: a hidden field can never take focus in a real
 * browser, and counting it as a stop breaks the wrap-around by one at both
 * ends. The list is read fresh on every Tab rather than cached at open,
 * because a sheet's own controls can add or remove focusable elements while it
 * stays open -- adding a measurement row is exactly that.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(container: HTMLElement, event: ReactKeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return;
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * How wide the panel is allowed to get ONCE IT IS CENTRED -- from `sm` up, and
 * never below it.
 *
 * Below `sm` there is no choice to make: the sheet is the full width of the
 * phone, at the bottom edge, with the grab handle. That shape was picked over
 * the sibling project's always-centred dialog on purpose and none of these
 * touch it.
 *
 * Above `sm` there is a real choice, and one answer was wrong for half the
 * callers. `md` is what every sheet used to be: right for the four measurement
 * boxes it was written for, and wrong for a ten-field two-column form, which at
 * 512px gives each column about 220px and scrolls -- a phone layout stranded in
 * the middle of a desktop, which is exactly what the owner reported. So the
 * width is the caller's to state, and the default is what the callers that
 * already existed were getting.
 */
const WIDTHS = {
  /** Two or three fields, or a list to pick from. The original, and the default. */
  md: 'sm:max-w-lg',
  /** A real form: a two-column grid whose columns want to be readable. */
  lg: 'sm:max-w-2xl',
  /** A table inside a sheet -- columns that cannot be narrowed without lying. */
  xl: 'sm:max-w-4xl',
} as const;

export type SheetSize = keyof typeof WIDTHS;

export function Sheet({
  label,
  title,
  subtitle,
  onClose,
  size = 'md',
  toolbar,
  children,
  footer,
}: {
  /** The accessible name. Distinct per sheet, so a query matches one dialog. */
  label: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  /** The centred width from `sm` up. The phone shape is not affected. */
  size?: SheetSize;
  /**
   * Pinned under the header, outside the scrolling body: a search box that
   * scrolls away from the list it filters is worse than no search box, because
   * the person has to scroll back up to correct a typo.
   */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  /** Omitted where the sheet has no terminating action -- picking from a list
   *  IS the action, and a lone Cancel below it would be a control invented to
   *  fill a slot. */
  footer?: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  /**
   * Who had focus immediately before this opened, so closing it puts focus
   * back on the row that was tapped rather than dumping it at the top of the
   * document.
   *
   * Captured during RENDER rather than in the effect below, and that is
   * load-bearing here: `Measurement` takes an `autoFocus`, and React handles
   * `autoFocus` with a real `.focus()` call in the COMMIT phase, which runs
   * before any effect. Reading `document.activeElement` from an effect would
   * therefore capture the just-focused input as "the opener". Render runs
   * strictly before commit, so this is the last moment it still names the real
   * trigger.
   *
   * `undefined` means not yet read; `null` is a legitimate answer (nothing had
   * focus), which is why the check is against `undefined` rather than falsy.
   * The `document` guard is for the server pass, where there is no activeElement
   * and the sheet is not interactive anyway.
   */
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (openerRef.current === undefined) {
    openerRef.current = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);
  }

  /**
   * The three things a modal owes somebody working from a keyboard or a screen
   * reader. Empty dependency array on purpose: this component is only rendered
   * while it is open, so a fresh mount already is a fresh open. A caller
   * switching which ROW the sheet edits without closing it first must pass a
   * `key` that changes with the row id, or the effect will not re-run.
   */
  useEffect(() => {
    // Only if nothing inside has already claimed it: a sheet whose first field
    // carries `autoFocus` has a better answer than the shell does, and stealing
    // focus back a moment later would undo it.
    if (!panelRef.current?.contains(document.activeElement)) {
      panelRef.current?.focus();
    }

    // Or a touch scroll moves the page behind a scrim the person can no longer
    // see, and closing the sheet leaves them somewhere they did not navigate to.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus();
    };
  }, []);

  /**
   * Escape, listened for on the DOCUMENT rather than on the panel.
   *
   * It used to be a case inside the panel's own `onKeyDown`, which works only
   * while focus is still inside the panel -- and focus does not always stay
   * there. Measured on the rate editor: submitting the form re-renders the
   * button that was pressed, focus lands back on `<body>`, and from that
   * moment Escape did nothing at all. A modal that stops answering Escape
   * after its own save is the trap this behaviour exists to prevent, and
   * nothing on screen would ever say so.
   *
   * `keydown` on the document, in the bubble phase, so a control that
   * legitimately consumes Escape -- an open native select, a date picker --
   * still gets it first.
   */
  useEffect(() => {
    function onEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [onClose]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (panelRef.current) trapTab(panelRef.current, event);
  }

  return (
    <div
      // The blur is not decoration. A worksheet is a dense grid of numbers, and
      // a flat 40% scrim over it leaves every one of them legible enough to
      // keep reading -- so the eye stays on the table it cannot edit instead of
      // the one field it opened the sheet to change.
      className="fixed inset-0 z-30 flex items-end bg-black/50 backdrop-blur-sm sm:items-center sm:justify-center"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        // Stops a click anywhere inside the panel bubbling to the scrim above,
        // so pressing a control -- or empty space beside one -- never closes
        // the sheet. Only the scrim itself does.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        // `max-h-[85dvh]` with a `flex-col` inside it is what keeps a WIDER
        // panel from becoming a TALLER one that runs off a short laptop: the
        // header, the toolbar and the footer are all `shrink-0` and the body
        // between them is the only thing that grows, so the save button stays
        // on screen at 720px of viewport and the form scrolls under it.
        /**
         * `outline-none` was hiding the focus landing: this panel takes
         * programmatic focus when the sheet opens, so with the outline
         * suppressed a keyboard user was given focus with nothing on screen
         * saying where it went. `focus-visible:outline-none` keeps the panel
         * itself quiet for a POINTER open -- where the ring would be noise --
         * while the browser still draws it for anything focus-visible inside.
         */
        className={`flex max-h-[85dvh] w-full flex-col rounded-t-panel border-t border-line-strong bg-surface shadow-pop focus-visible:outline-none sm:rounded-panel sm:border ${WIDTHS[size]}`}
      >
        <div
          aria-hidden
          className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-[2px] bg-line-strong sm:hidden"
        />

        <div className="flex shrink-0 items-start justify-between gap-3 p-4 pb-2">
          <div className="min-w-0">
            <p className="t-heading">{title}</p>
            {subtitle ? <p className="t-small text-muted">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-ink"
            onClick={onClose}
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        {toolbar ? <div className="shrink-0 px-4 pb-2">{toolbar}</div> : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">{children}</div>

        {footer ? (
          <div className="flex shrink-0 flex-wrap gap-2 border-t border-line p-4">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What every field inside `root` currently holds, as one comparable string.
 *
 * Read off the DOM rather than out of React state on purpose: the sheets this
 * serves are handed SERVER-rendered forms as children -- plain `<input>` and
 * `<select>` elements with `defaultValue`, whose current value React never
 * sees. A `FormData` would miss the same values for the same reason, and would
 * also miss an unchecked checkbox, which is exactly the edit somebody would be
 * annoyed to lose.
 *
 * Hidden fields are skipped because they carry the row id, not the person's
 * work, and a submit button's value is not an edit either.
 *
 * Exported so a sheet that is NOT opened by `SheetButton` -- the record
 * editors, which open from `?edit=1` so the URL stays linkable -- can ask the
 * same question the same way rather than keeping a second, drifting copy of
 * what counts as a dirty form.
 */
export function fieldSnapshot(root: HTMLElement | null): string {
  if (!root) return '';
  const parts: string[] = [];
  for (const element of root.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >('input, select, textarea')) {
    if (element instanceof HTMLInputElement) {
      if (element.type === 'hidden' || element.type === 'submit' || element.type === 'button') {
        continue;
      }
      if (element.type === 'checkbox' || element.type === 'radio') {
        parts.push(`${element.name}=${element.checked}`);
        continue;
      }
    }
    parts.push(`${element.name}=${element.value}`);
  }
  // One field per line. A newline inside a textarea can forge a boundary, but
  // the worst a collision does here is fail to notice an edit that swapped
  // text between two fields -- and it costs nothing to read in a debugger,
  // which a control character would not.
  return parts.join('\n');
}

/**
 * A button that opens its children in a `Sheet`.
 *
 * The shape the owner asked for on the rate list and the cost codes: a press,
 * then the form over a blurred page -- rather than a `<details>` that shoves
 * the table it belongs to halfway down the screen the moment it opens.
 *
 * It exists so a SERVER component can have one. The page renders the form as
 * children and never becomes a client component itself; only the open/shut of
 * the sheet lives in the browser, which is all that ever needed to.
 *
 * WHAT BELONGS IN ONE, and what does not. A form -- a focused task with a
 * consequence, read and filled in before it is agreed to -- belongs here. A
 * confirm that belongs to ONE ROW, where the answer turns on being able to
 * keep looking at that row, does NOT: it stays anchored where it is, which is
 * why "Retire this item" is still a `RowAction` with a plain browser confirm
 * rather than a second sheet nested inside this one.
 *
 * `discardPrompt` is not optional in spirit. Escape and a backdrop click both
 * dismiss a `Sheet`, and a modal that throws away a half-typed entry on a
 * mis-aimed click is worse than the disclosure it replaced. Passing it makes
 * the dismissal ask first, and only when something inside actually changed.
 */
export function SheetButton({
  trigger,
  label,
  title,
  subtitle,
  size = 'lg',
  variant = 'secondary',
  discardPrompt,
  children,
}: {
  /** What the button says. */
  trigger: React.ReactNode;
  /** The dialog's accessible name. Name the ROW, so which one is never in doubt. */
  label: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /**
   * `lg` by default, unlike `Sheet` itself: what opens from a button on a row
   * is a form, and a form is the thing the narrow default was wrong for.
   */
  size?: SheetSize;
  variant?: ButtonVariant;
  /**
   * Asked before Escape, the backdrop or Close throw away an edit. Omitted
   * only where the sheet holds nothing anybody types.
   */
  discardPrompt?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /**
   * What counts as "clean" right now, and what it falls back to if the submit
   * in flight is refused. See `dirty-baseline.ts` for the rule this follows
   * and why it is not simply "the fields as they were when the sheet opened".
   */
  const baseline = useRef<DirtyBaseline>(openBaseline(''));

  /**
   * Taken after the children have mounted, which is what this effect being in
   * the PARENT buys: `Sheet` and everything inside it has committed by the
   * time it runs, so the reading is of real fields rather than of nothing.
   */
  useEffect(() => {
    if (open) baseline.current = openBaseline(fieldSnapshot(bodyRef.current));
  }, [open]);

  /**
   * A save closes the sheet, because the thing it was open for is done.
   *
   * It used to stay open with a success notice inside it, so the answer to
   * "did that work?" was a paragraph rather than the row behind it visibly
   * changing -- and the row IS the answer, because the action revalidates the
   * page underneath. The owner asked exactly that question, which is the
   * clearest evidence the notice was not answering it.
   *
   * A DOM event rather than a prop, because this shell's children are
   * server-rendered: it holds no state of theirs and cannot be handed a result
   * it never receives. A REFUSAL does not fire this, so a rejected save leaves
   * the sheet open with the reason and the typing still in it -- which is the
   * one case where staying open is right.
   *
   * No discard prompt on this path. There is nothing left to discard.
   */
  useEffect(() => {
    const body = bodyRef.current;
    if (!open || !body) return;
    const close = () => setOpen(false);
    body.addEventListener(SAVED_EVENT, close);
    return () => body.removeEventListener(SAVED_EVENT, close);
  }, [open]);

  /**
   * The other half of the fix above: undo the submit handler's guess once a
   * refusal proves it wrong, so the sheet is exactly as dirty as it was
   * before that submit was ever attempted.
   */
  useEffect(() => {
    const body = bodyRef.current;
    if (!open || !body) return;
    const rollback = () => {
      baseline.current = refused(baseline.current);
    };
    body.addEventListener(REFUSED_EVENT, rollback);
    return () => body.removeEventListener(REFUSED_EVENT, rollback);
  }, [open]);

  function requestClose() {
    const dirty = isDirty(baseline.current, fieldSnapshot(bodyRef.current));
    if (discardPrompt && dirty && !window.confirm(discardPrompt)) return;
    setOpen(false);
  }

  return (
    <>
      <Button type="button" variant={variant} className="t-small" onClick={() => setOpen(true)}>
        {trigger}
      </Button>

      {open ? (
        <Sheet label={label} title={title} subtitle={subtitle} size={size} onClose={requestClose}>
          {/* A submit is a save, so what was typed stops being unsaved work and
              the guard above has to stop asking about it -- that is the
              common case, and it is assumed here, synchronously, before
              anything downstream knows whether the server will agree.
              Caught on the way up from whichever form inside fired it,
              because this shell holds no form of its own and the children
              are server-rendered. When the server instead REFUSES, the
              `REFUSED_EVENT` listener above rolls this guess back to what it
              was before the submit, so the guard is exactly as it would have
              been had the submit never happened -- the error shows, the
              typed values are still there (`ActionForm`'s `restoreInto`), and
              a dismissal after this still asks. */}
          <div
            ref={bodyRef}
            onSubmit={() => {
              baseline.current = submitted(baseline.current, fieldSnapshot(bodyRef.current));
            }}
          >
            {children}
          </div>
        </Sheet>
      ) : null}
    </>
  );
}

/**
 * A labelled numeric field, 48px at every width.
 *
 * 48px rather than the 44px floor because these are the fields used on site,
 * standing in a basement holding a tape measure, and `inputMode="decimal"`
 * because a phone that shows a QWERTY keyboard for a square footage costs more
 * taps than the whole edit is worth.
 */
export function Measurement({
  label,
  unit,
  value,
  onChange,
  autoFocus = false,
}: {
  label: string;
  unit?: string;
  value: string;
  onChange: (next: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="grid gap-1">
      <span className="t-small text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <input
          className="field field-num min-h-12"
          inputMode="decimal"
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
        />
        {/* Inside the <label>, so the unit is part of the field's accessible
            name as well as sitting beside it on screen. */}
        {unit ? <span className="w-12 shrink-0 t-small text-muted">{unit}</span> : null}
      </span>
    </label>
  );
}
