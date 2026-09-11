import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { quoteClauses } from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import {
  createClause,
  setClauseActive,
  updateClause,
  voidClause,
} from '@/app/settings/clauses/actions';
import { CLAUSE_KIND_LABELS, type ClauseKind } from '@/app/settings/clauses/schema';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { ClauseFields } from '@/components/settings/ClauseFields';
import { FieldGrid, TextField } from '@/components/settings/Fields';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read these but not change them.';

/**
 * The sentences a quote carries about what it does NOT cover.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WORTH A SCREEN
 * ---------------------------------------------------------------------------
 *
 * `quotes.exclusions_text` and `assumptions_text` have been in the schema
 * since the first migration and nothing wrote them, so no quote this product
 * printed had ever said what it left out. "I assumed that was included" is the
 * commonest argument on a job, and it is settled by one paragraph written
 * before the work starts or it is settled by whoever remembers harder.
 *
 * This list is the reusable half: the same six or seven sentences go on nearly
 * every quote, and typing them again each time is how they stop being typed.
 *
 * ---------------------------------------------------------------------------
 * THE QUOTE COPIES THE WORDS, IT DOES NOT POINT AT THE ROW
 * ---------------------------------------------------------------------------
 *
 * Tapping one on a quote APPENDS its sentence to that quote's own box. No
 * foreign key, no link. So a clause can be reworded here without altering a
 * word of any document already printed, and a quote from last year says
 * exactly what the customer read. It is also what makes retiring one safe.
 */
export default async function ClausesPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  // Void rows stay in the list. Nothing here is refused for a collision, but
  // hiding them would make a voided sentence look like it had been deleted --
  // and nothing in this product is.
  const rows = await db
    .select()
    .from(quoteClauses)
    .orderBy(asc(quoteClauses.kind), asc(quoteClauses.sortOrder), asc(quoteClauses.clauseText));

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Not included, and assumed"
        description={
          <p>
            The sentences you put on nearly every quote. On a quote you tap one to add it, and
            can reword it there for that job.
          </p>
        }
        actions={
          <SheetButton
            trigger="Add one"
            variant="primary"
            label="Add a saved clause"
            title="Add a saved clause"
            discardPrompt="Throw this away? Nothing has been saved yet."
          >
            <ActionForm
              action={createClause}
              submitLabel="Save it"
              disabled={!allowed}
              disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
              resetOnSuccess
            >
              <FieldGrid>
                <ClauseFields idPrefix="new-clause" disabled={!allowed} />
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

        <Notice tone="info" title="Changing these never changes a quote already sent">
          <p>
            A quote copies the words when you add them, so rewording one here reaches your next
            quote and none of the ones already out. Retiring one stops it being offered and leaves
            every existing quote exactly as it reads.
          </p>
          <p className="mt-2">
            Keep them short and specific. &ldquo;Painting&rdquo; settles less than &ldquo;Painting
            and patching beyond the work area&rdquo;.
          </p>
        </Notice>

        <TableWrap minWidth="52rem" className="mt-4">
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Wording</th>
              <th scope="col" className="cell-num">Order</th>
              <th scope="col">Status</th>
              <th scope="col">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td data-label="Kind" colSpan={5}>
                  Nothing saved yet. Start with what you always tell a customer is extra — permit
                  fees, painting, anything found behind a wall — and add to it the next time a job
                  surprises you.
                </td>
              </tr>
            ) : null}

            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const label = CLAUSE_KIND_LABELS[row.kind as ClauseKind] ?? row.kind;

              return (
                <tr key={row.id}>
                  <td data-label="Kind">{label}</td>
                  <td data-label="Wording">{row.clauseText}</td>
                  <AmountCell data-label="Order">{row.sortOrder}</AmountCell>
                  <td data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {!isVoid && row.isActive ? <Pill tone="positive">Offered</Pill> : null}
                      {!isVoid && !row.isActive ? <Pill tone="neutral">Retired</Pill> : null}
                    </span>
                  </td>
                  <td data-label="Manage">
                    <SheetButton
                      trigger="Change…"
                      label={`Change this ${label.toLowerCase()} clause`}
                      title="Change this clause"
                      subtitle={row.clauseText}
                      discardPrompt="Throw away these changes? Nothing has been saved yet."
                    >
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Edit the wording</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Reaches your next quote. Quotes already carrying these words keep them.
                          </p>
                          <ActionForm
                            action={updateClause}
                            submitLabel="Save it"
                            disabled={!allowed || isVoid}
                            disabledNote={
                              isVoid
                                ? 'This one is void. A void row is kept as a record and is not edited.'
                                : allowed
                                  ? undefined
                                  : REFUSAL
                            }
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              <ClauseFields
                                idPrefix={`edit-${row.id}`}
                                row={{
                                  kind: row.kind as ClauseKind,
                                  clauseText: row.clauseText,
                                  sortOrder: row.sortOrder,
                                }}
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
                            Stops it being offered on a new quote. Nothing already printed changes.
                          </p>
                          <RowAction
                            action={setClauseActive}
                            label={row.isActive ? 'Retire it' : 'Bring it back'}
                            destructive={row.isActive}
                            disabled={!allowed || isVoid}
                            fields={{ id: row.id, isActive: row.isActive ? 'false' : 'true' }}
                            confirm={
                              row.isActive
                                ? 'Retire this one? It stops being offered on new quotes. Every quote already carrying it is unchanged.'
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
                              For one that should never have been here. Use Retire for a sentence
                              you have simply stopped using.
                            </p>
                            <ActionForm
                              action={voidClause}
                              submitLabel="Void it"
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
