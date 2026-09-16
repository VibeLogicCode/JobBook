'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { createExpenseBatch } from '@/app/expenses/actions';
import { BATCH_ROWS } from '@/app/expenses/schema';
import type { ActionResult } from '@/app/settings/result';
import type { Option } from '@/components/settings/Fields';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { TableWrap } from '@/components/ui/Table';

/**
 * Several receipts, one job, one submit — and the typing survives a refusal.
 *
 * **Why this is a client component when every other form here is not.** React
 * resets an uncontrolled form after a form action completes, whether the
 * action succeeded or refused. On a two-field settings form that is a shrug.
 * On this one it is the whole feature failing: eight rows of a kitchen-table
 * catch-up thrown away because row six had a description missing, which is
 * precisely the moment somebody stops typing and goes back to the shoebox.
 *
 * So the cells are held in React state rather than in the DOM. A reset cannot
 * take what React re-renders from state, the per-row messages point at rows
 * that are still on the screen, and fixing row six means fixing row six.
 *
 * It carries its own `useActionState` rather than sitting inside `ActionForm`
 * for one reason: the grid has to clear itself on success and keep itself on
 * failure, and only the half that can see the result can decide which.
 * Everything else -- the notice, the field marking, the pending submit -- is
 * the same shape `ActionForm` uses, deliberately, so the two read alike.
 */
