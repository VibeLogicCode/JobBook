'use client';

import { useState } from 'react';
import { formatQty, formatRate, parseQtyToMilli } from '@/lib/money/format';
import { QTY_SCALE, RATE_SCALE, divRoundHalfUp } from '@/lib/money/scale';
import { type ScopeInputs, expandTemplate } from '@/lib/quote/template';
import type { CalcMode } from '@/lib/quote/types';

/**
 * Scaled integers cross to the browser as strings: a bigint cannot be
 * serialized into a React payload at all, and a Number would round a
 * multiplier the moment it got long enough to matter.
 */
export interface WireTemplateLine {
  id: string;
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
}

/** A whole count, or zero. A half-typed number must not read as a scope. */
function count(raw: string): number {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
}

/**
 * Derivation runs through `expandTemplate` -- the same function the quote
 * builder calls -- rather than through a formula written again here. A worked
 * example that computes its own answer is an example of nothing: the point is
 * to show what this template will actually do.
 *
 * Prices are deliberately absent. Only the quantity is being explained, and a
 * money figure here would read as a line total while ignoring overhead,
 * percentage lines, tax and the grossing-up an optional line gets.
 */
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

export function WorkedExample({
  lines,
  areaUnit,
}: {
  lines: WireTemplateLine[];
  areaUnit: string;
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

  const sourceText: Record<WireTemplateLine['qtySource'], string> = {
    area: `${formatQty(areaMilli)} ${areaUnit}`,
    washrooms: `${inputs.washroomCount} washrooms`,
    kitchens: `${inputs.kitchenCount} kitchens`,
    bedrooms: `${inputs.bedroomCount} bedrooms`,
    fixed: 'the fixed quantity',
    manual: 'nothing — it is typed on the quote',
  };

  return (
    <div className="flex flex-col gap-4">
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
        Change a measurement above and every derivation below follows it. This is exactly what
        a quote built from this template would contain at that scope — nothing here is saved.
      </p>

      <div className="overflow-x-auto rounded-[6px] border border-line">
        <table className="data-table data-table--stack" style={{ minWidth: '52rem' }}>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Quantity from</th>
              <th scope="col" className="cell-num">
                Multiplier
              </th>
              <th scope="col">Derivation</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td data-label="Item" colSpan={4}>
                  This template has no lines yet, so it would generate an empty quote.
                </td>
              </tr>
            ) : null}

            {lines.map((line) => {
              const multiplier = BigInt(line.qtyMultiplierTenThou);
              const generated = derive(line, inputs);
              const readsQuantity = line.calcMode === 'qty';

              // The inverse of a multiplier below one is the sentence that makes
              // it comprehensible: 0.02 per square foot IS one per fifty.
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
                  <td data-label="Quantity from" className="t-small text-muted">
                    {sourceText[line.qtySource]}
                  </td>
                  <td data-label="Multiplier" className="cell-num">
                    {formatRate(multiplier)}
                  </td>
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The source value in thousandths, for the left-hand side of the sentence. */
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
