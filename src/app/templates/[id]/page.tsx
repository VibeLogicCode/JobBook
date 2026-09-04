import { and, asc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import { organization, rateItems, scopeTemplateItems, scopeTemplates } from '@/db/schema';
import { can, resolveActor } from '@/app/settings/actor';
import {
  addTemplateLine,
  setTemplateActive,
  updateTemplate,
  updateTemplateLine,
  voidTemplateLine,
} from '@/app/templates/actions';
import {
  PROJECT_TYPE_OPTIONS,
  QTY_SOURCE_LABELS,
  QTY_SOURCE_OPTIONS,
} from '@/app/templates/schema';
import { WorkedExample, type WireTemplateLine } from '@/app/templates/[id]/WorkedExample';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import {
  CheckboxField,
  FieldGrid,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/settings/Fields';
import { Notice } from '@/components/settings/Notice';
import { Section } from '@/components/settings/Section';
import { Pill } from '@/components/ui/Pill';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { formatQty, formatRate } from '@/lib/money/format';

export const dynamic = 'force-dynamic';

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'scopeTemplates.edit') : false;

  const [template] = await db.select().from(scopeTemplates).where(eq(scopeTemplates.id, id));
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

  const wireLines: WireTemplateLine[] = lines.map(({ line, item }) => ({
    id: line.id,
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
  }));

  const nextSortOrder = lines.reduce((max, { line }) => Math.max(max, line.sortOrder), 0) + 10;

  const readOnlyNote = state.actor
    ? `Your role (${state.actor.role}) cannot edit scope templates.`
    : (state.reason ?? undefined);

  return (
    <div className="px-4 py-4 sm:px-6">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Link href="/templates" className="t-small text-accent-text underline underline-offset-2">
          Scope templates
        </Link>
        <span className="t-small text-subtle" aria-hidden>
          /
        </span>
        <h1 className="t-title">{template.name}</h1>
        {template.isActive ? (
          <Pill tone="positive">Available</Pill>
        ) : (
          <Pill tone="neutral">Retired</Pill>
        )}
      </div>
      <p className="mb-4 max-w-prose t-small text-muted">
        Every line names a rate item and a rule for its quantity. Nothing here reaches a quote
        already written: a quote line copies its description, rates and cost code at the moment
        it is created, so this screen is a starting point and never a live reference.
      </p>

      <div className="flex flex-col gap-4">
        <Section title="Template">
          <ActionForm
            action={updateTemplate}
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
                name="projectType"
                label="Project type"
                required
                defaultValue={template.projectType}
                options={PROJECT_TYPE_OPTIONS}
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
              Nothing is deleted. A quote records which template it came from, and that
              reference has to keep resolving years later.
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
        </Section>

        <Section
          title="How a quantity derives"
          description={
            <>
              <p>
                Every line computes as <span className="num">source value × multiplier</span>.
                Six sources cover the cases: the area, the washroom, kitchen or bedroom count, a
                fixed number, or a value the estimator types on the quote.
              </p>
              <p className="mt-2">
                The multiplier is where it stops being obvious, so read it as a rate rather than
                a factor: drywall at <span className="num">1.0000</span> is one unit per unit of
                area, while pot lights at <span className="num">0.0200</span> mean{' '}
                <span className="font-semibold">
                  area × 0.02 — one fixture per fifty {areaUnit}
                </span>
                . A washroom rough-in at <span className="num">1.0000</span> is one per washroom.
              </p>
              <p className="mt-2">
                It is an enum and not a formula language on purpose: a user-editable expression
                stored in a database column is an injection surface and an unbounded support
                burden.
              </p>
            </>
          }
        >
          <WorkedExample lines={wireLines} areaUnit={areaUnit} />
        </Section>

        <Section title="Lines">
          <TableWrap minWidth="68rem">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Group</th>
                <th scope="col">Quantity from</th>
                <th scope="col" className="cell-num">
                  Multiplier
                </th>
                <th scope="col" className="cell-num">
                  Fixed quantity
                </th>
                <th scope="col">Flags</th>
                <th scope="col" className="cell-num">
                  Order
                </th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 ? (
                <tr>
                  <td data-label="Item" colSpan={8}>
                    No lines yet. Add the first one below, and the worked example above will
                    show what it derives.
                  </td>
                </tr>
              ) : null}

              {lines.map(({ line, item }) => (
                <tr key={line.id}>
                  <td data-label="Item">
                    {item.description}
                    <span className="ml-2 num t-small text-subtle">{item.code}</span>
                    <span className="block t-small text-subtle">
                      {item.calcMode === 'qty'
                        ? `per ${item.unitLabel}`
                        : item.calcMode === 'flat'
                          ? 'flat price'
                          : 'percentage of the work'}
                    </span>
                  </td>
                  <td data-label="Group" className="t-small text-muted">
                    {line.lineGroup}
                  </td>
                  <td data-label="Quantity from" className="t-small text-muted">
                    {QTY_SOURCE_LABELS[line.qtySource] ?? line.qtySource}
                  </td>
                  <AmountCell data-label="Multiplier">
                    {formatRate(line.qtyMultiplierTenThou)}
                  </AmountCell>
                  <AmountCell data-label="Fixed quantity">
                    {line.fixedQtyMilli === null ? '—' : formatQty(line.fixedQtyMilli)}
                  </AmountCell>
                  <td data-label="Flags">
                    <span className="flex flex-wrap gap-1">
                      {line.isOptional ? <Pill tone="info">Optional</Pill> : null}
                      {line.isAllowance ? <Pill tone="warning">Allowance</Pill> : null}
                      {!line.isOptional && !line.isAllowance ? (
                        <span className="t-small text-subtle">Included, fixed price</span>
                      ) : null}
                    </span>
                  </td>
                  <AmountCell data-label="Order">{line.sortOrder}</AmountCell>
                  <td data-label="Change">
                    <details className="min-w-0">
                      <summary className="min-h-11 cursor-pointer list-none rounded-[4px] border border-line-strong px-3 py-2 t-small">
                        Change…
                      </summary>
                      <div className="mt-3 flex w-full max-w-[38rem] flex-col gap-4 border-t border-line pt-3">
                        <ActionForm
                          action={updateTemplateLine}
                          submitLabel="Save line"
                          disabled={!allowed}
                          disabledNote={readOnlyNote}
                        >
                          <input type="hidden" name="id" value={line.id} />
                          <input type="hidden" name="scopeTemplateId" value={template.id} />
                          <input type="hidden" name="rateItemId" value={line.rateItemId} />
                          <FieldGrid>
                            <SelectField
                              idPrefix={`line-${line.id}`}
                              name="qtySource"
                              label="Quantity from"
                              required
                              defaultValue={line.qtySource}
                              options={QTY_SOURCE_OPTIONS}
                              disabled={!allowed}
                            />
                            <TextField
                              idPrefix={`line-${line.id}`}
                              name="qtyMultiplier"
                              label="Multiplier"
                              required
                              numeric
                              inputMode="decimal"
                              maxLength={12}
                              defaultValue={formatRate(line.qtyMultiplierTenThou)}
                              disabled={!allowed}
                              hint="Four decimal places at most. Ignored when the quantity is typed on the quote."
                            />
                            <TextField
                              idPrefix={`line-${line.id}`}
                              name="fixedQty"
                              label="Fixed quantity"
                              numeric
                              inputMode="decimal"
                              maxLength={12}
                              defaultValue={
                                line.fixedQtyMilli === null
                                  ? ''
                                  : formatQty(line.fixedQtyMilli)
                              }
                              disabled={!allowed}
                              hint="Only read when the source is a fixed quantity."
                            />
                            <TextField
                              idPrefix={`line-${line.id}`}
                              name="lineGroup"
                              label="Line group"
                              required
                              maxLength={100}
                              defaultValue={line.lineGroup}
                              disabled={!allowed}
                              hint="The band this line sits under on the worksheet and the document."
                            />
                            <TextField
                              idPrefix={`line-${line.id}`}
                              name="sortOrder"
                              label="Order"
                              required
                              numeric
                              inputMode="numeric"
                              maxLength={4}
                              defaultValue={String(line.sortOrder)}
                              disabled={!allowed}
                            />
                            <CheckboxField
                              idPrefix={`line-${line.id}`}
                              name="isOptional"
                              label="Optional — an upgrade the customer may add"
                              defaultChecked={line.isOptional}
                              disabled={!allowed}
                              hint="An optional line starts excluded, so a template cannot silently inflate a quote."
                            />
                            <CheckboxField
                              idPrefix={`line-${line.id}`}
                              name="isAllowance"
                              label="Allowance — a placeholder reconciled against actual cost"
                              defaultChecked={line.isAllowance}
                              disabled={!allowed}
                              hint="Overrides the rate item's own flag, so one item can be a fixed price in one template and an allowance in another."
                            />
                          </FieldGrid>
                        </ActionForm>

                        <div>
                          <h3 className="t-small font-semibold">Remove this line</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            The row is voided with a reason, not deleted. The database
                            refuses a delete outright — a watermark-based mirror cannot
                            observe a row that no longer exists, and the phantom would
                            outlive the record.
                          </p>
                          <RowAction
                            action={voidTemplateLine}
                            label="Remove from template"
                            destructive
                            disabled={!allowed}
                            fields={{ id: line.id, scopeTemplateId: template.id, reason: '' }}
                            confirm="Remove this line from the template? The row stays, voided, with a reason."
                          />
                        </div>
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Section>

        <Section
          title="Add a line"
          description={
            <p>
              A line names a rate item — the priced list is the single source of both cost and
              sell — plus how its quantity derives from the measurements.
            </p>
          }
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
                <SelectField
                  idPrefix="new-line"
                  name="qtySource"
                  label="Quantity from"
                  required
                  defaultValue="area"
                  options={QTY_SOURCE_OPTIONS}
                  disabled={!allowed}
                />
                <TextField
                  idPrefix="new-line"
                  name="qtyMultiplier"
                  label="Multiplier"
                  required
                  numeric
                  inputMode="decimal"
                  maxLength={12}
                  defaultValue="1"
                  disabled={!allowed}
                  hint="1 means one unit per source unit. 0.02 means one per fifty."
                />
                <TextField
                  idPrefix="new-line"
                  name="fixedQty"
                  label="Fixed quantity"
                  numeric
                  inputMode="decimal"
                  maxLength={12}
                  disabled={!allowed}
                  hint="Required only when the source is a fixed quantity."
                />
                <TextField
                  idPrefix="new-line"
                  name="lineGroup"
                  label="Line group"
                  required
                  maxLength={100}
                  disabled={!allowed}
                  hint="Usually the trade. It bands the worksheet and groups the document."
                />
                <TextField
                  idPrefix="new-line"
                  name="sortOrder"
                  label="Order"
                  required
                  numeric
                  inputMode="numeric"
                  maxLength={4}
                  defaultValue={String(nextSortOrder)}
                  disabled={!allowed}
                  hint="Left in steps of ten, so a line can be inserted between two without renumbering."
                />
                <CheckboxField
                  idPrefix="new-line"
                  name="isOptional"
                  label="Optional — an upgrade the customer may add"
                  disabled={!allowed}
                />
                <CheckboxField
                  idPrefix="new-line"
                  name="isAllowance"
                  label="Allowance — a placeholder reconciled against actual cost"
                  disabled={!allowed}
                />
              </FieldGrid>
            </ActionForm>
          )}
        </Section>
      </div>
    </div>
  );
}
