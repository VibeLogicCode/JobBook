import type { Metadata } from 'next';
import Link from 'next/link';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { customerInvoices, customers, projects } from '@/db/schema';
import { Card } from '@/components/ui/Card';
import { FilterBar, NoMatches } from '@/components/ui/FilterBar';
import { ListMore } from '@/components/ui/ListMore';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill } from '@/components/ui/Pill';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { INVOICE_KINDS, isOverdue } from '@/lib/invoice/labels';
import type { InvoiceKind } from '@/lib/invoice/types';
import { listLimit, listSlice } from '@/lib/list/paging';
import { normalizeSearch, searchCondition } from '@/lib/list/search';
import { tenantToday } from '@/lib/quote/dates';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Invoices' };

const STATUSES: Record<string, string> = {
  draft: 'draft',
  sent: 'sent',
  partial: 'partial',
  paid: 'paid',
};

/**
 * Every invoice this business has raised, across every job.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN DID NOT EXIST
 * ---------------------------------------------------------------------------
 *
 * Invoicing lived only inside a job, at `/projects/[id]/billing`, because that
 * is where the arithmetic is: a progress draw bills contract x percent minus
 * what was billed before, and every figure it needs belongs to one job. That
 * was the right place to BILL from and the wrong place to be the only way in.
 *
 * "What have I invoiced and what is still owed" is a question about the
 * business, not about a job, and answering it meant opening jobs one at a
 * time. It is also the question that has to be answerable when the Pipeline
 * board is switched off -- otherwise a deployment that wants nothing but
 * quotes and invoices has no route to half of its own name.
 *
 * ---------------------------------------------------------------------------
 * IT LISTS, IT DOES NOT ISSUE
 * ---------------------------------------------------------------------------
 *
 * Raising an invoice stays on the job's billing screen, and that is deliberate
 * rather than unfinished. Which kinds a job may raise follows its project
 * type's `progress_invoicing` flag, the percentage is refused against the
 * contract value, and a holdback release reads the ledger -- all of which is
 * one job's arithmetic. A second form here would be a second implementation of
 * those rules, and the two would disagree the day one changed.
 *
 * So each row links to the job that raised it, and the way to bill is from
 * there.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; limit?: string }>;
}) {
  const params = await searchParams;
  const q = normalizeSearch(params.q);
  const status = params.status && STATUSES[params.status] ? params.status : '';

  const search = searchCondition(q, [
    customerInvoices.invoiceNumber,
    projects.name,
    projects.projectNumber,
    customers.name,
  ]);

  const conditions: (SQL | undefined)[] = [
    // Void invoices are hidden, never deleted -- the same rule every list here
    // follows.
    eq(customerInvoices.recordStatus, 'active'),
    search,
  ];
  if (status) conditions.push(eq(customerInvoices.status, status as 'draft'));

  const limit = listLimit(params.limit);

  const [fetched, today] = await Promise.all([
    db
      .select({
        id: customerInvoices.id,
        invoiceNumber: customerInvoices.invoiceNumber,
        kind: customerInvoices.kind,
        status: customerInvoices.status,
        issueDate: customerInvoices.issueDate,
        dueDate: customerInvoices.dueDate,
        totalCents: customerInvoices.totalCents,
        amountDueCents: customerInvoices.amountDueCents,
        projectId: customerInvoices.projectId,
        projectName: projects.name,
        projectNumber: projects.projectNumber,
        customerName: customers.name,
      })
      .from(customerInvoices)
      .innerJoin(projects, eq(customerInvoices.projectId, projects.id))
      .innerJoin(customers, eq(projects.customerId, customers.id))
      .where(and(...conditions))
      // Newest first: the question this screen answers is almost always about
      // something recent.
      .orderBy(desc(customerInvoices.issueDate), desc(customerInvoices.invoiceNumber))
      .limit(limit + 1),
    // The tenant's day, from the database, because overdue is derived against
    // it -- in a UTC container after 7pm Toronto `new Date()` is tomorrow and
    // would mark an invoice late a day early.
    db.transaction((tx) => tenantToday(tx)),
  ]);

  const { visible: rows, more } = listSlice(fetched, limit);
  const filtered = q !== '' || status !== '';
  const owing = rows.reduce((sum, row) => sum + row.amountDueCents, 0);

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        title="Invoices"
        description="Everything billed, across every job. Raising one happens on the job it belongs to."
      />

      <FilterBar
        basePath="/invoices"
        q={q}
        searchLabel="Search invoices"
        searchPlaceholder="Invoice number, job, customer"
        selects={[
          {
            name: 'status',
            label: 'Status',
            value: status,
            anyLabel: 'Any status',
            options: Object.entries(STATUSES).map(([value, label]) => ({ value, label })),
          },
        ]}
        shown={rows.length}
        noun={{ singular: 'invoice', plural: 'invoices' }}
      />

      {rows.length === 0 ? (
        filtered ? (
          <NoMatches basePath="/invoices" q={q} noun="invoices" describe={status ? [`Status: ${status}`] : []} />
        ) : (
          <Card as="div" className="p-6 text-muted">
            Nothing invoiced yet. An invoice is raised against the job it bills, from that job&rsquo;s
            billing screen — which is where the contract value, what was billed before and any
            holdback all live.{' '}
            <Link href="/quotes" className="text-accent-text hover:underline">
              An accepted quote
            </Link>{' '}
            is what gives a job something to bill.
          </Card>
        )
      ) : (
        <>
          <TableWrap minWidth="56rem">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" scope="col">Invoice</th>
                <th role="columnheader" scope="col">Job</th>
                <th role="columnheader" scope="col">Customer</th>
                <th role="columnheader" scope="col">Billed</th>
                <th role="columnheader" scope="col">Issued</th>
                <th role="columnheader" scope="col">Due</th>
                <th role="columnheader" scope="col" className="cell-num">Total</th>
                <th role="columnheader" scope="col" className="cell-num">Owing</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {rows.map((row) => {
                const late = isOverdue(row, today);
                return (
                  <tr role="row" key={row.id} className="row-target">
                    <td role="cell" data-label="Invoice">
                      {/* To the JOB, because that is where an invoice is acted
                          on -- sent, released, corrected. */}
                      <Link
                        href={`/projects/${row.projectId}/billing`}
                        className="row-link num text-accent-text hover:underline"
                      >
                        {row.invoiceNumber}
                      </Link>
                    </td>
                    <td role="cell" data-label="Job">
                      <span className="block truncate">{row.projectName}</span>
                      <span className="num t-small text-muted">{row.projectNumber}</span>
                    </td>
                    <td role="cell" data-label="Customer">{row.customerName}</td>
                    <td role="cell" data-label="Billed">
                      {INVOICE_KINDS[row.kind as InvoiceKind] ?? row.kind}
                    </td>
                    <td role="cell" data-label="Issued" className="num t-small">{row.issueDate}</td>
                    <td role="cell" data-label="Due" className="num t-small">
                      {row.dueDate ?? '—'}
                    </td>
                    <AmountCell data-label="Total" cents={row.totalCents} />
                    <td role="cell" data-label="Owing" className="cell-num">
                      <span className="flex items-center justify-end gap-2">
                        {/* Overdue is derived here and never stored -- see
                            `isOverdue`. A paid invoice is never late. */}
                        {late ? <Pill tone="negative">Overdue</Pill> : null}
                        {row.status === 'paid' ? <Pill tone="positive">Paid</Pill> : null}
                        <span className="num">{(row.amountDueCents / 100).toFixed(2)}</span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>

          <p className="mt-3 t-small text-muted">
            Owing on the invoices shown: <span className="num font-semibold">${(owing / 100).toFixed(2)}</span>
          </p>

          <ListMore more={more} shown={rows.length} limit={limit} noun="invoices" params={params} />
        </>
      )}
    </div>
  );
}
