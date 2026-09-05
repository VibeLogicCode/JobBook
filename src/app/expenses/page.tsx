import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db/client';
import {
  costCodes, expenseTaxes, expenses, organization, projects, taxRates, vendors,
} from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import { createExpense, createMileage, voidExpense } from '@/app/expenses/actions';
import { BulkGrid } from '@/app/expenses/BulkGrid';
import {
  PAYMENT_METHODS,
  RECEIPT_MAX_BYTES,
  expenseStatusLabel,
  formatDistance,
  formatRatePerKm,
  mileageSummary,
  paymentMethodLabel,
} from '@/app/expenses/schema';
import { formatBytes } from '@/app/settings/identity/logo/logo';
import { ActionForm } from '@/components/settings/ActionForm';
import {
  CheckboxField,
  FieldGrid,
  type Option,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/settings/Fields';
import { Card } from '@/components/ui/Card';
import { FilterBar, NoMatches } from '@/components/ui/FilterBar';
import { MetricCard } from '@/components/ui/MetricCard';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { normalizeSearch, searchCondition } from '@/lib/list/search';
import { formatCents } from '@/lib/money/format';
import { tenantToday } from '@/lib/quote/dates';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the expense list but not add to it.';

const KIND_OPTIONS = [
  { value: 'purchase', label: 'Purchases' },
  { value: 'mileage', label: 'Mileage' },
];

/**
 * What a job cost: the receipts, the subcontractors' invoices, and the driving.
 *
 * **Why a route of its own rather than a panel on the project screen.** Spend
 * is entered in the two shapes a project page cannot serve. One is the
 * kitchen-table catch-up -- forty receipts, several jobs, one sitting -- which
 * wants a list it can filter and a grid it can type into. The other is one
 * receipt photographed on site, which wants a form reachable in two taps from
 * anywhere. A panel three screens into a project record is neither. Filtering
 * this list by job (`?project=…`) is what gives the project view its answer,
 * and the URL is the state, so that view is a link somebody can be sent.
 *
 * The cost-code summary appears only once a job is chosen, deliberately: cost
 * codes across every job at once is a company report, and this screen is about
 * a job.
 */
export default async function ExpensesPage({
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
  const kind = one('kind') === 'purchase' || one('kind') === 'mileage' ? one('kind') : '';
  const projectFilter = one('project');
  const showVoided = one('voided') === '1';

  const state = await resolveActor();
  const allowed = state.actor ? can(state.actor.role, 'quote:write') : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') : false;

  const [org] = await db
    .select({
      locale: organization.locale,
      currency: organization.currency,
      mileageRate: organization.mileageRatePerKmTenThou,
    })
    .from(organization)
    .where(eq(organization.id, 1));

  const money = { locale: org?.locale ?? 'en-CA', currencyCode: org?.currency ?? 'CAD' };
  const today = await db.transaction((tx) => tenantToday(tx));

  const projectRows = await db
    .select({
      id: projects.id,
      name: projects.name,
      number: projects.projectNumber,
      stage: projects.stage,
    })
    .from(projects)
    .where(ne(projects.recordStatus, 'void'))
    .orderBy(desc(projects.projectNumber));

  const projectOptions: Option[] = projectRows.map((row) => ({
    value: row.id,
    label: `${row.number} — ${row.name}`,
  }));

  const vendorRows = await db
    .select({ id: vendors.id, name: vendors.name, isActive: vendors.isActive })
    .from(vendors)
    .where(ne(vendors.recordStatus, 'void'))
    .orderBy(asc(vendors.name));

  const vendorOptions: Option[] = vendorRows.map((row) => ({
    value: row.id,
    label: row.isActive ? row.name : `${row.name} (retired)`,
  }));

  const codeRows = await db
    .select({
      id: costCodes.id,
      code: costCodes.code,
      name: costCodes.name,
      isActive: costCodes.isActive,
    })
    .from(costCodes)
    .where(ne(costCodes.recordStatus, 'void'))
    .orderBy(asc(costCodes.code));

  const codeOptions: Option[] = codeRows.map((row) => ({
    value: row.id,
    label: `${row.code} — ${row.name}${row.isActive ? '' : ' (retired)'}`,
  }));

  // The taxes the form offers. In force TODAY, because that is what a form
  // rendered today can know; the action resolves each against the rate that
  // was in force on the receipt's own date before it snapshots one.
  const rateRows = await db
    .select({
      id: taxRates.id,
      label: taxRates.label,
      rateTenThou: taxRates.rateTenThou,
      effectiveFrom: taxRates.effectiveFrom,
      effectiveTo: taxRates.effectiveTo,
    })
    .from(taxRates)
    .where(and(eq(taxRates.recordStatus, 'active'), eq(taxRates.isActive, true)))
    .orderBy(asc(taxRates.sortOrder));

  const inForce = rateRows.filter(
    (row) => row.effectiveFrom <= today && (row.effectiveTo === null || row.effectiveTo >= today),
  );

  const search = searchCondition(q, [
    expenses.description,
    expenses.reference,
    expenses.notes,
    expenses.vendorTaxNumberCaptured,
  ]);

  const rows = await db
    .select({
      id: expenses.id,
      kind: expenses.kind,
      expenseDate: expenses.expenseDate,
      description: expenses.description,
      reference: expenses.reference,
      subtotalCents: expenses.subtotalCents,
      taxTotalCents: expenses.taxTotalCents,
      totalCents: expenses.totalCents,
      paymentMethod: expenses.paymentMethod,
      receiptFileId: expenses.receiptFileId,
      vendorTaxNumberCaptured: expenses.vendorTaxNumberCaptured,
      status: expenses.status,
      isBillable: expenses.isBillable,
      distanceMilli: expenses.distanceMilli,
      ratePerKmTenThou: expenses.ratePerKmTenThou,
      recordStatus: expenses.recordStatus,
      voidReason: expenses.voidReason,
      projectId: expenses.projectId,
      projectName: projects.name,
      projectNumber: projects.projectNumber,
      vendorName: vendors.name,
      costCodeId: expenses.costCodeId,
      costCode: costCodes.code,
      costCodeName: costCodes.name,
    })
    .from(expenses)
    .innerJoin(projects, eq(projects.id, expenses.projectId))
    .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
    .leftJoin(costCodes, eq(costCodes.id, expenses.costCodeId))
    .where(
      and(
        search,
        kind === '' ? undefined : eq(expenses.kind, kind as 'purchase' | 'mileage'),
        projectFilter === '' ? undefined : eq(expenses.projectId, projectFilter),
        showVoided ? undefined : eq(expenses.recordStatus, 'active'),
      ),
    )
    .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt));

  // Counted separately rather than filtered out of `rows`, so the reveal
  // control can say how many are behind it. A list that quietly drops records
  // is one the owner reads as having lost them.
  const [hidden] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(expenses)
    .where(
      and(
        eq(expenses.recordStatus, 'void'),
        projectFilter === '' ? undefined : eq(expenses.projectId, projectFilter),
      ),
    );
  const hiddenCount = hidden?.count ?? 0;

  const live = rows.filter((row) => row.recordStatus === 'active');
  const spend = live.reduce((total, row) => total + row.totalCents, 0);
  const mileageCost = live
    .filter((row) => row.kind === 'mileage')
    .reduce((total, row) => total + row.totalCents, 0);

  /**
   * Tax the company can claim back, summed from `expense_taxes` and not from
   * `expenses.tax_total_cents`.
   *
   * The two are different figures and the difference is the entire reason the
   * child table exists: `is_recoverable` is per tax, so a receipt carrying a
   * claimable HST and a non-claimable levy contributes only half its tax here.
   * Reading the header total instead would report an input tax credit larger
   * than the one the company is entitled to, which is the wrong direction to
   * be wrong in.
   */
  const [recoverable] = await db
    .select({ cents: sql<number>`coalesce(sum(${expenseTaxes.taxAmountCents}), 0)::int` })
    .from(expenseTaxes)
    .innerJoin(expenses, eq(expenses.id, expenseTaxes.expenseId))
    .where(
      and(
        eq(expenseTaxes.isRecoverable, true),
        eq(expenseTaxes.recordStatus, 'active'),
        eq(expenses.recordStatus, 'active'),
        projectFilter === '' ? undefined : eq(expenses.projectId, projectFilter),
      ),
    );
  const recoverableCents = recoverable?.cents ?? 0;

  /** Spend on the chosen job, grouped the way a costing question asks it. */
  const byCode = new Map<string, { label: string; cents: number; count: number }>();
  if (projectFilter !== '') {
    for (const row of live) {
      const key = row.costCodeId ?? 'none';
      const label =
        row.costCode === null ? 'Not coded yet' : `${row.costCode} — ${row.costCodeName}`;
      const existing = byCode.get(key) ?? { label, cents: 0, count: 0 };
      existing.cents += row.totalCents;
      existing.count += 1;
      byCode.set(key, existing);
    }
  }
  const codeGroups = [...byCode.values()].sort((a, b) => a.label.localeCompare(b.label));

  const chosenProject = projectRows.find((row) => row.id === projectFilter);

  /* ---------------------------------------------------------------------
     Forms
     --------------------------------------------------------------------- */

  const noProjects = projectOptions.length === 0;

  function purchaseForm() {
    return (
      <ActionForm
        action={createExpense}
        submitLabel="Record this expense"
        // Not "Saving…": a photograph crossing the wire is the one control
        // here whose wait is long enough to be noticed and pressed twice.
        pendingLabel="Uploading…"
        disabled={!allowed || noProjects}
        disabledNote={
          noProjects
            ? 'There are no jobs to cost this against yet. Add a project first.'
            : state.actor
              ? REFUSAL
              : (state.reason ?? undefined)
        }
        resetOnSuccess
      >
        <FieldGrid>
          <SelectField
            idPrefix="new-expense"
            name="projectId"
            label="Job"
            required
            defaultValue={projectFilter}
            options={projectOptions}
            blankLabel="Choose the job"
            disabled={!allowed}
            hint="Required. An expense with no job never reaches job costing, which is the whole reason for recording it."
          />
          <TextField
            idPrefix="new-expense"
            name="expenseDate"
            label="Date"
            type="date"
            required
            defaultValue={today}
            disabled={!allowed}
            hint="The date on the receipt, not today. Six weeks of paper typed in one evening otherwise lands in one filing period."
          />
          <SelectField
            idPrefix="new-expense"
            name="vendorId"
            label="Vendor"
            defaultValue=""
            options={vendorOptions}
            blankLabel="Nobody on the list"
            disabled={!allowed}
            hint="Who was paid. If they are not on the list, add them under Vendors — one counterparty is one row, and a typed name is how a T5018 total ends up split three ways."
          />
          <SelectField
            idPrefix="new-expense"
            name="costCodeId"
            label="Cost code"
            defaultValue=""
            options={codeOptions}
            blankLabel="Not coded yet"
            disabled={!allowed}
            hint="How the spend is categorised. Blank is allowed and can be set later, but uncoded spend shows as its own group on the job."
          />
          <TextField
            idPrefix="new-expense"
            name="description"
            label="Description"
            required
            maxLength={500}
            disabled={!allowed}
            wide
            hint="What was bought. A figure with no words beside it is unreadable a year later, which is exactly when somebody reads it."
          />
          <TextField
            idPrefix="new-expense"
            name="subtotal"
            label="Subtotal"
            numeric
            inputMode="decimal"
            maxLength={20}
            disabled={!allowed}
            hint="Before tax, as printed. A return or a credit is typed as a negative — (45.00) or -45.00 both read that way."
          />
          <TextField
            idPrefix="new-expense"
            name="reference"
            label="Receipt number"
            maxLength={100}
            disabled={!allowed}
            hint="What the paper calls itself, when it calls itself anything."
          />
          <SelectField
            idPrefix="new-expense"
            name="paymentMethod"
            label="Paid by"
            defaultValue=""
            options={PAYMENT_METHODS.map((method) => ({
              value: method.value,
              label: method.label,
            }))}
            blankLabel="Not said"
            disabled={!allowed}
            hint="How the money left, which is a different question from how the spend is coded. On account means it has not left yet — that is the row the payables view will read."
          />

          <div className="sm:col-span-2">
            <h3 className="t-heading mt-2">Tax</h3>
            <p className="mt-1 max-w-prose t-small text-muted">
              Typed from the receipt rather than calculated from the subtotal: the paper is the
              evidence, and where the two disagree it is the paper that a claim rests on. Each
              tax is recorded separately because an input tax credit is claimed per tax, not per
              receipt.
            </p>
          </div>

          {inForce.length === 0 ? (
            <div className="sm:col-span-2">
              <Notice tone="info">
                No tax rate is configured, so there is nowhere to record tax against. The
                subtotal will be the whole of this expense. Tax rates live under Settings.
              </Notice>
            </div>
          ) : null}

          {inForce.map((row) => (
            <TextField
              key={row.id}
              idPrefix="new-expense"
              name={`tax_${row.id}`}
              label={`${row.label} paid`}
              numeric
              inputMode="decimal"
              maxLength={20}
              disabled={!allowed}
              hint="Leave blank if the receipt carries none."
            />
          ))}
          {inForce.map((row) => (
            <CheckboxField
              key={`recoverable-${row.id}`}
              idPrefix="new-expense"
              name={`recoverable_${row.id}`}
              label={`This ${row.label} is recoverable`}
              defaultChecked
              disabled={!allowed}
              hint="Untick it for spend that was never a business input. It decides whether this tax counts toward what the company claims back."
            />
          ))}

          <div className="sm:col-span-2">
            <h3 className="t-heading mt-2">Evidence and treatment</h3>
          </div>

          <TextField
            idPrefix="new-expense"
            name="vendorTaxNumberCaptured"
            label="Tax number on the receipt"
            maxLength={60}
            disabled={!allowed}
            hint="Copied from the paper, on purpose — not looked up from the vendor record. A registration can change or lapse, and a credit over $30 is evidenced by what the receipt said on the day."
          />
          <CheckboxField
            idPrefix="new-expense"
            name="isBillable"
            label="Bill this on to the customer"
            disabled={!allowed}
            hint="For cost-plus and time-and-material work, and for spend against an allowance. Off by default: a cost you have to remember to bill is a smaller problem than an invoice that grew a line nobody decided on."
          />

          <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
            <label htmlFor="new-expense-receipt" className="t-small font-semibold">
              Receipt
            </label>
            <input
              id="new-expense-receipt"
              name="receipt"
              type="file"
              accept="image/png,image/jpeg"
              capture="environment"
              disabled={!allowed}
              aria-describedby="new-expense-receipt-hint"
              className={`field ${allowed ? '' : 'opacity-60'}`}
            />
            <p id="new-expense-receipt-hint" className="t-small text-subtle">
              A photograph of the paper, up to{' '}
              <span className="num">{formatBytes(RECEIPT_MAX_BYTES)}</span>. On a phone this opens
              the camera. The file is identified by its contents rather than its name, so renaming
              something .jpg will not get it past this, and it is served back only as the type it
              actually is. A PDF is not accepted yet — photograph the paper instead.
            </p>
          </div>

          <TextAreaField
            idPrefix="new-expense"
            name="notes"
            label="Notes"
            rows={2}
            disabled={!allowed}
            hint="Anything the next person needs. Not printed anywhere a customer sees."
          />
        </FieldGrid>
      </ActionForm>
    );
  }

  function mileageForm() {
    return (
      <ActionForm
        action={createMileage}
        submitLabel="Record this trip"
        disabled={!allowed || noProjects}
        disabledNote={
          noProjects
            ? 'There are no jobs to cost this against yet. Add a project first.'
            : state.actor
              ? REFUSAL
              : (state.reason ?? undefined)
        }
        resetOnSuccess
      >
        <Notice tone="info">
          This trip will be costed at{' '}
          <span className="num">
            {formatRatePerKm(org?.mileageRate ?? 0n, money)}
          </span>{' '}
          per kilometre, and that rate is stored on the entry. Changing it under Settings sets
          what the <em>next</em> trip costs and leaves every trip already logged exactly as it
          is — a per-kilometre allowance moves most years, and a trip driven this year has to go
          on costing what this year cost.
        </Notice>
        <FieldGrid>
          <SelectField
            idPrefix="new-mileage"
            name="projectId"
            label="Job"
            required
            defaultValue={projectFilter}
            options={projectOptions}
            blankLabel="Choose the job"
            disabled={!allowed}
          />
          <TextField
            idPrefix="new-mileage"
            name="expenseDate"
            label="Date"
            type="date"
            required
            defaultValue={today}
            disabled={!allowed}
          />
          <TextField
            idPrefix="new-mileage"
            name="distance"
            label="Distance"
            numeric
            inputMode="decimal"
            maxLength={12}
            required
            suffix="km"
            disabled={!allowed}
            hint="Return trip if that is what you drove. Three decimal places at most."
          />
          <SelectField
            idPrefix="new-mileage"
            name="costCodeId"
            label="Cost code"
            defaultValue=""
            options={codeOptions}
            blankLabel="Not coded yet"
            disabled={!allowed}
          />
          <TextField
            idPrefix="new-mileage"
            name="description"
            label="What the trip was for"
            required
            maxLength={500}
            disabled={!allowed}
            wide
            hint="Site visit, material run, inspection. The purpose is what makes the allowance defensible if it is ever asked about."
          />
          <TextAreaField
            idPrefix="new-mileage"
            name="notes"
            label="Notes"
            rows={2}
            disabled={!allowed}
          />
        </FieldGrid>
        <Notice tone="warning">
          Mileage is a cost and never a charge. It moves the margin on the job and it does not
          appear on anything the customer is sent, which is why this form asks for no vendor, no
          receipt and no tax — there is none of any of them.
        </Notice>
      </ActionForm>
    );
  }

  /**
   * Eight rows, one job, one submit.
   *
   * A client component, uniquely on this screen, and `BulkGrid` says why: a
   * refused batch must not throw away what was typed into it, and React
   * resets an uncontrolled form once its action completes.
   */
  function bulkForm() {
    return (
      <BulkGrid
        allowed={allowed && !noProjects}
        disabledNote={
          noProjects
            ? 'There are no jobs to cost these against yet. Add a project first.'
            : state.actor
              ? REFUSAL
              : (state.reason ?? undefined)
        }
        today={today}
        projectOptions={projectOptions}
        vendorOptions={vendorOptions}
        codeOptions={codeOptions}
        taxOptions={inForce.map((row) => ({ value: row.id, label: row.label }))}
        defaultProjectId={projectFilter}
      />
    );
  }

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        title="Expenses"
        description="What each job actually cost: the receipts, the subcontractors, and the driving. Every dollar recorded here lands against a job and a cost code on the day it was spent, so a year end is an export rather than an archaeology project."
        actions={
          <>
            <SheetButton
              trigger="Add expense"
              variant="primary"
              label="Record an expense"
              title="Record an expense"
              subtitle="One receipt, with the paper attached."
              size="lg"
              discardPrompt="Throw away this expense? Nothing has been saved yet."
            >
              {purchaseForm()}
            </SheetButton>
            <SheetButton
              trigger="Log mileage"
              label="Log mileage"
              title="Log mileage"
              subtitle="Distance driven on a job, costed at the rate in force today."
              size="lg"
              discardPrompt="Throw away this trip? Nothing has been saved yet."
            >
              {mileageForm()}
            </SheetButton>
            <SheetButton
              trigger="Bulk entry"
              label="Enter several expenses"
              title="Enter several expenses"
              subtitle="Eight rows, one job, one submit — for a run of paper at a table."
              size="xl"
              discardPrompt="Throw away these rows? Nothing has been saved yet."
            >
              {bulkForm()}
            </SheetButton>
          </>
        }
      />

      {state.actor ? null : (
        <div className="mb-3">
          <Notice tone="warning">{state.reason}</Notice>
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard
          label={chosenProject ? 'Cost on this job' : 'Cost shown'}
          from="the expenses below"
          value={<Money cents={spend} plain />}
          secondary={`${live.length} ${live.length === 1 ? 'entry' : 'entries'}`}
        />
        <MetricCard
          label="Of that, mileage"
          from="trips logged"
          value={<Money cents={mileageCost} plain />}
          secondary="A cost only. It never appears on anything the customer is sent."
        />
        <MetricCard
          label="Recoverable tax"
          from="the tax lines marked recoverable"
          value={<Money cents={recoverableCents} plain />}
          secondary="Not the tax total: a tax that was never a business input is not claimable, and only the ones ticked count here."
        />
      </div>

      <FilterBar
        basePath="/expenses"
        q={q}
        searchLabel="Search expenses"
        searchPlaceholder="Description, receipt number, tax number"
        selects={[
          {
            name: 'project',
            label: 'Job',
            value: projectFilter,
            anyLabel: 'Every job',
            options: projectOptions,
          },
          {
            name: 'kind',
            label: 'Kind',
            value: kind,
            anyLabel: 'Spend and mileage',
            options: KIND_OPTIONS,
          },
        ]}
        reveal={{
          name: 'voided',
          on: showVoided,
          showLabel: 'Show voided',
          hideLabel: 'Hide voided',
          hiddenCount,
          hiddenNoun: 'voided',
        }}
        shown={rows.length}
        noun={{ singular: 'expense', plural: 'expenses' }}
      />

      {chosenProject && codeGroups.length > 0 ? (
        <div className="mb-4">
          <h2 className="mb-2 t-heading">
            {chosenProject.number} — {chosenProject.name}, by cost code
          </h2>
          <TableWrap minWidth="32rem">
            <thead>
              <tr>
                <th scope="col">Cost code</th>
                <th scope="col">Entries</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {codeGroups.map((group) => (
                <tr key={group.label}>
                  <td data-label="Cost code">{group.label}</td>
                  <AmountCell data-label="Entries">{group.count}</AmountCell>
                  <AmountCell data-label="Cost" cents={group.cents} />
                </tr>
              ))}
              <tr>
                <td data-label="Cost code" className="font-semibold">
                  Total spent
                </td>
                <AmountCell data-label="Entries">{live.length}</AmountCell>
                <AmountCell data-label="Cost" cents={spend} className="font-semibold" />
              </tr>
            </tbody>
          </TableWrap>
          <p className="mt-2 max-w-prose t-small text-subtle">
            Cost only. What this job was quoted, and what remains against it, arrives with the
            job-costing view — this is the half of that answer the expenses can give on their
            own.
          </p>
        </div>
      ) : null}

      {rows.length === 0 ? (
        q !== '' || kind !== '' || projectFilter !== '' ? (
          <NoMatches
            basePath="/expenses"
            q={q}
            noun="expenses"
            describe={[
              chosenProject ? `Job: ${chosenProject.number}` : '',
              kind ? `Kind: ${kind === 'mileage' ? 'Mileage' : 'Purchases'}` : '',
            ].filter((entry) => entry !== '')}
            hint={
              hiddenCount > 0 && !showVoided
                ? 'Voided expenses are hidden by default. The control above brings them back.'
                : undefined
            }
          />
        ) : (
          <Card as="div" className="p-6 text-muted">
            Nothing recorded yet. Start with whatever paper is nearest — a receipt entered today
            is one you do not have to identify in February, and the photograph is what makes a
            credit over $30 claimable once the till roll has faded.
          </Card>
        )
      ) : (
        <TableWrap minWidth="72rem">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Job</th>
              <th scope="col">What</th>
              <th scope="col">Cost code</th>
              <th scope="col">Paid by</th>
              <th scope="col">Subtotal</th>
              <th scope="col">Tax</th>
              <th scope="col">Total</th>
              <th scope="col">Status</th>
              <th scope="col">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const isMileage = row.kind === 'mileage';

              return (
                <tr key={row.id}>
                  <td data-label="Date" className="num">
                    {row.expenseDate}
                  </td>
                  <td data-label="Job" className="t-small text-muted">
                    {row.projectNumber} — {row.projectName}
                  </td>
                  <td data-label="What">
                    {row.description}
                    <span className="block t-small text-subtle">
                      {isMileage
                        ? mileageSummary(row, money)
                        : [row.vendorName, row.reference].filter(Boolean).join(' · ') ||
                          'No vendor recorded'}
                    </span>
                  </td>
                  <td data-label="Cost code" className="t-small text-muted">
                    {row.costCode === null ? 'Not coded' : `${row.costCode} — ${row.costCodeName}`}
                  </td>
                  <td data-label="Paid by" className="t-small text-muted">
                    {isMileage ? 'An allowance, not a payment' : paymentMethodLabel(row.paymentMethod)}
                  </td>
                  <AmountCell data-label="Subtotal" cents={row.subtotalCents} />
                  <AmountCell data-label="Tax" cents={row.taxTotalCents} />
                  <AmountCell data-label="Total" cents={row.totalCents} />
                  <td data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {!isVoid && row.status === 'posted' ? (
                        <Pill tone="positive">{expenseStatusLabel(row.status)}</Pill>
                      ) : null}
                      {!isVoid && row.status !== 'posted' ? (
                        <Pill tone="neutral">{expenseStatusLabel(row.status)}</Pill>
                      ) : null}
                      {isMileage ? <Pill tone="neutral">Mileage</Pill> : null}
                      {row.isBillable ? <Pill tone="info">Billable</Pill> : null}
                      {!isMileage && row.receiptFileId === null ? (
                        // A word, not a colour. A purchase with no photograph
                        // is a credit that cannot be evidenced once the till
                        // roll fades, and the list is where that is cheapest
                        // to notice.
                        <Pill tone="warning">No receipt</Pill>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Manage">
                    <SheetButton
                      trigger="Open…"
                      label={`Open ${row.description}`}
                      title={row.description}
                      subtitle={`${row.expenseDate} · ${row.projectNumber} — ${row.projectName}`}
                      size="lg"
                      discardPrompt="Close this expense?"
                    >
                      <div className="flex flex-col gap-4">
                        {isMileage ? (
                          <div>
                            <h3 className="t-small font-semibold">The trip</h3>
                            <p className="max-w-prose t-small text-subtle">
                              {row.distanceMilli === null
                                ? 'No distance recorded.'
                                : `${formatDistance(row.distanceMilli, money.locale)} driven.`}{' '}
                              Costed at{' '}
                              <span className="num">
                                {row.ratePerKmTenThou === null
                                  ? '—'
                                  : formatRatePerKm(row.ratePerKmTenThou, money)}
                              </span>{' '}
                              per kilometre, which is the rate stored on this entry rather than
                              the one configured today. It is what the rate was when the trip was
                              driven, and it stays that way whatever the allowance does next
                              January.
                            </p>
                          </div>
                        ) : (
                          <div>
                            <h3 className="t-small font-semibold">The receipt</h3>
                            {row.receiptFileId ? (
                              <>
                                <a
                                  href={`/api/files/${row.receiptFileId}`}
                                  className="block w-fit rounded-control border border-line-strong bg-surface-2 p-2"
                                >
                                  {/* A plain img: the optimiser would fetch
                                      through its own loader, and this route is
                                      authenticated because a receipt is tenant
                                      data. The src is the row id and nothing
                                      else — no path, no name, no extension. */}
                                  <img
                                    src={`/api/files/${row.receiptFileId}`}
                                    alt={`The receipt attached to ${row.description}`}
                                    className="max-h-64 w-auto max-w-full"
                                  />
                                </a>
                                <p className="mt-1 max-w-prose t-small text-subtle">
                                  Served as the type its bytes actually are, never the one the
                                  uploader named it.
                                </p>
                              </>
                            ) : (
                              <p className="max-w-prose t-small text-subtle">
                                No photograph was attached. A credit on a purchase over $30 has to
                                be evidenced against the supplier&apos;s registration on the
                                paper, so it is worth photographing before the till roll fades.
                              </p>
                            )}
                            {row.vendorTaxNumberCaptured ? (
                              <p className="mt-1 t-small text-subtle">
                                Tax number as printed:{' '}
                                <span className="num">{row.vendorTaxNumberCaptured}</span>. Copied
                                from the paper rather than read off the vendor record, because
                                that is what the claim rests on.
                              </p>
                            ) : null}
                          </div>
                        )}

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
                              The only correction there is. Nothing here is deleted, so a wrong
                              figure or a receipt coded to the wrong job is voided with a reason
                              and entered again. The row leaves the job&apos;s cost and its tax
                              claim together, in one write.
                            </p>
                            <ActionForm
                              action={voidExpense}
                              submitLabel="Void this expense"
                              pendingLabel="Voiding…"
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

      <p className="mt-3 max-w-prose t-small text-subtle">
        The per-kilometre rate mileage is costed at lives under{' '}
        <Link href="/settings/financial" className="underline">
          Settings, financial and legal
        </Link>
        . Changing it sets what the next trip costs; every trip already logged keeps the rate it
        was driven at.
      </p>
    </div>
  );
}
