import Link from 'next/link';
import { LIST_PAGE, nextLimit } from '@/lib/list/paging';

/**
 * The line under a list that has been capped.
 *
 * Renders NOTHING when everything fits, which is the state every one of these
 * screens is in for a contractor's first year — so the cap is invisible until
 * it is real.
 *
 * A link and not a button: it carries the current filters in the query string
 * it was given, it works with no JavaScript, and the result is a URL somebody
 * can bookmark or send. The page stays a server component.
 */
export function ListMore({
  more,
  shown,
  limit,
  noun,
  params,
}: {
  /** Whether the query found more rows than were rendered. */
  more: boolean;
  shown: number;
  limit: number;
  /** Plural, lower case: 'quotes', 'jobs', 'expenses'. */
  noun: string;
  /** The current query string, so widening the window keeps every filter. */
  params: Record<string, string | string[] | undefined>;
}) {
  if (!more) return null;

  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === 'limit' || value === undefined) continue;
    if (Array.isArray(value)) for (const one of value) next.append(key, one);
    else next.append(key, value);
  }
  next.set('limit', String(nextLimit(limit)));

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 t-small text-muted">
      <span>
        Showing the {shown === LIST_PAGE ? 'first' : ''} <span className="num">{shown}</span>{' '}
        {noun}.
      </span>
      <Link href={`?${next.toString()}`} className="text-accent-text hover:underline">
        Show more
      </Link>
      <span className="text-subtle">Searching is usually quicker.</span>
    </div>
  );
}
