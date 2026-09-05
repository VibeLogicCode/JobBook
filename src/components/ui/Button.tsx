import type { ButtonHTMLAttributes, Ref, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';
/** 44px is the floor everywhere; 48px is the on-site target the stylesheet
 *  already gives `.field` below `sm`, so a form's submit matches its inputs. */
export type ButtonSize = 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'border-line-strong bg-surface text-ink hover:bg-surface-2',
  // Outlined, not a solid red slab. Nothing in this product ships a filled
  // negative button, and the two destructive controls that exist (void a
  // customer, void a project) are already outlined -- a solid red primary
  // beside them would read as the louder of two dangers.
  danger: 'border-negative bg-surface text-negative hover:bg-negative-soft',
};

/**
 * Class builder shared by `<Button>` and any `<Link>` that has to look like
 * one. Exported so a link never re-describes the styling by hand: the six
 * places that already hand-rolled `min-h-11 rounded-control bg-accent ...` had
 * drifted into three different paddings between them.
 */
export function buttonClass(
  variant: ButtonVariant = 'primary',
  opts: { size?: ButtonSize; fullWidth?: boolean; className?: string } = {},
): string {
  const { size = 'md', fullWidth = false, className = '' } = opts;
  return [
    // `no-print`: a control is an affordance, and an affordance on paper is
    // ink spent on something nobody can press. The document itself comes from
    // the /print route, never from printing a working screen.
    'no-print inline-flex items-center justify-center gap-2 rounded-control border px-4 font-semibold',
    'whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-60',
    // A button sizes to its content. The owner has twice objected to one
    // stretching the width of a desk monitor, and `inline-flex` alone does not
    // prevent it: a grid or flex-column parent stretches its items on the
    // inline axis, which is how every one of those buttons got wide. `w-fit`
    // is what actually holds the width, so full-width is the opt-in.
    fullWidth ? 'w-full' : 'w-fit',
    size === 'lg' ? 'min-h-12' : 'min-h-11',
    VARIANTS[variant],
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
  /**
   * In flight: disables the button, marks it busy, and starts the spinner.
   *
   * Deliberately NOT defaulted to `false`. Passing the prop at all -- even as
   * `false` -- is what tells this component the button can go busy, and that
   * is what reserves the spinner's width up front (see `Busy` below). A button
   * that never awaits anything omits it and is laid out exactly as before.
   */
  pending?: boolean;
  /**
   * What the button says while pending -- "Saving…", "Creating…", "Voiding…".
   * A verb in the present participle is the house convention because it names
   * the thing that is happening; a spinner alone says only "something".
   */
  pendingLabel?: ReactNode;
  /**
   * React 19 passes `ref` as an ordinary prop, and `{...rest}` already puts it
   * on the <button>; this only tells the type system so. `SubmitButton` needs
   * it to reach the <form> the button belongs to.
   */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * The busy mark: a ring with its top edge cut out, turning.
 *
 * `border-current` rather than a named line token, because this sits INSIDE a
 * button and has to be legible on all three variants -- on `primary` a
 * hairline grey ring over a saturated fill is invisible, and the fix is not a
 * fourth colour but taking the label's own.
 *
 * `motion-reduce:animate-none` states the intent locally. The stylesheet
 * already collapses every animation to 0.01ms under `prefers-reduced-motion`,
 * which leaves this frozen at the angle it started at -- a static cut ring,
 * which still reads as a busy mark, so somebody who asked for less motion gets
 * an indicator rather than nothing. Saying it here as well means the next
 * person to edit that global rule cannot quietly set this spinning again.
 *
 * `aria-hidden` because it is decoration twice over: the button carries
 * `aria-busy`, and the label beside it has already changed to a verb.
 */
function BusyMark() {
  return (
    <span
      aria-hidden
      className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
    />
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className = '',
  pending,
  pendingLabel,
  disabled,
  children,
  // Defaulted rather than left to the DOM: a bare <button> inside a form
  // submits it, so an unrelated row control was posting the form it sat in.
  type = 'button',
  ...rest
}: ButtonProps) {
  const busy = pending === true;

  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={buttonClass(variant, { size, fullWidth, className })}
    >
      {pending === undefined ? (
        children
      ) : (
        <Busy busy={busy} pendingLabel={pendingLabel}>
          {children}
        </Busy>
      )}
    </button>
  );
}

/**
 * Both labels, stacked in one grid cell, so the button is always as wide as
 * the wider of the two and NEVER changes size when it goes busy.
 *
 * This is the whole reason the pending label is not simply swapped in. "Save
 * quote" and "Saving…" beside a spinner are different widths; swapping them
 * moves the button's right edge while a finger or a cursor is still on it, and
 * the second press -- the one somebody makes because nothing appeared to
 * happen -- lands on whatever slid underneath. A control that resizes under
 * the pointer is a control that mis-fires.
 *
 * The inactive copy stays in the layout (`invisible` is `visibility: hidden`,
 * which reserves its box) and leaves the accessibility tree (`aria-hidden`),
 * so the accessible name is one label at a time -- "Save quote", then
 * "Saving…" -- rather than the two concatenated.
 */
function Busy({
  busy,
  pendingLabel,
  children,
}: {
  busy: boolean;
  pendingLabel?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <span className="grid items-center justify-items-center">
      <span
        aria-hidden={busy || undefined}
        className={`col-start-1 row-start-1 inline-flex items-center gap-2 ${busy ? 'invisible' : ''}`}
      >
        {children}
      </span>
      <span
        aria-hidden={busy ? undefined : true}
        className={`col-start-1 row-start-1 inline-flex items-center gap-2 ${busy ? '' : 'invisible'}`}
      >
        <BusyMark />
        {pendingLabel ?? children}
      </span>
    </span>
  );
}
