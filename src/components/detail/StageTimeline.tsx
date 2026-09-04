import { Pill } from '@/components/ui/Pill';
import { EmptyState } from '@/components/detail/Panel';
import { PROJECT_STAGES, stageTone, type ProjectStage } from '@/components/detail/labels';

export interface StageEntry {
  id: string;
  fromStage: ProjectStage | null;
  toStage: ProjectStage;
  changedAt: Date;
  note: string | null;
}

/**
 * How long the job sat in each stage, computed from the transition rows rather
 * than read from a column.
 *
 * There is no stored duration to read: a stored one is stale the moment the
 * clock moves past it, so the rows are the record and the arithmetic happens
 * at the point of display. The last row runs to now, which is why the newest
 * entry is the only one that keeps growing.
 */
function daysInStage(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

function spell(days: number): string {
  if (days === 0) return 'under a day';
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function StageTimeline({
  entries,
  locale,
  timeZone,
}: {
  /** Oldest first. Each entry's duration is measured against the next one. */
  entries: StageEntry[];
  /** From the organization record: a UTC container renders a 9pm transition on
   *  the following day, which puts the change on the wrong side of a month. */
  locale: string;
  timeZone: string;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState>
        No stage history yet. It is written automatically the first time this job moves.
      </EmptyState>
    );
  }

  const stamp = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
  const now = Date.now();

  return (
    <ol className="grid gap-0">
      {entries.map((entry, index) => {
        const next = entries[index + 1];
        const until = next ? next.changedAt : new Date(now);
        const days = daysInStage(entry.changedAt, until);
        const current = !next;

        return (
          <li
            key={entry.id}
            className="grid gap-x-3 gap-y-1 border-l-2 border-line py-2 pl-4 sm:grid-cols-[auto_1fr_auto] sm:items-center"
          >
            <span className="flex items-center gap-2">
              <Pill tone={stageTone(entry.toStage)}>{PROJECT_STAGES[entry.toStage]}</Pill>
              {current ? <span className="t-small text-muted">now</span> : null}
            </span>
            <span className="num t-small text-muted">{stamp.format(entry.changedAt)}</span>
            <span className="t-small sm:text-right">
              {spell(days)}
              {current ? ' so far' : ''}
            </span>
            {entry.note ? (
              <span className="t-small text-muted sm:col-span-3">{entry.note}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
