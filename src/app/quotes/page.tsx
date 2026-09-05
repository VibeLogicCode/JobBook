import Link from 'next/link';
import { and, desc, eq, inArray, lt, not, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { customers, projects, quotes } from '@/db/schema';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FilterBar, NoMatches } from '@/components/ui/FilterBar';
import { Pill, statusTone } from '@/components/ui/Pill';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { normalizeSearch, searchCondition } from '@/lib/list/search';

export const dynamic = 'force-dynamic';

/**
 * The statuses a person reads as a live document, and the ones that are over.
 *
 * `expired` is not a stored status -- it derives from `valid_until` against
 * today, which is why the enum deliberately has no member for it. It is a
 * filter value here all the same, because it is what the status chip already
 * says on the row, and a filter that cannot ask for the thing the screen
 * prints is a filter the owner does not believe.
 *
 * `accepted` is NOT closed. An accepted quote is the live contract -- the one
 * document on this screen the owner is most likely to be looking for -- so
 * hiding it as finished would be exactly backwards.
 */
const QUOTE_STATUSES = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'expired', label: 'Expired' },
  { value: 'declined', label: 'Declined' },
  { value: 'superseded', label: 'Superseded' },
] as const;

type StatusFilter = (typeof QUOTE_STATUSES)[number]['value'];

const CLOSED_STATUSES: StatusFilter[] = ['declined', 'expired', 'superseded'];

function readStatus(raw: string | undefined): StatusFilter | '' {
  return QUOTE_STATUSES.some((entry) => entry.value === raw) ? (raw as StatusFilter) : '';
}

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; closed?: string }>;
}) {
  const params = await searchParams;
  const q = normalizeSearch(params.q);
  const status = readStatus(params.status);

  const today = new Date().toISOString().slice(0, 10);

  // A change order names the estimate it amends, so the list is a route to the
  // parent contract rather than a flat pile of documents.
  const parentQuotes = alias(quotes, 'parent_quotes');

  // Expiry is computed, never stored, so both the filter and the chip ask the
  // same question of the same two columns.
  const expired = and(eq(quotes.status, 'sent'), lt(quotes.validUntil, today)) as SQL;
  const closed = or(inArray(quotes.status, ['declined', 'superseded']), expired) as SQL;

  // Asking for a closed status overrides the default hiding. Otherwise
  // choosing "Declined" returns nothing, which reads as a broken filter.
  const showClosed = params.closed === '1' || CLOSED_STATUSES.includes(status as StatusFilter);

  const statusCondition: SQL | undefined =
    status === ''
      ? undefined
      : status === 'expired'
        ? expired
        : status === 'sent'
          // A sent quote past its date prints as Expired, so it is not
          // returned by "Sent" either -- the filter matches what is drawn.
          ? (and(eq(quotes.status, 'sent'), not(lt(quotes.validUntil, today))) as SQL)
          : eq(quotes.status, status);

  const search = searchCondition(q, [
    quotes.quoteNumber,
    quotes.notes,
    projects.name,
    projects.projectNumber,
    customers.name,
    customers.companyName,
  ]);

  // Voided quotes are hidden by default, never deleted -- and no filter on
  // this screen can bring one back.
  const base = and(eq(quotes.recordStatus, 'active'), search, statusCondition);

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
    .where(showClosed ? base : and(base, not(closed)))
    .orderBy(desc(quotes.createdAt));

  // What the default is holding back, counted in SQL rather than by fetching
  // the rows and throwing them away -- so the figure stays right when this
  // list outgrows one screen.
  const hiddenCount = showClosed
    ? 0
    : Number(
        (
          await db
            .select({ n: sql<number>`count(*)::int` })
            .from(quotes)
            .innerJoin(projects, eq(quotes.projectId, projects.id))
            .innerJoin(customers, eq(projects.customerId, customers.id))
            .where(and(base, closed))
        )[0]?.n ?? 0,
      );

  const filtered = q !== '' || status !== '';
  const statusLabel = QUOTE_STATUSES.find((entry) => entry.value === status)?.label;

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="t-title">Quotes</h1>
        <Link href="/quotes/new" className={buttonClass('primary')}>
          New quote
        </Link>
      </div>

      <FilterBar
        basePath="/quotes"
        q={q}
        searchLabel="Search quotes"
        searchPlaceholder="Quote number, project, customer"
        selects={[
          {
            name: 'status',
            label: 'Status',
            value: status,
            anyLabel: 'Any status',
            options: [...QUOTE_STATUSES],
          },
        ]}
        reveal={{
          name: 'closed',
          on: showClosed,
          showLabel: 'Show closed quotes',
          hideLabel: 'Hide closed quotes',
          hiddenCount,
          hiddenNoun: 'closed',
        }}
        shown={rows.length}
        noun={{ singular: 'quote', plural: 'quotes' }}
      />

      {rows.length === 0 ? (
        filtered || hiddenCount > 0 ? (
          <NoMatches
            basePath="/quotes"
            q={q}
            noun="quotes"
            describe={statusLabel ? [`Status: ${statusLabel}`] : []}
            hint={
              hiddenCount > 0 ? (
                <>
                  {hiddenCount} declined, expired or superseded{' '}
                  {hiddenCount === 1 ? 'quote is' : 'quotes are'} hidden by default — use
                  &ldquo;Show closed quotes&rdquo; above.
                </>
              ) : null
            }
          />
        ) : (
          <Card as="div" className="p-6 text-muted">
            No quotes yet.{' '}
            <Link href="/quotes/new" className="text-accent-text hover:underline">
              Start one
            </Link>
            . The customer and the opportunity can both be created on the way through, so there is
            nothing to set up first.
          </Card>
        )
      ) : (
        <TableWrap minWidth="44rem">
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
                <AmountCell data-label="Total" cents={row.totalCents} />
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
