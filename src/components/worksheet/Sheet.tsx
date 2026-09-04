'use client';

import { X } from 'lucide-react';

/**
 * The bottom sheet, and the same panel centred on a wide screen.
 *
 * One component for both because the difference is a media query, not a
 * behaviour: a phone gets a grab handle and the full width at the bottom edge,
 * a desktop gets a 6px-radius panel in the middle, and the content inside knows
 * about neither.
 */
export function Sheet({
  label,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  /** The accessible name. Distinct per sheet, so a query matches one dialog. */
  label: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-end bg-black/40 sm:items-center sm:justify-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        // Escape closes the sheet from anywhere inside it, including from a
        // field: a sheet that can only be dismissed by finding its close button
        // is a trap for anyone working from the keyboard.
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          onClose();
        }}
        className="flex max-h-[85dvh] w-full flex-col rounded-t-[6px] border-t border-line-strong bg-surface shadow-pop sm:max-w-lg sm:rounded-[6px] sm:border"
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
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[4px] text-muted hover:bg-surface-2 hover:text-ink"
            onClick={onClose}
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">{children}</div>

        <div className="flex shrink-0 flex-wrap gap-2 border-t border-line p-4">{footer}</div>
      </div>
    </div>
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
