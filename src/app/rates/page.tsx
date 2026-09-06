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
import { ImportPanel } from '@/app/rates/ImportPanel';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid, TextField } from '@/components/settings/Fields';
import { Section } from '@/components/settings/Section';
import { RateItemFields } from '@/components/rates/RateItemFields';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { formatBasisPoints, formatRate } from '@/lib/money/format';
import { marginBasisPoints } from '@/lib/money/scale';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the rate list but not change it.';

export default async function RatesPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  const rows = await db
    .select({
      item: rateItems,
      costCode: costCodes.name,
      // A cost code can be retired or voided on /settings/cost-codes. Neither
      // blanks it out here: the row is never deleted and the join still
      // resolves, so what the cell owes the reader is the standing of the code
      // rather than a name that looks as current as any other.
      costCodeActive: costCodes.isActive,
      costCodeStatus: costCodes.recordStatus,
    })
    .from(rateItems)
    .leftJoin(costCodes, eq(rateItems.costCodeId, costCodes.id))
    // Voided rows stay in the list rather than being filtered away. Their code
    // is still taken -- the unique index is on the column, not on the live
    // rows -- so a list that hid them would leave the owner refused by a row
    // he cannot see.
    .orderBy(asc(rateItems.sortOrder), asc(rateItems.code));

  const allCodes = await db
    .select({
      id: costCodes.id,
      code: costCodes.code,
      name: costCodes.name,
      isActive: costCodes.isActive,
      recordStatus: costCodes.recordStatus,
    })
    .from(costCodes)
    .orderBy(asc(costCodes.code));

  // What the importer may match against. Not the same set as the picker
  // below, and deliberately: `importRateItems` re-runs the same plan on the
  // server over the codes whose `record_status` is active, so a preview drawn
  // from a narrower set would promise an outcome the commit would not honour.
  const codes = allCodes.filter((row) => row.recordStatus === 'active');

  // What a NEW rate item may be given. Retired means "do not offer this on new
  // work", so a retired code is absent here even though it is still a code.
  const costCodeOptions = allCodes
    .filter((row) => row.recordStatus === 'active' && row.isActive)
    .map((row) => ({ value: row.id, label: `${row.code} — ${row.name}` }));

  /**
   * The picker for one existing item, which is the same list plus whatever the
   * item is already coded to.
   *
   * The addition is not a courtesy. A `<select>` whose `defaultValue` matches
   * no option silently shows the first one instead, so an item coded to a
   * since-retired division would be re-coded to whatever sorts first the next
   * time anybody saved its price -- a change nobody asked for, on the column
   * job costing groups by.
   */
  function optionsFor(currentId: string | null) {
    if (currentId === null) return costCodeOptions;
    const current = allCodes.find((row) => row.id === currentId);
    if (!current || costCodeOptions.some((option) => option.value === currentId)) {
      return costCodeOptions;
    }
    return [
      ...costCodeOptions,
      {
        value: current.id,
        label: `${current.code} — ${current.name} (${
          current.recordStatus === 'active' ? 'retired' : 'void'
        })`,
      },
    ];
  }

  return (
    <div className="px-4 py-4 sm:px-6">
      {/* No `parent`, and that is the finding rather than an omission: the
          rate book is a top-level destination on the rail, reached from
          nowhere else and belonging to no record. A header that pointed
          somewhere would be inventing a hierarchy the data does not have. */}
      <PageHeader
        className="mb-4"
        title="Rates"
        description="One list per deployment. Editing a rate never moves a quote already written."
        actions={
          // A press, then the form over a blurred page -- the same shape the
          // owner asked for twice, and the shape the row below already uses
          // for "Change...". A form sitting at the foot of the table, below
          // everything already priced, was the split he was naming.
          <SheetButton
            trigger="Add a rate item"
            variant="primary"
            label="Add a rate item"
            title="Add a rate item"
            discardPrompt="Throw away this rate item? Nothing has been saved yet."
          >
            <ActionForm
              action={createRateItem}
              submitLabel="Add rate item"
              disabled={!allowed}
              disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
              resetOnSuccess
            >
              <FieldGrid>
                <RateItemFields
                  idPrefix="new-rate"
                  costCodeOptions={costCodeOptions}
                  disabled={!allowed}
                />
              </FieldGrid>
            </ActionForm>
          </SheetButton>
        }
      />

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
                    Nothing priced yet. Add one above, or paste a whole price list into the
                    importer — a quote can still be built line by line without any.
                  </td>
                </tr>
              ) : null}

              {rows.map(({ item, costCode, costCodeActive, costCodeStatus }) => {
                const margin = marginBasisPoints(item.sellRateTenThou, item.costRateTenThou);
                const isVoid = item.recordStatus === 'void';
                const costCodeNote =
                  costCode === null
                    ? null
                    : costCodeStatus !== 'active'
                      ? 'void'
                      : costCodeActive === false
                        ? 'retired'
                        : null;
                return (
                  <tr key={item.id}>
                    <td data-label="Description">{item.description}</td>
                    <td data-label="Code" className="num t-small text-muted">{item.code}</td>
                    <td data-label="Cost code" className="t-small text-muted">
                      {costCode ?? '—'}
                      {costCodeNote ? (
                        <span className="text-subtle"> ({costCodeNote})</span>
                      ) : null}
                    </td>
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
                      {/* A press, then the form over a blurred page -- not a
                          disclosure that shoves the rest of the list down
                          the screen the moment somebody opens it. The title
                          names the row, because the table behind it is
                          dimmed and the sheet is now the only thing saying
                          which price is being changed. */}
                      <SheetButton
                        trigger="Change…"
                        label={`Change ${item.code}`}
                        title={`Change ${item.code}`}
                        subtitle={item.description}
                        discardPrompt="Throw away the changes to this item? Nothing has been saved yet."
                      >
                        <div className="flex flex-col gap-4">
                          <div>
                            <h3 className="t-small font-semibold">Edit this item</h3>
                            <p className="mb-2 max-w-prose t-small text-subtle">
                              Applies to quotes written from here on — a quote line keeps its
                              own copy of everything.
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
                                <RateItemFields
                                  idPrefix={`edit-${item.id}`}
                                  item={item}
                                  costCodeOptions={optionsFor(item.costCodeId)}
                                  costCodeHint={
                                    costCodeNote
                                      ? `Coded to a ${costCodeNote} cost code; stays until you pick another.`
                                      : undefined
                                  }
                                  disabled={!allowed || isVoid}
                                />
                              </FieldGrid>
                            </ActionForm>
                          </div>

                          <div>
                            <h3 className="t-small font-semibold">
                              {item.isActive ? 'Retire' : 'Bring back'}
                            </h3>
                            <p className="mb-2 max-w-prose t-small text-subtle">
                              Stops the item being offered on new quotes. The row and its code
                              stay, and every quote and template naming it keeps resolving.
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
                                For a row that should never have existed — a bad import, a
                                duplicate. Not how you retire an item, and it does not free the
                                code either.
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
                                  hint="Kept on the record permanently."
                                  disabled={!mayVoid}
                                  wide
                                />
                              </ActionForm>
                            </div>
                          )}
                        </div>
                      </SheetButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        </Section>

        <Section
          title="Import a price list"
          description={
            <p>
              Paste the list or choose a file, say which column is which, and review what will
              happen before anything is written.
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