export function BulkGrid({
  allowed,
  disabledNote,
  today,
  projectOptions,
  vendorOptions,
  codeOptions,
  paymentMethodOptions,
  taxOptions,
  defaultProjectId,
}: {
  allowed: boolean;
  disabledNote?: React.ReactNode;
  today: string;
  projectOptions: Option[];
  vendorOptions: Option[];
  codeOptions: Option[];
  paymentMethodOptions: Option[];
  /** The taxes in force. Empty when none is configured, and then no picker is shown. */
  taxOptions: Option[];
  defaultProjectId: string;
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    createExpenseBatch,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);

  const blank = () => {
    const start: Record<string, string> = {
      projectId: defaultProjectId,
      batchTaxRateId: taxOptions[0]?.value ?? '',
    };
    for (let index = 0; index < BATCH_ROWS; index += 1) start[`r${index}_date`] = today;
    return start;
  };

  const [cells, setCells] = useState<Record<string, string>>(blank);
  const at = (name: string) => cells[name] ?? '';
  const set = (name: string, value: string) =>
    setCells((current) => ({ ...current, [name]: value }));

  const invalid = new Set((state && !state.ok ? (state.fieldErrors ?? []) : []).map((e) => e.field));

  useEffect(() => {
    // Cleared only on success. A refusal leaves every cell exactly as typed,
    // which is the entire reason this component exists.
    if (state?.ok) setCells(blank());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const cell = (name: string, label: string, extra?: string) => ({
    name,
    value: at(name),
    disabled: !allowed,
    'aria-label': label,
    'aria-invalid': invalid.has(name) ? (true as const) : undefined,
    className: `field ${extra ?? ''}`.trim(),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      set(name, event.target.value),
  });

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="batch-projectId" className="t-small font-semibold">
            Job for all of these
            <span className="text-negative" aria-hidden>
              {' *'}
            </span>
          </label>
          <select
            id="batch-projectId"
            {...cell('projectId', 'Job for all of these')}
            required
            aria-describedby="batch-projectId-hint"
          >
            <option value="">Choose the job</option>
            {projectOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p id="batch-projectId-hint" className="t-small text-subtle">
            One job for the whole batch.
          </p>
        </div>

        {taxOptions.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="batch-taxRateId" className="t-small font-semibold">
              Tax on these receipts
            </label>
            <select
              id="batch-taxRateId"
              {...cell('batchTaxRateId', 'Tax on these receipts')}
              aria-describedby="batch-taxRateId-hint"
            >
              <option value="">No tax on any of them</option>
              {taxOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p id="batch-taxRateId-hint" className="t-small text-subtle">
              One tax for the batch, always recoverable. Enter singly if a receipt differs.
            </p>
          </div>
        ) : null}
      </div>

      <TableWrap minWidth="72rem" bare>
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">Date</th>
            <th role="columnheader" scope="col">Vendor</th>
            <th role="columnheader" scope="col">Cost code</th>
            <th role="columnheader" scope="col">Description</th>
            <th role="columnheader" scope="col">Receipt no.</th>
            <th role="columnheader" scope="col">Subtotal</th>
            <th role="columnheader" scope="col">Tax</th>
            <th role="columnheader" scope="col">Paid by</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {Array.from({ length: BATCH_ROWS }, (_unused, index) => {
            const row = index + 1;
            return (
              <tr role="row" key={index}>
                <td role="cell" data-label="Date">
                  <input type="date" {...cell(`r${index}_date`, `Row ${row} date`)} />
                </td>
                <td role="cell" data-label="Vendor">
                  <select {...cell(`r${index}_vendor`, `Row ${row} vendor`)}>
                    <option value="">Nobody on the list</option>
                    {vendorOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td role="cell" data-label="Cost code">
                  <select {...cell(`r${index}_code`, `Row ${row} cost code`)}>
                    <option value="">Not coded yet</option>
                    {codeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td role="cell" data-label="Description">
                  <input
                    type="text"
                    maxLength={500}
                    {...cell(`r${index}_desc`, `Row ${row} description`)}
                  />
                </td>
                <td role="cell" data-label="Receipt no.">
                  <input
                    type="text"
                    maxLength={100}
                    {...cell(`r${index}_ref`, `Row ${row} receipt number`)}
                  />
                </td>
                <td role="cell" data-label="Subtotal">
                  <input
                    type="text"
                    inputMode="decimal"
                    maxLength={20}
                    {...cell(`r${index}_sub`, `Row ${row} subtotal`, 'field-num')}
                  />
                </td>
                <td role="cell" data-label="Tax">
                  <input
                    type="text"
                    inputMode="decimal"
                    maxLength={20}
                    {...cell(`r${index}_tax`, `Row ${row} tax`, 'field-num')}
                  />
                </td>
                <td role="cell" data-label="Paid by">
                  <select {...cell(`r${index}_pay`, `Row ${row} paid by`)}>
                    <option value="">Not said</option>
                    {paymentMethodOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>

      {state ? (
        state.ok ? (
          <Notice tone="positive" role="status">
            {state.message}
          </Notice>
        ) : (
          <Notice tone="negative" role="alert" title={state.error}>
            {state.fieldErrors?.length ? (
              <ul className="list-disc pl-5">
                {state.fieldErrors.map((fieldError) => (
                  <li key={`${fieldError.field}-${fieldError.message}`}>
                    <span className="font-semibold">{fieldError.label}</span> {fieldError.message}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-2">
              Nothing was written, and nothing was cleared — the rows above are still as you typed
              them. Fix the one named and submit again.
            </p>
          </Notice>
        )
      ) : null}

      <Notice tone="info">
        A row is ignored until something is typed into it, so eight boxes is not eight
        obligations. No receipt photograph is taken here — eight file pickers on one submit is the
        slowest possible version of the fastest possible screen. A receipt whose paper needs
        keeping is entered on its own, where the camera is one tap away.
      </Notice>

      {!allowed && disabledNote ? <Notice tone="warning">{disabledNote}</Notice> : null}

      <div className="flex items-center gap-3">
        <BulkSubmit disabled={!allowed} />
      </div>
    </form>
  );
}

/** Separate, because `useFormStatus` only reports for a form it is rendered inside. */
function BulkSubmit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      size="lg"
      variant="primary"
      disabled={disabled}
      pending={pending}
      pendingLabel="Recording…"
    >
      Record these expenses
    </Button>
  );
}
