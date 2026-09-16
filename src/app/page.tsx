import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, projects, quotes } from '@/db/schema';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { PageHeader } from '@/components/ui/PageHeader';
import { Money } from '@/components/ui/Money';
import { Pill, statusTone } from '@/components/ui/Pill';
import { ReminderList } from '@/components/reminders/ReminderList';
import { firstRunDestination } from '@/app/setup/entry';
import { readSetupGate } from '@/app/setup/state';
import { loadOrganization } from '@/lib/organization/load';
import { formatCents } from '@/lib/money/format';
import { tenantToday } from '@/lib/quote/dates';
import { listReminders, type ReminderRow } from '@/lib/reminders/repository';
import { NEEDS_ATTENTION, urgencyOf } from '@/components/reminders/urgency';

export const dynamic = 'force-dynamic';

/**
 * A page at the same route segment as the root layout is the one place its
 * title template does not apply (Next's own rule), so the tenant name is
 * built in here rather than left to the layout. `loadOrganization` is the
 * same `cache()`-wrapped read the layout and the page body both use, so this
 * costs nothing extra.
 */
export async function generateMetadata(): Promise<Metadata> {
  const org = await loadOrganization();
  return { title: org ? `Today — ${org.displayName}` : 'Today' };
}

/** What the panel will show before it starts asking to be scrolled. */
/**
 * Eight rows could fill half a laptop screen before the owner reached the
 * figures underneath, which was the complaint. Five is enough to see that a
 * morning is busy without the panel becoming the page; past that the count in
 * the footer says how many more, and the reminders screen holds them all.
 */
const PANEL_ROWS = 5;

export default async function TodayPage() {
  const org = await loadOrganization();

  if (!org) {
    /**
     * An unfinished deployment is handed to the wizard rather than told about
     * it. This screen used to name `npm run db:seed` -- a command written for
     * somebody standing at a checkout, and the only instruction on the page
     * for a contractor looking at a NAS in a browser with no shell, no
     * repository and no npm. Its other half said "complete the setup wizard"
     * without saying where, and nothing anywhere linked to `/setup`.
     *
     * `firstRunDestination` returns null for the three closed gates, so a
     * finished deployment, a company this wizard did not create, and an
     * unreadable database each keep their existing behaviour.
     */
    const destination = firstRunDestination(await readSetupGate());
    if (destination) redirect(destination);

    return (
      <div className="px-4 py-8 sm:px-6">
        <PageHeader
          title="No company on file"
          description={
            <>
              Setup is closed on this deployment but no organization record exists, so there is
              no company name, tax number or branding to work from. Nothing can be printed until
              one does. This is not a state the first-run wizard can leave behind, so it wants
              looking at rather than clicking through.
            </>
          }
        />
      </div>
    );
  }

  const rows = await db
    .select({
      id: quotes.id,
      quoteNumber: quotes.quoteNumber,
      status: quotes.status,
      validUntil: quotes.validUntil,
      totalCents: quotes.totalCents,
      projectName: projects.name,
      customerName: customers.name,
      /**
       * Whether any line on it is still waiting for a price.
       *
       * Without this the drafts list reads `$0.00` against a quote that is not
       * worth nothing -- it is a quote nobody has priced yet. The starter packs
       * ship a rate book with no prices in it on purpose, and the templates
       * expand from it, so this is the NORMAL state of a first quote rather
       * than an edge case.
       *
       * The same three exemptions the send guard and the worksheet warning
       * use: a percentage line states its rate, an allowance has no figure by
       * definition, and a voided line is not on the quote.
       */
      unpriced: sql<boolean>`exists (
        select 1 from quote_lines ql
        where ql.quote_id = ${quotes.id}
          and ql.record_status = 'active'
          and ql.unit_price_ten_thou = 0
          and ql.calc_mode <> 'percent'
          and ql.is_allowance = false
      )`,
    })
    .from(quotes)
    .innerJoin(projects, eq(quotes.projectId, projects.id))
    .innerJoin(customers, eq(projects.customerId, customers.id))
    .where(and(eq(quotes.recordStatus, 'active')));

  // The tenant's day, from the database. `new Date().toISOString()` was here
  // and was wrong for the same reason it is wrong everywhere else in this
  // product: in a UTC container after 7pm Toronto it returns tomorrow, which
  // expires a quote a day early and puts a reminder on the screen a day late.
  const today = await db.transaction((tx) => tenantToday(tx));

  const awaiting = rows.filter((row) => row.status === 'sent' && row.validUntil >= today);
  const expiring = awaiting.filter((row) => daysBetween(today, row.validUntil) <= 7);
  const drafts = rows.filter((row) => row.status === 'draft');
  const outstanding = awaiting.reduce((sum, row) => sum + row.totalCents, 0);

  const openReminders = await listReminders({ status: 'open' });
  /**
   * Late or due today, and nothing else.
   *
   * This panel answers one question -- what has to be dealt with before the
   * day is out -- and every row that is not an answer to it makes the rows
   * that are harder to find. A snoozed reminder is by definition NOT today's
   * problem: the owner has already looked at it and pushed it away, and
   * showing it back to him the same morning undoes the only thing snoozing is
   * for. Coming-up is the same argument a week earlier.
   *
   * Both still live on the reminders screen, which is the one that shows
   * everything. This one is deliberately the short list.
   */
  const attention = openReminders.filter((row) =>
    NEEDS_ATTENTION.includes(urgencyOf(row, today)),
  );
  const shown = attention.slice(0, PANEL_ROWS);
  const overflow = attention.length - shown.length;

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        title="Today"
        description="What is out with customers, what is still a draft, and what has to be chased this morning."
        actions={
          <Link href="/quotes/new" className={buttonClass('primary')}>
            New quote
          </Link>
        }
      />

      {/* First on the screen, above the money. The figure below is what the
          business is worth this week; this is what has to happen this morning,
          and a panel underneath two lists is a panel nobody scrolls to. */}
      <Card className="mb-6">
        <CardHeader
          title="Reminders"
          description={remindersLine(attention, today)}
          action={
            <Link href="/reminders" className={buttonClass('secondary')}>
              All reminders
            </Link>
          }
        />
        <CardBody padded={false}>
          <ReminderList
            rows={shown}
            today={today}
            headingLevel={3}
            compact
            empty={
              // Good news said as good news. A blank panel here reads as a
              // failed query, and the answer to "is this broken" is to stop
              // opening it.
              <>Nothing is late and nothing is due. Anything coming up is on the reminders screen.</>
            }
          />
        </CardBody>
        {overflow > 0 ? (
          <CardFooter>
            {overflow} more {overflow === 1 ? 'reminder needs' : 'reminders need'} attention —{' '}
            <Link href="/reminders" className="text-accent-text hover:underline">
              open the list
            </Link>
            .
          </CardFooter>
        ) : null}
      </Card>

      {/* `from` rather than a comma: the figure is the sum of the quotes that
          are out, not a stored number, and MetricCard writes every derived
          figure's provenance the same way. */}
      <MetricCard
        className="mb-6"
        label="Out with customers"
        from="awaiting a decision"
        value={<Money cents={outstanding} plain />}
        secondary={
          `${awaiting.length} quote${awaiting.length === 1 ? '' : 's'}` +
          (expiring.length > 0 ? ` · ${expiring.length} expiring within 7 days` : '')
        }
      />

      <QuoteList title="Awaiting a decision" rows={awaiting} today={today} />
      <QuoteList title="Drafts" rows={drafts} today={today} />
    </div>
  );
}

