import { and, asc, eq, sql } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db/client';
import { scopeTemplateItems, scopeTemplates } from '@/db/schema';
import { can, resolveActor } from '@/app/settings/actor';
import { createTemplate, setTemplateActive } from '@/app/templates/actions';
import { PROJECT_TYPE_LABELS, PROJECT_TYPE_OPTIONS } from '@/app/templates/schema';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid, SelectField, TextAreaField, TextField } from '@/components/settings/Fields';
import { Notice } from '@/components/settings/Notice';
import { Section } from '@/components/settings/Section';
import { Pill } from '@/components/ui/Pill';
import { AmountCell, TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'scopeTemplates.edit') : false;

  // Voided lines are excluded from the count: the row survives for the audit
  // trail and the mirror, but it is not part of the template any more.
  const rows = await db
    .select({
      template: scopeTemplates,
      lineCount: sql<number>`count(${scopeTemplateItems.id})::int`,
    })
    .from(scopeTemplates)
    .leftJoin(
      scopeTemplateItems,
      and(
        eq(scopeTemplateItems.scopeTemplateId, scopeTemplates.id),
        eq(scopeTemplateItems.recordStatus, 'active'),
      ),
    )
    .where(eq(scopeTemplates.recordStatus, 'active'))
    .groupBy(scopeTemplates.id)
    .orderBy(asc(scopeTemplates.name));

  return (
    <div className="px-4 py-4 sm:px-6">
      <h1 className="t-title mb-1">Scope templates</h1>
      <p className="mb-4 max-w-prose t-small text-muted">
        A template is a line set plus the rule for each quantity. Choose one on a quote, enter
        the measurements, and the whole scope generates — then adjust it. It is the difference
        between quoting from a list and quoting from memory.
      </p>

      <div className="flex flex-col gap-4">
        <Section title="Templates">
          {state.actor ? null : (
            <div className="mb-3">
              <Notice tone="warning">{state.reason}</Notice>
            </div>
          )}

          <TableWrap minWidth="48rem">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Project type</th>
                <th scope="col" className="cell-num">
                  Lines
                </th>
                <th scope="col">Status</th>
                <th scope="col">Manage</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td data-label="Name" colSpan={5}>
                    No templates yet. Create one below — a quote can still be built line by
                    line without any.
                  </td>
                </tr>
              ) : null}

              {rows.map(({ template, lineCount }) => (
                <tr key={template.id}>
                  <td data-label="Name">
                    <Link
                      href={`/templates/${template.id}`}
                      className="text-accent-text underline decoration-1 underline-offset-2"
                    >
                      {template.name}
                    </Link>
                    {template.description ? (
                      <span className="block t-small text-subtle">{template.description}</span>
                    ) : null}
                  </td>
                  <td data-label="Project type" className="t-small text-muted">
                    {PROJECT_TYPE_LABELS[template.projectType] ?? template.projectType}
                  </td>
                  <AmountCell data-label="Lines">{lineCount}</AmountCell>
                  <td data-label="Status">
                    {template.isActive ? (
                      <Pill tone="positive">Available</Pill>
                    ) : (
                      <Pill tone="neutral">Retired</Pill>
                    )}
                  </td>
                  <td data-label="Manage">
                    <span className="flex flex-wrap gap-2">
                      <Link
                        href={`/templates/${template.id}`}
                        className="min-h-11 rounded-[4px] border border-line-strong px-3 py-2 t-small hover:bg-surface-2"
                      >
                        Open
                      </Link>
                      <RowAction
                        action={setTemplateActive}
                        label={template.isActive ? 'Retire' : 'Bring back'}
                        destructive={template.isActive}
                        disabled={!allowed}
                        fields={{
                          id: template.id,
                          isActive: template.isActive ? 'false' : 'true',
                        }}
                        confirm={
                          template.isActive
                            ? 'Retire this template? It stops being offered on new quotes. Quotes already built from it are untouched.'
                            : undefined
                        }
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Section>

        <Section
          title="Create a template"
          description={
            <p>
              Name it after the job it prices, because that is what the owner picks from on a
              quote. The project type is what filters the list down.
            </p>
          }
        >
          <ActionForm
            action={createTemplate}
            submitLabel="Create template"
            disabled={!allowed}
            disabledNote={
              state.actor
                ? `Your role (${state.actor.role}) cannot edit scope templates.`
                : (state.reason ?? undefined)
            }
            resetOnSuccess
          >
            <FieldGrid>
              <TextField
                idPrefix="new-template"
                name="name"
                label="Name"
                required
                maxLength={200}
                disabled={!allowed}
              />
              <SelectField
                idPrefix="new-template"
                name="projectType"
                label="Project type"
                required
                defaultValue="renovation"
                options={PROJECT_TYPE_OPTIONS}
                disabled={!allowed}
              />
              <TextAreaField
                idPrefix="new-template"
                name="description"
                label="Description"
                rows={3}
                disabled={!allowed}
                hint="What this template covers, and what it deliberately leaves out."
              />
            </FieldGrid>
          </ActionForm>
        </Section>
      </div>
    </div>
  );
}
