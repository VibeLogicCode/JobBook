import { asc, count, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { expenses, paymentMethods } from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import {
  createPaymentMethod,
  setPaymentMethodActive,
  updatePaymentMethod,
  voidPaymentMethod,
} from '@/app/settings/payment-methods/actions';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { CheckboxField, FieldGrid, ReadOnlyField, TextField } from '@/components/settings/Fields';
import { PaymentMethodFields } from '@/components/settings/PaymentMethodFields';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { Reveal } from '@/components/ui/Reveal';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the payment method list but not change it.';

/**
 * How money leaves, on the expense form.
 *
 * The fifth hardcoded enum caught for the reason vendor types, trades, project
 * types and lead sources were: `cash, debit, credit, cheque, etransfer,
 * account` was fixed at migration time, so the owner could not add "Line of
 * credit" or "Owner's personal card" without one.
 *
 * The screen's one unusual control is the one that is missing, exactly as on
 * `/settings/vendor-types`: "Means the money has not left yet" is offered when
 * a method is created and shown read-only afterwards. See
 * `db/schema/payment-methods.ts`: `is_on_account` is what decides whether an
 * expense recorded against a method counts as paid, and a flag anybody could
 * flip would restate that for every expense under it without a single expense
 * record appearing to change.
 */
export default async function PaymentMethodsPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  // Voided rows stay in the list rather than being filtered away. Their name
  // is still taken -- the unique index is on the column, not on the live rows
  // -- so a list that hid them would leave the owner refused by a row he
  // cannot see, and expenses may still name them.
  const rows = await db
    .select()
    .from(paymentMethods)
    .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name));

  const onExpenses = await db
    .select({ id: expenses.paymentMethodId, n: count() })
    .from(expenses)
    .where(isNotNull(expenses.paymentMethodId))
    .groupBy(expenses.paymentMethodId);

  // Counted once for the whole list rather than once per row. The figure is
  // not decoration: retiring and voiding are the two decisions on this screen
  // that are hard to walk back, and both turn on whether anybody is already
  // filed here.
  const used = new Map(
    onExpenses.flatMap((row) => (row.id === null ? [] : [[row.id, row.n] as const])),
  );

  return (
    <div className="flex flex-col gap-4">
      {/*
       * Add whatever this company actually gets paid with. Keep the list
       * short enough that whoever is typing a receipt at a kitchen table can
       * pick the right one without reading a dozen options.
       */}
      <Section
        title="Payment methods"
        description={<p>How money leaves, on the expense form.</p>}
        actions={
          <SheetButton
            trigger="Add a payment method"
            variant="primary"
            label="Add a payment method"
            title="Add a payment method"
            discardPrompt="Throw away this payment method? Nothing has been saved yet."
          >
            <ActionForm
              action={createPaymentMethod}
              submitLabel="Add payment method"
              disabled={!allowed}
              disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
              resetOnSuccess
            >
              <FieldGrid>
                <PaymentMethodFields idPrefix="new-payment-method" disabled={!allowed} />
                <CheckboxField
                  idPrefix="new-payment-method"
                  name="isOnAccount"
                  label="Choosing this means the money has not left yet"
                  disabled={!allowed}
                  wide
                  hint="Tick for a supplier account or terms — not for cash, a card, a cheque or a transfer."
                />
                <div className="sm:col-span-2 -mt-2">
                  <Reveal label="Why this is fixed">
                    Fixed once the method exists — a method set wrongly is retired and replaced,
                    not edited. Renaming this method never moves an expense on or off "not yet
                    paid".
                  </Reveal>
                </div>
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

        <Notice tone="info" title="The name is yours. Whether it's been paid is not.">
          <p>
            Fixed when the method is added. It is the one fact that decides whether an expense
            recorded against it counts as paid.
          </p>
          <p className="mt-2">
            Rename freely — that doesn&rsquo;t change it. If the answer itself is wrong, retire
            this method and add the right one.
          </p>
        </Notice>

        <TableWrap minWidth="52rem" className="mt-4">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Name</th>
              <th role="columnheader" scope="col">Settles</th>
              <th role="columnheader" scope="col" className="cell-num">Order</th>
              <th role="columnheader" scope="col">Used by</th>
              <th role="columnheader" scope="col">Status</th>
              <th role="columnheader" scope="col">Manage</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.length === 0 ? (
              <tr role="row">
                <td role="cell" data-label="Name" colSpan={6}>
                  No payment methods yet. Add the ways this company actually gets paid.
                </td>
              </tr>
            ) : null}

            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const uses = used.get(row.id) ?? 0;

              return (
                <tr role="row" key={row.id}>
                  <td role="cell" data-label="Name">{row.name}</td>
                  <td role="cell" data-label="Settles" className="t-small text-muted">
                    {row.isOnAccount ? (
                      <Pill tone="info">Not yet paid</Pill>
                    ) : (
                      'Immediately'
                    )}
                  </td>
                  <AmountCell data-label="Order">{row.sortOrder}</AmountCell>
                  <td role="cell" data-label="Used by" className="t-small text-muted">
                    {uses === 0 ? 'Nothing yet' : `${uses} ${uses === 1 ? 'expense' : 'expenses'}`}
                  </td>
                  <td role="cell" data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {!isVoid && row.isActive ? <Pill tone="positive">On the list</Pill> : null}
                      {!isVoid && !row.isActive ? <Pill tone="neutral">Retired</Pill> : null}
                    </span>
                  </td>
                  <td role="cell" data-label="Manage">
                    {/* The same press-then-panel every list in Settings takes. */}
                    <SheetButton
                      trigger="Change…"
                      label={`Change ${row.name}`}
                      title={`Change ${row.name}`}
                      subtitle={
                        row.isOnAccount
                          ? 'Means the money has not left yet'
                          : 'Settles immediately'
                      }
                      discardPrompt="Throw away the changes to this method? Nothing has been saved yet."
                    >
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Edit this method</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            A rename reaches every expense recorded against this method.
                          </p>
                          <ActionForm
                            action={updatePaymentMethod}
                            submitLabel="Save this method"
                            disabled={!allowed || isVoid}
                            disabledNote={
                              isVoid
                                ? 'This method is void. A void row is kept as a record and is not edited.'
                                : allowed
                                  ? undefined
                                  : REFUSAL
                            }
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              <PaymentMethodFields
                                idPrefix={`edit-${row.id}`}
                                row={row}
                                disabled={!allowed || isVoid}
                              />
                              {/* Shown rather than omitted, for the same reason
                                  the vendor type screen shows it: the one thing
                                  a reader of this panel most needs to know is
                                  what this method means for an expense. */}
                              <ReadOnlyField
                                label="Means the money has not left yet"
                                value={row.isOnAccount ? 'Yes' : 'No'}
                                wide
                                hint="Fixed when added. Decides whether an expense on this method counts as paid."
                              />
                            </FieldGrid>
                          </ActionForm>
                        </div>

                        <div>
                          <h3 className="t-small font-semibold">
                            {row.isActive ? 'Retire' : 'Bring back'}
                          </h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Stops it being offered on new expenses. Existing expenses keep it,
                            unaffected.
                          </p>
                          <RowAction
                            action={setPaymentMethodActive}
                            label={row.isActive ? 'Retire this method' : 'Bring it back'}
                            destructive={row.isActive}
                            disabled={!allowed || isVoid}
                            fields={{ id: row.id, isActive: row.isActive ? 'false' : 'true' }}
                            confirm={
                              row.isActive
                                ? `Retire ${row.name}? It stops being offered on new expenses. Nothing already on it changes.`
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
                              For a row that never should have existed. Use Retire instead for
                              one you simply stopped using — voiding keeps the name reserved.
                            </p>
                            {uses > 0 ? (
                              <Notice tone="warning">
                                {uses} {uses === 1 ? 'expense is' : 'expenses are'} recorded
                                against this method, so voiding it will be refused. A method
                                doing that work was not a mistake — retire it instead.
                              </Notice>
                            ) : (
                              <ActionForm
                                action={voidPaymentMethod}
                                submitLabel="Void this method"
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
