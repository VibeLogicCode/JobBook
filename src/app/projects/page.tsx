import Link from 'next/link';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, projects, quotes } from '@/db/schema';
import { Pill } from '@/components/ui/Pill';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { PROJECT_STAGES, stageTone, workNoun } from '@/components/detail/labels';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const rows = await db
    .select({
      id: projects.id,
      projectNumber: projects.projectNumber,
      name: projects.name,
      stage: projects.stage,
      projectType: projects.projectType,
      scheduledStart: projects.scheduledStart,
      actualStart: projects.actualStart,
      customerName: customers.name,
      // Contract value is DERIVED from accepted quotes, never stored: two
      // sources of truth is a reconciliation bug waiting for a witness.
      contractValueCents: sql<number>`coalesce((
        select sum(q.total_cents) from ${quotes} q
        where q.project_id = ${projects.id}
          and q.status = 'accepted' and q.record_status = 'active'
      ), 0)`,
      acceptedQuotes: sql<number>`(
        select count(*) from ${quotes} q
        where q.project_id = ${projects.id}
          and q.status = 'accepted' and q.record_status = 'active'
      )`,
    })
    .from(projects)
    .innerJoin(customers, eq(projects.customerId, customers.id))
    .where(and(eq(projects.recordStatus, 'active')))
    .orderBy(asc(projects.projectNumber));

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="t-title">Pipeline</h1>
        <Link
          href="/projects/new"
          className="no-print ml-auto flex min-h-11 items-center rounded-[4px] bg-accent px-3 text-accent-fg hover:bg-accent-hover"
        >
          New opportunity
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-[6px] border border-line bg-surface p-6 text-muted">
          Nothing in the pipeline yet.{' '}
          <Link href="/quotes/new" className="text-accent-text hover:underline">
            Start a quote
          </Link>{' '}
          and the opportunity is created with it.
        </p>
      ) : (
        <TableWrap minWidth="46rem">
          <thead>
            <tr>
              <th scope="col">Work</th>
              <th scope="col">Number</th>
              <th scope="col">Customer</th>
              <th scope="col">Stage</th>
              <th scope="col">Starts</th>
              <th scope="col" className="cell-num">Contract</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td data-label="Work">
                  <Link href={`/projects/${row.id}`} className="text-accent-text hover:underline">
                    {row.name}
                  </Link>
                  <span className="block t-small text-subtle">
                    {workNoun(Number(row.acceptedQuotes) > 0)}
                  </span>
                </td>
                <td data-label="Number" className="num t-small text-muted">
                  {row.projectNumber}
                </td>
                <td data-label="Customer">{row.customerName}</td>
                <td data-label="Stage">
                  <Pill tone={stageTone(row.stage)}>{PROJECT_STAGES[row.stage]}</Pill>
                </td>
                <td data-label="Starts" className="num t-small">
                  {row.actualStart ?? row.scheduledStart ?? '—'}
                </td>
                <AmountCell data-label="Contract" cents={Number(row.contractValueCents)} />
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
