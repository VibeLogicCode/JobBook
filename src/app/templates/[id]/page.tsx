import type { Metadata } from 'next';
import { and, asc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { db } from '@/db/client';
import { organization, projectTypes, rateItems, scopeTemplateItems, scopeTemplates } from '@/db/schema';
import { can, resolveActor } from '@/app/settings/actor';
import { addTemplateLine, setTemplateActive, updateTemplate } from '@/app/templates/actions';
import { timesPhrase } from '@/app/templates/schema';
import { TemplateLines, type WireTemplateLine } from '@/app/templates/[id]/TemplateLines';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid, SelectField } from '@/components/settings/Fields';
import { TemplateHeaderFields } from '@/components/templates/TemplateHeaderFields';
import { TemplateLineFields } from '@/components/templates/TemplateLineFields';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Section } from '@/components/settings/Section';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { isUuid } from '@/lib/ids';

export const dynamic = 'force-dynamic';

/** `cache()`-wrapped so `generateMetadata` and the page share this one read. */
const loadScopeTemplate = cache(async (id: string) => {
  const [template] = await db.select().from(scopeTemplates).where(eq(scopeTemplates.id, id));
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
    const template = await loadScopeTemplate(id);
    return { title: template && template.recordStatus !== 'void' ? template.name : 'Template' };
  } catch {
    return { title: 'Template' };
  }
}

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // A mistyped URL is a 404, not a 500: an id of the wrong shape reaches the
  // driver as `invalid input syntax for type uuid` and surfaces as an error page.
  if (!isUuid(id)) notFound();
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'scopeTemplates.edit') : false;

  const template = await loadScopeTemplate(id);
  if (!template || template.recordStatus === 'void') notFound();

  const lines = await db
    .select({ line: scopeTemplateItems, item: rateItems })
    .from(scopeTemplateItems)
    .innerJoin(rateItems, eq(scopeTemplateItems.rateItemId, rateItems.id))
    .where(
      and(
        eq(scopeTemplateItems.scopeTemplateId, id),
        eq(scopeTemplateItems.recordStatus, 'active'),
      ),
    )
    .orderBy(asc(scopeTemplateItems.sortOrder), asc(rateItems.code));

  const items = await db
    .select()
    .from(rateItems)
    .where(and(eq(rateItems.isActive, true), eq(rateItems.recordStatus, 'active')))
    .orderBy(asc(rateItems.sortOrder), asc(rateItems.code));

  const [org] = await db.select().from(organization).where(eq(organization.id, 1));
  const areaUnit = org?.areaUnit ?? 'sqft';

  // Every project type, retired and voided included -- this template's own
  // may not be offered to new work any more, and it still has to render.
  const projectTypeRows = await db
    .select()
    .from(projectTypes)
    .orderBy(asc(projectTypes.sortOrder), asc(projectTypes.name));

  const wireLines: WireTemplateLine[] = lines.map(({ line, item }) => ({
    id: line.id,
    rateItemId: line.rateItemId,
    code: item.code,
    description: item.description,
    unitLabel: item.unitLabel,
    calcMode: item.calcMode,
    qtySource: line.qtySource,
    qtyMultiplierTenThou: line.qtyMultiplierTenThou.toString(),
    fixedQtyMilli: line.fixedQtyMilli === null ? null : line.fixedQtyMilli.toString(),
    lineGroup: line.lineGroup,
    sortOrder: line.sortOrder,
    isOptional: line.isOptional,
    isAllowance: line.isAllowance,
  }));

  const nextSortOrder = lines.reduce((max, { line }) => Math.max(max, line.sortOrder), 0) + 10;

  // A quote built from this template bills whatever is on it -- two lines
  // pointing at the same rate item bill that item twice, and nothing else on
  // this page would ever say so before somebody sent the quote out. Two lines
  // of the same item in different groups can be a real thing (a second
  // flooring line for a different room, priced separately), so this warns
  // rather than refusing.
  const countByCode = new Map<string, number>();
  for (const { item } of lines) countByCode.set(item.code, (countByCode.get(item.code) ?? 0) + 1);
  const duplicates = [...countByCode.entries()].filter(([, itemCount]) => itemCount > 1);

  const readOnlyNote = state.actor
    ? `Your role (${state.actor.role}) cannot edit scope templates.`
    : (state.reason ?? undefined);

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        // The list is this template's home, and it is the only screen that can
        // say so: a template opened from a quote's scope picker, from a
        // bookmark, or from a link pasted into a message arrives with no
        // history to go back through.
        parent={{ href: '/templates', label: 'Templates' }}
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
        description="Every line names a rate item and a rule for its quantity. Editing here never changes a quote already built from it."
        actions={
          // A press, then the form over a blurred page -- the button that
          // adds a row lives at the top of the page it belongs to, matching
          // vendors, expenses and the schedule, rather than at the foot of a
          // table somebody has to scroll past everything to reach. Edit sits
          // beside it for the same reason: the name, project type and
          // description used to fill half the screen above the lines table,
          // which is what this page is actually for -- the owner already read
          // all three on the list a click ago.
          <>
            <SheetButton
              trigger="Edit"
              variant="secondary"
              label={`Edit ${template.name}`}
              title="Edit template"
              subtitle={template.name}
              discardPrompt="Throw away the changes to this template? Nothing has been saved yet."
            >
              <div className="flex flex-col gap-4">
                <ActionForm
                  action={updateTemplate}
                  submitLabel="Save template"
                  disabled={!allowed}
                  disabledNote={readOnlyNote}
                >
                  <input type="hidden" name="id" value={template.id} />
                  <TemplateHeaderFields
                    idPrefix="template"
                    name={template.name}
                    projectTypeId={template.projectTypeId}
                    projectTypes={projectTypeRows}
                    description={template.description}
                    disabled={!allowed}
                  />
                </ActionForm>

                <div className="border-t border-line pt-4">
                  <h3 className="t-small font-semibold">
                    {template.isActive ? 'Retire this template' : 'Bring this template back'}
                  </h3>
                  <p className="mb-2 max-w-prose t-small text-subtle">
                    Nothing is deleted. A quote's reference to this template must keep resolving
                    years later.
                  </p>
                  <RowAction
                    action={setTemplateActive}
                    label={template.isActive ? 'Retire' : 'Bring back'}
                    destructive={template.isActive}
                    disabled={!allowed}
                    fields={{ id: template.id, isActive: template.isActive ? 'false' : 'true' }}
                    confirm={
                      template.isActive
                        ? 'Retire this template? It stops being offered on new quotes.'
                        : undefined
                    }
                  />
                </div>
              </div>
            </SheetButton>

            <SheetButton
              trigger="Add a line"
              variant="primary"
              label="Add a line to this template"
              title="Add a line"
              subtitle={template.name}
              discardPrompt="Throw away this line? Nothing has been saved yet."
            >
              {items.length === 0 ? (
                <Notice tone="warning" title="There are no rate items to choose from">
                  A template line has to point at a priced item. Add rate items first.
                </Notice>
              ) : (
                <ActionForm
                  action={addTemplateLine}
                  submitLabel="Add line"
                  disabled={!allowed}
                  disabledNote={readOnlyNote}
                  resetOnSuccess
                >
                  <input type="hidden" name="scopeTemplateId" value={template.id} />
                  <FieldGrid>
                    <SelectField
                      idPrefix="new-line"
                      name="rateItemId"
                      label="Rate item"
                      required
                      wide
                      options={items.map((item) => ({
                        value: item.id,
                        label: `${item.code} — ${item.description} (${
                          item.calcMode === 'qty' ? `per ${item.unitLabel}` : item.calcMode
                        })`,
                      }))}
                      disabled={!allowed}
                    />
                    <TemplateLineFields
                      idPrefix="new-line"
                      nextSortOrder={nextSortOrder}
                      disabled={!allowed}
                    />
                  </FieldGrid>
                </ActionForm>
              )}
            </SheetButton>
          </>
        }
      />

      <div className="flex flex-col gap-4">
        <Section title="Lines">
          {duplicates.length > 0 ? (
            <div className="mb-3">
              <Notice tone="warning" title="A rate item repeats in this template">
                {duplicates
                  .map(([code, itemCount]) => `${code} appears ${timesPhrase(itemCount)}`)
                  .join('; ')}{' '}
                — a quote built from here bills it that many times. Might be intended; worth a
                check before it goes out.
              </Notice>
            </div>
          ) : null}

          <TemplateLines
            templateId={template.id}
            lines={wireLines}
            areaUnit={areaUnit}
            allowed={allowed}
            refusal={readOnlyNote}
          />
        </Section>
      </div>
    </div>
  );
}
