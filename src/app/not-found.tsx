import Link from 'next/link';
import { buttonClass } from '@/components/ui/Button';

/**
 * What a link to something that is gone lands on.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE HAS TO EXIST
 * ---------------------------------------------------------------------------
 *
 * `notFound()` is called from every detail route in the product -- a quote, a
 * job, a customer, an invoice -- and with no `not-found.tsx` anywhere, all of
 * them rendered Next's built-in page: black text on white, no shell, no
 * navigation, no way back except the browser's own button. A quote number
 * pasted into a chat six months ago, or a bookmark to a record since voided,
 * dropped the owner clean out of his own application.
 *
 * This renders INSIDE the app shell, because the shell is the way back. The
 * copy names the two ordinary reasons rather than saying "404", which is a
 * number that means nothing to somebody holding a phone on a site.
 */
export default function NotFound() {
  return (
    <div className="grid max-w-2xl gap-4 px-4 py-4 sm:px-6">
      <div className="rounded-panel card-surface p-6">
        <h1 className="t-title">That page is not here</h1>
        <p className="mt-2 max-w-prose t-small text-muted">
          The address does not match anything in this deployment. Usually that means one of two
          things: the record was voided after the link was made, or the link was typed or pasted
          with a character missing.
        </p>
        <p className="mt-2 max-w-prose t-small text-muted">
          Nothing has been deleted — this product does not delete. If the record was voided it is
          still on its list, marked as void, with the reason it was voided.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/" className={buttonClass('primary')}>
            Back to Today
          </Link>
          <Link href="/quotes" className={buttonClass('secondary')}>
            All quotes
          </Link>
        </div>
      </div>
    </div>
  );
}
