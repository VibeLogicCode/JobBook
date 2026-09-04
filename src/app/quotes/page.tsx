import Link from 'next/link';
import { and, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { customers, projects, quotes } from '@/db/schema';
import { Pill, statusTone } from '@/components/ui/Pill';
import { formatCents } from '@/lib/money/format';

export const dynamic = 'force-dynamic';

export default async function QuotesPage() {
  // A change order names the estimate it amends, so the list is a route to the
  // parent contract rather than a flat pile of documents.
  const parentQuotes = alias(quotes, 'parent_quotes');

  const rows = await db
    .select({
      id: quotes.id,
      quoteNumber: quotes.quoteNumber,
      version: quotes.version,
      status: quotes.status,
      kind: quotes.kind,
      sequence: quotes.sequence,
      parentId: parentQuotes.id,
      parentNumber: parentQuotes.quoteNumber,
      quoteDate: quotes.quoteDate,
      validUntil: quotes.validUntil,
      totalCents: quotes.totalCents,
      marginBp: quotes.marginBp,
      projectName: projects.name,
      customerName: customers.name,
    })
    .from(quotes)
    .innerJoin(projects, eq(quotes.projectId, projects.id))
    .innerJoin(customers, eq(projects.customerId, customers.id))
    .leftJoin(parentQuotes, eq(quotes.parentQuoteId, parentQuotes.id))
    // Voided quotes are hidden by default, never deleted.
    .where(and(eq(quotes.recordStatus, 'active')))
    .orderBy(desc(quotes.createdAt));

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="t-title">Quotes</h1>
        <Link
          href="/quotes/new"
          className="flex min-h-12 items-center rounded-[4px] bg-accent px-4 text-accent-fg hover:bg-accent-hover"
        >
          New quote
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-[6px] border border-line bg-surface p-6 text-muted">
          No quotes yet.{' '}
          <Link href="/quotes/new" className="text-accent-text hover:underline">
            Start one
          </Link>
          . The customer and the opportunity can both be created on the way through, so there is
          nothing to set up first.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[6px] border border-line bg-surface">
          <table className="data-table data-table--stack" style={{ minWidth: '44rem' }}>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Number</th>
                <th scope="col">Customer</th>
                <th scope="col">Status</th>
                <th scope="col" className="cell-num">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td data-label="Project">
                    {/* Wrapped so the change-order marker sits beside the name
                        in the table and inside the card, at both widths. */}
                    <span className="flex flex-wrap items-center gap-x-2">
                      <Link href={`/quotes/${row.id}`} className="text-accent-text hover:underline">
                        {row.projectName}
                      </Link>
                      {row.kind === 'change_order' ? (
                        <Pill tone="info">Change order {row.sequence}</Pill>
                      ) : null}
                      {row.kind === 'change_order' && row.parentId ? (
                        <span className="t-small text-muted">
                          amends{' '}
                          <Link
                            href={`/quotes/${row.parentId}`}
                            className="num text-accent-text hover:underline"
                          >
                            {row.parentNumber}
                          </Link>
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Number" className="num t-small text-muted">
                    {row.quoteNumber} v{row.version}
                  </td>
                  <td data-label="Customer">{row.customerName}</td>
                  <td data-label="Status">
                    <Pill tone={statusTone(row.status, row.validUntil < today)}>
                      {row.validUntil < today && row.status === 'sent' ? 'Expired' : row.status}
                    </Pill>
                  </td>
                  <td data-label="Total" className="cell-num">
                    {formatCents(row.totalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
