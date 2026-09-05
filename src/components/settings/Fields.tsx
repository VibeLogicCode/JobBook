/**
 * Labelled form controls, built on the `.field` token class.
 *
 * Presentational and server-rendered: no state, no effects, no 'use client'.
 * The forms they sit in are client components only because a submit result has
 * to be shown; the fields themselves are HTML, so a form still works while the
 * page's JavaScript is on its way.
 *
 * Every placeholder here is generic by rule, not by accident. A settings screen
 * is exactly where a placeholder like a real company's phone number would do
 * the most damage: the owner reads it as an example of what HIS deployment
 * should contain, and a tenant literal in a placeholder ships to every other
 * company that buys the product.
 */

interface FieldShell {
  name: string;
  label: string;
  hint?: React.ReactNode;
  /** Distinguishes controls when several forms share a page. */
  idPrefix?: string;
  disabled?: boolean;
  required?: boolean;
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

/** Spans both columns of the two-column grid. */
  wide?: boolean;
}

function controlId(prefix: string | undefined, name: string) {
  return prefix ? `${prefix}-${name}` : name;
}

function Shell({
  id,
  label,
  hint,
  required,
  wide,
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  required?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 self-start ${wide ? 'sm:col-span-2' : ''}`}>
      <label htmlFor={id} className="t-small font-semibold">
        {label}
        {required ? (
          <span className="text-negative" aria-hidden>
            {' *'}
          </span>
        ) : null}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="t-small text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  name,
  label,
  hint,
  idPrefix,
  disabled,
  required,
  wide,
  defaultValue,
  placeholder,
  type = 'text',
  inputMode,
  maxLength,
  pattern,
  numeric,
  suffix,
}: FieldShell & {
  defaultValue?: string | null;
  placeholder?: string;
  type?: 'text' | 'email' | 'url' | 'tel' | 'date' | 'number';
  inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url';
  maxLength?: number;
  pattern?: string;
  /** Right-aligned Plex Mono, for a figure rather than a name. */
  numeric?: boolean;
  suffix?: string;
}) {
  const id = controlId(idPrefix, name);
  const input = (
    <input
      id={id}
      name={name}
      type={type}
      defaultValue={defaultValue ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      inputMode={inputMode}
      maxLength={maxLength}
      pattern={pattern}
      aria-describedby={hint ? `${id}-hint` : undefined}
      className={`field ${numeric ? 'field-num' : ''} ${disabled ? 'opacity-60' : ''}`}
    />
  );

  return (
    <Shell id={id} label={label} hint={hint} required={required} wide={wide}>
      {suffix ? (
        <span className="flex items-center gap-2">
          {input}
          <span className="shrink-0 t-small text-muted">{suffix}</span>
        </span>
      ) : (
        input
      )}
    </Shell>
  );
}

export function TextAreaField({
  name,
  label,
  hint,
  idPrefix,
  disabled,
  required,
  defaultValue,
  placeholder,
  rows = 4,
}: FieldShell & { defaultValue?: string | null; placeholder?: string; rows?: number }) {
  const id = controlId(idPrefix, name);
  return (
    <Shell id={id} label={label} hint={hint} required={required} wide>
      <textarea
        id={id}
        name={name}
        rows={rows}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={`field ${disabled ? 'opacity-60' : ''}`}
      />
    </Shell>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({
  name,
  label,
  hint,
  idPrefix,
  disabled,
  required,
  wide,
  defaultValue,
  options,
  blankLabel,
}: FieldShell & {
  defaultValue?: string | null;
  options: Option[];
  /** Present when the column is nullable: the blank option is a real value. */
  blankLabel?: string;
}) {
  const id = controlId(idPrefix, name);
  return (
    <Shell id={id} label={label} hint={hint} required={required} wide={wide}>
      <select
        id={id}
        name={name}
        defaultValue={defaultValue ?? ''}
        disabled={disabled}
        required={required}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={`field ${disabled ? 'opacity-60' : ''}`}
      >
        {blankLabel ? <option value="">{blankLabel}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Shell>
  );
}

export function CheckboxField({
  name,
  label,
  hint,
  idPrefix,
  disabled,
  defaultChecked,
  wide,
}: FieldShell & { defaultChecked?: boolean }) {
  const id = controlId(idPrefix, name);
  return (
    <div className={`flex min-w-0 flex-col gap-1 self-start ${wide ? 'sm:col-span-2' : ''}`}>
      <label htmlFor={id} className="flex min-h-11 items-center gap-2 t-small font-semibold">
        <input
          id={id}
          name={name}
          type="checkbox"
          defaultChecked={defaultChecked}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="size-4 accent-[var(--accent)]"
        />
        {label}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="t-small text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A value the tenant cannot change here, shown so the screen is not silent about it. */
export function ReadOnlyField({
  label,
  hint,
  value,
  wide,
}: {
  label: string;
  hint?: React.ReactNode;
  value: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 self-start ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="t-small font-semibold">{label}</span>
      <span className="rounded-control border border-line bg-surface-2 px-2 py-1.5 t-small text-muted">
        {value}
      </span>
      {hint ? <p className="t-small text-subtle">{hint}</p> : null}
    </div>
  );
}

/** The two-column grid every settings form uses. One column below `sm`. */
export function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>;
}
