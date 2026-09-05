'use client';

import { useState } from 'react';
import { updateTemplateLine, voidTemplateLine } from '@/app/templates/actions';
import { QTY_SOURCE_LABELS } from '@/app/templates/schema';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid } from '@/components/settings/Fields';
import { TemplateLineFields } from '@/components/templates/TemplateLineFields';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { formatQty, formatRate, parseQtyToMilli } from '@/lib/money/format';
import { QTY_SCALE, RATE_SCALE, divRoundHalfUp } from '@/lib/money/scale';
import { type ScopeInputs, expandTemplate } from '@/lib/quote/template';
import type { CalcMode } from '@/lib/quote/types';

/**
 * The template's lines, and the one place they are shown.
 *
 * This used to be two tables: a read-only "worked example" above a real,
 * editable one below it, both drawing the same eight-ish columns because
 * three of the four columns in the preview were the real table's columns
 * again. The owner hit exactly the trap that makes: he tried to edit the
 * preview, because nothing on screen said the two tables were not the same
 * thing. *"why are there 2 different components? shouldn't this just be 1?
 * maybe adding 1 column in the order."* He was right -- the only thing the
 * preview added was a Derivation column, so that is now the ninth-turned-fifth
 * column of the one table that exists.
 *
 * **Why this whole table is a client component, rather than a server table
 * with a small client cell inside it.** Derivation depends on the four
 * measurement boxes, and every row needs to re-read them the moment any one
 * of them changes -- that is the whole feature. Lifting just the boxes to a
 * client wrapper still leaves every row needing that state, which means
 * threading it back down through context or props to a client cell per row;
 * putting the whole table in one client component instead means the state
 * and the sixty-odd cells that read it are next to each other, with nothing
 * invented to pass it across a boundary that would otherwise cut through the
 * middle of a single table. It costs nothing extra to load: `ActionForm`,
 * `SheetButton` and `Fields` were already client-safe (`ActionForm` and
 * `SheetButton` are already `'use client'` themselves), so nothing here forces
 * a second bundle that would not have shipped anyway.
 *
 * Derivation runs through `expandTemplate` -- the SAME function the quote
 * builder calls -- rather than a formula rewritten here. A preview that
 * computes its own answer is a preview of nothing: the point is to show what
 * this template will actually do.
 *
 * Scaled integers cross to the browser as strings: a bigint cannot be
 * serialized into a React payload at all, and a Number would round a
 * multiplier the moment it got long enough to matter.
 */
export interface WireTemplateLine {
  id: string;
  rateItemId: string;
  code: string;
  description: string;
  unitLabel: string;
  calcMode: CalcMode;
  qtySource: 'area' | 'washrooms' | 'kitchens' | 'bedrooms' | 'fixed' | 'manual';
  qtyMultiplierTenThou: string;
  fixedQtyMilli: string | null;
  lineGroup: string;
  sortOrder: number;
  isOptional: boolean;
  isAllowance: boolean;
}

/** A whole count, or zero. A half-typed number must not read as a scope. */
function count(raw: string): number {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
}

function derive(line: WireTemplateLine, inputs: ScopeInputs) {
  const [generated] = expandTemplate(
    [
      {
        code: line.code,
        description: line.description,
        lineGroup: line.lineGroup,
        sortOrder: line.sortOrder,
        calcMode: line.calcMode,
        unitLabel: line.unitLabel,
        qtySource: line.qtySource,
        qtyMultiplierTenThou: BigInt(line.qtyMultiplierTenThou),
        fixedQtyMilli: line.fixedQtyMilli === null ? null : BigInt(line.fixedQtyMilli),
        costRateTenThou: 0n,
        sellRateTenThou: 0n,
        isTaxable: true,
        isOptional: line.isOptional,
        isAllowance: false,
        rateItemId: null,
        costCodeId: null,
      },
    ],
    inputs,
  );
  return generated ?? null;
}

function sourceQty(source: WireTemplateLine['qtySource'], inputs: ScopeInputs): bigint {
  switch (source) {
    case 'area':
      return inputs.areaSqftMilli;
    case 'washrooms':
      return BigInt(inputs.washroomCount) * QTY_SCALE;
    case 'kitchens':
      return BigInt(inputs.kitchenCount) * QTY_SCALE;
    case 'bedrooms':
      return BigInt(inputs.bedroomCount) * QTY_SCALE;
    default:
      return 0n;
  }
}

