'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { buttonClass } from '@/components/ui/Button';

/**
 * What a page shows when its render throws.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE HAS TO EXIST
 * ---------------------------------------------------------------------------
 *
 * There was no error boundary anywhere in the app. In development an
 * unhandled server error renders Next's overlay, which is exactly right for a
 * developer and exposes absolute file paths; in production it renders a bare
 * "Application error: a server-side exception has occurred" with a digest and
 * nothing else. Either way the owner is outside his own application with no
 * route back and nothing he can act on.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT SAY
 * ---------------------------------------------------------------------------
 *
 * The error's message. It is written by whatever threw -- a driver, a
 * constraint, a parser -- and at best it names a column, at worst a connection
 * string. The DIGEST is shown instead: a short hash the server logged beside
 * the real stack, so somebody reading the container log can find the exact
 * occurrence. That is the one string worth putting on screen.
 *
 * "Nothing was saved" is the sentence that matters most. Every write in this
 * product runs inside a transaction, so a render that threw cannot have left
 * half a quote behind, and the owner's first fear -- that he has corrupted
 * something -- is the one worth answering first.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The browser console is the only place a client-side occurrence is
    // visible at all; the server half is already in the container log.
    console.error('[jobbook] render failed', error);
  }, [error]);

  return (
    <div className="grid max-w-2xl gap-4 px-4 py-4 sm:px-6">
      <div className="rounded-panel card-surface p-6">
        <h1 className="t-title">This screen did not load</h1>
        <p className="mt-2 max-w-prose t-small text-muted">
          Something went wrong while building this page. <strong>Nothing was saved and nothing
          was changed</strong> — every write in this product happens inside a transaction, so a
          screen that fails to load cannot leave a half-finished record behind.
        </p>
        <p className="mt-2 max-w-prose t-small text-muted">
          Try it again first. If it keeps happening, the rest of the application still works —
          go back to Today and carry on from there.
        </p>

        {error.digest ? (
          <p className="mt-3 t-small text-subtle">
            Reference <span className="num">{error.digest}</span> — quote this if you go looking
            in the server log.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={reset} className={buttonClass('primary')}>
            Try again
          </button>
          <Link href="/" className={buttonClass('secondary')}>
            Back to Today
          </Link>
        </div>
      </div>
    </div>
  );
}
