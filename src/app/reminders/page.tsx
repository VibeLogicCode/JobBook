import Link from 'next/link';
import { db } from '@/db/client';
import { Card } from '@/components/ui/Card';
import { FilterBar, NoMatches } from '@/components/ui/FilterBar';
import { PageHeader } from '@/components/ui/PageHeader';
import { ReminderList } from '@/components/reminders/ReminderList';
import { normalizeSearch } from '@/lib/list/search';
import { tenantToday } from '@/lib/quote/dates';
import { listReminders } from '@/lib/reminders/repository';

export const dynamic = 'force-dynamic';

/**
 * Who to call.
 *
 * The measure of this screen is not that it is complete: it is that on a
 * Tuesday morning it tells the owner what to do, and that he opens it again on
 * Wednesday. So it shows a short list, grouped by how late each row is, with
 * the overdue ones impossible to miss -- and it hides what has already been
 * dealt with behind a control that says how many are back there, because a
 * list that quietly drops rows is a list he reads as having lost them.
 *
 * Reminders are written by the hourly evaluator (`scripts/reminders.ts`), from
 * five seeded rules the owner can edit. Nothing on this screen creates one; it
 * completes, defers, moves and dismisses them.
 */
export default async function RemindersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; dealt?: string }>;
}) {
  const params = await searchParams;
  const q = normalizeSearch(params.q);
  const showDealt = params.dealt === '1';

  // The tenant's day, read from the database. Not `new Date()` and not the
  // server's: in a UTC container after 7pm Toronto those are different days,
  // and a reminder that shows up a day late reads as the system being broken.
  const today = await db.transaction((tx) => tenantToday(tx));

  // One query for every status. The partition below is a handful of rows in a
  // contractor's book, and asking twice would let the count and the list
  // disagree about the same instant.
  const all = await listReminders({ search: q });
  const open = all.filter((row) => row.status === 'open');
  const dealt = all.length - open.length;
  const rows = showDealt ? all : open;

  return (
    <div className="px-4 py-4 sm:px-6">
      {/* No action in the header, and that is the answer to the obvious
          question rather than an oversight: nothing on this screen creates a
          reminder. The hourly evaluator writes them from the owner's rules,
          and this is where they are dealt with -- so the description says so,
          because a screen with no add button and no explanation reads as a
          screen with a missing button. */}
      <PageHeader
        className="mb-4"
        title="Reminders"
        description="Written by the hourly evaluator from your rules, not by hand. This is where they get completed, deferred, moved out or dismissed."
      />

      <FilterBar
        basePath="/reminders"
        q={q}
        searchLabel="Search reminders"
        searchPlaceholder="What the reminder says"
        reveal={{
          name: 'dealt',
          on: showDealt,
          showLabel: 'Show dealt with',
          hideLabel: 'Hide dealt with',
          hiddenCount: dealt,
          hiddenNoun: 'dealt with',
        }}
        shown={rows.length}
        noun={{ singular: 'reminder', plural: 'reminders' }}
      />

      {rows.length === 0 && q !== '' ? (
        <NoMatches
          basePath="/reminders"
          q={q}
          noun="reminders"
          hint={
            !showDealt && dealt > 0 ? (
              <>
                {dealt} completed or dismissed {dealt === 1 ? 'reminder is' : 'reminders are'} hidden
                by default — use &ldquo;Show dealt with&rdquo; above.
              </>
            ) : null
          }
        />
      ) : (
        <Card as="div">
          <ReminderList
            rows={rows}
            today={today}
            empty={
              // Good news, worded as good news. "No results" on a screen whose
              // whole job is to tell him what is outstanding reads as a query
              // that failed, and the recovery from that is to stop looking.
              <>
                Nothing to chase. Every reminder is either done or still ahead of its date — the
                hourly evaluator adds one the moment a quote, a site visit or a won job needs
                following up.{' '}
                <Link href="/quotes" className="text-accent-text hover:underline">
                  Quotes
                </Link>{' '}
                is where the follow-ups come from.
              </>
            }
          />
        </Card>
      )}
    </div>
  );
}
