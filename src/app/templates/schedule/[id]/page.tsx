import type { Metadata } from 'next';
import { and, asc, eq, ne } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { hasContractWork } from '@/lib/posture/read';
import { cache } from 'react';
import { db } from '@/db/client';
import {
  costCodes,
  organization,
  projectTypes,
  rateItems,
  scheduleTemplates,
  scheduleTemplateTasks,
  trades,
} from '@/db/schema';
import { can } from '@/lib/auth/permissions';
import { resolveActor } from '@/app/settings/actor';
import {
  createTemplateTask,
  setScheduleTemplateActive,
  updateScheduleTemplate,
} from '@/app/templates/schedule/actions';
import { listOptions } from '@/app/settings/project-lists';
import { ScheduleTemplateTasks, type TemplateTaskRow } from '@/app/templates/schedule/[id]/ScheduleTemplateTasks';
import { TemplateTaskFields } from '@/components/schedule/TemplateTaskFields';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid, type Option, SelectField, TextAreaField, TextField } from '@/components/settings/Fields';
import { PageHeader } from '@/components/ui/PageHeader';
import { Section } from '@/components/settings/Section';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { isUuid } from '@/lib/ids';

export const dynamic = 'force-dynamic';

/** `cache()`-wrapped so `generateMetadata` and the page share this one read. */
const loadScheduleTemplate = cache(async (id: string) => {
  const [template] = await db.select().from(scheduleTemplates).where(eq(scheduleTemplates.id, id));
  return template ?? null;
});

/** The template's own name, its home screen already having said what kind it is. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  // A mistyped URL is a 404, not a 500: an id of the wrong shape reaches the
  // driver as `invalid input syntax for type uuid` and surfaces as an error page.
  if (!isUuid(id)) notFound();
  try {
    const template = await loadScheduleTemplate(id);
    return { title: template && template.recordStatus !== 'void' ? template.name : 'Template' };
  } catch {
    return { title: 'Template' };
  }
}

/**
 * The schedule template editor -- section 5 of
 * `docs/superpowers/specs/2026-09-05-schedule-templates-design.md`.
 *
 * Shaped after `src/app/templates/[id]/page.tsx` (the scope template editor)
 * on purpose: a header with an "Add a task" sheet, a table of rows each with
 * its own "Change…" sheet, one field component shared by both. That file is
 * not imported from or edited here -- the two template kinds share nothing
 * but the shape of the SCREEN (section 4 of the design doc is explicit they
 * are two tables, not one with a `kind`), so the shape is copied and the code
 * is not.
 *
 * Authorization mirrors `src/app/projects/[id]/schedule/page.tsx` rather than
 * `src/app/templates/[id]/page.tsx`: `can()` is read straight from
 * `src/lib/auth/permissions.ts` with the canonical capability (`rates:edit`,
 * `record:void`) rather than through `src/app/settings/actor.ts`'s
 * `SETTINGS_CAPABILITIES` alias, which has no `scheduleTemplates.edit` entry
 * yet and is owned by another agent's work in this same change. Section 8 of
 * the design doc records that the eventual rename changes nothing observable
 * -- `rates:edit` already covers exactly the roles a schedule template needs.
 */
