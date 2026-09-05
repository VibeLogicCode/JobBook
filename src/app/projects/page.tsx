import Link from 'next/link';
import { and, asc, eq, inArray, not, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, projects, quotes } from '@/db/schema';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FilterBar, NoMatches } from '@/components/ui/FilterBar';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill } from '@/components/ui/Pill';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import {
  JOB_STAGES, OPPORTUNITY_STAGES, PROJECT_STAGES, type ProjectStage, stageTone, workNoun,
} from '@/components/detail/labels';
import { normalizeSearch, searchCondition } from '@/lib/list/search';

export const dynamic = 'force-dynamic';

/**
 * The stage dropdown, grouped the way the two halves of a project's life
 * actually divide.
 *
 * An opportunity and a job are the same `projects` row at different points,
 * and their stage sets are different -- so nine members in one flat list
 * invites the reader to think a job can be at `quoting`. The groups are
 * derived from the same two constants the stage control uses rather than
 * retyped, so a stage added to either set turns up here without anybody
 * remembering this file.
 *
 * `won` belongs to neither constant, because neither is a list of destinations
 * a person may choose -- `won` is what accepting a quote does. It is still a
 * stage a row sits at, and therefore still a thing to filter by.
 */
const SHARED_STAGES = OPPORTUNITY_STAGES.filter((stage) => JOB_STAGES.includes(stage));

const STAGE_GROUPS = [
  {
    label: 'Opportunity',
    stages: OPPORTUNITY_STAGES.filter((stage) => !SHARED_STAGES.includes(stage)),
  },
  {
    label: 'Job',
    stages: ['won' as ProjectStage, ...JOB_STAGES.filter((stage) => !SHARED_STAGES.includes(stage))],
  },
  { label: 'Either', stages: SHARED_STAGES },
].map((group) => ({
  label: group.label,
  options: group.stages.map((stage) => ({ value: stage, label: PROJECT_STAGES[stage] })),
}));

/** Work that is over. A lost bid and a finished job are both history. */
const CLOSED_STAGES: ProjectStage[] = ['lost', 'complete'];

const KIND_OPTIONS = [
  { value: 'opportunity', label: 'Opportunities' },
  { value: 'job', label: 'Jobs' },
];

function readStage(raw: string | undefined): ProjectStage | '' {
  return raw !== undefined && raw in PROJECT_STAGES ? (raw as ProjectStage) : '';
}

function readKind(raw: string | undefined): 'opportunity' | 'job' | '' {
  return raw === 'opportunity' || raw === 'job' ? raw : '';
}

/**
 * What to call the things counted, which depends on what is being shown.
 *
 * "5 records" is the word a database uses, and this product deliberately does
 * not: an opportunity and a job are the same row at different stages, and the
 * distinction is the one the owner actually thinks in -- `workNoun` exists so
 * that every other screen says it. Once the list is narrowed to one half, the
 * count can say which half. Unfiltered it names both rather than reaching for
 * a generic that means nothing to him.
 */
function countNoun(kind: 'opportunity' | 'job' | ''): { singular: string; plural: string } {
  if (kind === 'job') return { singular: 'job', plural: 'jobs' };
  if (kind === 'opportunity') return { singular: 'opportunity', plural: 'opportunities' };
  return { singular: 'opportunity or job', plural: 'opportunities and jobs' };
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; stage?: string; kind?: string; closed?: string }>;
}) {
  const params = await searchParams;
  const q = normalizeSearch(params.q);
  const stage = readStage(params.stage);
  const kind = readKind(params.kind);

  // Opportunity or job is decided by whether a quote has been accepted, never
  // by the stage -- `on_hold` is a stalled opportunity before anything is won
  // and a paused job afterwards. Same rule as `workNoun`, which is what the
  // row itself prints, so the filter and the label cannot disagree.
  const hasAcceptedQuote = sql<boolean>`exists (
    select 1 from ${quotes} q
    where q.project_id = ${projects.id}
      and q.status = 'accepted' and q.record_status = 'active'
  )`;

  const closed = inArray(projects.stage, CLOSED_STAGES);

  // Asking for a finished stage overrides the default hiding, so choosing
  // "Lost" does not return an empty screen.
  const showClosed = params.closed === '1' || CLOSED_STAGES.includes(stage as ProjectStage);

  const search = searchCondition(q, [
    projects.name,
    projects.projectNumber,
    projects.siteAddressLine1,
    projects.siteCity,
    projects.notes,
    customers.name,
    customers.companyName,
  ]);

  const kindCondition: SQL | undefined =
    kind === '' ? undefined : kind === 'job' ? hasAcceptedQuote : (not(hasAcceptedQuote) as SQL);

  // Voided projects are hidden here, never deleted, and no filter can bring
  // one back.
  const base = and(
    eq(projects.recordStatus, 'active'),
    search,
    kindCondition,
    stage === '' ? undefined : eq(projects.stage, stage),
  );

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
    .where(showClosed ? base : and(base, not(closed)))
    .orderBy(asc(projects.projectNumber));

  // Counted in SQL rather than by fetching rows and discarding them, so the
  // figure stays right once this list outgrows one screen.
  const hiddenCount = showClosed
    ? 0
    : Number(
        (
          await db
            .select({ n: sql<number>`count(*)::int` })
            .from(projects)
            .innerJoin(customers, eq(projects.customerId, customers.id))
            .where(and(base, closed))
        )[0]?.n ?? 0,
      );

  const filtered = q !== '' || stage !== '' || kind !== '';
  const describe = [
    kind ? `Showing: ${KIND_OPTIONS.find((entry) => entry.value === kind)?.label}` : '',
    stage ? `Stage: ${PROJECT_STAGES[stage]}` : '',
  ].filter(Boolean);

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        title="Pipeline"
        actions={
          <Link href="/projects/new" className={buttonClass('primary')}>
            New opportunity
          </Link>
        }
      />

      <FilterBar
        basePath="/projects"
        q={q}
        searchLabel="Search pipeline"
        searchPlaceholder="Job name, number, customer, site"
        selects={[
          {
            name: 'kind',
            label: 'Opportunity or job',
            value: kind,
            anyLabel: 'Both',
            options: KIND_OPTIONS,
          },
          {
            name: 'stage',
            label: 'Stage',
            value: stage,
            anyLabel: 'Any stage',
            groups: STAGE_GROUPS,
          },
        ]}
        reveal={{
          name: 'closed',
          on: showClosed,
          showLabel: 'Show lost and complete',
          hideLabel: 'Hide lost and complete',
          hiddenCount,
          hiddenNoun: 'closed',
        }}
        shown={rows.length}
        noun={countNoun(kind)}
      />

      {rows.length === 0 ? (
        filtered || hiddenCount > 0 ? (
          <NoMatches
            basePath="/projects"
            q={q}
            noun="opportunities or jobs"
            describe={describe}
            hint={
              hiddenCount > 0 ? (
                <>
                  {hiddenCount} lost or complete {hiddenCount === 1 ? 'record is' : 'records are'}{' '}
                  hidden by default — use &ldquo;Show lost and complete&rdquo; above.
                </>
              ) : null
            }
          />
        ) : (
          <Card as="div" className="p-6 text-muted">
            Nothing in the pipeline yet.{' '}
            <Link href="/quotes/new" className="text-accent-text hover:underline">
              Start a quote
            </Link>{' '}
            and the opportunity is created with it.
          </Card>
        )
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
