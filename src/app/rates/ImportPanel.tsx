'use client';

import { useActionState, useMemo, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { importRateItems } from '@/app/rates/actions';
import { CALC_MODE_LABELS } from '@/app/rates/schema';
import type { ActionResult } from '@/app/settings/result';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import {
  FIELD_LABELS,
  RATE_FIELDS,
  REQUIRED_FIELDS,
  autoMap,
  emptyMapping,
  type RateField,
  type RateImportMapping,
} from '@/lib/import/mapping';
import { columnOptions, planImport } from '@/lib/import/preview';
import { ImportLimitError, decodeBytes, detectDelimiter, splitRows, type Delimiter } from '@/lib/import/text';
import { formatRate } from '@/lib/money/format';

/**
 * Paste a price list, say which column is which, see what would happen, commit.
 *
 * The preview is computed in the browser by `planImport`, and the commit is
 * decided on the server by the same `planImport` against the same file. Two
 * implementations of "would this row import" is how a preview comes to promise
 * something the commit does not do, so there is one.
 *
 * The file itself never leaves the browser until the person presses the last
 * button: it travels with that submit as a hidden field. No staging directory,
 * no half-uploaded file to expire -- the sibling project needs one because a
 * bank statement import spans several screens, and this is one screen.
 */

const DELIMITERS: { value: Delimiter; label: string }[] = [
  { value: ',', label: 'Comma' },
  { value: '\t', label: 'Tab (what a spreadsheet copies)' },
  { value: ';', label: 'Semicolon' },
  { value: '|', label: 'Vertical bar' },
];

export function ImportPanel({
  existingCodes,
  costCodes,
  allowed,
  disabledNote,
}: {
  existingCodes: string[];
  costCodes: { id: string; code: string; name: string }[];
  allowed: boolean;
  disabledNote?: string;
}) {
  const [text, setText] = useState('');
  const [filename, setFilename] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [delimiter, setDelimiter] = useState<Delimiter | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [overrides, setOverrides] = useState<Partial<Record<RateField, number | null>>>({});

  const [state, formAction] = useActionState<ActionResult | null, FormData>(importRateItems, null);

  const resolvedDelimiter = delimiter ?? (text === '' ? ',' : detectDelimiter(text));

  const parsed = useMemo(() => {
    if (text.trim() === '') return { grid: [] as string[][], error: null as string | null };
    try {
      return { grid: splitRows(text, resolvedDelimiter), error: null };
    } catch (error) {
      return {
        grid: [] as string[][],
        error: error instanceof ImportLimitError ? error.message : 'That text could not be read.',
      };
    }
  }, [text, resolvedDelimiter]);

  const { grid } = parsed;

  // The guess, recomputed whenever the file or the header switch changes, then
  // whatever the person has since chosen laid over it. Keeping the two apart
  // is what lets a re-paste re-guess without throwing away a correction.
  const mapping: RateImportMapping = useMemo(() => {
    const base = grid.length === 0 ? emptyMapping(hasHeader) : hasHeader ? autoMap(grid[0] ?? []) : emptyMapping(false);
    base.hasHeader = hasHeader;
    for (const [field, index] of Object.entries(overrides)) {
      base.columns[field as RateField] = index ?? null;
    }
    return base;
  }, [grid, hasHeader, overrides]);

  const plan = useMemo(
    () => planImport(grid, mapping, { existingCodes, costCodes }),
    [grid, mapping, existingCodes, costCodes],
  );

  const options = useMemo(() => columnOptions(grid, hasHeader), [grid, hasHeader]);

  async function readFile(file: File) {
    setReadError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { text: decoded } = decodeBytes(bytes);
      setFilename(file.name);
      setDelimiter(null);
      setOverrides({});
      setText(decoded);
    } catch {
      setReadError('That file could not be read as text. Save it as CSV and try again.');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info" title="What an import can and cannot do">
        <p>
          It creates rate items. It never changes one that is already on the list, and it never
          touches a quote: every quote line keeps its own copy of the rates it was built at.
        </p>
        <p className="mt-2">
          A row whose code is already in use is skipped rather than overwritten, and the preview
          below says so row by row before anything is written.
        </p>
      </Notice>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="t-small font-semibold">Choose a file</span>
          <input
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
            disabled={!allowed}
            className="field min-h-11"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
          <span className="t-small text-subtle">
            A CSV saved out of a spreadsheet. {filename ? `Reading ${filename}.` : null}
          </span>
        </label>

        <label className="flex min-w-0 flex-col gap-1">
          <span className="t-small font-semibold">Separator</span>
          <select
            className="field min-h-11"
            value={resolvedDelimiter}
            disabled={!allowed}
            onChange={(event) => setDelimiter(event.target.value as Delimiter)}
          >
            {DELIMITERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="t-small text-subtle">
            Guessed from the text, and changeable when the guess is wrong.
          </span>
        </label>
      </div>

      <label className="flex min-w-0 flex-col gap-1">
        <span className="t-small font-semibold">Or paste it</span>
        <textarea
          rows={6}
          className="field"
          disabled={!allowed}
          value={text}
          placeholder={'Code\tDescription\tUnit\tCost\tSell'}
          onChange={(event) => {
            setText(event.target.value);
            setFilename(null);
          }}
        />
        <span className="t-small text-subtle">
          Copying rows straight out of a spreadsheet pastes them tab-separated, which is read
          here as it stands.
        </span>
      </label>

      {readError ? <Notice tone="negative" role="alert">{readError}</Notice> : null}
      {parsed.error ? <Notice tone="negative" role="alert">{parsed.error}</Notice> : null}

      {grid.length > 0 ? (
        <>
          <div className="flex flex-col gap-3 rounded-panel card-surface-2 p-3">
            <label className="flex min-h-11 items-center gap-2 t-small font-semibold">
              <input
                type="checkbox"
                className="size-4 accent-[var(--accent)]"
                checked={hasHeader}
                disabled={!allowed}
                onChange={(event) => {
                  setHasHeader(event.target.checked);
                  setOverrides({});
                }}
              />
              The first row names the columns
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {RATE_FIELDS.map((field) => {
                const required = REQUIRED_FIELDS.includes(field);
                return (
                  <label key={field} className="flex min-w-0 flex-col gap-1">
                    <span className="t-small font-semibold">
                      {FIELD_LABELS[field]}
                      {required ? (
                        <span className="text-negative" aria-hidden>
                          {' *'}
                        </span>
                      ) : null}
                    </span>
                    <select
                      className="field min-h-11"
                      disabled={!allowed}
                      value={mapping.columns[field] ?? ''}
                      onChange={(event) =>
                        setOverrides((current) => ({
                          ...current,
                          [field]: event.target.value === '' ? null : Number(event.target.value),
                        }))
                      }
                    >
                      <option value="">Not in this file</option>
                      {options.map((option) => (
                        <option key={option.index} value={option.index}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </div>

          {plan.problems.length > 0 ? (
            <Notice tone="negative" role="alert" title="These columns need sorting out first">
              <ul className="list-disc pl-5">
                {plan.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </Notice>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={plan.createCount > 0 ? 'positive' : 'neutral'}>
                  {plan.createCount} to create
                </Pill>
                <Pill tone={plan.skipCount > 0 ? 'warning' : 'neutral'}>
                  {plan.skipCount} skipped
                </Pill>
                {plan.noteCount > 0 ? (
                  <Pill tone="info">{plan.noteCount} with something assumed</Pill>
                ) : null}
              </div>

              <TableWrap minWidth="62rem">
                <thead>
                  <tr>
                    <th scope="col" className="cell-num">
                      Row
                    </th>
                    <th scope="col">Code</th>
                    <th scope="col">Description</th>
                    <th scope="col">How</th>
                    <th scope="col">Unit</th>
                    <th scope="col" className="cell-num">
                      Cost
                    </th>
                    <th scope="col" className="cell-num">
                      Sell
                    </th>
                    <th scope="col">What will happen</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map((row) =>
                    row.outcome === 'create' ? (
                      <tr key={row.rowNumber}>
                        <td data-label="Row" className="cell-num">
                          {row.rowNumber}
                        </td>
                        <td data-label="Code" className="num t-small">
                          {row.item.code}
                        </td>
                        <td data-label="Description">{row.item.description}</td>
                        <td data-label="How" className="t-small text-muted">
                          {CALC_MODE_LABELS[row.item.calcMode]}
                        </td>
                        <td data-label="Unit" className="t-small text-muted">
                          {row.item.unitLabel === ''
                            ? row.item.calcMode === 'percent'
                              ? '%'
                              : '—'
                            : row.item.unitLabel}
                        </td>
                        <AmountCell data-label="Cost">
                          {formatRate(row.item.costRateTenThou)}
                        </AmountCell>
                        <AmountCell data-label="Sell">
                          {formatRate(row.item.sellRateTenThou)}
                        </AmountCell>
                        <td data-label="What will happen">
                          <span className="flex flex-col gap-1">
                            <Pill tone="positive">Create</Pill>
                            {row.notes.map((note) => (
                              <span key={note} className="t-small text-muted">
                                {note}
                              </span>
                            ))}
                          </span>
                        </td>
                      </tr>
                    ) : (
                      <tr key={row.rowNumber}>
                        <td data-label="Row" className="cell-num">
                          {row.rowNumber}
                        </td>
                        <td data-label="Row contents" className="num t-small text-muted" colSpan={6}>
                          {row.cells.join(' · ').slice(0, 160) || '—'}
                        </td>
                        <td data-label="What will happen">
                          <span className="flex flex-col gap-1">
                            <Pill tone="warning">Skipped</Pill>
                            <span className="t-small text-muted">{row.reason}</span>
                          </span>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </TableWrap>
            </>
          )}
        </>
      ) : null}

      {state ? (
        state.ok ? (
          <Notice tone="positive" role="status">
            {state.message}
          </Notice>
        ) : (
          <Notice tone="negative" role="alert" title={state.error}>
            <p>Nothing was written. The whole file lands together or not at all.</p>
          </Notice>
        )
      ) : null}

      {!allowed && disabledNote ? <Notice tone="warning">{disabledNote}</Notice> : null}

      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="text" value={text} />
        <input type="hidden" name="delimiter" value={resolvedDelimiter} />
        <input type="hidden" name="mapping" value={JSON.stringify(mapping)} />
        <Commit
          disabled={!allowed || plan.createCount === 0 || plan.problems.length > 0}
          count={plan.createCount}
        />
      </form>
    </div>
  );
}

function Commit({ disabled, count }: { disabled: boolean; count: number }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={disabled} pending={pending} pendingLabel="Importing…">
      {count === 0 ? 'Nothing to import yet' : `Import ${count} rate ${count === 1 ? 'item' : 'items'}`}
    </Button>
  );
}
