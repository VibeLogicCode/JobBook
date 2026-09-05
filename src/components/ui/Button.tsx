import type { ButtonHTMLAttributes, ReactNode } from 'react';

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
  /** In flight: disables the button and marks it busy. */
  pending?: boolean;
  /**
   * What the button says while pending -- "Saving…", "Creating…", "Voiding…".
   * A verb in the present participle is the house convention because it names
   * the thing that is happening; a spinner alone says only "something".
   */
  pendingLabel?: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className = '',
  pending = false,
  pendingLabel,
  disabled,
  children,
  // Defaulted rather than left to the DOM: a bare <button> inside a form
  // submits it, so an unrelated row control was posting the form it sat in.
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={buttonClass(variant, { size, fullWidth, className })}
    >
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
}
