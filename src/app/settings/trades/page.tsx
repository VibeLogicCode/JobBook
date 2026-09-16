import { asc, count, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { trades, vendors } from '@/db/schema';
import { ensureVendorLists } from '@/db/seed/vendor-lists';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import {
  createTrade,
  setTradeActive,
  updateTrade,
  voidTrade,
} from '@/app/settings/trades/actions';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid, TextField } from '@/components/settings/Fields';
import { TradeFields } from '@/components/settings/TradeFields';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the trade list but not change it.';

/**
 * What kind of subcontractor somebody is.
 *
 * The owner's phrasing is the specification: not a work-breakdown vocabulary
 * and not a second cost code list, but the answer to "what sort of sub is
 * this". A trade is what you call somebody when you are looking for one --
 * framer, drywall, electrical -- and a cost code is how their invoice is
 * categorised. They correlate and are not the same, and one electrician's work
 * lands on two codes.
 *
 * Asked only of a vendor whose type carries the subcontractor flag. A lumber
 * yard has no trade, and being asked for one was the thing that made this
 * screen exist.
 */
export default async function TradesPage() {
  await ensureVendorLists();

  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  // Voided rows stay in the list rather than being filtered away. Their name
  // is still taken -- the unique index is on the column, not on the live rows
  // -- so a list that hid them would leave the owner refused by a row he
  // cannot see, and subcontractors may still carry them.
  const rows = await db
    .select()
    .from(trades)
    .orderBy(asc(trades.sortOrder), asc(trades.name));

  const onVendors = await db
    .select({ id: vendors.tradeId, n: count() })
    .from(vendors)
    .where(isNotNull(vendors.tradeId))
    .groupBy(vendors.tradeId);

  // Counted once for the whole list rather than once per row. Retiring and
  // voiding are the two decisions here that are hard to walk back, and both
  // turn on whether anybody already carries the trade.
  const used = new Map(
    onVendors.flatMap((row) => (row.id === null ? [] : [[row.id, row.n] as const])),
  );

  return (
    <div className="flex flex-col gap-4">
      {/*
       * Every vendor whose type counts as a subcontractor carries one, and
       * it's what the schedule and the vendor list use to say who to go
       * looking for.
       */}
      <Section
        title="Trades"
        description={
          <p>Not the same as a cost code — a trade finds somebody; a cost code categorises the invoice.</p>
        }
        actions={
          // A press, then the form over a blurred page -- the same shape
          // "Change..." already uses on the row below, rather than a form
          // sitting at the foot of the table.
          <SheetButton
            trigger="Add a trade"
            variant="primary"
            label="Add a trade"
            title="Add a trade"
            discardPrompt="Throw away this trade? Nothing has been saved yet."
          >
            <ActionForm
              action={createTrade}
              submitLabel="Add trade"
              disabled={!allowed}
              disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
              resetOnSuccess
            >
              <FieldGrid>
                <TradeFields idPrefix="new-trade" disabled={!allowed} />
              </FieldGrid>
            </ActionForm>
          </SheetButton>
        }
      >
        {state.actor ? null : (
          <div className="mb-3">
            <Notice tone="warning">{state.reason}</Notice>
          </div>
        )}

        <Notice tone="info" title="Retiring a trade does not blank the sub who has it">
          <p>Stops it being offered on new vendors — everyone already on it keeps it.</p>
          <p className="mt-2">
            Renaming relabels everyone at once — right for a spelling fix, wrong for a trade
            that&rsquo;s actually changed; retire and add a new one instead.
          </p>
        </Notice>

        <TableWrap minWidth="52rem" className="mt-4">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Name</th>
              <th role="columnheader" scope="col" className="cell-num">Order</th>
              <th role="columnheader" scope="col">Used by</th>
              <th role="columnheader" scope="col">Status</th>
              <th role="columnheader" scope="col">Manage</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.length === 0 ? (
              <tr role="row">
                <td role="cell" data-label="Name" colSpan={5}>
                  No trades yet. Add the ones you actually hire — the trades you would name
                  out loud when somebody asks who is on site this week.
                </td>
              </tr>
            ) : null}

            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const uses = used.get(row.id) ?? 0;

              return (
                <tr role="row" key={row.id}>
                  <td role="cell" data-label="Name">{row.name}</td>
                  <AmountCell data-label="Order">{row.sortOrder}</AmountCell>
                  <td role="cell" data-label="Used by" className="t-small text-muted">
                    {uses === 0
                      ? 'Nothing yet'
                      : `${uses} ${uses === 1 ? 'subcontractor' : 'subcontractors'}`}
                  </td>
                  <td role="cell" data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {!isVoid && row.isActive ? <Pill tone="positive">On the list</Pill> : null}
                      {!isVoid && !row.isActive ? <Pill tone="neutral">Retired</Pill> : null}
                    </span>
                  </td>
                  <td role="cell" data-label="Manage">
                    {/* The same press-then-panel the cost code list takes: a
                        disclosure here pushed every trade below this one off
                        the screen, and the list is the thing somebody is
                        reading while they decide. */}
                    <SheetButton
                      trigger="Change…"
                      label={`Change ${row.name}`}
                      title={`Change ${row.name}`}
                      subtitle={
                        uses === 0
                          ? 'Nobody carries this trade yet'
                          : `${uses} ${uses === 1 ? 'subcontractor carries' : 'subcontractors carry'} it`
                      }
                      discardPrompt="Throw away the changes to this trade? Nothing has been saved yet."
                    >
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Edit this trade</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            A rename reaches every subcontractor filed under it.
                          </p>
                          <ActionForm
                            action={updateTrade}
                            submitLabel="Save this trade"
                            disabled={!allowed || isVoid}
                            disabledNote={
                              isVoid
                                ? 'This trade is void. A void row is kept as a record and is not edited.'
                                : allowed
                                  ? undefined
                                  : REFUSAL
                            }
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              <TradeFields
                                idPrefix={`edit-${row.id}`}
                                row={row}
                                disabled={!allowed || isVoid}
                              />
                            </FieldGrid>
                          </ActionForm>
                        </div>

                        <div>
                          <h3 className="t-small font-semibold">
                            {row.isActive ? 'Retire' : 'Bring back'}
                          </h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Stops it being offered on new subcontractors. Everyone already
                            carrying it is unaffected.
                          </p>
                          <RowAction
                            action={setTradeActive}
                            label={row.isActive ? 'Retire this trade' : 'Bring it back'}
                            destructive={row.isActive}
                            disabled={!allowed || isVoid}
                            fields={{ id: row.id, isActive: row.isActive ? 'false' : 'true' }}
                            confirm={
                              row.isActive
                                ? `Retire ${row.name}? It stops being offered on new subcontractors. Nobody already carrying it changes.`
                                : undefined
                            }
                          />
                        </div>

                        {isVoid ? (
                          <div>
                            <h3 className="t-small font-semibold">Voided</h3>
                            <p className="max-w-prose t-small text-subtle">
                              {row.voidReason ?? 'No reason was recorded.'}
                            </p>
                          </div>
                        ) : (
                          <div>
                            <h3 className="t-small font-semibold">Void it</h3>
                            <p className="mb-2 max-w-prose t-small text-subtle">
                              For a row that never should have existed. Use Retire for a
                              trade you no longer hire — voiding keeps the name reserved.
                            </p>
                            {uses > 0 ? (
                              <Notice tone="warning">
                                {uses}{' '}
                                {uses === 1 ? 'subcontractor carries' : 'subcontractors carry'}{' '}
                                this trade, so voiding it will be refused. A trade doing that
                                work was not a mistake — retire it instead.
                              </Notice>
                            ) : (
                              <ActionForm
                                action={voidTrade}
                                submitLabel="Void this trade"
                                destructive
                                disabled={!mayVoid}
                                disabledNote={
                                  mayVoid ? undefined : 'Your role does not permit voiding a record.'
                                }
                              >
                                <input type="hidden" name="id" value={row.id} />
                                <TextField
                                  idPrefix={`void-${row.id}`}
                                  name="reason"
                                  label="Reason"
                                  required
                                  maxLength={300}
                                  disabled={!mayVoid}
                                  wide
                                  hint="Kept on the record permanently."
                                />
                              </ActionForm>
                            )}
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
    </div>
  );
}
