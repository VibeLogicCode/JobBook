import Link from 'next/link';
import { Pill } from '@/components/ui/Pill';
import { ReminderActions } from '@/components/reminders/ReminderActions';
import {
  REMINDER_KINDS,
  URGENCY_HEADINGS,
  URGENCY_TONES,
  urgencyChip,
  type Urgency,
} from '@/components/reminders/labels';
import { groupByUrgency } from '@/components/reminders/urgency';
import { describeEntities, entityKey, type EntityRef, type ReminderRow } from '@/lib/reminders/repository';

/**
 * The reminder list, grouped by how late it is.
 *
 * A flat list ordered by date is technically the same information and is not
 * the same screen. What the owner is doing on a Tuesday morning is triage:
 * what is late, what is today, what did I push and what is coming. Grouping
 * answers that in one look; a flat list makes him read every date and do the
 * subtraction himself, and a screen that asks for arithmetic before it gives
 * an answer is a screen he stops opening.
 *
 * Overdue is first, always, and carries a rule down its left edge as well as
 * its chip -- but the chip carries the WORD, because colour never conveys
 * state on its own here and the owner reads this on a phone in daylight.
 *
 * One DOM tree. The row is a wrapping flex column, so the same markup is a
 * line on a desk monitor and a small card on a phone; there is no second
 * render path to drift.
 */

export interface ReminderListProps {
  rows: readonly ReminderRow[];
  /** The tenant's today. Never the server's, and never the browser's. */
  today: string;
  /** Which piles to draw. Today's panel leaves out what is merely coming up. */
  only?: readonly Urgency[];
  /** `3` when the list sits inside a card whose header is already the h2. */
  headingLevel?: 2 | 3;
  /**
   * The Today panel: one line per reminder and Done as the only control.
   *
   * The full row carries a kind, any snooze wording, the detail body and four
   * controls. That is right on the reminders screen, which is where the list is
   * shaped; on a panel of three rows it cost 276px each on a phone and pushed
   * the week's figures off the bottom of the screen -- which was the owner's
   * complaint. What survives here is what a glance needs: how late it is, what
   * it is about, and a way to tick it off.
   */
  compact?: boolean;
  /** Drawn when nothing survives the grouping. Says "you are on top of it". */
  empty: React.ReactNode;
}

export async function ReminderList({
  rows,
  today,
  only,
  headingLevel = 2,
  compact = false,
  empty,
}: ReminderListProps) {
  const groups = groupByUrgency(rows, today, only);

  if (groups.length === 0) {
    // An empty reminder list is good news and has to read as good news. A
    // blank panel reads as a query that failed, and the owner's next move
    // after "is this broken?" is to stop opening it.
    return <div className="px-4 py-4 t-small text-muted">{empty}</div>;
  }

  // One pass for every entity on the screen rather than a lookup per row: a
  // list of twenty reminders costs three queries.
  const refs = await describeEntities(rows.map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
  })));

  const Heading = headingLevel === 3 ? 'h3' : 'h2';

  // The list carries its own radius and clips itself, rather than the card
  // clipping: `Card` deliberately does not hide its overflow, and the group
  // headings paint a fill all the way to the edge.
  return (
    <div className="grid overflow-hidden rounded-panel">
      {groups.map((group) => (
        <section key={group.urgency}>
          <Heading className="flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-1.5 t-micro uppercase text-muted">
            {URGENCY_HEADINGS[group.urgency]}
            <span className="num">{group.rows.length}</span>
          </Heading>
          <ul className="divide-y divide-line">
            {group.rows.map(({ reminder, urgency }) => (
              <ReminderItem
                key={reminder.id}
                reminder={reminder}
                urgency={urgency}
                today={today}
                about={refs.get(entityKey(reminder.entityType, reminder.entityId))}
                compact={compact}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ReminderItem({
  reminder,
  urgency,
  today,
  about,
  compact,
}: {
  reminder: ReminderRow;
  urgency: Urgency;
  today: string;
  about: EntityRef | undefined;
  compact: boolean;
}) {
  const settled = urgency === 'done' || urgency === 'dismissed';

  return (
    <li
      // The left rule is redundant with the chip on purpose: the chip is what
      // says WHY, and the rule is what the eye finds while scrolling past
      // eleven rows. Neither is load-bearing alone.
      className={`flex px-4 ${
        compact ? 'flex-row items-start gap-3 py-2' : 'flex-col gap-2 py-3'
      } ${
        urgency === 'overdue' ? 'border-l-2 border-negative bg-negative-soft' : ''
      }`}
    >
      <div
        className={`flex items-baseline gap-x-3 gap-y-1 ${
          compact ? 'min-w-0 flex-1 flex-nowrap' : 'flex-wrap'
        }`}
      >
        <Pill tone={URGENCY_TONES[urgency]}>{urgencyChip(urgency, reminder, today)}</Pill>
        <span className={`min-w-0 flex-1 ${compact ? '' : 'basis-64'}`}>
          <span className={`block ${compact ? 'truncate' : ''} ${settled ? 'text-muted' : ''}`}>
            {reminder.title}
          </span>
          <span className={`t-small text-muted ${compact ? 'block truncate' : ''}`}>
            {about ? (
              <Link href={about.href} className="text-accent-text hover:underline">
                {about.label}
              </Link>
            ) : (
              // Polymorphic reference, so the database cannot enforce it.
              // Nothing is ever deleted here, so a miss is a bug rather than
              // ordinary use -- and it says so rather than rendering blank.
              <span className="text-subtle">record not found</span>
            )}
            {about?.sub ? ` · ${about.sub}` : ''}
            {' · '}
            <span className="num">{reminder.dueOn}</span>
            {compact ? null : (
              <>
                {' · '}
                {REMINDER_KINDS[reminder.kind]}
              </>
            )}
            {/* The snooze and the due date are printed separately because they
                are different facts: snoozing hides a row without moving its
                deadline, so one that comes back after its due date comes back
                overdue. Showing only the snooze date would hide exactly that. */}
            {reminder.snoozedUntil && reminder.snoozedUntil > today ? (
              <>
                {' · snoozed to '}
                <span className="num">{reminder.snoozedUntil}</span>
                {reminder.dueOn < reminder.snoozedUntil ? ', comes back overdue' : ''}
              </>
            ) : null}
          </span>
          {reminder.detail && !compact ? (
            <span className="mt-1 block whitespace-pre-wrap t-small text-muted">
              {reminder.detail}
            </span>
          ) : null}
        </span>
      </div>

      {/* A settled reminder keeps no controls: `completeReminder` and the rest
          refuse anything that is not open, and a button whose action always
          says no is worse than no button. */}
      {settled ? null : (
        <div className={compact ? 'shrink-0' : ''}>
          <ReminderActions id={reminder.id} dueOn={reminder.dueOn} compact={compact} />
        </div>
      )}
    </li>
  );
}
