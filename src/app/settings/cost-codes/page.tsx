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
import { SheetButton } from '@/components/ui/Sheet';
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
      {/*
       * A rate item, a quote line, an invoice line, and job costing all group
       * actual spend against the same list — that's what turns year end into
       * an export rather than a search through a year of paper. Keep the list
       * short enough that whoever is coding a receipt at the end of a long
       * day can pick the right one without reading forty options.
       */}
      <Section
        title="Cost codes"
        description={
          <p>How spend is categorised. Two levels: a division, and the sections inside it.</p>
        }
      >
        {state.actor ? null : (
          <div className="mb-3">
            <Notice tone="warning">{state.reason}</Notice>
          </div>
        )}

        <Notice tone="info" title="A code is a bucket, and a bucket is never reused">
          <p>
            Renaming relabels the bucket — every line filed under it reads the new name.
            Right for a wording fix.
          </p>
          <p className="mt-2">
            Wrong for a code that now means a different trade — retire it and add a new one,
            or last year&rsquo;s spend reports as this year&rsquo;s category.
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
                    {/* The same press-then-panel the rate list takes, and for
                        the same reason: a disclosure here pushed every code
                        below this one off the screen, and the list is the
                        thing somebody is reading while they decide. */}
                    <SheetButton
                      trigger="Change…"
                      label={`Change ${row.code}`}
                      title={`Change ${row.code}`}
                      subtitle={row.name}
                      discardPrompt="Throw away the changes to this code? Nothing has been saved yet."
                    >
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Edit this code</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            A rename reaches everything filed here, past work included.
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
                                hint="Unique, stored upper case. Renaming doesn't orphan anything already filed."
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
                                    ? "Has sections under it, so it's a division — move those first to change that."
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
                                hint="What a year-end export groups by, above the code itself."
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
                            Stops it being offered on new work. Everything already filed under
                            it is unaffected.
                            {sections > 0 ? ' Sections under it are not retired with it.' : ''}
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
                              For a row that never should have existed. Use Retire for a trade
                              you no longer run — voiding keeps the code reserved.
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

      <Section
        title="Add a cost code"
        description={<p>A division on its own, or a section inside one.</p>}
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
              // A comma or a pipe breaks the price-list importer, which
              // splits a pasted line on exactly those.
              hint="Letters, digits and . - _ / only, in upper case."
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
              hint="Leave it a division unless one has grown too broad to code against."
            />
            <SelectField
              idPrefix="new-cost-code"
              name="category"
              label="Spend category"
              options={CATEGORY_OPTIONS}
              blankLabel="Not categorised"
              disabled={!allowed}
              hint="Chosen from a list, so an export never reports Labour and labour as two things."
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
