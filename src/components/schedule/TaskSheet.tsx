'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Sheet, fieldSnapshot } from '@/components/ui/Sheet';
import { SAVED_EVENT } from '@/components/ui/saved-event';

/**
 * The task editor over the calendar, opened by the URL rather than by a button.
 *
 * `SheetButton` holds its open/shut in React state, which is right for a form
 * that hangs off a row already on screen. It is wrong here for the reason
 * `EditSheet` records about `?edit=1`: a block tapped on a calendar has to be
 * an ADDRESS. The page reads `?task=` on the server, so the editor arrives with
 * that task's real cost-code and predecessor options already in it, it survives
 * a reload, it can be sent to somebody, and it opens before the page has
 * hydrated. None of that is true of a sheet whose only record of what is open
 * is client state.
 *
 * So this component draws a result the server already decided; it never decides
 * anything itself. Closing is a navigation back to the calendar's own URL.
 *
 * `router.refresh()` on the way out, which `EditSheet` does not need. Its
 * actions redirect, so the page they land on is fetched fresh either way. The
 * schedule actions revalidate the JOB's schedule path -- correctly, it is
 * theirs -- and know nothing about a calendar, so without this a date moved in
 * the sheet would leave the block sitting on the day it came from.
 */
export function TaskSheet({
  closeHref,
  label,
  title,
  subtitle,
  discardPrompt,
  children,
}: {
  /** The calendar's own URL, filters and period intact. Where every dismissal goes. */
  closeHref: string;
  /** The dialog's accessible name. Names the task, so which one is never in doubt. */
  label: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Asked before a dismissal throws an edit away, and only when there is one. */
  discardPrompt: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  /** What the fields held when the sheet opened. */
  const baseline = useRef('');

  useEffect(() => {
    baseline.current = fieldSnapshot(bodyRef.current);
  }, []);

  const close = useCallback(() => {
    // `scroll: false`, because the page underneath has not moved and jumping it
    // to the top would be the app losing the reader's place as a parting gift.
    router.push(closeHref, { scroll: false });
    router.refresh();
  }, [router, closeHref]);

  /**
   * A save closes the sheet, because the thing it was open for is done -- the
   * same rule `SheetButton` follows, and the same DOM event, because the
   * children are server-rendered and cannot hand a result back up.
   *
   * A REFUSAL does not fire it, so a rejected save leaves the sheet open with
   * the reason and the typing still in it. Moving dates does not fire it
   * either: that form answers with a preview and a second press, and closing
   * the sheet under it would take the confirmation away unread.
   */
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.addEventListener(SAVED_EVENT, close);
    return () => body.removeEventListener(SAVED_EVENT, close);
  }, [close]);

  function requestClose() {
    const dirty = fieldSnapshot(bodyRef.current) !== baseline.current;
    if (dirty && !window.confirm(discardPrompt)) return;
    close();
  }

  return (
    <Sheet
      label={label}
      title={title}
      subtitle={subtitle}
      // A two-column form with a date preview under it. `md` is the width that
      // strands a form like this in the middle of a monitor.
      size="xl"
      onClose={requestClose}
    >
      <div ref={bodyRef}>{children}</div>
    </Sheet>
  );
}
