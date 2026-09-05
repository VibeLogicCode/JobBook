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
import {
  CheckboxField,
  FieldGrid,
  ReadOnlyField,
  TextField,
} from '@/components/settings/Fields';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
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
      <Section
        title="Vendor types"
        description={
          <>
            <p>
              What kind of counterparty somebody is: where you buy materials, who you hire to
              do work, who you rent a machine from, who you pay for a drawing. Every vendor
              carries one, and the vendor form asks for a trade only when the type says the
              vendor performs work.
            </p>
            <p className="mt-2">
              Add whatever kinds this company actually pays. Keep the list short enough that
              whoever is adding a vendor on site can pick the right one without reading
              twenty options.
            </p>
          </>
        }
      >
        {state.actor ? null : (
          <div className="mb-3">
            <Notice tone="warning">{state.reason}</Notice>
          </div>
        )}

        <Notice tone="info" title="The name is yours. What follows from it is not.">
          <p>
            Whether a type&rsquo;s vendors count as subcontractors is chosen once, when the
            type is added, and cannot be edited afterwards. Three things and nothing else
            hang off it: they receive a T5018 statement of contract payments, their WSIB
            clearance is checked before they are paid, and they appear when work is assigned
            on a schedule.
          </p>
          <p className="mt-2">
            If that answer were editable, renaming a row would quietly restate who this
            company owes a slip and a clearance check to, and nothing on any vendor&rsquo;s
            record would say so. Rename freely; if the answer itself is wrong, retire that
            type and add the right one, then move the vendors across on their own screen.
          </p>
        </Notice>

        <TableWrap minWidth="58rem" className="mt-4">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Counts as</th>
              <th scope="col" className="cell-num">Order</th>
              <th scope="col">Used by</th>
              <th scope="col">Status</th>
              <th scope="col">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td data-label="Name" colSpan={6}>
                  No vendor types yet. Add the kinds of counterparty you already write
                  cheques to.
                </td>
              </tr>
            ) : null}

            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const uses = used.get(row.id) ?? 0;

              return (
                <tr key={row.id}>
                  <td data-label="Name">{row.name}</td>
                  <td data-label="Counts as" className="t-small text-muted">
                    {row.isSubcontractor ? (
                      <Pill tone="info">Subcontractor</Pill>
                    ) : (
                      'Not a subcontractor'
                    )}
                  </td>
                  <AmountCell data-label="Order">{row.sortOrder}</AmountCell>
                  <td data-label="Used by" className="t-small text-muted">
                    {uses === 0 ? 'Nothing yet' : `${uses} ${uses === 1 ? 'vendor' : 'vendors'}`}
                  </td>
                  <td data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {!isVoid && row.isActive ? <Pill tone="positive">On the list</Pill> : null}
                      {!isVoid && !row.isActive ? <Pill tone="neutral">Retired</Pill> : null}
                    </span>
                  </td>
                  <td data-label="Manage">
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
                            A rename reaches every vendor filed under this type. It does not
                            change what the type means for a filing — that answer is fixed
                            below.
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
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="name"
                                label="Name"
                                required
                                maxLength={120}
                                defaultValue={row.name}
                                disabled={!allowed || isVoid}
                                hint="What you call this kind of counterparty. Vendors point at the row, not at the text, so nothing is orphaned by a rename."
                              />
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="sortOrder"
                                label="Order"
                                numeric
                                inputMode="numeric"
                                maxLength={6}
                                defaultValue={String(row.sortOrder)}
                                disabled={!allowed || isVoid}
                                hint="Where it sits in the picker. Equal numbers fall back to the name."
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
                                hint="Fixed when the type was added and not editable. It decides who receives a T5018 slip, whose WSIB clearance is checked before payment, and who may be assigned work on a schedule — so a wording change must never be able to restate it. If this answer is wrong, retire this type and add the right one."
                              />
                            </FieldGrid>
                          </ActionForm>
                        </div>

                        <div>
                          <h3 className="t-small font-semibold">
                            {row.isActive ? 'Retire' : 'Bring back'}
                          </h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Retiring stops the type being offered on new vendors — a kind of
                            counterparty this company no longer deals with. It is not a
                            deletion and not a void: the row stays, its name stays taken, and
                            every vendor already filed under it keeps it, standing included.
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
                              For a row that should never have existed — a name typed twice,
                              or a type added with the wrong answer above before anybody was
                              put on it. It is not how you take a kind of counterparty out of
                              circulation; that is Retire. Voiding does not free the name, so
                              a corrected type needs a name of its own.
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
                                  hint="Recorded on the row. A void with no reason teaches nobody anything a year later."
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

      <Section
        title="Add a vendor type"
        description={
          <p>
            One decision on this form cannot be revisited, and it is marked. Everything else
            is a label you can change whenever the wording stops fitting.
          </p>
        }
      >
        <ActionForm
          action={createVendorType}
          submitLabel="Add vendor type"
          disabled={!allowed}
          disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
          resetOnSuccess
        >
          <FieldGrid>
            <TextField
              idPrefix="new-vendor-type"
              name="name"
              label="Name"
              required
              maxLength={120}
              disabled={!allowed}
              hint="The kind of counterparty, in the words you would use out loud."
            />
            <TextField
              idPrefix="new-vendor-type"
              name="sortOrder"
              label="Order"
              numeric
              inputMode="numeric"
              maxLength={6}
              defaultValue="0"
              disabled={!allowed}
              hint="Where it sits in the picker. Equal numbers fall back to the name."
            />
            <CheckboxField
              idPrefix="new-vendor-type"
              name="isSubcontractor"
              label="Vendors of this type are subcontractors"
              disabled={!allowed}
              wide
              hint="Tick it for somebody who performs work, not for somewhere you buy materials or hire a machine. Three things follow and nothing else sets them: they receive a T5018 slip, their WSIB clearance is checked before they are paid, and they appear when work is assigned on a schedule. They are also the only vendors asked which trade they are. This answer is fixed once the type exists — a type set wrongly is retired and replaced, not edited."
            />
          </FieldGrid>
        </ActionForm>
      </Section>
    </div>
  );
}
