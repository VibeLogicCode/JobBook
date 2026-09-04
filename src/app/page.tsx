import Link from 'next/link';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, organization, projects, quotes } from '@/db/schema';
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
        <Link
          href="/quotes/new"
          className="flex min-h-12 items-center rounded-[4px] bg-accent px-4 text-accent-fg hover:bg-accent-hover"
        >
          New quote
        </Link>
      </div>

      <section className="mb-6 rounded-[6px] border border-line bg-surface p-4">
        <p className="t-small text-muted">Out with customers, awaiting a decision</p>
        <p className="num t-display">{formatCents(outstanding)}</p>
        <p className="t-small text-muted">
          {awaiting.length} quote{awaiting.length === 1 ? '' : 's'}
          {expiring.length > 0 ? ` · ${expiring.length} expiring within 7 days` : ''}
        </p>
      </section>

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
        <p className="rounded-[6px] border border-line bg-surface p-4 t-small text-muted">
          Nothing here. {title === 'Drafts' ? 'Start a quote and it appears here.' : 'Send a draft to fill this list.'}
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-[6px] border border-line bg-surface">
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
      )}
    </section>
  );
}
