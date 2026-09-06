import { asc, count } from 'drizzle-orm';
import { db } from '@/db/client';
import { projectTypes, projects, scheduleTemplates, scopeTemplates } from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import {
  createProjectType,
  setProjectTypeActive,
  updateProjectType,
  voidProjectType,
} from '@/app/settings/project-types/actions';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid, TextField } from '@/components/settings/Fields';
import { ProjectTypeFields } from '@/components/settings/ProjectTypeFields';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the project type list but not change it.';

/**
 * What kind of work a job is: custom home, basement, kitchen, and so on.
 *
 * Used to be a hardcoded Postgres enum -- `custom_home, basement, renovation,
 * kitchen, bathroom, addition, commercial_ti, water_leak, other` -- so adding
 * "Deck" needed a migration and a deploy. This is the third list converted for
 * exactly that reason, after vendor types and trades.
 *
 * Read by three tables: `projects`, `scope_templates` and `schedule_templates`,
 * all `NOT NULL`. Retiring a type here never blanks the job, the scope
 * template or the schedule template that already carries it.
 */
export default async function ProjectTypesPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  // Voided rows stay in the list rather than being filtered away -- their name
  // is still taken, and a project, scope template or schedule template may
  // still carry them.
  const rows = await db
    .select()
    .from(projectTypes)
    .orderBy(asc(projectTypes.sortOrder), asc(projectTypes.name));

  const [onProjects, onScopeTemplates, onScheduleTemplates] = await Promise.all([
    db.select({ id: projects.projectTypeId, n: count() }).from(projects).groupBy(projects.projectTypeId),
    db.select({ id: scopeTemplates.projectTypeId, n: count() }).from(scopeTemplates).groupBy(scopeTemplates.projectTypeId),
    db.select({ id: scheduleTemplates.projectTypeId, n: count() }).from(scheduleTemplates).groupBy(scheduleTemplates.projectTypeId),
  ]);

  // Three tables carry this list, so "used by" is a sum of three counts per
  // row rather than one -- counted once for the whole list rather than once
  // per row, matching the trades screen.
  const usage = new Map<string, { projects: number; scopeTemplates: number; scheduleTemplates: number }>();
  const bump = (id: string | null, key: 'projects' | 'scopeTemplates' | 'scheduleTemplates', n: number) => {
    if (id === null) return;
    const entry = usage.get(id) ?? { projects: 0, scopeTemplates: 0, scheduleTemplates: 0 };
    entry[key] = n;
    usage.set(id, entry);
  };
  for (const row of onProjects) bump(row.id, 'projects', Number(row.n));
  for (const row of onScopeTemplates) bump(row.id, 'scopeTemplates', Number(row.n));
  for (const row of onScheduleTemplates) bump(row.id, 'scheduleTemplates', Number(row.n));

  function usedByText(id: string): string {
    const u = usage.get(id);
    if (!u) return 'Nothing yet';
    const parts = [
      u.projects > 0 ? `${u.projects} ${u.projects === 1 ? 'project' : 'projects'}` : '',
      u.scopeTemplates > 0 ? `${u.scopeTemplates} scope ${u.scopeTemplates === 1 ? 'template' : 'templates'}` : '',
      u.scheduleTemplates > 0
        ? `${u.scheduleTemplates} schedule ${u.scheduleTemplates === 1 ? 'template' : 'templates'}`
        : '',
    ].filter(Boolean);
    return parts.length === 0 ? 'Nothing yet' : parts.join(', ');
  }

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Project types"
        description={
          <p>What kind of work a job is. Every project, scope template and schedule template names one.</p>
        }
        actions={
          <SheetButton
            trigger="Add a project type"
            variant="primary"
            label="Add a project type"
            title="Add a project type"
            discardPrompt="Throw away this project type? Nothing has been saved yet."
          >
            <ActionForm
              action={createProjectType}
              submitLabel="Add project type"
              disabled={!allowed}
              disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
              resetOnSuccess
            >
              <FieldGrid>
                <ProjectTypeFields idPrefix="new-project-type" disabled={!allowed} />
              </FieldGrid>
            </ActionForm>
          </SheetButton>
        }
      >
        {state.actor ? null : (
          <div className="mb-3">
            <Notice tone="warning">{state.reason}</Notice>
          </div>
        )}

        <Notice tone="info" title="Retiring a project type does not blank the work that has it">
          <p>Stops it being offered on new work — everything already on it keeps it.</p>
          <p className="mt-2">
            Renaming relabels everyone at once — right for a spelling fix, wrong for a type
            that&rsquo;s actually changed; retire and add a new one instead.
          </p>
        </Notice>

        <TableWrap minWidth="52rem" className="mt-4">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="cell-num">Order</th>
              <th scope="col">Used by</th>
              <th scope="col">Status</th>
              <th scope="col">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td data-label="Name" colSpan={5}>
                  No project types yet. Add the kinds of work you actually quote — custom
                  homes, basements, kitchens, whatever your business calls a job.
                </td>
              </tr>
            ) : null}

            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const u = usage.get(row.id);
              const total = (u?.projects ?? 0) + (u?.scopeTemplates ?? 0) + (u?.scheduleTemplates ?? 0);

              return (
                <tr key={row.id}>
                  <td data-label="Name">{row.name}</td>
                  <AmountCell data-label="Order">{row.sortOrder}</AmountCell>
                  <td data-label="Used by" className="t-small text-muted">
                    {usedByText(row.id)}
                  </td>
                  <td data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {!isVoid && row.isActive ? <Pill tone="positive">On the list</Pill> : null}
                      {!isVoid && !row.isActive ? <Pill tone="neutral">Retired</Pill> : null}
                    </span>
                  </td>
                  <td data-label="Manage">
                    <SheetButton
                      trigger="Change…"
                      label={`Change ${row.name}`}
                      title={`Change ${row.name}`}
                      subtitle={total === 0 ? 'Nothing carries this type yet' : usedByText(row.id)}
                      discardPrompt="Throw away the changes to this project type? Nothing has been saved yet."
                    >
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Edit this project type</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            A rename reaches every project, scope template and schedule template
                            filed under it.
                          </p>
                          <ActionForm
                            action={updateProjectType}
                            submitLabel="Save this project type"
                            disabled={!allowed || isVoid}
                            disabledNote={
                              isVoid
                                ? 'This project type is void. A void row is kept as a record and is not edited.'
                                : allowed
                                  ? undefined
                                  : REFUSAL
                            }
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              <ProjectTypeFields
                                idPrefix={`edit-${row.id}`}
                                row={row}
                                disabled={!allowed || isVoid}
                              />
                            </FieldGrid>
                          </ActionForm>
                        </div>

                        <div>
                          <h3 className="t-small font-semibold">
                            {row.isActive ? 'Retire' : 'Bring back'}
                          </h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Stops it being offered on new work. Everything already carrying it is
                            unaffected.
                          </p>
                          <RowAction
                            action={setProjectTypeActive}
                            label={row.isActive ? 'Retire this project type' : 'Bring it back'}
                            destructive={row.isActive}
                            disabled={!allowed || isVoid}
                            fields={{ id: row.id, isActive: row.isActive ? 'false' : 'true' }}
                            confirm={
                              row.isActive
                                ? `Retire ${row.name}? It stops being offered on new work. Nothing already carrying it changes.`
                                : undefined
                            }
                          />
                        </div>

                        {isVoid ? (
                          <div>
                            <h3 className="t-small font-semibold">Voided</h3>
                            <p className="max-w-prose t-small text-subtle">
                              {row.voidReason ?? 'No reason was recorded.'}
                            </p>
                          </div>
                        ) : (
                          <div>
                            <h3 className="t-small font-semibold">Void it</h3>
                            <p className="mb-2 max-w-prose t-small text-subtle">
                              For a row that never should have existed. Use Retire for a type you
                              no longer offer — voiding keeps the name reserved.
                            </p>
                            {total > 0 ? (
                              <Notice tone="warning">
                                {usedByText(row.id)} {total === 1 ? 'carries' : 'carry'} this
                                project type, so voiding it will be refused. A type doing that
                                work was not a mistake — retire it instead.
                              </Notice>
                            ) : (
                              <ActionForm
                                action={voidProjectType}
                                submitLabel="Void this project type"
                                destructive
                                disabled={!mayVoid}
                                disabledNote={
                                  mayVoid ? undefined : 'Your role does not permit voiding a record.'
                                }
                              >
                                <input type="hidden" name="id" value={row.id} />
                                <TextField
                                  idPrefix={`void-${row.id}`}
                                  name="reason"
                                  label="Reason"
                                  required
                                  maxLength={300}
                                  disabled={!mayVoid}
                                  wide
                                  hint="Kept on the record permanently."
                                />
                              </ActionForm>
                            )}
                          </div>
                        )}
                      </div>
                    </SheetButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      </Section>
    </div>
  );
}