/**
 * The "Quantity from" cell. A fixed quantity folds its figure in here rather
 * than keeping its own column -- it is a dash on almost every other row, and
 * that spare width is what the Derivation column spends instead.
 *
 * A flat or percent line never reads a quantity at all, so a fixed quantity
 * sitting under one -- `GEN-01`'s "1", priced as a flat fee -- is a number
 * nobody may ever change and read as a dash instead, matching the multiplier
 * beside it.
 */
function quantityFromText(line: WireTemplateLine): string {
  if (line.qtySource !== 'fixed') return QTY_SOURCE_LABELS[line.qtySource] ?? line.qtySource;
  if (line.calcMode !== 'qty') return `${QTY_SOURCE_LABELS.fixed}: —`;
  const qty = line.fixedQtyMilli === null ? 0n : BigInt(line.fixedQtyMilli);
  return `${QTY_SOURCE_LABELS.fixed}: ${formatQty(qty)}`;
}

/** A flat or percent line ignores the multiplier entirely; showing a figure
 *  it never reads invites somebody to tune it and wonder why nothing moves. */
function multiplierText(line: WireTemplateLine): string {
  if (line.calcMode !== 'qty') return '—';
  return formatRate(BigInt(line.qtyMultiplierTenThou));
}

function ExampleInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="t-small font-semibold">
        {label}
      </label>
      <input
        id={id}
        value={value}
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
        className="field field-num"
      />
    </div>
  );
}

