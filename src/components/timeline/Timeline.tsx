import { Pill, type Tone } from '@/components/ui/Pill';
import { EmptyState } from '@/components/detail/Panel';
import { ACTIVITY_KINDS, type ActivityKindName } from '@/components/reminders/labels';
import type { ActivityRow } from '@/lib/reminders/repository';

/**
 * What has happened against one record, newest first.
 *
 * Ordered by `occurred_at` and never by `created_at` -- the repository already
 * does that, and it is the reason there are two columns. An owner who logs
 * Tuesday's call on Thursday must read it under Tuesday, or the timeline is a
 * record of his typing rather than of the job, and it is the kind of lie
 * nobody notices until they are reconstructing a dispute.
 *
 * The stamp is rendered in the tenant's zone and locale, for the same reason:
 * a call at 9pm belongs to that evening, not to the next morning.
 */

/**
 * Inbound and outbound are toned apart, and both carry their word.
 *
 * Whose turn it is is the one question the owner is reading this to answer, so
 * "Email received" and "Email sent" have to be distinguishable while
 * scrolling -- but never by colour alone.
 */
const KIND_TONES: Record<ActivityKindName, Tone> = {
  call_in: 'info',
  call_out: 'accent',
  email_in: 'info',
  email_out: 'accent',
  sms: 'accent',
  site_visit: 'neutral',
  meeting: 'neutral',
  note: 'neutral',
};

export function Timeline({
  entries,
  locale,
  timeZone,
}: {
  entries: readonly ActivityRow[];
  locale: string;
  timeZone: string;
}) {
  if (entries.length === 0) {
    return (
      <EmptyState>
        Nothing logged yet. Log a call, email or visit — the follow-up rules read this.
      </EmptyState>
    );
  }

  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone });
  const withTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
  // Both in the tenant's zone, which decides which DAY an evening belongs to
  // as well as what the clock reads.
  const clock = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  });

  /**
   * A backdated entry gets a date and no time.
   *
   * Somebody logging Tuesday's call on Thursday knows the day and not the
   * minute; the repository stores that as the tenant's midnight, and printing
   * it back as "12:00 a.m." claims a precision nobody entered. An activity
   * logged as it happens keeps its time, because that one is real.
   */
  const stamp = (at: Date): string =>
    (clock.format(at) === '00:00' ? day : withTime).format(at);

  return (
    <ol className="grid gap-3">
      {entries.map((entry) => (
        <li key={entry.id} className="grid gap-1 border-l-2 border-line pl-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Pill tone={KIND_TONES[entry.kind]}>{ACTIVITY_KINDS[entry.kind]}</Pill>
            <span className="num t-small text-muted">{stamp(entry.occurredAt)}</span>
            {entry.durationMinutes !== null ? (
              <span className="t-small text-muted">
                <span className="num">{entry.durationMinutes}</span> min
              </span>
            ) : null}
          </div>
          {entry.subject ? <p className="font-semibold">{entry.subject}</p> : null}
          {/* Pre-wrapped: a pasted email keeps its paragraphs, and an email
              reflowed into one block is one nobody reads back. */}
          {entry.body ? (
            <p className="max-w-prose whitespace-pre-wrap t-small text-muted">{entry.body}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
