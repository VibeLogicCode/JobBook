import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, organization, projects, quotes } from '@/db/schema';
import { buttonClass } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill, statusTone } from '@/components/ui/Pill';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { updateCustomer, voidCustomer } from '@/app/customers/actions';
import { CustomerForm } from '@/components/detail/CustomerForm';
import { DetailList, DetailRow, EmptyState, Panel } from '@/components/detail/Panel';
import { VoidControl } from '@/components/detail/VoidControl';
import { tenantIsoToday } from '@/components/detail/dates';
import { LogActivityForm } from '@/components/timeline/LogActivityForm';
import { Timeline } from '@/components/timeline/Timeline';
import { listTimeline } from '@/lib/reminders/repository';
import {
  CUSTOMER_TYPES, LEAD_SOURCES, PROJECT_STAGES, isLiveStage, stageTone,
} from '@/components/detail/labels';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { id } = await params;
  const { edit } = await searchParams;

  // A malformed id is a wrong URL, not a server fault. Postgres rejects a
  // non-uuid outright, so without this the answer to a typo is a 500.
  if (!UUID.test(id)) notFound();

  const [customer] = await db.select().from(customers).where(eq(customers.id, id));
  if (!customer) notFound();

  const [org] = await db.select().from(organization).where(eq(organization.id, 1));

  const jobs = await db
    .select({
      id: projects.id,
      projectNumber: projects.projectNumber,
      name: projects.name,
      stage: projects.stage,
      scheduledStart: projects.scheduledStart,
      actualStart: projects.actualStart,
      // Contract value is DERIVED from accepted quotes, never stored: a stored
      // copy is a second source of truth that starts disagreeing on the day
      // somebody accepts a change order.
      contractValueCents: sql<number>`coalesce((
        select sum(q.total_cents) from ${quotes} q
        where q.project_id = ${projects.id}
          and q.status = 'accepted' and q.record_status = 'active'
      ), 0)`,
    })
    .from(projects)
    .where(and(eq(projects.customerId, id), eq(projects.recordStatus, 'active')))
    .orderBy(asc(projects.projectNumber));

  const history = await db
    .select({
      id: quotes.id,
      quoteNumber: quotes.quoteNumber,
      version: quotes.version,
      kind: quotes.kind,
      status: quotes.status,
      quoteDate: quotes.quoteDate,
      validUntil: quotes.validUntil,
      totalCents: quotes.totalCents,
      projectName: projects.name,
    })
    .from(quotes)
    .innerJoin(projects, eq(quotes.projectId, projects.id))
    .where(and(eq(projects.customerId, id), eq(quotes.recordStatus, 'active')))
    .orderBy(desc(quotes.quoteDate), desc(quotes.version));

  // Ordered by when things HAPPENED, not by when they were typed: the
  // repository sorts on `occurred_at`, so Tuesday's call logged on Thursday
  // reads under Tuesday.
  const timeline = await listTimeline('customer', id);

  const today = tenantIsoToday(org?.timezone ?? 'UTC');
  // Rendered in the tenant's zone for the same reason `today` is computed in
  // it: a void recorded at 9pm belongs to that evening, not to the next day.
  const stamp = new Intl.DateTimeFormat(org?.locale ?? 'en-CA', {
    dateStyle: 'medium',
    timeZone: org?.timezone ?? 'UTC',
  });
  const active = customer.recordStatus === 'active';
  const editing = edit === '1' && active;
  // The same live-work test the void action applies, so the screen never
  // offers a button the action is going to refuse.
  const liveJobs = jobs.filter((job) => isLiveStage(job.stage));

  return (
    <div className="grid gap-4 px-4 py-4 sm:px-6">
      {/* The chips move ABOVE the name rather than beside it. Inside the
          <h1> they became part of the heading's accessible name, so the page
          announced itself as the customer's name followed by "Commercial Tax
          exempt" -- and what they say (what kind of record this is, whether it
          is still live) is exactly what an eyebrow is for. */}
      <PageHeader
        eyebrow={
          <>
            <Pill tone={customer.customerType === 'commercial' ? 'info' : 'neutral'}>
              {CUSTOMER_TYPES[customer.customerType]}
            </Pill>
            {customer.isTaxExempt ? <Pill tone="warning">Tax exempt</Pill> : null}
            {active ? null : <Pill tone="negative">Void</Pill>}
          </>
        }
        title={customer.name}
        description={
          <>
            {customer.companyName ?? 'No company recorded'}
            {customer.leadSource ? ` · ${LEAD_SOURCES[customer.leadSource]}` : ''}
          </>
        }
        actions={
          active && !editing ? (
            <>
              <Link href={`/customers/${customer.id}?edit=1`} className={buttonClass('secondary')}>
                Edit
              </Link>
              <Link
                href={`/projects/new?customer=${customer.id}`}
                className={buttonClass('secondary')}
              >
                New opportunity
              </Link>
              <Link href={`/quotes/new?customer=${customer.id}`} className={buttonClass('primary')}>
                New quote
              </Link>
            </>
          ) : null
        }
      />

      {active ? null : (
        <Notice tone="negative" title="This customer was voided">
          {customer.voidedAt ? `On ${stamp.format(customer.voidedAt)}: ` : ''}
          {customer.voidReason ?? 'No reason recorded'}. Nothing is ever deleted, so the record and
          its quotes stay readable.
        </Notice>
      )}

      {editing ? (
        <Panel title="Edit customer">
          <CustomerForm
            action={updateCustomer}
            customer={customer}
            defaultProvince={org?.province ?? ''}
            cancelHref={`/customers/${customer.id}`}
            submitLabel="Save customer"
          />
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Contact">
            <DetailList>
              <DetailRow label="Email">
                {customer.email ? (
                  <a className="text-accent-text hover:underline" href={`mailto:${customer.email}`}>
                    {customer.email}
                  </a>
                ) : (
                  <span className="text-subtle">—</span>
                )}
              </DetailRow>
              <DetailRow label="Phone" numeric>
                {customer.phone ? (
                  <a className="text-accent-text hover:underline" href={`tel:${customer.phone}`}>
                    {customer.phone}
                  </a>
                ) : (
                  <span className="text-subtle">—</span>
                )}
              </DetailRow>
              <DetailRow label="Address">
                {customer.addressLine1
                  || customer.city
                  || customer.province
                  || customer.postalCode ? (
                    <span className="grid">
                      {customer.addressLine1 ? <span>{customer.addressLine1}</span> : null}
                      {customer.addressLine2 ? <span>{customer.addressLine2}</span> : null}
                      <span>
                        {[customer.city, customer.province].filter(Boolean).join(', ')}
                        {customer.postalCode ? ` ${customer.postalCode}` : ''}
                      </span>
                    </span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
              </DetailRow>
            </DetailList>
          </Panel>

          <Panel title="Second contact">
            {customer.altContactName || customer.altContactEmail || customer.altContactPhone ? (
              <DetailList>
                <DetailRow label="Name" value={customer.altContactName} />
                <DetailRow label="Email" value={customer.altContactEmail} />
                <DetailRow label="Phone" value={customer.altContactPhone} numeric />
              </DetailList>
            ) : (
              <EmptyState>
                No second contact. Add a spouse, property manager or site contact under Edit, so a
                call about site access does not depend on one phone being answered.
              </EmptyState>
            )}
          </Panel>

          <Panel title="Tax">
            <DetailList>
              <DetailRow label="Status">
                {customer.isTaxExempt ? (
                  <Pill tone="warning">Exempt</Pill>
                ) : (
                  <span>Taxable at the rates in force</span>
                )}
              </DetailRow>
              {customer.isTaxExempt ? (
                <>
                  <DetailRow label="Exemption number" value={customer.taxExemptNumber} numeric />
                  <DetailRow label="Reason" value={customer.taxExemptReason} />
                </>
              ) : null}
            </DetailList>
          </Panel>
        </div>
      )}

      {/* High on the page rather than under the tables, because the phase turns
          on whether this gets written down at all. A quote sent and never
          chased is indistinguishable from one that was declined, and both show
          up as silence -- and the `no_activity` rule reads exactly this. */}
      <Panel title="Activity">
        {active ? (
          <div className="mb-4">
            <LogActivityForm
              entityType="customer"
              entityId={customer.id}
              today={today}
            />
          </div>
        ) : null}
        <Timeline
          entries={timeline}
          locale={org?.locale ?? 'en-CA'}
          timeZone={org?.timezone ?? 'UTC'}
        />
      </Panel>

      {/* min-w-0 on both table panels because a grid item's automatic minimum
          width is its min-content, and for a panel holding a table that
          declares a min-width that IS the table's width: without it the panel
          will not shrink and the page scrolls sideways instead of the table
          (measured: 826px of page at a 700px viewport). */}
      <Panel title="Jobs" className="min-w-0">
        {jobs.length === 0 ? (
          <EmptyState>
            No jobs for this customer yet.{' '}
            <Link
              href={`/projects/new?customer=${customer.id}`}
              className="text-accent-text hover:underline"
            >
              Start one
            </Link>
            {' '}— a quote is written against a job, not against a person.
          </EmptyState>
        ) : (
          <TableWrap minWidth="44rem" bare>
            <caption className="sr-only">Jobs for {customer.name}</caption>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Number</th>
                <th scope="col">Stage</th>
                <th scope="col">Starts</th>
                <th scope="col" className="cell-num">Contract</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td data-label="Job">
                    <Link href={`/projects/${job.id}`} className="text-accent-text hover:underline">
                      {job.name}
                    </Link>
                  </td>
                  <td data-label="Number" className="num t-small text-muted">
                    {job.projectNumber}
                  </td>
                  <td data-label="Stage">
                    <Pill tone={stageTone(job.stage)}>{PROJECT_STAGES[job.stage]}</Pill>
                  </td>
                  <td data-label="Starts" className="num t-small">
                    {job.actualStart ?? job.scheduledStart ?? '—'}
                  </td>
                  <AmountCell data-label="Contract" cents={Number(job.contractValueCents)} />
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <Panel title="Quote history" className="min-w-0">
        {history.length === 0 ? (
          <EmptyState>
            No quotes yet. Open a job and start one from its worksheet.
          </EmptyState>
        ) : (
          <TableWrap minWidth="44rem" bare>
            <caption className="sr-only">Quotes for {customer.name}</caption>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Number</th>
                <th scope="col">Dated</th>
                <th scope="col">Status</th>
                <th scope="col" className="cell-num">Total</th>
              </tr>
            </thead>
            <tbody>
              {history.map((quote) => {
                // Expiry is derived from valid_until, never stored: a stored
                // 'expired' status is wrong the moment the clock passes it.
                const expired = quote.status === 'sent' && quote.validUntil < today;
                return (
                  <tr key={quote.id}>
                    <td data-label="Job">
                      <Link href={`/quotes/${quote.id}`} className="text-accent-text hover:underline">
                        {quote.projectName}
                      </Link>
                    </td>
                    <td data-label="Number" className="num t-small text-muted">
                      {quote.quoteNumber} v{quote.version}
                      {quote.kind === 'change_order' ? ' CO' : ''}
                    </td>
                    <td data-label="Dated" className="num t-small">{quote.quoteDate}</td>
                    <td data-label="Status">
                      <Pill tone={statusTone(quote.status, expired)}>
                        {expired ? 'Expired' : quote.status}
                      </Pill>
                    </td>
                    <AmountCell data-label="Total" cents={quote.totalCents} />
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      {active && !editing ? (
        <Panel title="Void this customer" className="no-print">
          <VoidControl
            action={voidCustomer}
            recordId={customer.id}
            description="Voiding hides the customer from the lists and blocks further edits. It is never a delete — the quotes and jobs written against this record are tax documents."
            submitLabel="Void customer"
            blockerLead="This customer has live work, so the record cannot be closed out yet:"
            blockers={liveJobs.map((job) => ({
              href: `/projects/${job.id}`,
              label: `${job.projectNumber} ${job.name} — ${PROJECT_STAGES[job.stage]}`,
            }))}
          />
        </Panel>
      ) : null}
    </div>
  );
}