export function TemplateLines({
  templateId,
  lines,
  areaUnit,
  allowed,
  refusal,
}: {
  templateId: string;
  lines: WireTemplateLine[];
  areaUnit: string;
  /** The role may write, and this is not a read-only view of someone else's tenant. */
  allowed: boolean;
  /** The sentence saying why the role may not write, when it may not. */
  refusal?: string;
}) {
  // Round starting values, so the arithmetic on screen is easy to check by eye.
  const [area, setArea] = useState('1000');
  const [washrooms, setWashrooms] = useState('2');
  const [kitchens, setKitchens] = useState('1');
  const [bedrooms, setBedrooms] = useState('3');

  const areaMilli = parseQtyToMilli(area) ?? 0n;
  const inputs: ScopeInputs = {
    areaSqftMilli: areaMilli,
    washroomCount: count(washrooms),
    kitchenCount: count(kitchens),
    bedroomCount: count(bedrooms),
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose t-small text-muted">
        Every line computes as <span className="num">source value × multiplier</span>. Read the
        multiplier as a rate, not a factor: pot lights at <span className="num">0.0200</span>{' '}
        mean <span className="font-semibold">one fixture per fifty {areaUnit}</span>, not two
        percent.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ExampleInput
          id="example-area"
          label={`Area (${areaUnit})`}
          value={area}
          onChange={setArea}
        />
        <ExampleInput
          id="example-washrooms"
          label="Washrooms"
          value={washrooms}
          onChange={setWashrooms}
        />
        <ExampleInput
          id="example-kitchens"
          label="Kitchens"
          value={kitchens}
          onChange={setKitchens}
        />
        <ExampleInput
          id="example-bedrooms"
          label="Bedrooms"
          value={bedrooms}
          onChange={setBedrooms}
        />
      </div>

      <p className="max-w-prose t-small text-muted">
        Change a measurement above and every derivation below updates. Nothing here is saved.
      </p>

      <TableWrap minWidth="78rem">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Group</th>
            <th scope="col">Quantity from</th>
            <th scope="col" className="cell-num">
              Multiplier
            </th>
            <th scope="col">Derivation</th>
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
                No lines yet. Add one from the button above — until then, this template
                generates an empty quote.
              </td>
            </tr>
          ) : null}

          {lines.map((line) => {
            const multiplier = BigInt(line.qtyMultiplierTenThou);
            const generated = derive(line, inputs);
            const readsQuantity = line.calcMode === 'qty';
            const disabled = !allowed;

            // The inverse of a multiplier below one is the sentence that
            // makes it comprehensible: 0.02 per square foot IS one per fifty.
            const perUnitMilli =
              multiplier > 0n && multiplier < RATE_SCALE
                ? divRoundHalfUp(RATE_SCALE * QTY_SCALE, multiplier)
                : null;

            return (
              <tr key={line.id}>
                <td data-label="Item">
                  {line.description}
                  <span className="ml-2 num t-small text-subtle">{line.code}</span>
                </td>
                <td data-label="Group" className="t-small text-muted">
                  {line.lineGroup}
                </td>
                <td data-label="Quantity from" className="t-small text-muted">
                  {quantityFromText(line)}
                </td>
                <AmountCell data-label="Multiplier">{multiplierText(line)}</AmountCell>
                <td data-label="Derivation" className="t-small">
                  {!readsQuantity ? (
                    <span className="text-muted">
                      {line.calcMode === 'flat'
                        ? 'A flat price. It does not read a quantity at all.'
                        : 'A percentage of the included work. It does not read a quantity.'}
                    </span>
                  ) : line.qtySource === 'manual' ? (
                    <span className="text-muted">
                      Left at zero for the estimator to type on the quote.
                    </span>
                  ) : generated === null ? (
                    <span className="text-warning">
                      Not generated at this scope. A derived quantity of zero means the job
                      does not include the item, so the line is dropped rather than left for
                      somebody to delete.
                    </span>
                  ) : (
                    <>
                      <span className="num">
                        {line.qtySource === 'fixed'
                          ? formatQty(
                              line.fixedQtyMilli === null ? 0n : BigInt(line.fixedQtyMilli),
                            )
                          : formatQty(sourceQty(line.qtySource, inputs))}
                      </span>
                      {' × '}
                      <span className="num">{formatRate(multiplier)}</span>
                      {' = '}
                      <span className="num font-semibold">{formatQty(generated.qtyMilli)}</span>{' '}
                      {line.unitLabel}
                      {perUnitMilli !== null ? (
                        <span className="block text-subtle">
                          one per <span className="num">{formatQty(perUnitMilli)}</span>{' '}
                          {line.qtySource === 'area' ? areaUnit : 'source units'}
                        </span>
                      ) : null}
                    </>
                  )}
                </td>
                <td data-label="Flags">
                  {line.isOptional || line.isAllowance ? (
                    <span className="flex flex-wrap gap-1">
                      {line.isOptional ? <Pill tone="info">Optional</Pill> : null}
                      {line.isAllowance ? <Pill tone="warning">Allowance</Pill> : null}
                    </span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
                <AmountCell data-label="Order">{line.sortOrder}</AmountCell>
                <td data-label="Change">
                  {/* The same press-then-panel every row control in the
                      product uses. The title names the item, because the
                      table behind the sheet is dimmed and the sheet is now
                      the only thing on screen saying which line this is. */}
                  <SheetButton
                    trigger="Change…"
                    label={`Change ${line.description}`}
                    title={`Change ${line.description}`}
                    subtitle={`${line.code} · ${line.lineGroup}`}
                    discardPrompt="Throw away the changes to this line? Nothing has been saved yet."
                  >
                    <div className="flex flex-col gap-4">
                      <ActionForm
                        action={updateTemplateLine}
                        submitLabel="Save line"
                        disabled={disabled}
                        disabledNote={refusal}
                      >
                        <input type="hidden" name="id" value={line.id} />
                        <input type="hidden" name="scopeTemplateId" value={templateId} />
                        <input type="hidden" name="rateItemId" value={line.rateItemId} />
                        <FieldGrid>
                          <TemplateLineFields
                            idPrefix={`line-${line.id}`}
                            line={{
                              qtySource: line.qtySource,
                              qtyMultiplierTenThou: line.qtyMultiplierTenThou,
                              fixedQtyMilli: line.fixedQtyMilli,
                              lineGroup: line.lineGroup,
                              sortOrder: line.sortOrder,
                              isOptional: line.isOptional,
                              isAllowance: line.isAllowance,
                            }}
                            disabled={disabled}
                          />
                        </FieldGrid>
                      </ActionForm>

                      {/* The database refuses a delete outright, not just this
                          form: a watermark-based mirror cannot observe a row
                          that no longer exists, and the phantom would outlive
                          the record. */}
                      <div>
                        <h3 className="t-small font-semibold">Remove this line</h3>
                        <p className="mb-2 max-w-prose t-small text-subtle">
                          Voided with a reason, not deleted — nothing here is ever
                          hard-deleted.
                        </p>
                        <RowAction
                          action={voidTemplateLine}
                          label="Remove from template"
                          destructive
                          disabled={disabled}
                          fields={{ id: line.id, scopeTemplateId: templateId, reason: '' }}
                          confirm="Remove this line from the template? The row stays, voided, with a reason."
                        />
                      </div>
                    </div>
                  </SheetButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
    </div>
  );
}
