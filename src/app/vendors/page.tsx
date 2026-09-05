import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { costCodes, organization, vendors } from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import {
  createVendor,
  setVendorActive,
  updateVendor,
  voidVendor,
} from '@/app/vendors/actions';
import { paymentTermsLabel, vendorKindLabel } from '@/app/vendors/schema';
import { ActionForm, RowAction } from '@/components/settings/ActionForm';
import {
  CheckboxField,
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
import { SheetButton } from '@/components/ui/Sheet';
import { TableWrap } from '@/components/ui/Table';
import { normalizeSearch, searchCondition } from '@/lib/list/search';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the vendor list but not change it.';

type VendorRow = typeof vendors.$inferSelect;

const KIND_OPTIONS = [
  { value: 'subcontractor', label: 'Subcontractors' },
  { value: 'supplier', label: 'Suppliers' },
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

  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'rates:edit') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  const search = searchCondition(q, [
    vendors.name,
    vendors.legalName,
    vendors.contactName,
    vendors.trade,
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
            hint="What you call them. One counterparty is one row — if they are already on the list under another spelling, edit that one rather than adding a second."
          />
          <TextField
            idPrefix={prefix}
            name="legalName"
            label="Legal name"
            maxLength={200}
            defaultValue={row?.legalName}
            disabled={disabled}
            hint="The name on the cheque, if it differs. This is the one a T5018 slip carries."
          />
          <CheckboxField
            idPrefix={prefix}
            name="isSubcontractor"
            label="This is a subcontractor"
            defaultChecked={row?.isSubcontractor ?? false}
            disabled={disabled}
            wide
            hint="Tick it for somebody who performs work, not for somewhere you buy materials. Three things follow and nothing else sets them: they receive a T5018 slip, their WSIB clearance is checked before they are paid, and they appear when work is assigned on a schedule."
          />
          <TextField
            idPrefix={prefix}
            name="trade"
            label="Trade"
            maxLength={120}
            defaultValue={row?.trade}
            disabled={disabled}
            hint="How you would describe them when looking for one — framer, drywall, electrical. Not the same as the cost code below."
          />
          <SelectField
            idPrefix={prefix}
            name="defaultCostCodeId"
            label="Usual cost code"
            defaultValue={row?.defaultCostCodeId ?? ''}
            options={costCodeOptions(row)}
            blankLabel="None — code each receipt as it arrives"
            disabled={disabled}
            hint="Proposed on an expense, never imposed. Changing it later does not recode anything already recorded."
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
            hint="Net days. Leave it blank if nothing was agreed; 0 is cash on delivery, which is a different fact."
          />
          <TextField
            idPrefix={prefix}
            name="businessNumber"
            label="Business number"
            maxLength={60}
            defaultValue={row?.businessNumber}
            disabled={disabled}
            hint="The CRA business number, and the T5018 requirement. Ask for it the day they are hired — chasing it in February from somebody who finished in August is how a filing gets late."
          />
          <TextField
            idPrefix={prefix}
            name="taxRegistrationNumber"
            label="Tax registration number"
            maxLength={60}
            defaultValue={row?.taxRegistrationNumber}
            disabled={disabled}
            hint="A different number from the one beside it. This is what an input tax credit on a receipt over $30 is evidenced against; a supplier who is not registered has none, and charges no tax."
          />
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

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        title="Vendors"
        description="Everyone you pay: the suppliers you buy from and the subcontractors you hire. Every expense and every scheduled task will point at a row here, so one counterparty being one row is the whole value of the list."
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
            describe={kind ? [`Kind: ${kind === 'subcontractor' ? 'Subcontractors' : 'Suppliers'}`] : []}
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

              return (
                <tr key={row.id}>
                  <td data-label="Name">
                    {row.name}
                    {row.legalName && row.legalName !== row.name ? (
                      <span className="block t-small text-subtle">{row.legalName}</span>
                    ) : null}
                  </td>
                  <td data-label="Kind" className="t-small text-muted">
                    {vendorKindLabel(row)}
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
                      subtitle={vendorKindLabel(row)}
                      size="xl"
                      discardPrompt="Throw away the changes to this vendor? Nothing has been saved yet."
                    >
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Edit this vendor</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            A change reaches everything already recorded against them, past
                            work included — which is right for a new phone number and wrong
                            for a different company. If this row now points at somebody else,
                            retire it and add the new counterparty below.
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

                        <div>
                          <h3 className="t-small font-semibold">
                            {row.isActive ? 'Retire' : 'Bring back'}
                          </h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Retiring stops them being offered on new work — a supplier that
                            closed, a sub you no longer use. It is not a deletion and not a
                            void: the row stays, the name stays taken, and every expense,
                            payment and assignment already recorded against them goes on
                            naming them.
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
                              For a row that should never have existed — a name typed twice, a
                              vendor added against the wrong company. It is not how you stop
                              using somebody; that is Retire, above. Voiding does not free the
                              name, so a corrected record needs a name of its own.
                            </p>
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
                                disabled={!mayVoid}
                                wide
                                hint="Recorded on the row. A void with no reason teaches nobody anything a year later."
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
      )}

      {subcontractors > 0 ? (
        <p className="mt-3 max-w-prose t-small text-subtle">
          {subcontractors} of these {subcontractors === 1 ? 'is a subcontractor' : 'are subcontractors'}.
          A T5018 is filed for each of them, and each needs current WSIB clearance before they
          are paid — which is the gate this list is being built for.
        </p>
      ) : null}
    </div>
  );
}
