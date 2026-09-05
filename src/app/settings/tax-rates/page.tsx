import { asc, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { taxRates } from '@/db/schema';
import { resolveActor, can } from '@/app/settings/actor';
import { formatPercent } from '@/app/settings/percent';
import {
  addTaxRate,
  editTaxRatePresentation,
  setTaxRateActive,
  supersedeTaxRate,
} from '@/app/settings/tax-rates/actions';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { CheckboxField, FieldGrid, TextField } from '@/components/settings/Fields';
import { Notice } from '@/components/ui/Notice';
import { Section } from '@/components/settings/Section';
import { Pill } from '@/components/ui/Pill';
import { TableWrap } from '@/components/ui/Table';
import { tenantToday } from '@/lib/quote/dates';
import { selectRatesInForce } from '@/lib/quote/tax';

export const dynamic = 'force-dynamic';

const OWNER_ONLY = 'Editing tax rates is reserved to an owner.';

type TaxRateRow = typeof taxRates.$inferSelect;

/**
 * Which rates apply today, decided by the calculation engine's own predicate
 * rather than by a comparison written again here.
 *
 * The two filters match what the engine loads -- active rows, not voided --
 * so a rate this screen marks as in force is the rate the next quote gets. A
 * second implementation of "is this rate current" is a second answer waiting
 * to disagree with the document.
 */
function inForceIds(rows: TaxRateRow[], today: string): Set<string> {
  const candidates = rows
    .filter((row) => row.isActive && row.recordStatus === 'active')
    .map((row) => ({
      id: row.id,
      label: row.label,
      registrationNumber: row.registrationNumber,
      rateTenThou: row.rateTenThou,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      isCompound: row.isCompound,
      sortOrder: row.sortOrder,
    }));
  // The engine filters, copies and sorts, so the rows it hands back are the
  // same objects that went in. Matching on identity keeps the row id out of
  // the engine's own type without a cast that would outlive the reason for it.
  const selected = new Set(selectRatesInForce(candidates, today));
  return new Set(candidates.filter((row) => selected.has(row)).map((row) => row.id));
}

export default async function TaxRatesPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'taxRates.edit') : false;

  const rows = await db
    .select()
    .from(taxRates)
    .orderBy(asc(taxRates.sortOrder), desc(taxRates.effectiveFrom));

  // The tenant's own calendar day, not the container's. A rate transition at
  // midnight local time is exactly the case where a UTC "today" prices a quote
  // under the wrong rate for five hours.
  let today: string | null = null;
  try {
    today = await db.transaction(async (tx) => tenantToday(tx));
  } catch {
    today = null;
  }

  const current = today ? inForceIds(rows, today) : new Set<string>();

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Tax rates"
        description={
          <>
            <p>
              A table rather than a single percentage, because a single one is wrong outside
              the region it was written for: some jurisdictions bill one harmonized line,
              others a federal and a provincial line together, and one of them has no sales
              tax at all.
            </p>
            <p className="mt-2">
              {today ? (
                <>
                  Today, in your timezone, is <span className="num">{today}</span>. Rates in
                  force on that date are marked below.
                </>
              ) : (
                'The organization record is missing, so today’s date in your timezone cannot be resolved.'
              )}
            </p>
          </>
        }
      >
        <Notice tone="info" title="Editing a rate never overwrites it">
          <p>
            Changing a rate closes the current row with an end date and inserts a new row
            starting the day the new rate takes effect. Both rows stay.
          </p>
          <p className="mt-2">
            The reason is that a quote must still print the tax it was signed at. Every issued
            quote also carries its own snapshot of the tax it charged, and the two work
            together: the snapshot protects documents already sent, while these effective
            dates decide what a new quote picks up — including one back-dated into the weeks
            around a change — and answer &ldquo;what was the rate on this date&rdquo; years
            later.
          </p>
        </Notice>

        <TableWrap minWidth="64rem" className="mt-4">
          <thead>
            <tr>
              <th scope="col">Label</th>
              <th scope="col" className="cell-num">
                Rate
              </th>
              <th scope="col">In force from</th>
              <th scope="col">Until</th>
              <th scope="col">Registration</th>
              <th scope="col">Compound</th>
              <th scope="col" className="cell-num">
                Order
              </th>
              <th scope="col">Status</th>
              <th scope="col">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td data-label="Label" colSpan={9}>
                  No tax rates yet. Add the first one below. A deployment in a jurisdiction
                  with no sales tax leaves this list empty, and quotes simply carry no tax
                  line.
                </td>
              </tr>
            ) : null}

            {rows.map((row) => {
              const isCurrent = current.has(row.id);
              const closed = row.effectiveTo !== null;
              return (
                <tr key={row.id}>
                  <td data-label="Label">
                    {row.label}
                    {row.shortLabel ? (
                      <span className="ml-2 t-small text-subtle">{row.shortLabel}</span>
                    ) : null}
                  </td>
                  <td data-label="Rate" className="cell-num">
                    {formatPercent(row.rateTenThou)}%
                  </td>
                  <td data-label="In force from" className="cell-num">
                    {row.effectiveFrom}
                  </td>
                  <td data-label="Until" className="cell-num">
                    {row.effectiveTo ?? '—'}
                  </td>
                  <td data-label="Registration" className="num t-small text-muted">
                    {row.registrationNumber ?? '—'}
                  </td>
                  <td data-label="Compound" className="t-small text-muted">
                    {row.isCompound ? 'On subtotal plus prior taxes' : 'On the subtotal'}
                  </td>
                  <td data-label="Order" className="cell-num">
                    {row.sortOrder}
                  </td>
                  <td data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isCurrent ? <Pill tone="positive">In force today</Pill> : null}
                      {!row.isActive ? <Pill tone="neutral">Retired</Pill> : null}
                      {row.recordStatus === 'void' ? <Pill tone="negative">Void</Pill> : null}
                      {closed && row.isActive && !isCurrent ? (
                        <Pill tone="neutral">Superseded</Pill>
                      ) : null}
                      {!closed && !isCurrent && row.isActive ? (
                        <Pill tone="info">Future</Pill>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Change">
                    <details className="min-w-0">
                      <summary className="min-h-11 cursor-pointer list-none rounded-control border border-line-strong px-3 py-2 t-small">
                        Change…
                      </summary>
                      <div className="mt-3 flex w-full max-w-[38rem] flex-col gap-4 border-t border-line pt-3">
                        <div>
                          <h3 className="t-small font-semibold">Change the rate</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Closes this row on the day before the new rate starts and
                            inserts its successor.
                          </p>
                          <ActionForm
                            action={supersedeTaxRate}
                            submitLabel="Supersede this rate"
                            disabled={!allowed || closed || row.recordStatus === 'void'}
                            disabledNote={
                              closed
                                ? 'This row is already closed. Supersede the rate that is in force instead.'
                                : allowed
                                  ? undefined
                                  : OWNER_ONLY
                            }
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              <TextField
                                idPrefix={`supersede-${row.id}`}
                                name="rate"
                                label="New rate"
                                required
                                numeric
                                inputMode="decimal"
                                suffix="%"
                                maxLength={8}
                                disabled={!allowed || closed}
                              />
                              <TextField
                                idPrefix={`supersede-${row.id}`}
                                name="effectiveFrom"
                                label="Takes effect on"
                                type="date"
                                required
                                disabled={!allowed || closed}
                                hint="The first day the new rate applies. It must be after this row's start date."
                              />
                            </FieldGrid>
                          </ActionForm>
                        </div>

                        <div>
                          <h3 className="t-small font-semibold">Correct the presentation</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            What it is called, its registration number, whether it compounds
                            and the order it applies in. These change in place — every
                            issued quote already carries its own copy of all four, so a
                            correction here cannot reach a signed document.
                          </p>
                          <ActionForm
                            action={editTaxRatePresentation}
                            submitLabel="Save presentation"
                            disabled={!allowed}
                            disabledNote={allowed ? undefined : OWNER_ONLY}
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="label"
                                label="Label"
                                required
                                maxLength={50}
                                defaultValue={row.label}
                                disabled={!allowed}
                                hint="Printed on the document beside the amount."
                              />
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="shortLabel"
                                label="Short label"
                                maxLength={20}
                                defaultValue={row.shortLabel}
                                disabled={!allowed}
                                hint="For a narrow column, where the full label will not fit."
                              />
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="registrationNumber"
                                label="Registration number"
                                maxLength={50}
                                numeric
                                defaultValue={row.registrationNumber}
                                disabled={!allowed}
                              />
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="sortOrder"
                                label="Order"
                                required
                                numeric
                                inputMode="numeric"
                                maxLength={3}
                                defaultValue={String(row.sortOrder)}
                                disabled={!allowed}
                                hint="Application order. It matters when a compound tax is in the list."
                              />
                              <CheckboxField
                                idPrefix={`edit-${row.id}`}
                                name="isCompound"
                                label="Applies on the subtotal plus taxes already added"
                                defaultChecked={row.isCompound}
                                disabled={!allowed}
                                wide
                                hint="Compound taxes evaluate after every non-compound one, in the order above. No current Canadian jurisdiction compounds; one historically did."
                              />
                            </FieldGrid>
                          </ActionForm>
                        </div>

                        <div>
                          <h3 className="t-small font-semibold">
                            {row.isActive ? 'Retire' : 'Bring back'}
                          </h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Nothing is deleted. A retired rate keeps its dates, so a quote
                            inside its window still answers to an audit.
                          </p>
                          <RowAction
                            action={setTaxRateActive}
                            label={row.isActive ? 'Retire this rate' : 'Bring it back'}
                            destructive={row.isActive}
                            disabled={!allowed}
                            fields={{ id: row.id, isActive: row.isActive ? 'false' : 'true' }}
                            confirm={
                              row.isActive
                                ? 'Retire this rate? It stops applying to new quotes. The row and its dates stay.'
                                : undefined
                            }
                          />
                        </div>
                      </div>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      </Section>

      <Section
        title="Add a rate"
        description={
          <p>
            A second row for a jurisdiction that bills two lines, or the first row on a new
            deployment. To <em>change</em> an existing rate, use the row above instead — that
            is what keeps the history.
          </p>
        }
      >
        <ActionForm
          action={addTaxRate}
          submitLabel="Add rate"
          disabled={!allowed}
          disabledNote={state.actor ? OWNER_ONLY : (state.reason ?? undefined)}
          resetOnSuccess
        >
          <FieldGrid>
            <TextField
              idPrefix="new-rate"
              name="label"
              label="Label"
              required
              maxLength={50}
              disabled={!allowed}
              hint="As it prints on a document."
            />
            <TextField
              idPrefix="new-rate"
              name="shortLabel"
              label="Short label"
              maxLength={20}
              disabled={!allowed}
            />
            <TextField
              idPrefix="new-rate"
              name="rate"
              label="Rate"
              required
              numeric
              inputMode="decimal"
              suffix="%"
              maxLength={8}
              disabled={!allowed}
              hint="Two decimal places at most, which is what the stored scale holds exactly."
            />
            <TextField
              idPrefix="new-rate"
              name="effectiveFrom"
              label="In force from"
              type="date"
              required
              disabled={!allowed}
              hint="The first day this rate applies. Back-dating is allowed and is how a historical rate is recorded."
            />
            <TextField
              idPrefix="new-rate"
              name="registrationNumber"
              label="Registration number"
              maxLength={50}
              numeric
              disabled={!allowed}
              hint="Printed beside this tax. It can differ from the company's other numbers."
            />
            <TextField
              idPrefix="new-rate"
              name="sortOrder"
              label="Order"
              required
              numeric
              inputMode="numeric"
              maxLength={3}
              defaultValue="1"
              disabled={!allowed}
            />
            <CheckboxField
              idPrefix="new-rate"
              name="isCompound"
              label="Applies on the subtotal plus taxes already added"
              disabled={!allowed}
              wide
            />
          </FieldGrid>
        </ActionForm>
      </Section>
    </div>
  );
}
