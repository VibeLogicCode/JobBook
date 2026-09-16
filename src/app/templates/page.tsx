import type { Metadata } from 'next';
import { and, asc, eq, sql } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db/client';
import { hasContractWork } from '@/lib/posture/read';
import {
  projectTypes,
  scheduleTemplateTasks,
  scheduleTemplates,
  scopeTemplateItems,
  scopeTemplates,
} from '@/db/schema';
import { can, resolveActor } from '@/app/settings/actor';
import { setTemplateActive } from '@/app/templates/actions';
import { RowAction } from '@/components/settings/ActionForm';
import { CreateTemplateForm } from '@/components/templates/CreateTemplateForm';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Section } from '@/components/settings/Section';
import { buttonClass } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Templates' };

type Kind = 'quote' | 'schedule';

/** One row of either table, in the one shape the list renders. */
interface TemplateRow {
  kind: Kind;
  id: string;
  name: string;
  projectTypeName: string;
  description: string | null;
  isActive: boolean;
  /** Template lines for a quote, tasks for a schedule -- never both. */
  count: number;
}

export default async function TemplatesPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'scopeTemplates.edit') : false;
  const disabledNote = state.actor
    ? `Your role (${state.actor.role}) cannot edit scope templates.`
    : (state.reason ?? undefined);

  // Voided lines/tasks are excluded from the count: the row survives for the
  // audit trail and the mirror, but it is not part of the template any more.
  const scopeRows = await db
    .select({
      id: scopeTemplates.id,
      name: scopeTemplates.name,
      projectTypeName: projectTypes.name,
      description: scopeTemplates.description,
      isActive: scopeTemplates.isActive,
      count: sql<number>`count(${scopeTemplateItems.id})::int`,
    })
    .from(scopeTemplates)
    .innerJoin(projectTypes, eq(scopeTemplates.projectTypeId, projectTypes.id))
    .leftJoin(
      scopeTemplateItems,
      and(
        eq(scopeTemplateItems.scopeTemplateId, scopeTemplates.id),
        eq(scopeTemplateItems.recordStatus, 'active'),
      ),
    )
    .where(eq(scopeTemplates.recordStatus, 'active'))
    .groupBy(scopeTemplates.id, projectTypes.name);

  const scheduleRows = await db
    .select({
      id: scheduleTemplates.id,
      name: scheduleTemplates.name,
      projectTypeName: projectTypes.name,
      description: scheduleTemplates.description,
      isActive: scheduleTemplates.isActive,
      count: sql<number>`count(${scheduleTemplateTasks.id})::int`,
    })
    .from(scheduleTemplates)
    .innerJoin(projectTypes, eq(scheduleTemplates.projectTypeId, projectTypes.id))
    .leftJoin(
      scheduleTemplateTasks,
      and(
        eq(scheduleTemplateTasks.scheduleTemplateId, scheduleTemplates.id),
        eq(scheduleTemplateTasks.recordStatus, 'active'),
      ),
    )
    .where(eq(scheduleTemplates.recordStatus, 'active'))
    .groupBy(scheduleTemplates.id, projectTypes.name);

  // Every project type, retired and voided included -- the create sheet's
  // picker needs the full list, exactly as `/vendors` fetches every vendor
  // type and trade unfiltered (see that page's own note on why).
  const projectTypeRows = await db
    .select()
    .from(projectTypes)
    .orderBy(asc(projectTypes.sortOrder), asc(projectTypes.name));

  // One list from two tables (design spec §4: "One list at /templates reading
  // both tables, with a Kind column"). Sorted by name -- case-insensitively,
  // matching how a person alphabetises -- and by id after that so two
  // templates sharing a name still render in the same order on every request
  // rather than however each query happened to come back.
  /**
   * Schedule templates are omitted where NOBODY does contract work.
   *
   * A task chain with dependencies and a forward pass is contract-work
   * machinery: three tasks do not want a critical path, and a service-only
   * business scrolling past them is being shown a feature it will never open.
   *
   * Filtered from the LIST here and refused at `/templates/schedule/[id]`,
   * because a hidden link is not a mechanism -- this codebase has already
   * written that about the estimator role. Both are needed: this stops it
   * being offered, the route stops it being reached.
   *
   * Asked over the whole deployment rather than per company, because a
   * schedule template belongs to a project TYPE and every company shares
   * those. One contract company means these exist.
   */
  const showSchedules = await hasContractWork();

  const rows: TemplateRow[] = [
    ...scopeRows.map((row) => ({ ...row, kind: 'quote' as const })),
    ...(showSchedules
      ? scheduleRows.map((row) => ({ ...row, kind: 'schedule' as const }))
      : []),
  ].sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id),
  );

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        title="Templates"
        description="Priced lines for a quote, or a task chain for a schedule."
        actions={
          <SheetButton
            trigger="Create a template"
            variant="primary"
            label="Create a template"
            title="Create a template"
            discardPrompt="Throw away this template? Nothing has been saved yet."
          >
            <CreateTemplateForm allowed={allowed} disabledNote={disabledNote} projectTypes={projectTypeRows} />
          </SheetButton>
        }
      />

      <div className="flex flex-col gap-4">
        <Section title="Templates">
          {state.actor ? null : (
            <div className="mb-3">
              <Notice tone="warning">{state.reason}</Notice>
            </div>
          )}

          <TableWrap minWidth="52rem">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" scope="col">Name</th>
                <th role="columnheader" scope="col">Kind</th>
                <th role="columnheader" scope="col">Project type</th>
                <th role="columnheader" scope="col" className="cell-num">
                  Lines / tasks
                </th>
                <th role="columnheader" scope="col">Status</th>
                <th role="columnheader" scope="col">Manage</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {rows.length === 0 ? (
                <tr role="row">
                  <td role="cell" data-label="Name" colSpan={6}>
                    No templates yet. Create one above — a quote can still be built line by
                    line without any.
                  </td>
                </tr>
              ) : null}

              {rows.map((row) => {
                const href =
                  row.kind === 'quote' ? `/templates/${row.id}` : `/templates/schedule/${row.id}`;
                return (
                  <tr role="row" key={`${row.kind}-${row.id}`}>
                    <td role="cell" data-label="Name">
                      <Link
                        href={href}
                        className="text-accent-text underline decoration-1 underline-offset-2"
                      >
                        {row.name}
                      </Link>
                      {row.description ? (
                        <span className="block t-small text-subtle">{row.description}</span>
                      ) : null}
                    </td>
                    <td role="cell" data-label="Kind">
                      <Pill tone={row.kind === 'quote' ? 'accent' : 'info'}>
                        {row.kind === 'quote' ? 'Quote' : 'Schedule'}
                      </Pill>
                    </td>
                    <td role="cell" data-label="Project type" className="t-small text-muted">
                      {row.projectTypeName}
                    </td>
                    <AmountCell data-label={row.kind === 'quote' ? 'Lines' : 'Tasks'}>
                      {row.count}
                    </AmountCell>
                    <td role="cell" data-label="Status">
                      {row.isActive ? (
                        <Pill tone="positive">Available</Pill>
                      ) : (
                        <Pill tone="neutral">Retired</Pill>
                      )}
                    </td>
                    <td role="cell" data-label="Manage">
                      <span className="flex flex-wrap gap-2">
                        <Link href={href} className={buttonClass('secondary', { className: 't-small' })}>
                          Open
                        </Link>
                        {row.kind === 'quote' ? (
                          <RowAction
                            action={setTemplateActive}
                            label={row.isActive ? 'Retire' : 'Bring back'}
                            destructive={row.isActive}
                            disabled={!allowed}
                            fields={{
                              id: row.id,
                              isActive: row.isActive ? 'false' : 'true',
                            }}
                            confirm={
                              row.isActive
                                ? 'Retire this template? It stops being offered on new quotes. Quotes already built from it are untouched.'
                                : undefined
                            }
                          />
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        </Section>
      </div>
    </div>
  );
}
