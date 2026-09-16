import type { Metadata } from 'next';
import Link from 'next/link';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers } from '@/db/schema';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FilterBar, NoMatches } from '@/components/ui/FilterBar';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill } from '@/components/ui/Pill';
import { TableWrap } from '@/components/ui/Table';
import { CUSTOMER_TYPES } from '@/components/detail/labels';
import { normalizeSearch, searchCondition } from '@/lib/list/search';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'People' };

const TYPE_OPTIONS = Object.entries(CUSTOMER_TYPES).map(([value, label]) => ({ value, label }));

type CustomerType = keyof typeof CUSTOMER_TYPES;

function readType(raw: string | undefined): CustomerType | '' {
  return raw === 'residential' || raw === 'commercial' ? raw : '';
}

/**
 * There is no reveal control on this screen, and that is deliberate: a person
 * has no closed state. A customer is either active or voided, and a voided one
 * is never listed under any filter -- so a "show closed people" toggle would
 * be a control that could only ever show nothing.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string }>;
}) {
  const params = await searchParams;
  const q = normalizeSearch(params.q);
  const type = readType(params.type);

  const search = searchCondition(q, [
    customers.name,
    customers.companyName,
    customers.email,
    customers.phone,
    customers.city,
    customers.altContactName,
    customers.notes,
  ]);

  const rows = await db
    .select()
    .from(customers)
    .where(
      and(
        // Voided customers are hidden here, never deleted, and no filter on
        // this screen can bring one back.
        eq(customers.recordStatus, 'active'),
        search,
        type === '' ? undefined : eq(customers.customerType, type),
      ),
    )
    .orderBy(asc(customers.name));

  const filtered = q !== '' || type !== '';

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        title="People"
        actions={
          <Link href="/customers/new" className={buttonClass('primary')}>
            New customer
          </Link>
        }
      />

      <FilterBar
        basePath="/customers"
        q={q}
        searchLabel="Search people"
        searchPlaceholder="Name, company, phone, email, city"
        selects={[
          {
            name: 'type',
            label: 'Type',
            value: type,
            anyLabel: 'Any type',
            options: TYPE_OPTIONS,
          },
        ]}
        shown={rows.length}
        noun={{ singular: 'person', plural: 'people' }}
      />

      {rows.length === 0 ? (
        filtered ? (
          <NoMatches
            basePath="/customers"
            q={q}
            noun="people"
            describe={type ? [`Type: ${CUSTOMER_TYPES[type]}`] : []}
          />
        ) : (
          <Card as="div" className="p-6 text-muted">
            No customers yet.{' '}
            <Link href="/customers/new" className="text-accent-text hover:underline">
              Add the first one
            </Link>
            , or load the demo tenant with <span className="num">npm run db:seed</span>.
          </Card>
        )
      ) : (
        <TableWrap minWidth="40rem">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Name</th>
              <th role="columnheader" scope="col">Type</th>
              <th role="columnheader" scope="col">Phone</th>
              <th role="columnheader" scope="col">City</th>
              <th role="columnheader" scope="col">Tax</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {/* `row-target`: the whole row opens the customer. See globals.css. */}
            {rows.map((row) => (
              <tr role="row" key={row.id} className="row-target">
                <td role="cell" data-label="Name">
                  <Link
                    href={`/customers/${row.id}`}
                    className="row-link text-accent-text hover:underline"
                  >
                    {row.name}
                  </Link>
                </td>
                <td role="cell" data-label="Type" className="t-small text-muted">{row.customerType}</td>
                <td role="cell" data-label="Phone" className="num t-small">{row.phone ?? '—'}</td>
                <td role="cell" data-label="City" className="t-small text-muted">{row.city ?? '—'}</td>
                <td role="cell" data-label="Tax">
                  {row.isTaxExempt ? (
                    <Pill tone="warning">Exempt</Pill>
                  ) : (
                    <span className="t-small text-muted">Taxable</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
