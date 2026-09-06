import type { Metadata } from 'next';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { costCodes, organization, trades, vendorTypes, vendors } from '@/db/schema';
import { ensureVendorLists } from '@/db/seed/vendor-lists';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import {
  createVendor,
  setVendorActive,
  updateVendor,
  voidVendor,
} from '@/app/vendors/actions';
import { listOptionLabel } from '@/app/settings/vendor-lists';
import { paymentTermsLabel, vendorKindLabel } from '@/app/vendors/schema';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import {
  FieldGrid,
  SelectField,
  TextAreaField,
  TextField,
  type Option,
} from '@/components/settings/Fields';
import { Card } from '@/components/ui/Card';
import { FilterBar, NoMatches } from '@/components/ui/FilterBar';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill } from '@/components/ui/Pill';
import { Reveal } from '@/components/ui/Reveal';
import { SheetButton } from '@/components/ui/Sheet';
import { TableWrap } from '@/components/ui/Table';
import { normalizeSearch, searchCondition } from '@/lib/list/search';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Vendors' };

const REFUSAL = 'Your role can read the vendor list but not change it.';

type VendorRow = typeof vendors.$inferSelect;

/**
 * The filter is still the derived flag rather than the type list, and
 * deliberately. "Which of these am I filing a T5018 for" is the question this
 * screen gets asked, and it has two answers however many types the owner has
 * invented. The second option is no longer called "Suppliers": a type list
 * makes equipment hire and professional services ordinary answers, and neither
 * of those is a supplier.
 */
const KIND_OPTIONS = [
  { value: 'subcontractor', label: 'Subcontractors' },
  { value: 'supplier', label: 'Everyone else' },
];

/**
 * Who gets paid: the suppliers goods are bought from and the subcontractors
 * work is hired from.
 *
 * **Why this is a route of its own rather than a settings section.** A cost
 * code is a decision about how the company reports itself, made once and
 * changed rarely, which is what put that list on the settings nav. A vendor is
 * a counterparty, added on the day somebody is hired -- often from a phone, on
 * site, by whoever is standing there. That is the same shape as `/customers`,
 * and this table is the mirror of it: one is where money comes from, the other
 * is where it goes. Spec 5.4 lists a "subcontractor directory" as a screen
 * beside the schedule and the compliance dashboard, not as a panel inside
 * Setup, and the settings screen describes itself as everything a customer
 * DOCUMENT says about the company -- which a vendor is not.
 */
