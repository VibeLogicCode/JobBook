import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { Camera } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { db } from '@/db/client';
import {
  costCodes, expenseTaxes, expenses, files, organization, paymentMethods, projects, taxRates,
  vendors,
} from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import { createExpense, createMileage, voidExpense } from '@/app/expenses/actions';
import { BulkGrid } from '@/app/expenses/BulkGrid';
import {
  RECEIPT_ACCEPT,
  RECEIPT_MAX_BYTES,
  expenseStatusLabel,
  formatDistance,
  formatRatePerKm,
  mileageSummary,
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
import { Reveal } from '@/components/ui/Reveal';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { isInlineType } from '@/lib/files/sniff';
import { ListMore } from '@/components/ui/ListMore';
import { listLimit, listSlice } from '@/lib/list/paging';
import { normalizeSearch, searchCondition } from '@/lib/list/search';
import { formatCents } from '@/lib/money/format';
import { tenantToday } from '@/lib/quote/dates';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read the expense list but not write to it.';

const KIND_OPTIONS = [
  { value: 'purchase', label: 'Purchases' },
  { value: 'mileage', label: 'Mileage' },
];

/**
 * The browser tab.
 *
 * Plain "Expenses" answers "which screen is this" for the common case, but
 * this screen has a second identity the moment `?project=…` narrows it to one
 * job: several tabs each reading "Expenses" cannot be told apart, and the
 * number is exactly what the page body already leads with once a job is
 * chosen (`PageHeader`'s parent link, the cost-code table's heading). The
 * title says the same thing the screen does.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const params = await searchParams;
  const raw = params.project;
  const projectId = Array.isArray(raw) ? raw[0] : raw;
  if (!projectId) return { title: 'Expenses' };

  const [project] = await db
    .select({ number: projects.projectNumber })
    .from(projects)
    .where(eq(projects.id, projectId));

  return { title: project ? `${project.number} — Expenses` : 'Expenses' };
}

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
  // One capability for both, because entering an expense and retracting one
  // are the same job. `record:void` stays what it is elsewhere -- a quote, a
  // project, a customer -- and is deliberately not consulted here.
  const allowed = state.actor ? can(state.actor.role, 'expense:write') : false;
  const mayVoid = allowed;

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

  const paymentMethodRows = await db
    .select({
      id: paymentMethods.id,
      name: paymentMethods.name,
      isOnAccount: paymentMethods.isOnAccount,
      isActive: paymentMethods.isActive,
    })
    .from(paymentMethods)
    .where(ne(paymentMethods.recordStatus, 'void'))
    .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name));

  // "On account" is not a label here — `isOnAccount` is read straight off the
  // row to grow the hint, so a deployment's own on-account method (a second
  // supplier account, a line of credit) reads the same way this one does,
  // with nothing matching its name.
  const paymentMethodOptions: Option[] = paymentMethodRows.map((row) => ({
    value: row.id,
    label: `${row.name}${row.isOnAccount ? ' — not paid yet' : ''}${row.isActive ? '' : ' (retired)'}`,
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

  /**
   * Capped, over-fetched by one. Every declared index on this table leads with
   * a foreign key, so the unfiltered "everything, newest first" path the screen
   * opens on had nothing to use -- a full scan and a sort of every expense ever
   * entered. `expenses_recent_idx` and this limit are the two halves of that.
   */
  const limit = listLimit(params.limit);

  const fetched = await db
    .select({
      id: expenses.id,
      kind: expenses.kind,
      expenseDate: expenses.expenseDate,
      description: expenses.description,
      reference: expenses.reference,
      subtotalCents: expenses.subtotalCents,
      taxTotalCents: expenses.taxTotalCents,
      totalCents: expenses.totalCents,
      paymentMethodId: expenses.paymentMethodId,
      paymentMethodName: paymentMethods.name,
      receiptFileId: expenses.receiptFileId,
      // Read from the file row rather than assumed from the expense, because a
      // receipt is now a PNG, a JPEG or a PDF and only the first two are
      // rendered into this page. `mime_type` is the store's own sniffed answer,
      // and it is used here to choose a control, never to decide a policy --
      // the serve route consults the allowlist for itself.
      receiptMimeType: files.mimeType,
      receiptFileName: files.fileName,
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
    .leftJoin(paymentMethods, eq(paymentMethods.id, expenses.paymentMethodId))
    .leftJoin(files, eq(files.id, expenses.receiptFileId))
    .where(
      and(
        search,
        kind === '' ? undefined : eq(expenses.kind, kind as 'purchase' | 'mileage'),
        projectFilter === '' ? undefined : eq(expenses.projectId, projectFilter),
        showVoided ? undefined : eq(expenses.recordStatus, 'active'),
      ),
    )
    .orderBy(desc(expenses.expenseDate), desc(expenses.createdAt))
    .limit(limit + 1);

  const { visible: rows, more } = listSlice(fetched, limit);

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
          {/*
            First in the form, deliberately, and full width rather than a
            corner: what actually happens here is the photograph first, the
            figures off it second -- he is standing at a counter or in a van,
            he shoots the receipt, then types what it says. A field further
            down treated the photo as an afterthought to money that had not
            been typed yet.

            Sized well past the 44px floor because this is tapped one-handed,
            outdoors, sometimes with a glove on -- the whole box is the
            target, not just the button drawn inside it. The dashed line is
            this app's own word for "nothing here yet" (the schedule uses it
            for a task with nobody assigned), and it costs nothing extra: it
            is the browser's own empty-file state, so no script has to track
            whether one was chosen, and none does.

            `accept` is the list the action enforces, not a second copy of it.
            `capture` is deliberately gone: it sends a phone straight to the
            camera, which is the wrong door for the supplier PDF sitting in
            the mail app. The camera is still one tap inside the picker.

            The file is identified by its contents rather than its name --
            renaming something .jpg will not get it past the `accept` list --
            and a PDF downloads instead of opening inline, deliberately: a PDF
            can carry script, and one displayed inside this application would
            be running inside it.
          */}
          <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
            <label htmlFor="new-expense-receipt" className="t-small font-semibold">
              Receipt
            </label>
            <div className="relative">
              <Camera
                size={22}
                aria-hidden
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-subtle"
              />
              <input
                id="new-expense-receipt"
                name="receipt"
                type="file"
                accept={RECEIPT_ACCEPT}
                disabled={!allowed}
                aria-describedby="new-expense-receipt-hint"
                className={`field min-h-16 cursor-pointer border-dashed py-3 pl-12 pr-3 file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-control file:border-0 file:bg-accent file:px-4 file:font-semibold file:text-accent-fg hover:file:bg-accent-hover ${allowed ? '' : 'cursor-not-allowed opacity-60'}`}
              />
            </div>
            <p id="new-expense-receipt-hint" className="t-small text-subtle">
              A photo or the supplier&apos;s PDF, up to{' '}
              <span className="num">{formatBytes(RECEIPT_MAX_BYTES)}</span>. PDFs download
              instead of opening here.
            </p>
          </div>

          <SelectField
            idPrefix="new-expense"
            name="projectId"
            label="Job"
            required
            defaultValue={projectFilter}
            options={projectOptions}
            blankLabel="Choose the job"
            disabled={!allowed}
            hint="Needed for job costing to pick this up."
          />
          <TextField
            idPrefix="new-expense"
            name="expenseDate"
            label="Date"
            type="date"
            required
            defaultValue={today}
            disabled={!allowed}
            // A form default of today is easy to mistake for the right
            // answer. Six weeks of paper typed in one evening, all dated
            // today, otherwise lands in one filing period instead of six.
            hint="The date on the receipt, not today."
          />
          <SelectField
            idPrefix="new-expense"
            name="vendorId"
            label="Vendor"
            defaultValue=""
            options={vendorOptions}
            blankLabel="Nobody on the list"
            disabled={!allowed}
            hint="Who was paid. Add them under Vendors first if they aren't listed."
          />
          <SelectField
            idPrefix="new-expense"
            name="costCodeId"
            label="Cost code"
            defaultValue=""
            options={codeOptions}
            blankLabel="Not coded yet"
            disabled={!allowed}
            hint="Optional — uncoded spend shows as its own group on the job."
          />
          <TextField
            idPrefix="new-expense"
            name="description"
            label="Description"
            required
            maxLength={500}
            disabled={!allowed}
            wide
          />
          <TextField
            idPrefix="new-expense"
            name="subtotal"
            label="Subtotal"
            numeric
            inputMode="decimal"
            maxLength={20}
            disabled={!allowed}
            hint="Before tax, as printed. Negative for a return — (45.00) or -45.00 both work."
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
            name="paymentMethodId"
            label="Paid by"
            defaultValue=""
            options={paymentMethodOptions}
            blankLabel="Not said"
            disabled={!allowed}
            hint="How the money left. On account means it hasn't left yet."
          />

          <div className="sm:col-span-2">
            <h3 className="t-heading mt-2">Tax</h3>
            <p className="mt-1 max-w-prose t-small text-muted">
              Typed from the receipt, not calculated — the paper is the evidence. Each tax is
              recorded separately; an ITC is claimed per tax.
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
              hint="Off for spend that wasn't a business input — affects what you can claim back."
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
            hint="Copied from the paper, not the vendor record — it can change or lapse."
          />
          <div className="sm:col-span-2">
            <Reveal label="Why this is copied rather than looked up">
              Evidence for an input tax credit over $30 rests on what the receipt said that day.
            </Reveal>
          </div>
          {/*
            Off by default: a cost somebody has to remember to bill is a
            smaller problem than an invoice that grew a line nobody decided
            on.
          */}
          <CheckboxField
            idPrefix="new-expense"
            name="isBillable"
            label="Bill this on to the customer"
            disabled={!allowed}
            hint="For cost-plus, time-and-material work, or spend against an allowance."
          />

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
            hint="Site visit, material run, inspection."
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
        paymentMethodOptions={paymentMethodOptions}
        taxOptions={inForce.map((row) => ({ value: row.id, label: row.label }))}
        defaultProjectId={projectFilter}
      />
    );
  }

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        // Only when the list is narrowed to one job (`?project=…`): reached
        // from the pipeline that way, this screen is that job's spend and
        // says so; reached from the rail with no filter it belongs to nobody
        // in particular, and a parent link here would invent one.
        parent={
          chosenProject
            ? { href: `/projects/${chosenProject.id}`, label: `${chosenProject.number} · ${chosenProject.name}` }
            : undefined
        }
        title="Expenses"
        description="What each job actually cost: the receipts, the subcontractors, and the driving."
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
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" scope="col">Cost code</th>
                <th role="columnheader" scope="col">Entries</th>
                <th role="columnheader" scope="col">Cost</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {codeGroups.map((group) => (
                <tr role="row" key={group.label}>
                  <td role="cell" data-label="Cost code">{group.label}</td>
                  <AmountCell data-label="Entries">{group.count}</AmountCell>
                  <AmountCell data-label="Cost" cents={group.cents} />
                </tr>
              ))}
              <tr role="row">
                <td role="cell" data-label="Cost code" className="font-semibold">
                  Total spent
                </td>
                <AmountCell data-label="Entries">{live.length}</AmountCell>
                <AmountCell data-label="Cost" cents={spend} className="font-semibold" />
              </tr>
            </tbody>
          </TableWrap>
          <p className="mt-2 max-w-prose t-small text-subtle">
            Cost only — what this job was quoted and what remains lives in job costing.
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
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Date</th>
              <th role="columnheader" scope="col">Job</th>
              <th role="columnheader" scope="col">What</th>
              <th role="columnheader" scope="col">Cost code</th>
              <th role="columnheader" scope="col">Paid by</th>
              <th role="columnheader" scope="col">Subtotal</th>
              <th role="columnheader" scope="col">Tax</th>
              <th role="columnheader" scope="col">Total</th>
              <th role="columnheader" scope="col">Status</th>
              <th role="columnheader" scope="col">Manage</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const isMileage = row.kind === 'mileage';

              return (
                <tr role="row" key={row.id}>
                  <td role="cell" data-label="Date" className="num">
                    {row.expenseDate}
                  </td>
                  <td role="cell" data-label="Job" className="t-small text-muted">
                    {row.projectNumber} — {row.projectName}
                  </td>
                  <td role="cell" data-label="What">
                    {row.description}
                    <span className="block t-small text-subtle">
                      {isMileage
                        ? mileageSummary(row, money)
                        : [row.vendorName, row.reference].filter(Boolean).join(' · ') ||
                          'No vendor recorded'}
                    </span>
                  </td>
                  <td role="cell" data-label="Cost code" className="t-small text-muted">
                    {row.costCode === null ? 'Not coded' : `${row.costCode} — ${row.costCodeName}`}
                  </td>
                  <td role="cell" data-label="Paid by" className="t-small text-muted">
                    {isMileage ? 'An allowance, not a payment' : (row.paymentMethodName ?? '—')}
                  </td>
                  <AmountCell data-label="Subtotal" cents={row.subtotalCents} />
                  <AmountCell data-label="Tax" cents={row.taxTotalCents} />
                  <AmountCell data-label="Total" cents={row.totalCents} />
                  <td role="cell" data-label="Status">
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
                  <td role="cell" data-label="Manage">
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
                              per kilometre — the rate stored on this entry, not today&apos;s rate.
                            </p>
                          </div>
                        ) : (
                          <div>
                            <h3 className="t-small font-semibold">The receipt</h3>
                            {row.receiptFileId ? (
                              <>
                                {isInlineType(row.receiptMimeType ?? '') ? (
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
                                ) : (
                                  // Not an <img>, and not an <embed> either. A
                                  // PDF is stored and never rendered by this
                                  // application, so the only control that tells
                                  // the truth about it is a link the browser
                                  // downloads.
                                  <a
                                    href={`/api/files/${row.receiptFileId}`}
                                    className="inline-block w-fit rounded-control border border-line-strong bg-surface-2 px-3 py-2 t-small font-semibold"
                                  >
                                    Download {row.receiptFileName ?? 'the receipt'}
                                  </a>
                                )}
                                <p className="mt-1 max-w-prose t-small text-subtle">
                                  Served as the type its bytes actually are, never the name it
                                  was uploaded under.
                                  {isInlineType(row.receiptMimeType ?? '')
                                    ? ''
                                    : ' PDFs download rather than open here.'}
                                </p>
                              </>
                            ) : (
                              <p className="max-w-prose t-small text-subtle">
                                No photograph attached. A credit over $30 needs the supplier&apos;s
                                registration on the receipt.
                              </p>
                            )}
                            {row.vendorTaxNumberCaptured ? (
                              <p className="mt-1 t-small text-subtle">
                                Tax number as printed:{' '}
                                <span className="num">{row.vendorTaxNumberCaptured}</span>. Copied
                                from the paper, not the vendor record.
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
                              Nothing here is deleted — a wrong figure or the wrong job is voided
                              with a reason and entered again.
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
                                hint="Kept on the record permanently."
                                disabled={!mayVoid}
                                wide
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

      <ListMore more={more} shown={rows.length} limit={limit} noun="expenses" params={params} />

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