export default async function ScheduleTemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // A mistyped URL is a 404, not a 500: an id of the wrong shape reaches the
  // driver as `invalid input syntax for type uuid` and surfaces as an error page.
  if (!isUuid(id)) notFound();

  /**
   * Refused where NOBODY in this deployment does contract work.
   *
   * On the ROUTE and not only on the link that reaches it. A hidden nav entry
   * is not a mechanism -- this codebase has already written that about the
   * estimator role -- and `/templates` filtering these out of its list is the
   * other half of the same rule, not a substitute for it. A bookmark, a stale
   * tab and a typed URL all arrive here.
   *
   * `notFound` rather than a refusal sentence, deliberately: under service-only
   * this concept does not exist rather than being withheld, so "not found" is
   * the true answer and a permission-shaped message would suggest asking
   * somebody for access to it.
   *
   * `hasContractWork` fails OPEN on an unreadable database -- a blip must not
   * 404 a template somebody is editing.
   */
  if (!(await hasContractWork())) notFound();

  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  const template = await loadScheduleTemplate(id);
  if (!template || template.recordStatus === 'void') notFound();

  const taskRows = await db
    .select({
      id: scheduleTemplateTasks.id,
      name: scheduleTemplateTasks.name,
      tradeId: scheduleTemplateTasks.tradeId,
      costCodeId: scheduleTemplateTasks.costCodeId,
      notes: scheduleTemplateTasks.notes,
      sortOrder: scheduleTemplateTasks.sortOrder,
      isMilestone: scheduleTemplateTasks.isMilestone,
      durationBaseDays: scheduleTemplateTasks.durationBaseDays,
      durationSource: scheduleTemplateTasks.durationSource,
      durationAreaPerDayMilli: scheduleTemplateTasks.durationAreaPerDayMilli,
      durationDaysPerUnit: scheduleTemplateTasks.durationDaysPerUnit,
      predecessorTaskId: scheduleTemplateTasks.predecessorTaskId,
      lagDays: scheduleTemplateTasks.lagDays,
      conditionMeasurement: scheduleTemplateTasks.conditionMeasurement,
      conditionRateItemId: scheduleTemplateTasks.conditionRateItemId,
    })
    .from(scheduleTemplateTasks)
    .where(
      and(
        eq(scheduleTemplateTasks.scheduleTemplateId, id),
        ne(scheduleTemplateTasks.recordStatus, 'void'),
      ),
    )
    .orderBy(asc(scheduleTemplateTasks.sortOrder));

  const rows: TemplateTaskRow[] = taskRows;

  // One query each for trades, cost codes and rate items -- filtered to
  // active for the picker's OPTIONS, unfiltered for the NAME/CODE a void or
  // retired one still needs in the read-only table and the condition
  // sentence. Matching the quote template editor's own convention
  // (`src/app/templates/[id]/page.tsx` lists only active rate items) rather
  // than the vendor screen's append-the-current-value trick: this screen has
  // no evidence a template task commonly points at an already-retired trade,
  // and the simpler query is the one that does not drift from its sibling.
  const tradeRows = await db
    .select({ id: trades.id, name: trades.name, isActive: trades.isActive, recordStatus: trades.recordStatus })
    .from(trades)
    .orderBy(asc(trades.sortOrder), asc(trades.name));
  const tradeNameById = new Map(tradeRows.map((trade) => [trade.id, trade.name]));
  const tradeOptions: Option[] = tradeRows
    .filter((trade) => trade.isActive && trade.recordStatus === 'active')
    .map((trade) => ({ value: trade.id, label: trade.name }));

  const costCodeRows = await db
    .select({
      id: costCodes.id,
      code: costCodes.code,
      name: costCodes.name,
      isActive: costCodes.isActive,
      recordStatus: costCodes.recordStatus,
    })
    .from(costCodes)
    .orderBy(asc(costCodes.sortOrder), asc(costCodes.code));
  const costCodeOptions: Option[] = costCodeRows
    .filter((code) => code.isActive && code.recordStatus === 'active')
    .map((code) => ({ value: code.id, label: `${code.code} — ${code.name}` }));

  const rateItemRows = await db
    .select({
      id: rateItems.id,
      code: rateItems.code,
      description: rateItems.description,
      isActive: rateItems.isActive,
      recordStatus: rateItems.recordStatus,
    })
    .from(rateItems)
    .orderBy(asc(rateItems.sortOrder), asc(rateItems.code));
  const rateItemCodeById = new Map(rateItemRows.map((item) => [item.id, item.code]));
  const rateItemOptions: Option[] = rateItemRows
    .filter((item) => item.isActive && item.recordStatus === 'active')
    .map((item) => ({ value: item.id, label: `${item.code} — ${item.description}` }));

  const [org] = await db.select().from(organization).where(eq(organization.id, 1));
  const areaUnit = org?.areaUnit ?? 'sqft';

  // Every project type, retired and voided included -- this template's own
  // may not be offered to new work any more, and it still has to render.
  const projectTypeRows = await db
    .select()
    .from(projectTypes)
    .orderBy(asc(projectTypes.sortOrder), asc(projectTypes.name));

  const nextSortOrder = taskRows.reduce((max, task) => Math.max(max, task.sortOrder), 0) + 10;
  // Every existing task is a valid predecessor for a brand-new one -- there is
  // no "own row" to exclude yet, unlike the Change sheet's per-row list in
  // `ScheduleTemplateTasks`.
  const addPredecessorOptions: Option[] = taskRows.map((task) => ({ value: task.id, label: task.name }));

  const readOnlyNote = state.actor
    ? `Your role (${state.actor.role}) cannot edit schedule templates.`
    : (state.reason ?? undefined);

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        // The list is this template's home -- opened from a bookmark or a
        // pasted link, this screen otherwise arrives with no history behind
        // it to go back through.
        parent={{ href: '/templates', label: 'Schedule templates' }}
        eyebrow={
          <>
            {template.isActive ? (
              <Pill tone="positive">Available</Pill>
            ) : (
              <Pill tone="neutral">Retired</Pill>
            )}
          </>
        }
        title={template.name}
        description="Every task names a duration rule, what it waits on, and its condition. Applying this to a job takes one date; editing here never touches a job that already imported from it."
        actions={
          <SheetButton
            trigger="Add a task"
            variant="primary"
            label="Add a task to this template"
            title="Add a task"
            subtitle={template.name}
            discardPrompt="Throw away this task? Nothing has been saved yet."
          >
            <ActionForm
              action={createTemplateTask}
              submitLabel="Add task"
              disabled={!allowed}
              disabledNote={readOnlyNote}
              resetOnSuccess
            >
              <input type="hidden" name="scheduleTemplateId" value={template.id} />
              <FieldGrid>
                <TemplateTaskFields
                  idPrefix="new-task"
                  nextSortOrder={nextSortOrder}
                  disabled={!allowed}
                  areaUnit={areaUnit}
                  tradeOptions={tradeOptions}
                  costCodeOptions={costCodeOptions}
                  predecessorOptions={addPredecessorOptions}
                  rateItemOptions={rateItemOptions}
                />
              </FieldGrid>
            </ActionForm>
          </SheetButton>
        }
      />

      <div className="flex flex-col gap-4">
        <Section title="Template">
          <ActionForm
            action={updateScheduleTemplate}
            submitLabel="Save template"
            disabled={!allowed}
            disabledNote={readOnlyNote}
          >
            <input type="hidden" name="id" value={template.id} />
            <FieldGrid>
              <TextField
                idPrefix="template"
                name="name"
                label="Name"
                required
                maxLength={200}
                defaultValue={template.name}
                disabled={!allowed}
              />
              <SelectField
                idPrefix="template"
                name="projectTypeId"
                label="Project type"
                required
                defaultValue={template.projectTypeId}
                options={listOptions(projectTypeRows, template.projectTypeId)}
                disabled={!allowed}
              />
              <TextAreaField
                idPrefix="template"
                name="description"
                label="Description"
                rows={3}
                defaultValue={template.description}
                disabled={!allowed}
              />
            </FieldGrid>
          </ActionForm>

          <div className="mt-4 border-t border-line pt-4">
            <h3 className="t-small font-semibold">
              {template.isActive ? 'Retire this template' : 'Bring this template back'}
            </h3>
            <p className="mb-2 max-w-prose t-small text-subtle">
              Nothing is deleted. A job that already imported from this template keeps its own
              tasks regardless.
            </p>
            <RowAction
              action={setScheduleTemplateActive}
              label={template.isActive ? 'Retire' : 'Bring back'}
              destructive={template.isActive}
              disabled={!allowed}
              fields={{ id: template.id, isActive: template.isActive ? 'false' : 'true' }}
              confirm={
                template.isActive
                  ? 'Retire this template? It stops being offered when importing a schedule.'
                  : undefined
              }
            />
          </div>
        </Section>

        <Section title="Tasks">
          <ScheduleTemplateTasks
            templateId={template.id}
            tasks={rows}
            areaUnit={areaUnit}
            tradeOptions={tradeOptions}
            tradeNameById={tradeNameById}
            costCodeOptions={costCodeOptions}
            rateItemOptions={rateItemOptions}
            rateItemCodeById={rateItemCodeById}
            allowed={allowed}
            mayVoid={mayVoid}
            refusal={readOnlyNote}
          />
        </Section>
      </div>
    </div>
  );
}
