import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { lineGroups } from '@/db/schema';
import { ensureLineGroups } from '@/db/seed/line-groups';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import {
  createLineGroup,
  setLineGroupActive,
  updateLineGroup,
  voidLineGroup,
} from '@/app/settings/line-groups/actions';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid, TextField } from '@/components/settings/Fields';
import { LineGroupFields } from '@/components/settings/LineGroupFields';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the line group list but not change it.';

/**
 * The section heading a quote line prints under.
 *
 * The owner's own question was the spec: "shouldn't this be a dropdown? I
 * don't know what this does." It bands the worksheet and it is what a
 * customer reads at the top of each block of a quote -- typing "Flooring" on
 * one line and "flooring" on another prints as two sections with the same
 * name on the same document, and nobody notices until the customer asks why.
 *
 * This screen only maintains the list. `line_group` on scope template items,
 * quote lines and invoice lines stays free text for now -- see
 * `db/schema/line-groups.ts` -- so nothing here changes what already prints.
 */
export default async function LineGroupsPage() {
  await ensureLineGroups();

  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  // Voided rows stay in the list rather than being filtered away. Their name
  // is still taken -- the unique index is on the column, not on the live rows
  // -- so a list that hid them would leave the owner refused by a row he
  // cannot see.
  const rows = await db
    .select()
    .from(lineGroups)
    .orderBy(asc(lineGroups.sortOrder), asc(lineGroups.name));

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Line groups"
        description={
          <p>The section heading a quote prints. Bands the worksheet into the blocks a customer reads.</p>
        }
        actions={
          // A press, then the form over a blurred page -- the same shape
          // "Change..." already uses on the row below, rather than a form
          // sitting at the foot of the table.
          <SheetButton
            trigger="Add a line group"
            variant="primary"
            label="Add a line group"
            title="Add a line group"
            discardPrompt="Throw away this line group? Nothing has been saved yet."
          >
            <ActionForm
              action={createLineGroup}
              submitLabel="Add line group"
              disabled={!allowed}
              disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
              resetOnSuccess
            >
              <FieldGrid>
                <LineGroupFields idPrefix="new-line-group" disabled={!allowed} />
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

        <Notice tone="info" title="Retiring a heading does not touch what already printed">
          <p>Stops it being offered on a new line — anything already using it is unaffected.</p>
          <p className="mt-2">
            Renaming relabels every future use at once — right for a wording fix, wrong for a
            heading that&rsquo;s actually a different section; retire and add a new one instead.
          </p>
        </Notice>

        <TableWrap minWidth="48rem" className="mt-4">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Name</th>
              <th role="columnheader" scope="col" className="cell-num">Order</th>
              <th role="columnheader" scope="col">Status</th>
              <th role="columnheader" scope="col">Manage</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.length === 0 ? (
              <tr role="row">
                <td role="cell" data-label="Name" colSpan={4}>
                  No line groups yet. Add the section headings you actually print — General,
                  Framing, Drywall — and leave the rest until a quote needs one.
                </td>
              </tr>
            ) : null}

            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';

              return (
                <tr role="row" key={row.id}>
                  <td role="cell" data-label="Name">{row.name}</td>
                  <AmountCell data-label="Order">{row.sortOrder}</AmountCell>
                  <td role="cell" data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {!isVoid && row.isActive ? <Pill tone="positive">On the list</Pill> : null}
                      {!isVoid && !row.isActive ? <Pill tone="neutral">Retired</Pill> : null}
                    </span>
                  </td>
                  <td role="cell" data-label="Manage">
                    {/* The same press-then-panel the trade list takes: a
                        disclosure here pushed every heading below this one off
                        the screen, and the list is the thing somebody is
                        reading while they decide. */}
                    <SheetButton
                      trigger="Change…"
                      label={`Change ${row.name}`}
                      title={`Change ${row.name}`}
                      subtitle={row.name}
                      discardPrompt="Throw away the changes to this line group? Nothing has been saved yet."
                    >
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Edit this line group</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            A rename reaches every future use of this heading.
                          </p>
                          <ActionForm
                            action={updateLineGroup}
                            submitLabel="Save this line group"
                            disabled={!allowed || isVoid}
                            disabledNote={
                              isVoid
                                ? 'This line group is void. A void row is kept as a record and is not edited.'
                                : allowed
                                  ? undefined
                                  : REFUSAL
                            }
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              <LineGroupFields
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
                            Stops it being offered on a new line. Anything already using it is
                            unaffected.
                          </p>
                          <RowAction
                            action={setLineGroupActive}
                            label={row.isActive ? 'Retire this line group' : 'Bring it back'}
                            destructive={row.isActive}
                            disabled={!allowed || isVoid}
                            fields={{ id: row.id, isActive: row.isActive ? 'false' : 'true' }}
                            confirm={
                              row.isActive
                                ? `Retire ${row.name}? It stops being offered on a new line. Nothing already using it changes.`
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
                              For a row that never should have existed. Use Retire for a heading
                              you no longer print — voiding keeps the name reserved.
                            </p>
                            <ActionForm
                              action={voidLineGroup}
                              submitLabel="Void this line group"
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
