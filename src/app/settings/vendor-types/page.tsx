import { asc, count, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { vendorTypes, vendors } from '@/db/schema';
import { ensureVendorLists } from '@/db/seed/vendor-lists';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import {
  createVendorType,
  setVendorTypeActive,
  updateVendorType,
  voidVendorType,
} from '@/app/settings/vendor-types/actions';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { CheckboxField, FieldGrid, ReadOnlyField, TextField } from '@/components/settings/Fields';
import { VendorTypeFields } from '@/components/settings/VendorTypeFields';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { Reveal } from '@/components/ui/Reveal';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the vendor type list but not change it.';

/**
 * What kind of counterparty a vendor is.
 *
 * Here rather than beside the vendor directory for the reason the cost code
 * list is here: `/vendors` is worked on -- a row is added on site, from a
 * phone, on the day somebody is hired -- and this is a decision about how the
 * company classifies who it pays, made once and read by every vendor for
 * years. It sits directly under Cost codes because it is the same kind of
 * thing about the same subject.
 *
 * The screen's one unusual control is the one that is missing. "Counts as a
 * subcontractor" is offered when a type is created and shown read-only
 * afterwards. See `db/schema/vendor-lists.ts`: that flag is what decides who
 * receives a T5018 slip, who needs current WSIB clearance before a cheque is
 * written, and who may be assigned to a scheduled task -- and a flag anybody
 * could flip would restate all three for every vendor under the type without a
 * single vendor record appearing to change.
 */
export default async function VendorTypesPage() {
  await ensureVendorLists();

  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  // Voided rows stay in the list rather than being filtered away. Their name
  // is still taken -- the unique index is on the column, not on the live rows
  // -- so a list that hid them would leave the owner refused by a row he
  // cannot see, and vendors may still name them.
  const rows = await db
    .select()
    .from(vendorTypes)
    .orderBy(asc(vendorTypes.sortOrder), asc(vendorTypes.name));

  const onVendors = await db
    .select({ id: vendors.vendorTypeId, n: count() })
    .from(vendors)
    .where(isNotNull(vendors.vendorTypeId))
    .groupBy(vendors.vendorTypeId);

  // Counted once for the whole list rather than once per row. The figure is
  // not decoration: retiring and voiding are the two decisions on this screen
  // that are hard to walk back, and both turn on whether anybody is already
  // filed here.
  const used = new Map(
    onVendors.flatMap((row) => (row.id === null ? [] : [[row.id, row.n] as const])),
  );

  return (
    <div className="flex flex-col gap-4">
      {/*
       * Add whatever kinds this company actually pays — materials, labour,
       * equipment, drawings. Keep the list short enough that whoever is
       * adding a vendor on site can pick the right one without reading
       * twenty options.
       */}
      <Section
        title="Vendor types"
        description={<p>Only vendors whose type performs work are asked for a trade.</p>}
        actions={
          // A press, then the form over a blurred page -- the same shape
          // "Change..." already uses on the row below, rather than a form
          // sitting at the foot of the table.
          <SheetButton
            trigger="Add a vendor type"
            variant="primary"
            label="Add a vendor type"
            title="Add a vendor type"
            discardPrompt="Throw away this vendor type? Nothing has been saved yet."
          >
            <ActionForm
              action={createVendorType}
              submitLabel="Add vendor type"
              disabled={!allowed}
              disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
              resetOnSuccess
            >
              <FieldGrid>
                <VendorTypeFields idPrefix="new-vendor-type" disabled={!allowed} />
                <CheckboxField
                  idPrefix="new-vendor-type"
                  name="isSubcontractor"
                  label="Vendors of this type are subcontractors"
                  disabled={!allowed}
                  wide
                  hint="Tick for someone who performs work, not a materials or equipment supplier."
                />
                <div className="sm:col-span-2 -mt-2">
                  <Reveal label="What this decides, and why it's fixed">
                    Three things follow and nothing else: a T5018 slip, a WSIB clearance check
                    before payment, and eligibility for scheduled work. They are also the only
                    vendors asked which trade they are. Fixed once the type exists — a type set
                    wrongly is retired and replaced, not edited.
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

        <Notice tone="info" title="The name is yours. What follows from it is not.">
          <p>
            Fixed when the type is added. It decides T5018 slips, WSIB clearance checks, and
            schedule assignment.
          </p>
          <p className="mt-2">
            Rename freely — that doesn&rsquo;t change it. If the answer itself is wrong,
            retire this type and add the right one.
          </p>
        </Notice>

        <TableWrap minWidth="58rem" className="mt-4">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Name</th>
              <th role="columnheader" scope="col">Counts as</th>
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
                  No vendor types yet. Add the kinds of counterparty you already write
                  cheques to.
                </td>
              </tr>
            ) : null}

            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const uses = used.get(row.id) ?? 0;

              return (
                <tr role="row" key={row.id}>
                  <td role="cell" data-label="Name">{row.name}</td>
                  <td role="cell" data-label="Counts as" className="t-small text-muted">
                    {row.isSubcontractor ? (
                      <Pill tone="info">Subcontractor</Pill>
                    ) : (
                      'Not a subcontractor'
                    )}
                  </td>
                  <AmountCell data-label="Order">{row.sortOrder}</AmountCell>
                  <td role="cell" data-label="Used by" className="t-small text-muted">
                    {uses === 0 ? 'Nothing yet' : `${uses} ${uses === 1 ? 'vendor' : 'vendors'}`}
                  </td>
                  <td role="cell" data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {!isVoid && row.isActive ? <Pill tone="positive">On the list</Pill> : null}
                      {!isVoid && !row.isActive ? <Pill tone="neutral">Retired</Pill> : null}
                    </span>
                  </td>
                  <td role="cell" data-label="Manage">
                    {/* The same press-then-panel the cost code list takes, and
                        for the same reason: a disclosure here pushed every
                        type below this one off the screen, and the list is the
                        thing somebody is reading while they decide. */}
                    <SheetButton
                      trigger="Change…"
                      label={`Change ${row.name}`}
                      title={`Change ${row.name}`}
                      subtitle={
                        row.isSubcontractor
                          ? 'Vendors on this type are subcontractors'
                          : 'Vendors on this type are not subcontractors'
                      }
                      discardPrompt="Throw away the changes to this type? Nothing has been saved yet."
                    >
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Edit this type</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            A rename reaches every vendor filed under this type.
                          </p>
                          <ActionForm
                            action={updateVendorType}
                            submitLabel="Save this type"
                            disabled={!allowed || isVoid}
                            disabledNote={
                              isVoid
                                ? 'This type is void. A void row is kept as a record and is not edited.'
                                : allowed
                                  ? undefined
                                  : REFUSAL
                            }
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              <VendorTypeFields
                                idPrefix={`edit-${row.id}`}
                                row={row}
                                disabled={!allowed || isVoid}
                              />
                              {/* Shown rather than omitted. The one thing a
                                  reader of this panel most needs to know is
                                  what this type means for a filing, and a
                                  screen that simply did not mention it would
                                  read as a screen that forgot. */}
                              <ReadOnlyField
                                label="Counts as a subcontractor"
                                value={row.isSubcontractor ? 'Yes' : 'No'}
                                wide
                                hint="Fixed when added. Decides T5018, WSIB checks, and schedule eligibility."
                              />
                            </FieldGrid>
                          </ActionForm>
                        </div>

                        <div>
                          <h3 className="t-small font-semibold">
                            {row.isActive ? 'Retire' : 'Bring back'}
                          </h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Stops it being offered on new vendors. Existing vendors keep it,
                            unaffected.
                          </p>
                          <RowAction
                            action={setVendorTypeActive}
                            label={row.isActive ? 'Retire this type' : 'Bring it back'}
                            destructive={row.isActive}
                            disabled={!allowed || isVoid}
                            fields={{ id: row.id, isActive: row.isActive ? 'false' : 'true' }}
                            confirm={
                              row.isActive
                                ? `Retire ${row.name}? It stops being offered on new vendors. Nobody already on it changes.`
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
                                {uses} {uses === 1 ? 'vendor is' : 'vendors are'} filed under
                                this type, so voiding it will be refused. A type doing that
                                work was not a mistake — retire it instead.
                              </Notice>
                            ) : (
                              <ActionForm
                                action={voidVendorType}
                                submitLabel="Void this type"
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
