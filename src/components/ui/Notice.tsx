import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';

/** The tone names are `Pill`'s, not a second vocabulary: one word for one
 *  meaning across the product is worth more than a tone named for the feeling
 *  it produces. `accent` is absent -- a notice reports an outcome, and the
 *  brand colour is not an outcome. */
export type NoticeTone = 'neutral' | 'info' | 'positive' | 'warning' | 'negative';

const TONES = {
  neutral: { wrap: 'border-line-strong bg-surface-2 text-muted', Icon: Info },
  info: { wrap: 'border-info bg-info-soft text-info-soft-fg', Icon: Info },
  positive: { wrap: 'border-positive bg-positive-soft text-positive-soft-fg', Icon: CircleCheck },
  warning: { wrap: 'border-warning bg-warning-soft text-warning-soft-fg', Icon: TriangleAlert },
  negative: { wrap: 'border-negative bg-negative-soft text-negative-soft-fg', Icon: CircleAlert },
} as const;

/**
 * A banner reporting what just happened, or the constraint the person is about
 * to run into.
 *
 * The icon and the fill are both redundant. Neither carries the meaning: the
 * sentence does, and a caller that writes "Done" and leans on green has
 * written a notice that says nothing to a person who cannot see the green or
 * is reading it on a fax of a printout.
 *
 * `role` defaults from the tone rather than being required, because the two
 * tones that report an EVENT are the two that need announcing: an error
 * interrupts (`alert`), a success is polite (`status`), and neutral, info and
 * warning are usually prose that was on the page before anybody pressed
 * anything -- announcing those on load talks over the screen a person is
 * still reading. An event in one of those tones passes `role` explicitly.
 */
export function Notice({
  tone = 'neutral',
  title,
  children,
  role,
  className = '',
}: {
  tone?: NoticeTone;
  title?: React.ReactNode;
  children: React.ReactNode;
  role?: 'alert' | 'status';
  className?: string;
}) {
  const { wrap, Icon } = TONES[tone];
  const resolvedRole = role ?? (tone === 'negative' ? 'alert' : tone === 'positive' ? 'status' : undefined);

  return (
    <div role={resolvedRole} className={`flex items-start gap-2 rounded-panel border p-3 t-small ${wrap} ${className}`.trim()}>
      <Icon size={16} aria-hidden className="mt-0.5 shrink-0" />
      <div className="grid gap-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}
