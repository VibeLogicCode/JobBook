import { asc, count, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { costCodes, customerInvoiceLines, quoteLines, rateItems } from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import {
  createCostCode,
  setCostCodeActive,
  updateCostCode,
  voidCostCode,
} from '@/app/settings/cost-codes/actions';
import {
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  isCategory,
} from '@/app/settings/cost-codes/schema';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import { FieldGrid, SelectField, TextField } from '@/components/settings/Fields';
import { Section } from '@/components/settings/Section';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import { AmountCell, TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the cost code list but not change it.';

type CostCodeRow = typeof costCodes.$inferSelect;

/**
 * Divisions first, each followed by its own sections.
 *
 * Sorted here rather than in SQL because the ordering is the hierarchy, and a
 * recursive query for two levels is more machinery than the shape deserves.
 * Anything whose parent has gone missing is appended rather than dropped: a
 * list that silently loses a row is the failure this whole screen exists to
 * prevent.
 */
function inTreeOrder(rows: CostCodeRow[]): CostCodeRow[] {
  const by = (a: CostCodeRow, b: CostCodeRow) =>
    a.sortOrder - b.sortOrder || a.code.localeCompare(b.code);

  const divisions = rows.filter((row) => row.parentId === null).sort(by);
  const known = new Set(rows.map((row) => row.id));
  const ordered: CostCodeRow[] = [];

  for (const division of divisions) {
    ordered.push(division);
    ordered.push(...rows.filter((row) => row.parentId === division.id).sort(by));
  }
  ordered.push(
    ...rows.filter((row) => row.parentId !== null && !known.has(row.parentId)).sort(by),
  );
  return ordered;
}

/**
 * One row per cost code, counted once, rather than a count query per row.
 *
 * The figures are not decoration: retiring and voiding are the two decisions
 * on this screen that are hard to walk back, and both of them turn on whether
 * anything is already filed here. A screen that made the person guess would be
 * a screen that got guessed at.
 */
function tally(rows: { id: string | null; n: number }[]): Map<string, number> {
  return new Map(rows.flatMap((row) => (row.id === null ? [] : [[row.id, row.n] as const])));
}

export default async function CostCodesPage() {
  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  // Voided rows stay in the list rather than being filtered away. Their code
  // is still taken -- the unique index is on the column, not on the live rows
  // -- so a list that hid them would leave the owner refused by a row he
  // cannot see, and rate items still name them.
  const all = await db.select().from(costCodes).orderBy(asc(costCodes.code));
  const rows = inTreeOrder(all);

  const [rateUse, quoteUse, invoiceUse] = await Promise.all([
    db
      .select({ id: rateItems.costCodeId, n: count() })
      .from(rateItems)
      .where(isNotNull(rateItems.costCodeId))
      .groupBy(rateItems.costCodeId),
    db
      .select({ id: quoteLines.costCodeId, n: count() })
      .from(quoteLines)
      .where(isNotNull(quoteLines.costCodeId))
      .groupBy(quoteLines.costCodeId),
    db
      .select({ id: customerInvoiceLines.costCodeId, n: count() })
      .from(customerInvoiceLines)
      .where(isNotNull(customerInvoiceLines.costCodeId))
      .groupBy(customerInvoiceLines.costCodeId),
  ]);
  const onRates = tally(rateUse);
  const onQuotes = tally(quoteUse);
  const onInvoices = tally(invoiceUse);

  const childCount = new Map<string, number>();
  for (const row of all) {
    if (row.parentId) childCount.set(row.parentId, (childCount.get(row.parentId) ?? 0) + 1);
  }

  const byId = new Map(all.map((row) => [row.id, row]));

  /**
   * The divisions a code may be filed under: live rows, at the top level, and
   * never the row itself. Retired ones are offered and say so -- a section
   * being added to a division that is winding down is a real thing to want,
   * and hiding the division would leave the section looking parentless.
   *
   * When the row's CURRENT parent is not in that set -- it was retired, or
   * voided, after the filing -- it is appended, marked. A select whose
   * `defaultValue` matches no option silently shows the first one instead, and
   * the next save would refile the code under whatever happened to sort first.
   */
  function parentOptions(row?: CostCodeRow) {
    const options = all
      .filter(
        (candidate) =>
          candidate.parentId === null &&
          candidate.recordStatus === 'active' &&
          candidate.id !== row?.id,
      )
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((candidate) => ({
        value: candidate.id,
        label: `${candidate.code} — ${candidate.name}${candidate.isActive ? '' : ' (retired)'}`,
      }));

    const current = row?.parentId ? byId.get(row.parentId) : undefined;
    if (current && !options.some((option) => option.value === current.id)) {
      options.push({
        value: current.id,
        label: `${current.code} — ${current.name} (void)`,
      });
    }
    return options;
  }

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Cost codes"
        description={
          <>
            <p>
              How money is categorised. A rate item carries one, every quote line and
              invoice line keeps the one it was written with, and job costing groups actual
              spend — receipts, purchase orders, labour — against the same list. That is what
              turns year end into an export rather than a search through a year of paper.
            </p>
            <p className="mt-2">
              Two levels: a division, and the sections inside it. Keep the list short enough
              that whoever is coding a receipt at the end of a long day can pick the right
              one without reading forty options.
            </p>
          </>
        }
      >
        {state.actor ? null : (
          <div className="mb-3">
            <Notice tone="warning">{state.reason}</Notice>
          </div>
        )}

        <Notice tone="info" title="A code is a bucket, and a bucket is never reused">
          <p>
            Renaming a code relabels the bucket: every line already filed under it reads the
            new name, because a line points at this row rather than copying it. That is the
            right move for a wording fix.
          </p>
          <p className="mt-2">
            It is the wrong move for a code that now means a different trade. Retire that one
            and add the new trade under its own code — otherwise last year&rsquo;s spend
            reports itself as this year&rsquo;s category, and nothing on the screen would ever
            say so.
          </p>
        </Notice>

        <TableWrap minWidth="70rem" className="mt-4">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Name</th>
              <th scope="col">Sits under</th>
              <th scope="col">Spend category</th>
              <th scope="col" className="cell-num">Order</th>
              <th scope="col">Used by</th>
              <th scope="col">Status</th>
              <th scope="col">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td data-label="Code" colSpan={8}>
                  No cost codes yet. Add the divisions you already think in — the trades you
                  write cheques for — and leave the sections until one division needs
                  splitting.
                </td>
              </tr>
            ) : null}

            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const parent = row.parentId ? byId.get(row.parentId) : undefined;
              const sections = childCount.get(row.id) ?? 0;
              const rateUses = onRates.get(row.id) ?? 0;
              const documentUses = (onQuotes.get(row.id) ?? 0) + (onInvoices.get(row.id) ?? 0);
              const options = parentOptions(row);

              return (
                <tr key={row.id}>
                  <td data-label="Code" className="num">
                    {/* The indent is decoration; the "Sits under" column is the
                        answer, and it is the one that survives the stack into
                        cards on a phone. */}
                    {row.parentId ? <span aria-hidden className="text-subtle">└ </span> : null}
                    {row.code}
                  </td>
                  <td data-label="Name">{row.name}</td>
                  <td data-label="Sits under" className="t-small text-muted">
                    {parent ? `${parent.code} — ${parent.name}` : '—'}
                  </td>
                  <td data-label="Spend category" className="t-small text-muted">
                    {isCategory(row.category) ? CATEGORY_LABELS[row.category] : (row.category ?? '—')}
                  </td>
                  <AmountCell data-label="Order">{row.sortOrder}</AmountCell>
                  <td data-label="Used by" className="t-small text-muted">
                    {rateUses === 0 && documentUses === 0 && sections === 0
                      ? 'Nothing yet'
                      : [
                          rateUses > 0
                            ? `${rateUses} rate ${rateUses === 1 ? 'item' : 'items'}`
                            : null,
                          documentUses > 0
                            ? `${documentUses} quote or invoice ${documentUses === 1 ? 'line' : 'lines'}`
                            : null,
                          sections > 0
                            ? `${sections} ${sections === 1 ? 'section' : 'sections'}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                  </td>
                  <td data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {!isVoid && row.isActive ? <Pill tone="positive">On the list</Pill> : null}
                      {!isVoid && !row.isActive ? <Pill tone="neutral">Retired</Pill> : null}
                      {row.parentId === null ? <Pill tone="info">Division</Pill> : null}
                    </span>
                  </td>
                  <td data-label="Manage">
                    <details className="min-w-0">
                      <summary className="min-h-11 cursor-pointer list-none rounded-control border border-line-strong px-3 py-2 t-small">
                        Change…
                      </summary>
                      <div className="mt-3 flex w-full max-w-[38rem] flex-col gap-4 border-t border-line pt-3">
                        <div>
                          <h3 className="t-small font-semibold">Edit this code</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            A rename reaches everything filed here, past work included. If the
                            trade itself has changed, retire this code instead and add the new
                            one below.
                          </p>
                          <ActionForm
                            action={updateCostCode}
                            submitLabel="Save this code"
                            disabled={!allowed || isVoid}
                            disabledNote={
                              isVoid
                                ? 'This code is void. A void row is kept as a record and is not edited.'
                                : allowed
                                  ? undefined
                                  : REFUSAL
                            }
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="code"
                                label="Code"
                                required
                                maxLength={60}
                                defaultValue={row.code}
                                disabled={!allowed || isVoid}
                                hint="Unique across the list, stored in upper case. Changing it does not orphan anything — lines point at the row, not the text."
                              />
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="name"
                                label="Name"
                                required
                                maxLength={200}
                                defaultValue={row.name}
                                disabled={!allowed || isVoid}
                                hint="What this bucket is called on a report."
                              />
                              <SelectField
                                idPrefix={`edit-${row.id}`}
                                name="parentId"
                                label="Sits under"
                                defaultValue={row.parentId}
                                options={options}
                                blankLabel="Nothing — this is a division"
                                disabled={!allowed || isVoid || sections > 0}
                                hint={
                                  sections > 0
                                    ? 'This code has sections filed under it, so it is a division. Move those first if it has to become a section.'
                                    : 'Two levels only. A section cannot hold sections of its own.'
                                }
                              />
                              <SelectField
                                idPrefix={`edit-${row.id}`}
                                name="category"
                                label="Spend category"
                                defaultValue={isCategory(row.category) ? row.category : ''}
                                options={CATEGORY_OPTIONS}
                                blankLabel="Not categorised"
                                disabled={!allowed || isVoid}
                                hint="What kind of spend lands here. It is what a year-end export groups by above the code itself."
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
                                hint="Within its division. Equal numbers fall back to the code."
                              />
                            </FieldGrid>
                          </ActionForm>
                        </div>

                        <div>
                          <h3 className="t-small font-semibold">
                            {row.isActive ? 'Retire' : 'Bring back'}
                          </h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Retiring stops the code being offered on new work — a trade you no
                            longer run, a number a new standard superseded. It is not a
                            deletion and not a void: the row stays, its code stays taken, and
                            every rate item, quote line and invoice line already filed under it
                            goes on naming it.
                            {sections > 0
                              ? ' The sections under it are not retired with it; retire each one you also want off the list.'
                              : ''}
                          </p>
                          <RowAction
                            action={setCostCodeActive}
                            label={row.isActive ? 'Retire this code' : 'Bring it back'}
                            destructive={row.isActive}
                            disabled={!allowed || isVoid}
                            fields={{ id: row.id, isActive: row.isActive ? 'false' : 'true' }}
                            confirm={
                              row.isActive
                                ? `Retire ${row.code}? It stops being offered on new work. Nothing already coded to it changes.`
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
                              For a row that should never have existed — a code typed twice, a
                              division added under the wrong number. It is not how you take a
                              trade out of circulation; that is Retire, above. Voiding does not
                              free the code, so a corrected division needs a code of its own.
                            </p>
                            {documentUses > 0 ? (
                              <Notice tone="warning">
                                {documentUses} quote or invoice{' '}
                                {documentUses === 1 ? 'line is' : 'lines are'} already grouped
                                under this code, so voiding it will be refused. A code doing
                                that work was not a mistake — retire it instead.
                              </Notice>
                            ) : (
                              <ActionForm
                                action={voidCostCode}
                                submitLabel="Void this code"
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
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      </Section>

      <Section
        title="Add a cost code"
        description={
          <p>
            A division on its own, or a section inside one. Nothing here is offered to a
            quote until it exists, so the list is worth building before the first job rather
            than during one.
          </p>
        }
      >
        <ActionForm
          action={createCostCode}
          submitLabel="Add cost code"
          disabled={!allowed}
          disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
          resetOnSuccess
        >
          <FieldGrid>
            <TextField
              idPrefix="new-cost-code"
              name="code"
              label="Code"
              required
              maxLength={60}
              disabled={!allowed}
              hint="Letters, digits and . - _ / only, stored in upper case. A comma or a pipe inside a code breaks the price-list importer, which splits a pasted line on exactly those."
            />
            <TextField
              idPrefix="new-cost-code"
              name="name"
              label="Name"
              required
              maxLength={200}
              disabled={!allowed}
              hint="The trade or the bucket, in the words you would use on a report."
            />
            <SelectField
              idPrefix="new-cost-code"
              name="parentId"
              label="Sits under"
              options={parentOptions()}
              blankLabel="Nothing — this is a division"
              disabled={!allowed}
              hint="Leave it a division unless one division has already grown too broad to code a receipt against."
            />
            <SelectField
              idPrefix="new-cost-code"
              name="category"
              label="Spend category"
              options={CATEGORY_OPTIONS}
              blankLabel="Not categorised"
              disabled={!allowed}
              hint="What kind of spend lands here. Chosen from a list rather than typed, so a year-end export does not report Labour and labour as two things."
            />
            <TextField
              idPrefix="new-cost-code"
              name="sortOrder"
              label="Order"
              numeric
              inputMode="numeric"
              maxLength={6}
              defaultValue="0"
              disabled={!allowed}
              hint="Within its division. Equal numbers fall back to the code."
            />
          </FieldGrid>
        </ActionForm>
      </Section>
    </div>
  );
}
