import Link from 'next/link';
import { and, asc, eq, inArray, not, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, projects, quotes, stageHistory } from '@/db/schema';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FilterBar, NoMatches } from '@/components/ui/FilterBar';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  JOB_STAGES, OPPORTUNITY_STAGES, PROJECT_STAGES, type ProjectStage,
} from '@/components/detail/labels';
import { Board } from '@/components/pipeline/Board';
import {
  boardStages, CLOSED_STAGES, nextReminderByProject, SHARED_STAGES, type PipelineCard,
} from '@/components/pipeline/columns';
import { normalizeSearch, searchCondition } from '@/lib/list/search';
import { tenantToday } from '@/lib/quote/dates';
import { listReminders } from '@/lib/reminders/repository';

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

/**
 * The pipeline: every live opportunity and job, in the stage it is sitting in.
 *
 * There is ONE view here and it is the board. The table this screen used to be
 * was replaced rather than hidden behind a toggle, and the reason is worth
 * writing down: a toggle is a second render path over the same query, and the
 * filter bar is a plain GET form that would drop the toggle's parameter on
 * every search -- so the choice would silently reset itself exactly when
 * somebody was using it. The card carries everything the row carried (customer,
 * number, contract value, start date) and two things it could not (how long the
 * work has sat where it is, and the next thing to do about it), so nothing was
 * lost by picking one.
 *
 * The known cost: `complete` accumulates forever, because nothing is ever
 * deleted. That column is behind the reveal control, off by default, and when
 * a decade of finished jobs makes it unreadable the answer is paging, not a
 * second screen that has to be kept in step with this one.
 */
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
  // card itself prints, so the filter and the label cannot disagree.
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
      /**
       * How long this row has been in the stage it is in, from the transition
       * rows and never from a column.
       *
       * The LATEST entry into the current stage, not the first: a project that
       * went `lead -> quoting -> lead` has been at `lead` since the second
       * move, and measuring from the first would report a fortnight of
       * standing still that never happened.
       *
       * Whole elapsed days, floored -- the same arithmetic the stage timeline
       * on the detail screen does, so the two screens report the same number
       * about the same row.
       */
      daysInStage: sql<number | null>`(
        select floor(extract(epoch from (now() - max(sh.changed_at))) / 86400)::int
        from ${stageHistory} sh
        where sh.project_id = ${projects.id}
          and sh.to_stage = ${projects.stage}
          and sh.record_status = 'active'
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

  const cards: PipelineCard[] = rows.map((row) => ({
    id: row.id,
    projectNumber: row.projectNumber,
    name: row.name,
    customerName: row.customerName,
    stage: row.stage,
    isJob: Number(row.acceptedQuotes) > 0,
    contractValueCents: Number(row.contractValueCents),
    daysInStage: row.daysInStage === null ? null : Number(row.daysInStage),
    // Actual start beats scheduled: once a job has really begun, the date it
    // was meant to begin is history the detail screen keeps for slippage.
    startsOn: row.actualStart ?? row.scheduledStart ?? null,
  }));

  // The next thing to do about each card. Two small queries and only when
  // there is something to attach them to: an empty board asks the reminder
  // engine nothing.
  const projectIds = cards.map((card) => card.id);
  const [today, openReminders, quoteOwners] = await Promise.all([
    db.transaction((tx) => tenantToday(tx)),
    projectIds.length > 0 ? listReminders({ status: 'open' }) : Promise.resolve([]),
    projectIds.length > 0
      ? db
          .select({ id: quotes.id, projectId: quotes.projectId })
          .from(quotes)
          .where(and(inArray(quotes.projectId, projectIds), eq(quotes.recordStatus, 'active')))
      : Promise.resolve([]),
  ]);

  const reminderOf = nextReminderByProject(
    openReminders,
    new Map(quoteOwners.map((row) => [row.id, row.projectId])),
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
        // Said out loud because the board shows no figure on most of its left
        // half, and a reader who does not know why reads it as broken.
        description="Value is contract value, derived from accepted quotes — work that has not been won carries none."
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
        <Board
          cards={cards}
          stages={boardStages({ stage, kind, showClosed }, cards.map((card) => card.stage))}
          reminderOf={reminderOf}
          today={today}
          basePath="/projects"
          filters={{ q, kind, closed: params.closed === '1' ? '1' : '' }}
          stageFiltered={stage !== ''}
        />
      )}
    </div>
  );
}
