'use client';

import { useEffect, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { SAVED_EVENT, type SavedEvent } from '@/components/ui/saved-event';

/**
 * What happened, said on the page rather than inside the sheet that has just
 * closed.
 *
 * A sheet that saves and closes is right -- the thing it was open for is done
 * -- but on its own it is silent, and silence after pressing Save is the same
 * question as a notice nobody reads: did that work? So the sheet closes and
 * the page says what landed.
 *
 * Mounted once in the shell and listening at the document, because the forms
 * that announce this are server-rendered inside client shells and cannot be
 * handed a callback. See `saved-event.ts` for why it is a DOM event.
 *
 * `role="status"` with `aria-live="polite"`, so it is announced after whatever
 * the person was already hearing rather than cutting across it. It is NOT an
 * alert: a save that worked is not an interruption.
 */
const VISIBLE_MS = 5000;

export function SaveBanner() {
  const [message, setMessage] = useState<string | null>(null);
  /**
   * Bumped on every message so a second save restarts the timer rather than
   * inheriting the first one's remaining time -- otherwise two saves in quick
   * succession show the second for whatever was left of the first.
   */
  const [shownAt, setShownAt] = useState(0);

  useEffect(() => {
    function onSaved(event: Event) {
      const detail = (event as SavedEvent).detail;
      if (!detail?.message) return;
      setMessage(detail.message);
      setShownAt(Date.now());
    }
    document.addEventListener(SAVED_EVENT, onSaved);
    return () => document.removeEventListener(SAVED_EVENT, onSaved);
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [message, shownAt]);

  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      /* Above the sheet's own scrim, because a save made inside a sheet that is
         closing must not be painted underneath the thing it just left. Bottom
         on a phone, clear of the tab bar; top-right on a desktop, where it does
         not sit over the first row of a table. */
      className="no-print pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4 sm:inset-x-auto sm:right-6 sm:justify-end"
      style={{ bottom: 'calc(5rem + env(safe-area-inset-bottom))' }}
    >
      <p className="pointer-events-auto flex max-w-md items-start gap-2 rounded-panel border border-positive bg-positive-soft p-3 t-small text-positive-soft-fg shadow-pop">
        <CircleCheck size={16} aria-hidden className="mt-0.5 shrink-0" />
        {message}
      </p>
    </div>
  );
}