export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  };

  const q = normalizeSearch(one('q'));
  const kind = one('kind') === 'subcontractor' || one('kind') === 'supplier' ? one('kind') : '';
  const showRetired = one('retired') === '1';

  // The form cannot be drawn without them, and a fresh installation has never
  // opened the settings screens that would otherwise have loaded them.
  await ensureVendorLists();

  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  const search = searchCondition(q, [
    vendors.name,
    vendors.legalName,
    vendors.contactName,
    // The trade and the type live on other tables now, and both are things
    // people search by -- "who are my framers" is the question the trade list
    // exists for. Correlated rather than joined, so the search stays one
    // condition a caller drops into `and(...)` and the row set keeps its shape.
    sql`(select t.name from trades t where t.id = ${vendors.tradeId})`,
    sql`(select vt.name from vendor_types vt where vt.id = ${vendors.vendorTypeId})`,
    vendors.city,
    vendors.phone,
    vendors.email,
    // The two numbers are searchable because the moment somebody needs one is
    // the moment they have the number and not the name: a T5018 run works from
    // a business number, and a receipt being coded carries a registration.
    vendors.businessNumber,
    vendors.taxRegistrationNumber,
  ]);

  // Every row, then filtered in memory for the two counts the screen owes the
  // reader. The table gains a row when somebody is hired, so it is small by
  // construction; a list that quietly dropped rows is the failure this screen
  // exists to prevent, and the counts are what prove it did not.
  const all = await db
    .select()
    .from(vendors)
    .where(and(search, kind === '' ? undefined : eq(vendors.isSubcontractor, kind === 'subcontractor')))
    .orderBy(asc(vendors.name));

  // Retired and voided rows are behind the reveal rather than gone. Their name
  // is still taken -- the unique index is on `lower(name)`, not on the live
  // rows -- so a list that hid them permanently would leave somebody refused
  // by a row they cannot see.
  const isHidden = (row: VendorRow) => !row.isActive || row.recordStatus === 'void';
  const hiddenCount = all.filter(isHidden).length;
  const rows = showRetired ? all : all.filter((row) => !isHidden(row));

  const [org] = await db.select({ province: organization.province }).from(organization);

  // Every type and every trade, retired and voided included. A vendor already
  // carrying one has to go on displaying it -- retiring "Roofing" must not
  // blank the roofer -- and a select whose `defaultValue` matches no option
  // silently shows the FIRST one instead, which on the next save would refile
  // that vendor under whatever happened to sort first. For the type that would
  // not be a cosmetic slip: it would restate whether they are owed a T5018.
  const allTypes = await db
    .select()
    .from(vendorTypes)
    .orderBy(asc(vendorTypes.sortOrder), asc(vendorTypes.name));
  const allTrades = await db
    .select()
    .from(trades)
    .orderBy(asc(trades.sortOrder), asc(trades.name));

  const typeById = new Map(allTypes.map((row) => [row.id, row]));
  const tradeById = new Map(allTrades.map((row) => [row.id, row]));

  /**
   * The types a vendor may be filed under: the ones still on the list, plus
   * whichever one this vendor already carries, marked.
   *
   * A retired type is not offered to a vendor that is not already on it --
   * retired means do not put anybody new here -- but it IS offered back to the
   * vendor that is, because the alternative is a form that cannot be saved
   * without moving somebody between tax standings to correct their phone
   * number.
   */
  function typeOptions(row?: VendorRow): Option[] {
    // `reveals` marks the types that perform work, and it is a STYLING hook:
    // it is what the `.reveals-field` rule in globals.css watches to decide
    // whether the trade box is on the screen. Nothing is decided from it. The
    // answer that is acted on is read from `vendor_types` inside the writing
    // transaction, and `vendors.is_subcontractor` is derived from that by
    // trigger -- so a stale open tab costs a hidden box, never a wrong filing.
    const options: Option[] = allTypes
      .filter((type) => type.isActive && type.recordStatus === 'active')
      .map((type) => ({ value: type.id, label: type.name, reveals: type.isSubcontractor }));

    const current = row?.vendorTypeId ? typeById.get(row.vendorTypeId) : undefined;
    if (current && !options.some((option) => option.value === current.id)) {
      options.push({
        value: current.id,
        label: listOptionLabel(current),
        reveals: current.isSubcontractor,
      });
    }
    return options;
  }

  /** The same rule for trades, for the same reason. */
  function tradeOptions(row?: VendorRow): Option[] {
    const options: Option[] = allTrades
      .filter((trade) => trade.isActive && trade.recordStatus === 'active')
      .map((trade) => ({ value: trade.id, label: trade.name }));

    const current = row?.tradeId ? tradeById.get(row.tradeId) : undefined;
    if (current && !options.some((option) => option.value === current.id)) {
      options.push({ value: current.id, label: listOptionLabel(current) });
    }
    return options;
  }

  const allCodes = await db
    .select({
      id: costCodes.id,
      code: costCodes.code,
      name: costCodes.name,
      isActive: costCodes.isActive,
      recordStatus: costCodes.recordStatus,
    })
    .from(costCodes)
    .where(ne(costCodes.recordStatus, 'void'))
    .orderBy(asc(costCodes.code));

  const codeById = new Map(allCodes.map((row) => [row.id, row]));

  /**
   * The codes a vendor's default may be set to: live rows, retired ones
   * marked as such.
   *
   * Retired codes are offered rather than hidden, and the action agrees: a
   * vendor whose spend has always landed on a winding-down division should go
   * on proposing it until somebody decides otherwise. What is not offered is a
   * void code, because proposing one on every future receipt spreads a mistake
   * rather than recording it.
   *
   * When the row's CURRENT code is not in that set -- it was voided after the
   * vendor was created -- it is appended, marked. A select whose
   * `defaultValue` matches no option silently shows the first one instead, and
   * the next save would recode the vendor to whatever happened to sort first.
   */
  function costCodeOptions(row?: VendorRow): Option[] {
    const options: Option[] = allCodes.map((code) => ({
      value: code.id,
      label: `${code.code} — ${code.name}${code.isActive ? '' : ' (retired)'}`,
    }));

    if (row?.defaultCostCodeId && !codeById.has(row.defaultCostCodeId)) {
      options.push({ value: row.defaultCostCodeId, label: 'The code this was set to (now void)' });
    }
    return options;
  }

  /** The fields of the add and the edit form, written once. */
  function fields(row: VendorRow | undefined, prefix: string) {
    const disabled = !allowed || row?.recordStatus === 'void';
    return (
      <>
        <FieldGrid>
          <TextField
            idPrefix={prefix}
            name="name"
            label="Name"
            required
            maxLength={200}
            defaultValue={row?.name}
            disabled={disabled}
          />
          <TextField
            idPrefix={prefix}
            name="legalName"
            label="Legal name"
            maxLength={200}
            defaultValue={row?.legalName}
            disabled={disabled}
            hint="The name on the cheque, if it differs. The T5018 uses this name."
          />
          {/*
            The owner's ask, in one tree: a supplier is not asked which trade
            it is, and a subcontractor is asked what KIND of subcontractor it
            is. Both fields are always rendered and always submitted; the trade
            is hidden by the `.reveals-field` rule in globals.css while the
            chosen type is not one that performs work.

            `display: contents` on the wrapper, so both fields stay direct
            children of the two-column grid above -- a real box here would make
            the pair one grid cell and stack them under each other while every
            other field sat in two columns.

            Hidden rather than removed, so a trade already picked survives a
            change of mind. That means a leftover can still arrive for a
            supplier, which is why the action drops it from the TYPE row it
            reads in the writing transaction rather than trusting the browser.
            And hidden rather than `required`-toggled: a hidden required
            control blocks the submit with a browser message pointing at a box
            nobody can see, so the action refuses a missing trade in words,
            only for the types that need one.
          */}
          <div className="contents reveals-field">
            <SelectField
              idPrefix={prefix}
              name="vendorTypeId"
              label="Vendor type"
              required
              reveals
              defaultValue={row?.vendorTypeId ?? ''}
              options={typeOptions(row)}
              blankLabel="Choose one"
              disabled={disabled}
              hint="Decides T5018 filing, WSIB clearance checks, and assignment eligibility."
            />
            <div className="revealed-field min-w-0 self-start">
              <SelectField
                idPrefix={prefix}
                name="tradeId"
                label="Trade"
                defaultValue={row?.tradeId ?? ''}
                options={tradeOptions(row)}
                blankLabel="Choose one"
                disabled={disabled}
                hint="Not the same as the cost code below."
              />
            </div>
          </div>
          <SelectField
            idPrefix={prefix}
            name="defaultCostCodeId"
            label="Usual cost code"
            defaultValue={row?.defaultCostCodeId ?? ''}
            options={costCodeOptions(row)}
            blankLabel="None — code each receipt as it arrives"
            disabled={disabled}
            hint="Proposed on new expenses only; won't recode anything already recorded."
          />
          <TextField
            idPrefix={prefix}
            name="contactName"
            label="Contact"
            maxLength={200}
            defaultValue={row?.contactName}
            disabled={disabled}
          />
          <TextField
            idPrefix={prefix}
            name="phone"
            label="Phone"
            type="tel"
            maxLength={60}
            defaultValue={row?.phone}
            disabled={disabled}
          />
          <TextField
            idPrefix={prefix}
            name="email"
            label="Email"
            type="email"
            maxLength={200}
            defaultValue={row?.email}
            disabled={disabled}
          />
          <TextField
            idPrefix={prefix}
            name="paymentTermsDays"
            label="Payment terms"
            numeric
            inputMode="numeric"
            maxLength={4}
            defaultValue={row?.paymentTermsDays === null ? '' : String(row?.paymentTermsDays ?? '')}
            disabled={disabled}
            suffix="days"
            hint="Net days. Blank means none agreed; 0 means cash on delivery — different facts."
          />
          {/*
            Ask for the business number the day a subcontractor is hired.
            Chasing it in February from somebody who finished in August is how
            a T5018 filing gets late.
          */}
          <TextField
            idPrefix={prefix}
            name="businessNumber"
            label="Business number"
            maxLength={60}
            defaultValue={row?.businessNumber}
            disabled={disabled}
            hint="The CRA business number, for the T5018."
          />
          <TextField
            idPrefix={prefix}
            name="taxRegistrationNumber"
            label="Tax registration number"
            maxLength={60}
            defaultValue={row?.taxRegistrationNumber}
            disabled={disabled}
            hint="Different from the business number above."
          />
          <div className="sm:col-span-2">
            <Reveal label="What this number is for">
              Evidence for an input tax credit on a receipt over $30; a supplier who isn&apos;t
              registered charges no tax.
            </Reveal>
          </div>
          <TextField
            idPrefix={prefix}
            name="addressLine1"
            label="Address"
            maxLength={200}
            defaultValue={row?.addressLine1}
            disabled={disabled}
            wide
          />
          <TextField
            idPrefix={prefix}
            name="city"
            label="City"
            maxLength={120}
            defaultValue={row?.city}
            disabled={disabled}
          />
          <TextField
            idPrefix={prefix}
            name="province"
            label="Province"
            maxLength={60}
            // Defaulted from the company's own province rather than from a
            // constant: a province written into the product is a tenant's
            // region hardcoded for every other company that buys it.
            defaultValue={row ? row.province : (org?.province ?? '')}
            disabled={disabled}
          />
          <TextField
            idPrefix={prefix}
            name="postalCode"
            label="Postal code"
            maxLength={20}
            defaultValue={row?.postalCode}
            disabled={disabled}
          />
        </FieldGrid>
        <TextAreaField
          idPrefix={prefix}
          name="notes"
          label="Notes"
          rows={3}
          defaultValue={row?.notes}
          disabled={disabled}
          hint="Anything the next person needs to know. Not printed anywhere a customer sees."
        />
      </>
    );
  }

  const subcontractors = all.filter((row) => row.isSubcontractor).length;
  // Vendors added before the type list existed. Their standing is whatever the
  // old tick box left, which is why the form asks rather than guessing.
  const untyped = all.filter((row) => row.vendorTypeId === null && row.recordStatus !== 'void');

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        title="Vendors"
        description="Everyone you pay: the suppliers you buy from and the subcontractors you hire."
        actions={
          <SheetButton
            trigger="Add vendor"
            variant="primary"
            label="Add a vendor"
            title="Add a vendor"
            subtitle="A supplier you buy from, or a subcontractor you hire."
            discardPrompt="Throw away this vendor? Nothing has been saved yet."
          >
            <ActionForm
              action={createVendor}
              submitLabel="Add vendor"
              disabled={!allowed}
              disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
              resetOnSuccess
            >
              {fields(undefined, 'new-vendor')}
            </ActionForm>
          </SheetButton>
        }
      />

      {state.actor ? null : (
        <div className="mb-3">
          <Notice tone="warning">{state.reason}</Notice>
        </div>
      )}

      {untyped.length > 0 ? (
        <div className="mb-3">
          <Notice tone="info" title="Some of these predate the vendor type list">
            {untyped.length === 1 ? 'One vendor has' : `${untyped.length} vendors have`} no type
            yet, so {untyped.length === 1 ? 'it keeps' : 'they keep'} whatever the old
            subcontractor tick box left. Opening{' '}
            {untyped.length === 1 ? 'that row' : 'each of them'} and choosing a type is what
            settles it — the product will not guess, because the guess would be a guess
            about a tax filing.
          </Notice>
        </div>
      ) : null}

      <FilterBar
        basePath="/vendors"
        q={q}
        searchLabel="Search vendors"
        searchPlaceholder="Name, trade, contact, city, business number"
        selects={[
          {
            name: 'kind',
            label: 'Kind',
            value: kind,
            anyLabel: 'Anyone you pay',
            options: KIND_OPTIONS,
          },
        ]}
        reveal={{
          name: 'retired',
          on: showRetired,
          showLabel: 'Show retired and voided',
          hideLabel: 'Hide retired and voided',
          hiddenCount,
          hiddenNoun: 'retired or voided',
        }}
        shown={rows.length}
        noun={{ singular: 'vendor', plural: 'vendors' }}
      />

      {rows.length === 0 ? (
        q !== '' || kind !== '' ? (
          <NoMatches
            basePath="/vendors"
            q={q}
            noun="vendors"
            describe={kind ? [`Kind: ${kind === 'subcontractor' ? 'Subcontractors' : 'Everyone else'}`] : []}
            hint={
              hiddenCount > 0 && !showRetired
                ? 'Retired and voided vendors are hidden by default. The control above brings them back.'
                : undefined
            }
          />
        ) : hiddenCount > 0 ? (
          // Not "no vendors yet". There ARE vendors; every one of them is
          // retired or void, and a screen that said the list was empty would be
          // read as having lost them -- which is the one thing a list that
          // never deletes must never look like it did.
          <Card as="div" className="p-6 text-muted">
            Every vendor on the list is retired or voided. Nothing has been lost — the
            control above brings {hiddenCount === 1 ? 'the row' : 'them'} back into view, and
            every record already made against {hiddenCount === 1 ? 'it' : 'them'} still
            resolves.
          </Card>
        ) : (
          <Card as="div" className="p-6 text-muted">
            No vendors yet. Add the people you already write cheques to — the yard, the
            framer, the electrician. A subcontractor added now is one whose business number
            you can still ask for.
          </Card>
        )
      ) : (
        <TableWrap minWidth="62rem">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Contact</th>
              <th scope="col">Usual cost code</th>
              <th scope="col">Terms</th>
              <th scope="col">Numbers</th>
              <th scope="col">Status</th>
              <th scope="col">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const code = row.defaultCostCodeId ? codeById.get(row.defaultCostCodeId) : undefined;
              // Resolved from the full lists rather than the offered ones, so a
              // retired or voided type or trade still reads as itself here.
              const type = row.vendorTypeId ? typeById.get(row.vendorTypeId) : undefined;
              const kindOf = {
                typeName: type ? listOptionLabel(type) : null,
                isSubcontractor: row.isSubcontractor,
                trade: row.tradeId ? (tradeById.get(row.tradeId)?.name ?? null) : null,
              };

              return (
                <tr key={row.id}>
                  <td data-label="Name">
                    {row.name}
                    {row.legalName && row.legalName !== row.name ? (
                      <span className="block t-small text-subtle">{row.legalName}</span>
                    ) : null}
                  </td>
                  <td data-label="Kind" className="t-small text-muted">
                    {vendorKindLabel(kindOf)}
                  </td>
                  <td data-label="Contact" className="t-small text-muted">
                    {[row.contactName, row.phone, row.city].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td data-label="Usual cost code" className="t-small text-muted">
                    {row.defaultCostCodeId === null
                      ? '—'
                      : code
                        ? `${code.code} — ${code.name}${code.isActive ? '' : ' (retired)'}`
                        : 'A code that has since been voided'}
                  </td>
                  <td data-label="Terms" className="t-small text-muted">
                    {paymentTermsLabel(row.paymentTermsDays)}
                  </td>
                  <td data-label="Numbers" className="t-small text-muted">
                    {/* Named rather than printed bare. Two numbers that look
                        alike and mean different things are exactly the pair a
                        reader gets backwards, and the T5018 half is the one
                        with a filing deadline behind it. */}
                    {row.businessNumber || row.taxRegistrationNumber ? (
                      <>
                        {row.businessNumber ? (
                          <span className="block num">BN {row.businessNumber}</span>
                        ) : null}
                        {row.taxRegistrationNumber ? (
                          <span className="block num">Tax {row.taxRegistrationNumber}</span>
                        ) : null}
                      </>
                    ) : row.isSubcontractor ? (
                      // A word, not a colour: a subcontractor with no business
                      // number is a T5018 that cannot be filed, and the list is
                      // where that is cheapest to notice.
                      <Pill tone="warning">No business number</Pill>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {!isVoid && row.isActive ? <Pill tone="positive">On the list</Pill> : null}
                      {!isVoid && !row.isActive ? <Pill tone="neutral">Retired</Pill> : null}
                    </span>
                  </td>
                  <td data-label="Manage">
                    {/* The same press-then-panel the rate list and the cost
                        code list take, and for the same reason: a disclosure
                        here pushed every vendor below this one off the screen,
                        and the list is the thing somebody is reading while
                        they decide. */}
                    <SheetButton
                      trigger="Change…"
                      label={`Change ${row.name}`}
                      title={`Change ${row.name}`}
                      subtitle={vendorKindLabel(kindOf)}
                      size="xl"
                      discardPrompt="Throw away the changes to this vendor? Nothing has been saved yet."
                    >
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Edit this vendor</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Changes reach every past record too — right for a new phone number,
                            wrong for a different company. If this is really somebody else,
                            retire this row and add the new counterparty below.
                          </p>
                          <ActionForm
                            action={updateVendor}
                            submitLabel="Save this vendor"
                            disabled={!allowed || isVoid}
                            disabledNote={
                              isVoid
                                ? 'This vendor is void. A void row is kept as a record and is not edited.'
                                : allowed
                                  ? undefined
                                  : REFUSAL
                            }
                          >
                            <input type="hidden" name="id" value={row.id} />
                            {fields(row, `edit-${row.id}`)}
                          </ActionForm>
                        </div>

                        {/*
                          Retire and void used to be two full paragraphs and two
                          headings -- most of why this sheet scrolled. They are one
                          decision, stop using this vendor, with two answers: might
                          you use them again (retire, reversible) or should the row
                          never have existed (void, permanent, and does not free the
                          name). Read as one section.
                        */}
                        <div>
                          <h3 className="t-small font-semibold">Stop using this vendor</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Retire keeps the row and every record against it — for a supplier
                            that closed or a sub you no longer use. Void is only for a row that
                            should never have existed, and does not free the name.
                          </p>
                          <RowAction
                            action={setVendorActive}
                            label={row.isActive ? 'Retire this vendor' : 'Bring them back'}
                            destructive={row.isActive}
                            disabled={!allowed || isVoid}
                            fields={{ id: row.id, isActive: row.isActive ? 'false' : 'true' }}
                            confirm={
                              row.isActive
                                ? `Retire ${row.name}? They stop being offered on new work. Nothing already recorded against them changes.`
                                : undefined
                            }
                          />

                          {isVoid ? (
                            <p className="mt-3 max-w-prose t-small text-subtle">
                              Voided: {row.voidReason ?? 'No reason was recorded.'}
                            </p>
                          ) : (
                            <ActionForm
                              action={voidVendor}
                              submitLabel="Void this vendor"
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
                                hint="Kept on the record permanently."
                                disabled={!mayVoid}
                                wide
                              />
                            </ActionForm>
                          )}
                        </div>
                      </div>
                    </SheetButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}

      {subcontractors > 0 ? (
        <p className="mt-3 max-w-prose t-small text-subtle">
          {subcontractors} of these {subcontractors === 1 ? 'is a subcontractor' : 'are subcontractors'}
          — each needs a T5018 filed and current WSIB clearance before being paid.
        </p>
      ) : null}
    </div>
  );
}
