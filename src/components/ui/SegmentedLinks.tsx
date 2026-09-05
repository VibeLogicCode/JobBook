import Link from 'next/link';

/**
 * Two or three mutually exclusive views of the same screen, as a segmented
 * control built entirely from `<Link>`s.
 *
 * This is the third place this markup was about to be written by hand —
 * the pipeline's board/list toggle, the calendar's Day/Week/Month control,
 * and the job schedule's list/calendar toggle all needed the exact same
 * thing. Three decisions, each of them a complaint from the owner rather than
 * a taste:
 *
 * NOT ITS OWN ROW. He has said twice that controls eat a phone screen before
 * any work appears -- the search box and its button were put on one row for
 * that reason, and "Show lost and complete" was moved out of a button row and
 * into a line of prose for the same one. A toggle used once a session must not
 * cost 44 vertical pixels every time the screen is opened, so every caller
 * places this beside a count or a heading rather than above it. It is
 * `min-h-8` for the same trade the reveal link records: a comfortable target
 * at a third of the height of a button.
 *
 * NOT A DROPDOWN. Two or three options behind a select is two taps and a
 * rendered menu to answer a question with two or three answers, and the
 * current answer is only legible once the menu is closed.
 *
 * EVERY SEGMENT IS A LINK, and the active one is marked `aria-current` rather
 * than merely painted. Colour is never the only carrier of state in this
 * product, and the selected segment is also the heavier of the two -- filled
 * ground, bolder text -- so which one is on is answerable at a glance and by a
 * screen reader. Every segment is a real navigation that keeps whatever the
 * caller decided to carry, so pressing one is never a way to lose a filter.
 */
export interface SegmentedLinksOption {
  href: string;
  label: string;
  active: boolean;
}

export function SegmentedLinks({
  ariaLabel,
  options,
}: {
  /** Names the group for a screen reader -- beside a count or a heading, "A | B" read aloud is ambiguous without one. */
  ariaLabel: string;
  options: SegmentedLinksOption[];
}) {
  return (
    <span
      role="group"
      aria-label={ariaLabel}
      className="inline-flex overflow-hidden rounded-control border border-line-strong"
    >
      {options.map((option, index) => (
        <Link
          key={option.label}
          href={option.href}
          aria-current={option.active ? 'page' : undefined}
          className={`inline-flex min-h-8 items-center px-2.5 ${
            index > 0 ? 'border-l border-line-strong' : ''
          } ${
            option.active
              ? 'bg-accent-soft font-semibold text-accent-soft-fg'
              : 'text-muted hover:bg-surface-2 hover:text-ink'
          }`}
        >
          {option.label}
        </Link>
      ))}
    </span>
  );
}
