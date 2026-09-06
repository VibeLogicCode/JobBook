import type { Metadata } from 'next';
import Link from 'next/link';
import { and, asc, eq, inArray, not, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, projects, quotes, stageHistory } from '@/db/schema';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FilterBar, filterHref, NoMatches } from '@/components/ui/FilterBar';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  JOB_STAGES, OPPORTUNITY_STAGES, PROJECT_STAGES, type ProjectStage,
} from '@/components/detail/labels';
import { Board } from '@/components/pipeline/Board';
import { PipelineList } from '@/components/pipeline/List';
import { ViewToggle } from '@/components/pipeline/ViewToggle';
import { readView, viewParam } from '@/components/pipeline/view';
import {
  CLOSED_STAGES, nextReminderByProject, SHARED_STAGES, showsClosed, type PipelineCard,
} from '@/components/pipeline/columns';
import { normalizeSearch, searchCondition } from '@/lib/list/search';
import { tenantToday } from '@/lib/quote/dates';
import { listReminders } from '@/lib/reminders/repository';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Pipeline' };

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
 * TWO VIEWS OF ONE QUERY, chosen by `?view=`. The board is the default and the
 * list is the table this screen used to be, brought back with what the board
 * taught it. What is NOT duplicated is everything above the render: one set of
 * filters, one closed-record rule, one derived contract value, one
 * accepted-quote test, one query, one reminder lookup. Both components take the
 * same `PipelineCard[]`, so there is nothing here that can drift out of step --
 * a figure can only be wrong on both views at once.
 *
 * That was not free the first time it was considered. The table was DELETED
 * rather than toggled, on the grounds that the filter bar is a plain GET form
 * which posts its own controls and nothing else, so `?view=` would have been
 * dropped on every search and the toggle would have silently reset itself at
 * the moment somebody was using it. That was a correct reading of the bar as it
 * stood. The bar now takes a `carry` prop -- arbitrary parameters rendered as
 * hidden inputs and folded into the links it builds -- so the objection is
 * answered at the cause rather than worked around here.
 *
 * The known cost, unchanged: `complete` accumulates forever, because nothing is
 * ever deleted. It is behind the reveal control, off by default, and when a
 * decade of finished jobs makes either view unreadable the answer is paging.
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    stage?: string;
    kind?: string;
    closed?: string;
    view?: string;
  }>;
}) {
  const params = await searchParams;
  const q = normalizeSearch(params.q);
  const stage = readStage(params.stage);
  const kind = readKind(params.kind);
  const view = readView(params.view);

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

  // The `closed` parameter as the board reads it, so the query and the columns
  // cannot disagree about whether finished work is on screen. `showsClosed`
  // holds the rule -- including that asking for a finished stage overrides the
  // default hiding, so choosing "Lost" does not return an empty screen.
  const closedParam = params.closed === '1' ? '1' : '';
  const showClosed = showsClosed({ stage, closed: closedParam });

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
      // The town, because a contractor names a job by where it is.
      siteCity: projects.siteCity,
      stage: projects.stage,
      scheduledStart: projects.scheduledStart,
      // The end DATE a running job is working towards. Scheduled, not actual:
      // an actual end is a job that is finished, and a finished job is not on
      // this board by default.
      scheduledEnd: projects.scheduledEnd,
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
    siteCity: row.siteCity,
    stage: row.stage,
    isJob: Number(row.acceptedQuotes) > 0,
    contractValueCents: Number(row.contractValueCents),
    daysInStage: row.daysInStage === null ? null : Number(row.daysInStage),
    // The three dates are handed over as they are stored. Which of them a card
    // says, and in what words, is `columns.ts`'s decision -- a running job
    // reports the day it really started and the day it is due to finish, and
    // everything else reports when it begins.
    scheduledStart: row.scheduledStart,
    actualStart: row.actualStart,
    scheduledEnd: row.scheduledEnd,
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
  // What every link out of this screen has to keep. One object, so the toggle,
  // the reveal, Clear and the board's stage headings cannot each carry a
  // different subset of the filters.
  const query = { q, stage, kind, closed: closedParam };
  const describe = [
    kind ? `Showing: ${KIND_OPTIONS.find((entry) => entry.value === kind)?.label}` : '',
    stage ? `Stage: ${PROJECT_STAGES[stage]}` : '',
  ].filter(Boolean);

  return (
    <div className="px-4 py-4 sm:px-6">
      {/* No description. It said that value is contract value derived from
          accepted quotes and that unwon work carries none -- a docblock shown
          to the user, four lines down a phone screen, explaining an absence
          the Opportunities band now states by being called that. */}
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
        // The view is the screen's, not the bar's -- the bar has no idea there
        // are two of them. It carries the parameter through a search, through
        // the reveal and through Clear, which is the whole reason this toggle
        // can exist at all.
        carry={{ view: viewParam(view) }}
        // In the count line rather than above it, so the control costs no row
        // of its own on a phone. It sits beside "Show lost and complete" and
        // "Clear", which is where the other statements about what is on screen
        // already live.
        trailing={<ViewToggle basePath="/projects" filters={query} view={view} />}
        shown={rows.length}
        noun={countNoun(kind)}
      />

      {rows.length === 0 ? (
        filtered || hiddenCount > 0 ? (
          <NoMatches
            // Clearing a filter is not a request for the other view. The
            // parameter rides along, the same way it does through the bar.
            basePath={filterHref('/projects', { view: viewParam(view) })}
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
      ) : view === 'list' ? (
        <PipelineList cards={cards} reminderOf={reminderOf} today={today} />
      ) : (
        // The board's stage headings deliberately carry no `view`: they are
        // only reachable from the board, and the board is what an absent
        // parameter means. Adding it would put `view=board` in every URL to say
        // what the default already says.
        <Board
          cards={cards}
          reminderOf={reminderOf}
          today={today}
          basePath="/projects"
          filters={query}
          showClosed={showClosed}
        />
      )}
    </div>
  );
}