/**
 * The one-line summary under the panel's title.
 *
 * It names the overdue count first and separately, because that is the number
 * that decides whether the owner reads the panel at all.
 */
function remindersLine(rows: readonly ReminderRow[], today: string): string {
  if (rows.length === 0) return 'Nothing needs chasing.';
  const counts = { overdue: 0, today: 0, snoozed: 0 };
  for (const row of rows) {
    const urgency = urgencyOf(row, today);
    if (urgency === 'overdue' || urgency === 'today' || urgency === 'snoozed') {
      counts[urgency] += 1;
    }
  }
  return [
    counts.overdue > 0 ? `${counts.overdue} overdue` : null,
    counts.today > 0 ? `${counts.today} due today` : null,
    counts.snoozed > 0 ? `${counts.snoozed} snoozed` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function QuoteList({
  title,
  rows,
  today,
}: {
  title: string;
  rows: {
    id: string;
    quoteNumber: string;
    status: string;
    validUntil: string;
    totalCents: number;
    projectName: string;
    customerName: string;
    /** Any line still waiting for a price. See the query. */
    unpriced?: boolean;
  }[];
  today: string;
}) {
  return (
    <section className="mb-6">
      <h2 className="t-heading mb-2">{title}</h2>
      {rows.length === 0 ? (
        <Card as="div" className="p-4 t-small text-muted">
          Nothing here. {title === 'Drafts' ? 'Start a quote and it appears here.' : 'Send a draft to fill this list.'}
        </Card>
      ) : (
        // The list carries its own radius and clips itself, rather than the
        // card clipping: Card deliberately does not hide its overflow.
        <Card as="div">
          <ul className="divide-y divide-line overflow-hidden rounded-panel">
            {rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/quotes/${row.id}`}
                  className="flex min-h-12 items-center justify-between gap-3 px-4 py-2 hover:bg-surface-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{row.projectName}</span>
                    <span className="t-small text-muted">
                      {row.customerName} · <span className="num">{row.quoteNumber}</span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    {/*
                      * A quote whose lines have no prices yet is not a quote
                      * worth nothing, and `$0.00` says the second thing. The
                      * figure stays -- it is the honest total of what has been
                      * priced -- and the pill says why it is low.
                      */}
                    {row.unpriced ? (
                      <Pill tone="warning">Needs pricing</Pill>
                    ) : (
                      <Pill tone={statusTone(row.status, row.validUntil < today)}>{row.status}</Pill>
                    )}
                    <span className={`num ${row.unpriced ? 'text-subtle' : ''}`.trim()}>
                      {formatCents(row.totalCents)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
