import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers } from '@/db/schema';
import { Pill } from '@/components/ui/Pill';

export const dynamic = 'force-dynamic';

export default async function CustomersPage() {
  const rows = await db
    .select()
    .from(customers)
    .where(eq(customers.recordStatus, 'active'))
    .orderBy(asc(customers.name));

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="t-title">People</h1>
        <Link
          href="/customers/new"
          className="no-print ml-auto flex min-h-11 items-center rounded-[4px] bg-accent px-3 text-accent-fg hover:bg-accent-hover"
        >
          New customer
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-[6px] border border-line bg-surface p-6 text-muted">
          No customers yet.{' '}
          <Link href="/customers/new" className="text-accent-text hover:underline">
            Add the first one
          </Link>
          , or load the demo tenant with <span className="num">npm run db:seed</span>.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[6px] border border-line bg-surface">
          <table className="data-table data-table--stack" style={{ minWidth: '40rem' }}>
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
          </table>
        </div>
      )}
    </div>
  );
}
