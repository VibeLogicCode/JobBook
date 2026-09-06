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
import { FieldGrid } from '@/components/settings/Fields';
import { TaxRateAmountFields, TaxRatePresentationFields } from '@/components/settings/TaxRateFields';
import { Notice } from '@/components/ui/Notice';
import { Section } from '@/components/settings/Section';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
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
      {/*
       * A single percentage is wrong outside the region it was written for:
       * some jurisdictions bill one harmonized line, others a federal and a
       * provincial line together, and one has no sales tax at all.
       */}
      <Section
        title="Tax rates"
        description={
          <>
            <p>A table, not a single percentage — rates vary too much for one fixed number.</p>
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
        actions={
          // A press, then the form over a blurred page -- the same shape
          // "Change..." already uses on the row below, rather than a form
          // sitting at the foot of the table. To *change* an existing rate,
          // the row above is still the way in -- this keeps the history.
          <SheetButton
            trigger="Add a rate"
            variant="primary"
            label="Add a tax rate"
            title="Add a rate"
            discardPrompt="Throw away this rate? Nothing has been saved yet."
          >
            <ActionForm
              action={addTaxRate}
              submitLabel="Add rate"
              disabled={!allowed}
              disabledNote={state.actor ? OWNER_ONLY : (state.reason ?? undefined)}
              resetOnSuccess
            >
              <FieldGrid>
                <TaxRateAmountFields idPrefix="new-rate" disabled={!allowed} />
                <TaxRatePresentationFields idPrefix="new-rate" disabled={!allowed} />
              </FieldGrid>
            </ActionForm>
          </SheetButton>
        }
      >
        {/*
         * A quote's own snapshot protects documents already sent, while these
         * effective dates decide what a new quote picks up — including one
         * back-dated into the weeks around a change — and answer "what was
         * the rate on this date" years later.
         */}
        <Notice tone="info" title="Editing a rate never overwrites it">
          <p>
            Changing a rate closes the current row and inserts a new one starting when the new
            rate applies. Both stay.
          </p>
          <p className="mt-2">
            Every issued quote keeps the tax it was signed at — editing a rate never changes a
            document already sent.
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
                  No tax rates yet. Add the first one above. A deployment in a jurisdiction
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
                    {/* A press, then the form over a blurred page -- the same
                        control the rate list, the cost codes and the reminder
                        rules already use for "change this row". A disclosure
                        here pushed every later rate down the screen the moment
                        it opened, and this one holds three separate forms, so
                        it pushed them a long way. The title names the tax,
                        because the table behind it is dimmed and the sheet is
                        now the only thing saying which row is being changed. */}
                    <SheetButton
                      trigger="Change…"
                      label={`Change ${row.label}`}
                      title={`Change ${row.label}`}
                      subtitle={`${formatPercent(row.rateTenThou)}% from ${row.effectiveFrom}`}
                      discardPrompt="Throw away the changes to this rate? Nothing has been saved yet."
                    >
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Change the rate</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Closes this row and inserts its successor.
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
                              <TaxRateAmountFields
                                idPrefix={`supersede-${row.id}`}
                                supersede
                                disabled={!allowed || closed}
                              />
                            </FieldGrid>
                          </ActionForm>
                        </div>

                        <div>
                          <h3 className="t-small font-semibold">Correct the presentation</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Changes here don&rsquo;t reach an already-issued quote — it keeps
                            its own copy.
                          </p>
                          <ActionForm
                            action={editTaxRatePresentation}
                            submitLabel="Save presentation"
                            disabled={!allowed}
                            disabledNote={allowed ? undefined : OWNER_ONLY}
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              <TaxRatePresentationFields
                                idPrefix={`edit-${row.id}`}
                                row={row}
                                disabled={!allowed}
                              />
                            </FieldGrid>
                          </ActionForm>
                        </div>

                        <div>
                          <h3 className="t-small font-semibold">
                            {row.isActive ? 'Retire' : 'Bring back'}
                          </h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Nothing is deleted — a retired rate keeps its dates for audit.
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
