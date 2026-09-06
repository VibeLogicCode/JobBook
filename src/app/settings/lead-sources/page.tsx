import { asc, count, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, leadSources } from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import {
  createLeadSource,
  setLeadSourceActive,
  updateLeadSource,
  voidLeadSource,
} from '@/app/settings/lead-sources/actions';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid, TextField } from '@/components/settings/Fields';
import { LeadSourceFields } from '@/components/settings/LeadSourceFields';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the lead source list but not change it.';

/**
 * How a customer found this company: a phone call, a referral, a repeat
 * customer, and so on.
 *
 * Used to be a hardcoded Postgres enum -- the third list converted for the
 * same reason vendor types, trades and project types were. Nullable on
 * `customers.lead_source_id`: not knowing how somebody heard about the
 * company is a real and common state.
 */
export default async function LeadSourcesPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  const rows = await db
    .select()
    .from(leadSources)
    .orderBy(asc(leadSources.sortOrder), asc(leadSources.name));

  const onCustomers = await db
    .select({ id: customers.leadSourceId, n: count() })
    .from(customers)
    .where(isNotNull(customers.leadSourceId))
    .groupBy(customers.leadSourceId);

  const used = new Map(
    onCustomers.flatMap((row) => (row.id === null ? [] : [[row.id, row.n] as const])),
  );

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Lead sources"
        description={<p>How a customer found you. Recorded on the customer record, never required.</p>}
        actions={
          <SheetButton
            trigger="Add a lead source"
            variant="primary"
            label="Add a lead source"
            title="Add a lead source"
            discardPrompt="Throw away this lead source? Nothing has been saved yet."
          >
            <ActionForm
              action={createLeadSource}
              submitLabel="Add lead source"
              disabled={!allowed}
              disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
              resetOnSuccess
            >
              <FieldGrid>
                <LeadSourceFields idPrefix="new-lead-source" disabled={!allowed} />
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

        <Notice tone="info" title="Retiring a lead source does not blank the customer who has it">
          <p>Stops it being offered on new customers — everyone already on it keeps it.</p>
          <p className="mt-2">
            Renaming relabels everyone at once — right for a spelling fix, wrong for a source
            that&rsquo;s actually changed; retire and add a new one instead.
          </p>
        </Notice>

        <TableWrap minWidth="52rem" className="mt-4">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className="cell-num">Order</th>
              <th scope="col">Used by</th>
              <th scope="col">Status</th>
              <th scope="col">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td data-label="Name" colSpan={5}>
                  No lead sources yet. Add the ones you actually hear — a phone call, a
                  referral, your website.
                </td>
              </tr>
            ) : null}

            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const uses = used.get(row.id) ?? 0;

              return (
                <tr key={row.id}>
                  <td data-label="Name">{row.name}</td>
                  <AmountCell data-label="Order">{row.sortOrder}</AmountCell>
                  <td data-label="Used by" className="t-small text-muted">
                    {uses === 0 ? 'Nothing yet' : `${uses} ${uses === 1 ? 'customer' : 'customers'}`}
                  </td>
                  <td data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {!isVoid && row.isActive ? <Pill tone="positive">On the list</Pill> : null}
                      {!isVoid && !row.isActive ? <Pill tone="neutral">Retired</Pill> : null}
                    </span>
                  </td>
                  <td data-label="Manage">
                    <SheetButton
                      trigger="Change…"
                      label={`Change ${row.name}`}
                      title={`Change ${row.name}`}
                      subtitle={uses === 0 ? 'Nobody carries this source yet' : `${uses} ${uses === 1 ? 'customer carries' : 'customers carry'} it`}
                      discardPrompt="Throw away the changes to this lead source? Nothing has been saved yet."
                    >
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Edit this lead source</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            A rename reaches every customer filed under it.
                          </p>
                          <ActionForm
                            action={updateLeadSource}
                            submitLabel="Save this lead source"
                            disabled={!allowed || isVoid}
                            disabledNote={
                              isVoid
                                ? 'This lead source is void. A void row is kept as a record and is not edited.'
                                : allowed
                                  ? undefined
                                  : REFUSAL
                            }
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              <LeadSourceFields
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
                            Stops it being offered on new customers. Everyone already carrying it
                            is unaffected.
                          </p>
                          <RowAction
                            action={setLeadSourceActive}
                            label={row.isActive ? 'Retire this lead source' : 'Bring it back'}
                            destructive={row.isActive}
                            disabled={!allowed || isVoid}
                            fields={{ id: row.id, isActive: row.isActive ? 'false' : 'true' }}
                            confirm={
                              row.isActive
                                ? `Retire ${row.name}? It stops being offered on new customers. Nobody already carrying it changes.`
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
                              For a row that never should have existed. Use Retire for a source
                              you no longer track — voiding keeps the name reserved.
                            </p>
                            {uses > 0 ? (
                              <Notice tone="warning">
                                {uses} {uses === 1 ? 'customer carries' : 'customers carry'} this
                                lead source, so voiding it will be refused. A source doing that
                                work was not a mistake — retire it instead.
                              </Notice>
                            ) : (
                              <ActionForm
                                action={voidLeadSource}
                                submitLabel="Void this lead source"
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
