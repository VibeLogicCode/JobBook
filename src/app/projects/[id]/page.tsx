import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, organization, projects, quotes, stageHistory } from '@/db/schema';
import { Pill, statusTone } from '@/components/ui/Pill';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { formatBasisPoints, formatCents } from '@/lib/money/format';
import { setProjectStage, updateProject } from '@/app/projects/actions';
import { DetailList, DetailRow, EmptyState, Panel } from '@/components/detail/Panel';
import { ProjectForm } from '@/components/detail/ProjectForm';
import { StageControl } from '@/components/detail/StageControl';
import { StageTimeline } from '@/components/detail/StageTimeline';
import { tenantIsoToday } from '@/components/detail/dates';
import {
  CONTRACT_TYPES, PROJECT_STAGES, PROJECT_TYPES, stageTone, workNoun,
} from '@/components/detail/labels';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ProjectPage({
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

  const [job] = await db
    .select({
      project: projects,
      customerId: customers.id,
      customerName: customers.name,
      customerCompany: customers.companyName,
      /**
       * The contract value, DERIVED.
       *
       * There is no contract_value column and there deliberately never was
       * one: the figure is the sum of the accepted, active quotes on this job,
       * and a stored copy would start disagreeing with them the first time a
       * change order was accepted. A partial unique index already keeps at
       * most one accepted version per sequence, so this sum cannot
       * double-count a revision.
       */
      contractValueCents: sql<number>`coalesce((
        select sum(q.total_cents) from ${quotes} q
        where q.project_id = ${projects.id}
          and q.status = 'accepted' and q.record_status = 'active'
      ), 0)`,
    })
    .from(projects)
    .innerJoin(customers, eq(projects.customerId, customers.id))
    .where(eq(projects.id, id));

  if (!job) notFound();
  const { project } = job;

  const [org] = await db.select().from(organization).where(eq(organization.id, 1));

  const versions = await db
    .select({
      id: quotes.id,
      quoteNumber: quotes.quoteNumber,
      version: quotes.version,
      kind: quotes.kind,
      status: quotes.status,
      quoteDate: quotes.quoteDate,
      validUntil: quotes.validUntil,
      totalCents: quotes.totalCents,
      marginBp: quotes.marginBp,
    })
    .from(quotes)
    .where(and(eq(quotes.projectId, id), eq(quotes.recordStatus, 'active')))
    .orderBy(desc(quotes.sequence), desc(quotes.version));

  // Oldest first: the timeline measures each entry against the one after it.
  const history = await db
    .select({
      id: stageHistory.id,
      fromStage: stageHistory.fromStage,
      toStage: stageHistory.toStage,
      changedAt: stageHistory.changedAt,
      note: stageHistory.note,
    })
    .from(stageHistory)
    .where(and(eq(stageHistory.projectId, id), eq(stageHistory.recordStatus, 'active')))
    .orderBy(asc(stageHistory.changedAt));

  const customerList = await db
    .select({ id: customers.id, name: customers.name, companyName: customers.companyName })
    .from(customers)
    .where(eq(customers.recordStatus, 'active'))
    .orderBy(asc(customers.name));

  const today = tenantIsoToday(org?.timezone ?? 'UTC');
  // The record is a job from the moment a quote on it is accepted, which is
  // the same event the owner calls converting it.
  const accepted = versions.filter((quote) => quote.status === 'accepted');
  const noun = workNoun(accepted.length > 0);
  const active = project.recordStatus === 'active';
  const editing = edit === '1' && active;

  return (
    <div className="grid gap-4 px-4 py-4 sm:px-6">
      {/* Identity and the actions only. What the job is worth, who it is for
          and where it stands all read from the one block below, because the
          fact in two places is how this screen went wrong before. */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="t-title">{project.name}</h1>
        <span className="num t-small text-muted">{project.projectNumber}</span>
        <span className="t-small text-subtle">{noun}</span>
        {active ? null : <Pill tone="negative">Void</Pill>}

        <div className="no-print ml-auto flex flex-wrap gap-2">
          {active && !editing ? (
            <>
              <Link
                href={`/projects/${project.id}?edit=1`}
                className="flex min-h-11 items-center rounded-[4px] border border-line-strong bg-surface px-3 hover:bg-surface-2"
              >
                Edit
              </Link>
              {/* Another quote on the same opportunity -- a second price
                  point, or a scope the customer asked to see separately. */}
              <Link
                href={`/quotes/new?opportunity=${project.id}`}
                className="flex min-h-11 items-center rounded-[4px] bg-accent px-3 text-accent-fg hover:bg-accent-hover"
              >
                New quote
              </Link>
            </>
          ) : null}
        </div>
      </header>

      {/* Where the job stands, in one place: what it is worth, what it is,
          and which stage it is in. A stage with a panel of its own read as a
          setting to go and change rather than as this job's status, and put
          the one figure that matters two scrolls away from it. */}
      <section className="rounded-[6px] border border-line bg-surface p-4">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          <div className="min-w-0">
            {/* The label names the accepted quotes because the figure is
                derived from them -- there is no contract_value column -- and
                that is the whole reason it can be trusted. */}
            <p className="t-small text-muted">Contract value — accepted quotes</p>
            <p className="num t-display">{formatCents(Number(job.contractValueCents))}</p>
            <p className="t-small text-muted">
              {accepted.length} accepted of{' '}
              {versions.length} quote{versions.length === 1 ? '' : 's'}
            </p>
            <p className="mt-2 t-small text-muted">
              <Link
                href={`/customers/${job.customerId}`}
                className="text-accent-text hover:underline"
              >
                {job.customerName}
              </Link>
              {job.customerCompany ? ` · ${job.customerCompany}` : ''}
              {` · ${PROJECT_TYPES[project.projectType]}`}
              {project.contractType ? ` · ${CONTRACT_TYPES[project.contractType]}` : ''}
            </p>
          </div>

          {/* The control stays its own form with its own action even inside
              this block: every stage change writes a stage_history row
              through a trigger, and a stage folded in among fifteen other
              fields gets moved by accident on the way to fixing a postal
              code. It sizes to the select and its button rather than filling
              the card -- a stage change is a small, frequent adjustment, not
              this screen's primary surface. */}
          <div className="min-w-64 sm:ml-auto">
            <Pill tone={stageTone(project.stage)}>{PROJECT_STAGES[project.stage]}</Pill>
            {active && !editing ? (
              <div className="no-print mt-3">
                <StageControl
                  action={setProjectStage}
                  projectId={project.id}
                  stage={project.stage}
                  lostReason={project.lostReason}
                  hasAcceptedQuote={accepted.length > 0}
                />
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {project.stage === 'lost' && project.lostReason ? (
        <p className="rounded-[6px] border border-line bg-surface-2 px-4 py-3 t-small">
          <span className="text-muted">Lost because: </span>
          {project.lostReason}
        </p>
      ) : null}

      {editing ? (
        <Panel title={`Edit ${noun.toLowerCase()}`}>
          <ProjectForm
            action={updateProject}
            project={project}
            customers={customerList}
            defaultProvince={org?.province ?? ''}
            cancelHref={`/projects/${project.id}`}
            submitLabel={`Save ${noun.toLowerCase()}`}
            showRealisedDates
          />
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Site">
            <DetailList>
              <DetailRow label="Address">
                {project.siteAddressLine1 || project.siteCity ? (
                  <span className="grid">
                    {project.siteAddressLine1 ? <span>{project.siteAddressLine1}</span> : null}
                    <span>
                      {[project.siteCity, project.siteProvince].filter(Boolean).join(', ')}
                      {project.sitePostalCode ? ` ${project.sitePostalCode}` : ''}
                    </span>
                  </span>
                ) : (
                  <span className="text-subtle">—</span>
                )}
              </DetailRow>
              <DetailRow label="Type of work" value={PROJECT_TYPES[project.projectType]} />
              <DetailRow
                label="Contract type"
                value={project.contractType ? CONTRACT_TYPES[project.contractType] : null}
              />
            </DetailList>
          </Panel>

          <Panel title="Dates">
            <DetailList>
              {/* Scheduled and actual are separate columns, which is the only
                  reason slippage stays measurable rather than being
                  overwritten by the date the job really started. */}
              <DetailRow label="Scheduled start" value={project.scheduledStart} numeric />
              <DetailRow label="Scheduled end" value={project.scheduledEnd} numeric />
              <DetailRow label="Actual start" value={project.actualStart} numeric />
              <DetailRow label="Actual end" value={project.actualEnd} numeric />
              <DetailRow
                label="Substantial performance"
                value={project.substantialPerformanceDate}
                numeric
              />
              <DetailRow
                label="Certificate published"
                value={project.certificatePublishedDate}
                numeric
              />
            </DetailList>
            <p className="mt-2 t-small text-subtle">
              The last two are Construction Act dates: substantial performance starts the holdback
              release clock, and the statutory clock runs from publication rather than from the date
              certified.
            </p>
          </Panel>
        </div>
      )}

      {/* min-w-0 because this panel is a grid item, and a grid item's
          automatic minimum width is its min-content -- which, for a panel
          holding a table that declares a min-width, is that table's width.
          Without it the panel refuses to shrink and the PAGE scrolls
          sideways at any viewport narrower than the table (measured: 858px
          of page at a 700px viewport), which is the one thing the scroll
          container exists to prevent. */}
      <Panel title="Quotes" className="min-w-0">
        {versions.length === 0 ? (
          <EmptyState>
            No quotes on this job yet. Start one from the worksheet, or move the job to Quoting
            first so the stage history reads true.
          </EmptyState>
        ) : (
          <TableWrap minWidth="46rem" bare>
            <caption className="sr-only">Quote versions for {project.projectNumber}</caption>
            <thead>
              <tr>
                <th scope="col">Quote</th>
                <th scope="col">Version</th>
                <th scope="col">Dated</th>
                <th scope="col">Status</th>
                <th scope="col" className="cell-num">Total</th>
                <th scope="col" className="present-hide cell-num">Margin</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((quote) => {
                // Expiry derives from valid_until; there is no stored
                // 'expired' status to go stale.
                const expired = quote.status === 'sent' && quote.validUntil < today;
                return (
                  <tr key={quote.id}>
                    <td data-label="Quote">
                      <Link href={`/quotes/${quote.id}`} className="text-accent-text hover:underline">
                        {quote.quoteNumber}
                      </Link>
                      {quote.kind === 'change_order' ? (
                        <span className="ml-2">
                          <Pill tone="info">Change order</Pill>
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Version" className="num t-small text-muted">
                      v{quote.version}
                    </td>
                    <td data-label="Dated" className="num t-small">{quote.quoteDate}</td>
                    <td data-label="Status">
                      <Pill tone={statusTone(quote.status, expired)}>
                        {expired ? 'Expired' : quote.status}
                      </Pill>
                    </td>
                    <AmountCell data-label="Total" cents={quote.totalCents} />
                    {/* Margin is hidden in Present mode: he turns the laptop
                        around at the customer's kitchen table. */}
                    <AmountCell data-label="Margin" className="present-hide text-muted">
                      {formatBasisPoints(quote.marginBp)}
                    </AmountCell>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Panel>

      <Panel title="Stage history">
        <StageTimeline
          entries={history}
          locale={org?.locale ?? 'en-CA'}
          timeZone={org?.timezone ?? 'UTC'}
        />
      </Panel>
    </div>
  );
}
