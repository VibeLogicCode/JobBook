import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { costCodes, rateItems } from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import {
  createRateItem,
  setRateItemActive,
  updateRateItem,
  voidRateItem,
} from '@/app/rates/actions';
import { CALC_MODE_OPTIONS } from '@/app/rates/schema';
import { ImportPanel } from '@/app/rates/ImportPanel';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import {
  CheckboxField,
  FieldGrid,
  SelectField,
  TextField,
} from '@/components/settings/Fields';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { formatBasisPoints, formatQty, formatRate } from '@/lib/money/format';
import { marginBasisPoints } from '@/lib/money/scale';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the rate list but not change it.';

export default async function RatesPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  const rows = await db
    .select({ item: rateItems, costCode: costCodes.name })
    .from(rateItems)
    .leftJoin(costCodes, eq(rateItems.costCodeId, costCodes.id))
    // Voided rows stay in the list rather than being filtered away. Their code
    // is still taken -- the unique index is on the column, not on the live
    // rows -- so a list that hid them would leave the owner refused by a row
    // he cannot see.
    .orderBy(asc(rateItems.sortOrder), asc(rateItems.code));

  const codes = await db
    .select({ id: costCodes.id, code: costCodes.code, name: costCodes.name })
    .from(costCodes)
    .where(eq(costCodes.recordStatus, 'active'))
    .orderBy(asc(costCodes.code));

  const costCodeOptions = codes.map((row) => ({
    value: row.id,
    label: `${row.code} — ${row.name}`,
  }));

  return (
    <div className="px-4 py-4 sm:px-6">
      <h1 className="t-title mb-1">Rates</h1>
      <p className="mb-4 max-w-prose t-small text-muted">
        One list per deployment. Editing a rate never moves a quote already
        written — every line snapshots its rates when it is created.
      </p>

      <div className="flex flex-col gap-4">
        <Section title="Rate items">
          {state.actor ? null : (
            <div className="mb-3">
              <Notice tone="warning">{state.reason}</Notice>
            </div>
          )}

          <TableWrap minWidth="72rem">
            <thead>
              <tr>
                <th scope="col">Description</th>
                <th scope="col">Code</th>
                <th scope="col">Cost code</th>
                <th scope="col">Unit</th>
                <th scope="col" className="cell-num">Cost</th>
                <th scope="col" className="cell-num">Sell</th>
                <th scope="col" className="cell-num">Margin</th>
                <th scope="col">Status</th>
                <th scope="col">Manage</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td data-label="Description" colSpan={9}>
                    Nothing priced yet. Add one below, or paste a whole price list into the
                    importer — a quote can still be built line by line without any.
                  </td>
                </tr>
              ) : null}

              {rows.map(({ item, costCode }) => {
                const margin = marginBasisPoints(item.sellRateTenThou, item.costRateTenThou);
                const isVoid = item.recordStatus === 'void';
                return (
                  <tr key={item.id}>
                    <td data-label="Description">{item.description}</td>
                    <td data-label="Code" className="num t-small text-muted">{item.code}</td>
                    <td data-label="Cost code" className="t-small text-muted">{costCode ?? '—'}</td>
                    <td data-label="Unit" className="t-small text-muted">
                      {item.unitLabel || (item.calcMode === 'percent' ? '%' : '—')}
                    </td>
                    {/* Rates are ten-thousandths, not cents, so these take the
                        numeric cell but keep their own formatter. */}
                    <AmountCell data-label="Cost">{formatRate(item.costRateTenThou)}</AmountCell>
                    <AmountCell data-label="Sell">{formatRate(item.sellRateTenThou)}</AmountCell>
                    <AmountCell data-label="Margin" className={margin < 0 ? 'text-negative' : ''}>
                      {formatBasisPoints(margin)}
                    </AmountCell>
                    <td data-label="Status">
                      <span className="flex flex-wrap items-center gap-1">
                        {isVoid ? <Pill tone="negative">Void</Pill> : null}
                        {!isVoid && item.isActive ? <Pill tone="positive">On the list</Pill> : null}
                        {!isVoid && !item.isActive ? <Pill tone="neutral">Retired</Pill> : null}
                        {item.isAllowance ? <Pill tone="info">Allowance</Pill> : null}
                        {!item.isTaxable ? <Pill tone="warning">No tax</Pill> : null}
                      </span>
                    </td>
                    <td data-label="Manage">
                      <details className="min-w-0">
                        <summary className="min-h-11 cursor-pointer list-none rounded-control border border-line-strong px-3 py-2 t-small">
                          Change…
                        </summary>
                        <div className="mt-3 flex w-full max-w-[38rem] flex-col gap-4 border-t border-line pt-3">
                          <div>
                            <h3 className="t-small font-semibold">Edit this item</h3>
                            <p className="mb-2 max-w-prose t-small text-subtle">
                              Changes apply to quotes written from here on. Nothing already
                              quoted moves: a quote line carries its own copy of the
                              description, the cost code and both rates.
                            </p>
                            <ActionForm
                              action={updateRateItem}
                              submitLabel="Save this item"
                              disabled={!allowed || isVoid}
                              disabledNote={
                                isVoid
                                  ? 'This item is void. A void row is kept as a record and is not edited.'
                                  : allowed
                                    ? undefined
                                    : REFUSAL
                              }
                            >
                              <input type="hidden" name="id" value={item.id} />
                              <FieldGrid>
                                <TextField
                                  idPrefix={`edit-${item.id}`}
                                  name="code"
                                  label="Code"
                                  required
                                  maxLength={60}
                                  defaultValue={item.code}
                                  disabled={!allowed || isVoid}
                                  hint="Unique across the one list."
                                />
                                <TextField
                                  idPrefix={`edit-${item.id}`}
                                  name="description"
                                  label="Description"
                                  required
                                  maxLength={500}
                                  defaultValue={item.description}
                                  disabled={!allowed || isVoid}
                                  hint="What a quote line says by default."
                                />
                                <SelectField
                                  idPrefix={`edit-${item.id}`}
                                  name="calcMode"
                                  label="How it calculates"
                                  required
                                  defaultValue={item.calcMode}
                                  options={CALC_MODE_OPTIONS}
                                  disabled={!allowed || isVoid}
                                />
                                <TextField
                                  idPrefix={`edit-${item.id}`}
                                  name="unitLabel"
                                  label="Unit"
                                  maxLength={20}
                                  defaultValue={item.unitLabel}
                                  disabled={!allowed || isVoid}
                                  hint="Display only — sqft, lnft, ea, hr. It never affects the arithmetic."
                                />
                                <TextField
                                  idPrefix={`edit-${item.id}`}
                                  name="costRate"
                                  label="Cost"
                                  numeric
                                  inputMode="decimal"
                                  maxLength={20}
                                  defaultValue={formatRate(item.costRateTenThou)}
                                  disabled={!allowed || isVoid}
                                  hint="What it costs you. Never printed on a customer document."
                                />
                                <TextField
                                  idPrefix={`edit-${item.id}`}
                                  name="sellRate"
                                  label="Sell"
                                  required
                                  numeric
                                  inputMode="decimal"
                                  maxLength={20}
                                  defaultValue={formatRate(item.sellRateTenThou)}
                                  disabled={!allowed || isVoid}
                                  hint="Negative is allowed, and is how a discount line is written."
                                />
                                <SelectField
                                  idPrefix={`edit-${item.id}`}
                                  name="costCodeId"
                                  label="Cost code"
                                  defaultValue={item.costCodeId}
                                  options={costCodeOptions}
                                  blankLabel="Not costed"
                                  disabled={!allowed || isVoid}
                                />
                                <TextField
                                  idPrefix={`edit-${item.id}`}
                                  name="defaultQty"
                                  label="Default quantity"
                                  numeric
                                  inputMode="decimal"
                                  maxLength={20}
                                  defaultValue={
                                    item.defaultQtyMilli === null
                                      ? ''
                                      : formatQty(item.defaultQtyMilli)
                                  }
                                  disabled={!allowed || isVoid}
                                  hint="Filled in when the item is added to a quote. Leave it blank to type one each time."
                                />
                                <TextField
                                  idPrefix={`edit-${item.id}`}
                                  name="sortOrder"
                                  label="Order"
                                  numeric
                                  inputMode="numeric"
                                  maxLength={6}
                                  defaultValue={String(item.sortOrder)}
                                  disabled={!allowed || isVoid}
                                />
                                <CheckboxField
                                  idPrefix={`edit-${item.id}`}
                                  name="isTaxable"
                                  label="Tax applies to this item"
                                  defaultChecked={item.isTaxable}
                                  disabled={!allowed || isVoid}
                                  hint="Off for a pass-through such as a municipal permit fee."
                                />
                                <CheckboxField
                                  idPrefix={`edit-${item.id}`}
                                  name="isAllowance"
                                  label="This is an allowance"
                                  defaultChecked={item.isAllowance}
                                  disabled={!allowed || isVoid}
                                  hint="A placeholder the customer can spend, reconciled against actual cost later."
                                />
                              </FieldGrid>
                            </ActionForm>
                          </div>

                          <div>
                            <h3 className="t-small font-semibold">
                              {item.isActive ? 'Retire' : 'Bring back'}
                            </h3>
                            <p className="mb-2 max-w-prose t-small text-subtle">
                              Retiring stops the item being offered on new quotes. It is not a
                              deletion and not a void: the row stays, its code stays taken, and
                              every quote and template already naming it goes on resolving.
                            </p>
                            <RowAction
                              action={setRateItemActive}
                              label={item.isActive ? 'Retire this item' : 'Bring it back'}
                              destructive={item.isActive}
                              disabled={!allowed || isVoid}
                              fields={{ id: item.id, isActive: item.isActive ? 'false' : 'true' }}
                              confirm={
                                item.isActive
                                  ? 'Retire this item? It stops being offered on new quotes. Nothing already quoted changes.'
                                  : undefined
                              }
                            />
                          </div>

                          {isVoid ? (
                            <div>
                              <h3 className="t-small font-semibold">Voided</h3>
                              <p className="max-w-prose t-small text-subtle">
                                {item.voidReason ?? 'No reason was recorded.'}
                              </p>
                            </div>
                          ) : (
                            <div>
                              <h3 className="t-small font-semibold">Void it</h3>
                              <p className="mb-2 max-w-prose t-small text-subtle">
                                For a row that should never have existed — a bad import line, a
                                duplicate typed twice. It is not how you take an item out of
                                circulation; that is Retire, above. Voiding does not free the
                                code, so a corrected line needs a code of its own.
                              </p>
                              <ActionForm
                                action={voidRateItem}
                                submitLabel="Void this item"
                                destructive
                                disabled={!mayVoid}
                                disabledNote={
                                  mayVoid ? undefined : 'Your role does not permit voiding a record.'
                                }
                              >
                                <input type="hidden" name="id" value={item.id} />
                                <TextField
                                  idPrefix={`void-${item.id}`}
                                  name="reason"
                                  label="Reason"
                                  required
                                  maxLength={300}
                                  disabled={!mayVoid}
                                  wide
                                  hint="Recorded on the row. A void with no reason teaches nobody anything a year later."
                                />
                              </ActionForm>
                            </div>
                          )}
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
          title="Add a rate item"
          description={
            <p>
              One line, by hand — the usual way a new item arrives, after a supplier quotes a
              price. A whole list at once goes through the importer below.
            </p>
          }
        >
          <ActionForm
            action={createRateItem}
            submitLabel="Add rate item"
            disabled={!allowed}
            disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
            resetOnSuccess
          >
            <FieldGrid>
              <TextField
                idPrefix="new-rate"
                name="code"
                label="Code"
                required
                maxLength={60}
                disabled={!allowed}
                hint="Unique across the one list. It is how the item is found and how an import decides a row is already here."
              />
              <TextField
                idPrefix="new-rate"
                name="description"
                label="Description"
                required
                maxLength={500}
                disabled={!allowed}
                hint="What a quote line says by default."
              />
              <SelectField
                idPrefix="new-rate"
                name="calcMode"
                label="How it calculates"
                required
                defaultValue="qty"
                options={CALC_MODE_OPTIONS}
                disabled={!allowed}
                hint="By quantity multiplies the rate; a flat amount ignores quantity; a percentage applies to another figure."
              />
              <TextField
                idPrefix="new-rate"
                name="unitLabel"
                label="Unit"
                maxLength={20}
                disabled={!allowed}
                hint="Display only — sqft, lnft, ea, hr. It never affects the arithmetic."
              />
              <TextField
                idPrefix="new-rate"
                name="costRate"
                label="Cost"
                numeric
                inputMode="decimal"
                maxLength={20}
                disabled={!allowed}
                hint="What it costs you, to four decimals. Left blank it records as zero, and the margin will read 100%."
              />
              <TextField
                idPrefix="new-rate"
                name="sellRate"
                label="Sell"
                required
                numeric
                inputMode="decimal"
                maxLength={20}
                disabled={!allowed}
                hint="Negative is allowed, and is how a discount line is written."
              />
              <SelectField
                idPrefix="new-rate"
                name="costCodeId"
                label="Cost code"
                options={costCodeOptions}
                blankLabel="Not costed"
                disabled={!allowed}
              />
              <TextField
                idPrefix="new-rate"
                name="defaultQty"
                label="Default quantity"
                numeric
                inputMode="decimal"
                maxLength={20}
                disabled={!allowed}
                hint="Optional. Never negative — a reduction is a negative price on a positive quantity."
              />
              <TextField
                idPrefix="new-rate"
                name="sortOrder"
                label="Order"
                numeric
                inputMode="numeric"
                maxLength={6}
                defaultValue="0"
                disabled={!allowed}
              />
              <CheckboxField
                idPrefix="new-rate"
                name="isTaxable"
                label="Tax applies to this item"
                defaultChecked
                disabled={!allowed}
                hint="Off for a pass-through such as a municipal permit fee."
              />
              <CheckboxField
                idPrefix="new-rate"
                name="isAllowance"
                label="This is an allowance"
                disabled={!allowed}
                hint="A placeholder the customer can spend, reconciled against actual cost later."
              />
            </FieldGrid>
          </ActionForm>
        </Section>

        <Section
          title="Import a price list"
          description={
            <p>
              A fresh install starts with an empty list, and typing sixty items before the first
              quote is where an owner stops. Paste the list or choose the file, say which column
              is which, and read what will happen before anything is written.
            </p>
          }
        >
          <ImportPanel
            allowed={allowed}
            disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
            existingCodes={rows.map(({ item }) => item.code)}
            costCodes={codes}
          />
        </Section>
      </div>
    </div>
  );
}
