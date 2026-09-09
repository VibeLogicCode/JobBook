import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, organization, projects, projectTypes, quotes, stageHistory } from '@/db/schema';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill, statusTone } from '@/components/ui/Pill';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { defaultProvince } from '@/lib/company/load';
import { flagsForProject } from '@/lib/posture/read';
import { formatBasisPoints, formatCents } from '@/lib/money/format';
import { setProjectStage, updateProject } from '@/app/projects/actions';
import { EditSheet } from '@/components/detail/EditSheet';
import { DetailList, DetailRow, EmptyState, Panel } from '@/components/detail/Panel';
import { ProjectFields } from '@/components/detail/ProjectForm';
import { StageControl } from '@/components/detail/StageControl';
import { StageTimeline } from '@/components/detail/StageTimeline';
import { tenantIsoToday } from '@/components/detail/dates';
import { AddReminderForm } from '@/components/reminders/AddReminderForm';
import { LogActivityForm } from '@/components/timeline/LogActivityForm';
import { Timeline } from '@/components/timeline/Timeline';
import { listTimeline } from '@/lib/reminders/repository';
import {
  CONTRACT_TYPES, PROJECT_STAGES, stageTone, workNoun,
} from '@/components/detail/labels';
import { isUuid } from '@/lib/ids';

export const dynamic = 'force-dynamic';

/**
 * The job, its customer and its derived contract value -- the one query this
 * page runs to know what it is showing. `cache()`-wrapped so `generateMetadata`
 * and the page below share this single read instead of running it twice.
 */
