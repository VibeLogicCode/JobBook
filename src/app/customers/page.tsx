import Link from 'next/link';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers } from '@/db/schema';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FilterBar, NoMatches } from '@/components/ui/FilterBar';
import { Pill } from '@/components/ui/Pill';
import { TableWrap } from '@/components/ui/Table';
import { CUSTOMER_TYPES } from '@/components/detail/labels';
import { normalizeSearch, searchCondition } from '@/lib/list/search';

export const dynamic = 'force-dynamic';

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
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="t-title">People</h1>
        <Link
          href="/customers/new"
          className={buttonClass('primary', { className: 'ml-auto' })}
        >
          New customer
        </Link>
      </div>

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
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Phone</th>
              <th scope="col">City</th>
              <th scope="col">Tax</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td data-label="Name">
                  <Link href={`/customers/${row.id}`} className="text-accent-text hover:underline">
                    {row.name}
                  </Link>
                </td>
                <td data-label="Type" className="t-small text-muted">{row.customerType}</td>
                <td data-label="Phone" className="num t-small">{row.phone ?? '—'}</td>
                <td data-label="City" className="t-small text-muted">{row.city ?? '—'}</td>
                <td data-label="Tax">
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
