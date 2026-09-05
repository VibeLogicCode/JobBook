import Link from 'next/link';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, organization, projects, quotes } from '@/db/schema';
import { buttonClass } from '@/components/ui/Button';
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { Money } from '@/components/ui/Money';
import { Pill, statusTone } from '@/components/ui/Pill';
import { ReminderList } from '@/components/reminders/ReminderList';
import { formatCents } from '@/lib/money/format';
import { tenantToday } from '@/lib/quote/dates';
import { listReminders, type ReminderRow } from '@/lib/reminders/repository';
import { urgencyOf } from '@/components/reminders/urgency';

export const dynamic = 'force-dynamic';

/** What the panel will show before it starts asking to be scrolled. */
const PANEL_ROWS = 8;

export default async function TodayPage() {
  const [org] = await db.select().from(organization).where(eq(organization.id, 1));

  if (!org) {
    return (
      <div className="px-4 py-8 sm:px-6">
        <h1 className="t-title mb-2">Setup required</h1>
        <p className="max-w-prose text-muted">
          No organization record exists yet, so the app has no company name, tax number, or
          branding to work from. Load the demo tenant with{' '}
          <span className="num">npm run db:seed</span>, or complete the setup wizard.
        </p>
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
  // What is being asked for TODAY: late, due, or pushed out of the way. What
  // is merely coming up is left for the reminders screen -- this panel exists
  // to answer one question, and a list that also holds next Thursday is a list
  // whose overdue row is one of eleven.
  const attention = openReminders.filter((row) => urgencyOf(row, today) !== 'upcoming');
  const shown = attention.slice(0, PANEL_ROWS);
  const overflow = attention.length - shown.length;

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="t-title">Today</h1>
        <Link href="/quotes/new" className={buttonClass('primary')}>
          New quote
        </Link>
      </div>

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
                    <Pill tone={statusTone(row.status, row.validUntil < today)}>{row.status}</Pill>
                    <span className="num">{formatCents(row.totalCents)}</span>
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