const loadProjectRecord = cache(async (id: string) => {
  const [job] = await db
    .select({
      project: projects,
      customerId: customers.id,
      customerName: customers.name,
      customerCompany: customers.companyName,
      projectTypeName: projectTypes.name,
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
    .innerJoin(projectTypes, eq(projects.projectTypeId, projectTypes.id))
    .where(eq(projects.id, id));

  return job ?? null;
});

/**
 * Record first, tenant last: the job's number and name, so a tab on this
 * job's record reads apart from its schedule and its billing, open beside it.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (!isUuid(id)) return { title: 'Job' };
  try {
    const job = await loadProjectRecord(id);
    return { title: job ? `${job.project.projectNumber} — ${job.project.name}` : 'Job' };
  } catch {
    return { title: 'Job' };
  }
}

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
  if (!isUuid(id)) notFound();

  const job = await loadProjectRecord(id);

  if (!job) notFound();
  const { project } = job;

  const [org] = await db
    .select({ locale: organization.locale, timezone: organization.timezone })
    .from(organization)
    .where(eq(organization.id, 1));
  // A pre-fill, blank when two companies disagree about the answer.
  const province = await defaultProvince();
  /**
   * What paperwork this KIND of work needs, read from the job's own type.
   *
   * Never from the company's posture: switching a company to service-only must
   * not remove the substantial-performance date from a contract already signed
   * -- that date is what makes the billing screen able to say when the
   * holdback becomes invoiceable.
   */
  const flags = await flagsForProject(db, id);

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

  // Every project type, retired and voided included -- this job's own may no
  // longer be offered to new work, and it still has to render and resolve in
  // the edit sheet's picker.
  const projectTypeList = await db
    .select()
    .from(projectTypes)
    .orderBy(asc(projectTypes.sortOrder), asc(projectTypes.name));

  // What happened on this job, ordered by when it happened rather than by when
  // it was typed. Separate from the stage history below, and deliberately: one
  // is what the system did to the record, the other is what people did about
  // the work.
  const timeline = await listTimeline('project', id);

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
      <PageHeader
        eyebrow={
          <>
            <span className="num">{project.projectNumber}</span>
            <span>{noun}</span>
            {active ? null : <Pill tone="negative">Void</Pill>}
          </>
        }
        title={project.name}
        actions={
          active ? (
            <>
              {/* Still a link to `?edit=1`, and still rendered while the sheet
                  is open: it is the element focus goes back to when the sheet
                  closes, and a trigger that unmounts on open has nowhere to
                  return focus to. Behind the blur it is simply page. */}
              <Link
                href={`/projects/${project.id}?edit=1`}
                scroll={false}
                className={buttonClass('secondary')}
              >
                Edit
              </Link>
              {/* Billing is offered only once something has actually been
                  sold. An opportunity has no contract to bill against, and
                  the billing action refuses one outright -- so showing the
                  link on a lead would be an invitation to a dead end. The
                  condition is the same accepted-quote test the noun above
                  uses, rather than a second reading of `stage`. */}
              {/* Spend is offered on an opportunity too, not only a job. A
                  site visit driven to on a lead that never sells is a real
                  cost, and a screen that refuses to record it is how that
                  cost stops being counted. The job is carried in the query
                  string, so the form opens with it already chosen and the
                  cost lands against this record rather than being picked
                  from a list of twenty. */}
              <Link
                href={`/expenses?project=${project.id}`}
                className={buttonClass('secondary')}
              >
                Expenses
              </Link>
              {/* Scheduling and billing both need something sold. There is no
                  work to sequence and no contract to bill against until a
                  quote is accepted, and both actions refuse an opportunity
                  outright -- so the links would be invitations to a dead end.
                  The condition is the same accepted-quote test the noun above
                  uses, rather than a second reading of `stage`. */}
              {accepted.length > 0 ? (
                <>
                  <Link
                    href={`/projects/${project.id}/schedule`}
                    className={buttonClass('secondary')}
                  >
                    Schedule
                  </Link>
                  <Link
                    href={`/projects/${project.id}/billing`}
                    className={buttonClass('secondary')}
                  >
                    Billing
                  </Link>
                </>
              ) : null}
              {/* Another quote on the same opportunity -- a second price
                  point, or a scope the customer asked to see separately. */}
              <Link href={`/quotes/new?opportunity=${project.id}`} className={buttonClass('primary')}>
                New quote
              </Link>
            </>
          ) : null
        }
      />

      {/* Where the job stands, in one place: what it is worth, what it is,
          and which stage it is in. A stage with a panel of its own read as a
          setting to go and change rather than as this job's status, and put
          the one figure that matters two scrolls away from it. */}
      {/* Not a `MetricCard`: this block puts the stage control BESIDE the
          figure, and MetricCard stacks its slots. The surface treatment is
          `Card`'s either way, so the panel is not described twice. */}
      <Card className="p-4">
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
              {` · ${job.projectTypeName}`}
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
            {active ? (
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
      </Card>

      {project.stage === 'lost' && project.lostReason ? (
        <Notice tone="neutral" title="Lost because">
          {project.lostReason}
        </Notice>
      ) : null}

      {/* The form OVER the record, not INSTEAD of it. `?edit=1` still decides
          -- so the URL stays linkable and survives a reload -- but what it now
          switches on is a sheet, and the panels below stay on screen behind the
          blur. Pressing Edit used to make the job you came to read disappear.

          `lg` rather than `xl`. Fourteen fields is a lot, but they are short
          ones -- a postal code, four dates -- and at `xl` the two columns run
          to 26rem each, which is a street address with a hand's width of empty
          box after it. `lg` gives the same two readable columns the rate
          editor settled on, and the DEPTH is handled by the sheet's own scroll
          with Save pinned under it rather than by making the panel wider. */}
      {editing ? (
        <EditSheet
          action={updateProject}
          recordId={project.id}
          closeHref={`/projects/${project.id}`}
          label={`Edit ${project.name}`}
          title={`Edit ${noun.toLowerCase()}`}
          subtitle={`${project.projectNumber} · ${project.name}`}
          submitLabel={`Save ${noun.toLowerCase()}`}
          discardPrompt={`Throw away the changes to this ${noun.toLowerCase()}? Nothing has been saved yet.`}
        >
          <ProjectFields
            constructionActDates={flags.constructionActDates}
            project={project}
            customers={customerList}
            projectTypes={projectTypeList}
            defaultProvince={province ?? ''}
            showRealisedDates
          />
        </EditSheet>
      ) : null}

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
            <DetailRow label="Type of work" value={job.projectTypeName} />
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

      {/* Above the quote table, because a job's next action is decided by the
          last conversation about it rather than by the version history -- and
          because a form nobody scrolls to is a form nobody fills in. */}
      <Panel title="Activity">
        {active ? (
          <div className="mb-4 flex flex-wrap gap-2">
            <LogActivityForm
              entityType="project"
              entityId={project.id}
              today={today}
            />
            {/* Beside logging, not under it. Both answer "what about this
                record?" -- one records what already happened, the other puts
                something on the screen for a morning still to come -- and a
                reminder control anywhere else is one the owner has to go
                looking for. Secondary, so it does not compete with the
                primary action next to it. */}
            <AddReminderForm
              entityType="project"
              entityId={project.id}
              label={project.name}
            />
          </div>
        ) : null}
        <Timeline
          entries={timeline}
          locale={org?.locale ?? 'en-CA'}
          timeZone={org?.timezone ?? 'UTC'}
        />
      </Panel>

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
