import Link from 'next/link';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, organization, projects, quotes } from '@/db/schema';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { Money } from '@/components/ui/Money';
import { Pill, statusTone } from '@/components/ui/Pill';
import { formatCents } from '@/lib/money/format';

export const dynamic = 'force-dynamic';

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

  const today = new Date().toISOString().slice(0, 10);
  const awaiting = rows.filter((row) => row.status === 'sent' && row.validUntil >= today);
  const expiring = awaiting.filter((row) => daysBetween(today, row.validUntil) <= 7);
  const drafts = rows.filter((row) => row.status === 'draft');
  const outstanding = awaiting.reduce((sum, row) => sum + row.totalCents, 0);

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="t-title">Today</h1>
        <Link href="/quotes/new" className={buttonClass('primary')}>
          New quote
        </Link>
      </div>

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
