const TONES = {
  neutral: 'bg-neutral-soft text-neutral-soft-fg border-line-strong',
  positive: 'bg-positive-soft text-positive-soft-fg border-positive',
  negative: 'bg-negative-soft text-negative-soft-fg border-negative',
  warning: 'bg-warning-soft text-warning-soft-fg border-warning',
  info: 'bg-info-soft text-info-soft-fg border-info',
  accent: 'bg-accent-soft text-accent-soft-fg border-accent',
} as const;

export type Tone = keyof typeof TONES;

/**
 * A status chip: 4px radius, never a pill, and always carrying a word.
 * Colour never conveys state on its own.
 */
export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-[4px] border px-1.5 py-0.5 t-micro uppercase ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Quote status to tone. Every state is worded as well as coloured. */
export function statusTone(status: string, expired: boolean): Tone {
  if (expired) return 'warning';
  switch (status) {
    case 'accepted':
      return 'positive';
    case 'declined':
      return 'negative';
    case 'sent':
      return 'info';
    case 'superseded':
      return 'neutral';
    default:
      return 'accent';
  }
}
