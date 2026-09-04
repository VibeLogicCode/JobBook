const TONES = {
  neutral: 'border-line-strong bg-surface-2 text-muted',
  info: 'border-info bg-info-soft text-info-soft-fg',
  warning: 'border-warning bg-warning-soft text-warning-soft-fg',
  negative: 'border-negative bg-negative-soft text-negative-soft-fg',
  positive: 'border-positive bg-positive-soft text-positive-soft-fg',
} as const;

/**
 * A block of prose that explains a constraint rather than reporting an event.
 *
 * Settings screens need these more than any other screen in the product:
 * "editing a tax rate inserts a new row" and "the timezone decides what date a
 * quote carries" are consequences the owner cannot see from the form itself,
 * and a tooltip is not where a consequence belongs.
 */
export function Notice({
  tone = 'neutral',
  title,
  children,
  role,
}: {
  tone?: keyof typeof TONES;
  title?: string;
  children: React.ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <div role={role} className={`rounded-[6px] border p-3 t-small ${TONES[tone]}`}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      {children}
    </div>
  );
}
