/*
 * `self-start` is load-bearing, not tidiness.
 *
 * These fields sit in two-column grids, and a grid row stretches its items to
 * the tallest of them by default. So a field WITHOUT hint text, placed beside
 * one that has some, had its control grown to swallow the difference: a select
 * seventy pixels tall next to a forty-pixel input, and the two boxes starting
 * at different heights. It read as a rendering fault and it was on every
 * two-column form in the product -- edit a job, log a call, add a reminder.
 *
 * Fixing it here rather than adding `items-start` to seventeen grids means a
 * grid written tomorrow cannot reintroduce it.
 */

/**
 * Form primitives for the detail screens.
 *
 * The input is nested inside its `<label>` rather than wired to it by `id`.
 * Nesting cannot come apart: an `htmlFor` that drifts from its `id` -- after a
 * copy-paste, or when the same form renders twice on one page -- leaves a field
 * that a screen reader announces as unlabelled and a test cannot find, and
 * nothing about the rendered page looks wrong.
 *
 * Every control is at least 44px tall. `.field` already grows to 48px and 16px
 * type below `sm`, which is both the on-site touch target and what stops iOS
 * Safari zooming the page on focus.
 */

function Legend({ label, required }: { label: string; required?: boolean }) {
  return (
    <span className="t-small text-muted">
      {label}
      {/* The asterisk is decoration; `required` on the input is what a screen
          reader and the browser's own validation actually read. */}
      {required ? <span aria-hidden> *</span> : null}
    </span>
  );
}

type InputProps = Omit<React.ComponentProps<'input'>, 'className'> & {
  label: string;
  hint?: string;
  numeric?: boolean;
};

export function Field({ label, hint, numeric = false, ...input }: InputProps) {
  return (
    <label className="grid gap-1 self-start">
      <Legend label={label} required={input.required} />
      <input {...input} className={`field min-h-11 ${numeric ? 'field-num' : ''}`.trim()} />
      {hint ? <span className="t-small text-subtle">{hint}</span> : null}
    </label>
  );
}

type SelectProps = Omit<React.ComponentProps<'select'>, 'className' | 'children'> & {
  label: string;
  hint?: string;
  /** The blank first option. Omitted for a required field with a real default. */
  placeholder?: string;
  options: { value: string; label: string }[];
};

export function SelectField({ label, hint, placeholder, options, ...select }: SelectProps) {
  return (
    <label className="grid gap-1 self-start">
      <Legend label={label} required={select.required} />
      <select {...select} className="field min-h-11">
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <span className="t-small text-subtle">{hint}</span> : null}
    </label>
  );
}

type TextAreaProps = Omit<React.ComponentProps<'textarea'>, 'className'> & {
  label: string;
  hint?: string;
};

export function TextAreaField({ label, hint, ...area }: TextAreaProps) {
  return (
    <label className="grid gap-1 self-start">
      <Legend label={label} required={area.required} />
      {/* Three rows, not the 44px control floor every other field takes. A
          multi-line field whose minimum is one line tall is a single-line
          input that happens to wrap, and the fields using this hold
          exclusions, assumptions and payment terms -- paragraphs somebody has
          to be able to read back while typing them. */}
      <textarea {...area} className="field min-h-20" />
      {hint ? <span className="t-small text-subtle">{hint}</span> : null}
    </label>
  );
}

type CheckProps = Omit<React.ComponentProps<'input'>, 'className' | 'type'> & {
  label: string;
  hint?: string;
};

export function CheckField({ label, hint, ...input }: CheckProps) {
  return (
    <label className="flex min-h-11 items-center gap-3 self-start">
      <input {...input} type="checkbox" className="size-5 accent-accent" />
      <span className="grid">
        <span>{label}</span>
        {hint ? <span className="t-small text-subtle">{hint}</span> : null}
      </span>
    </label>
  );
}

/** A named group of fields, so a screen reader announces what a field is part of. */
export function FieldGroup({
  legend,
  children,
  columns = 2,
}: {
  legend: string;
  children: React.ReactNode;
  columns?: 1 | 2;
}) {
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-1 t-heading">{legend}</legend>
      <div className={`grid gap-3 ${columns === 2 ? 'sm:grid-cols-2' : ''}`.trim()}>{children}</div>
    </fieldset>
  );
}

/**
 * The action's own error, announced rather than merely printed: the person who
 * pressed Save may not be looking at the top of the form when it comes back.
 */
export function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p
      role="alert"
      className="rounded-panel border border-negative bg-negative-soft px-3 py-2 t-small text-negative-soft-fg"
    >
      {error}
    </p>
  );
}
