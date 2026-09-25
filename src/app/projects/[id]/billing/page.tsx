import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { cache } from 'react';
import { db } from '@/db/client';
import { customers, organization, projects } from '@/db/schema';
import { IssueForm } from '@/app/projects/[id]/billing/IssueForm';
import { DetailList, DetailRow, EmptyState } from '@/components/detail/Panel';
import { Field, SelectField } from '@/components/detail/Fields';
import { tenantIsoToday } from '@/components/detail/dates';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill, type Tone } from '@/components/ui/Pill';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { holdbackOutstandingCents, holdbackReleaseEligibleDate } from '@/lib/invoice/holdback';
import { companyOf } from '@/lib/company/load';
import { formatPercent, resolvePercentTenThou, type BillingKind } from '@/lib/invoice/percent';
import {
  jobBillingState,
  jobContract,
  listProjectInvoices,
  previewInvoice,
  type InvoicePreview,
  type InvoiceSummary,
} from '@/lib/invoice/repository';
import type { InvoiceKind } from '@/lib/invoice/types';
import { formatCents } from '@/lib/money/format';
import { isUuid } from '@/lib/ids';

/**
 * Billing a job.
 *
 * The one screen that turns work into money owed, and the one place three
 * rules have to be visible rather than merely obeyed:
 *
 *  1. A JOB is a project with an accepted quote behind it. There is no `jobs`
 *     table; the accepted, active quotes ARE the contract. An opportunity
 *     reaches this screen and is told why it cannot be billed.
 *  2. CONTRACT VALUE IS DERIVED and, here, PRE-TAX. Progress billing
 *     multiplies it and then charges tax on the result, so the tax-inclusive
 *     figure the job screen shows would charge tax on tax once per draw. The
 *     figure below is labelled "before tax" for that reason and no other.
 *  3. TAX ON A HOLDBACK IS NOT PAYABLE UNTIL THE HOLDBACK IS (Excise Tax Act
 *     s.168(7)). The taxable base is the draw MINUS the withholding, and the
 *     preview prints that subtraction as its own row rather than folding it
 *     into a total, because it is the line an accountant checks.
 *
 * Nothing on this page is stored. The preview is priced by the same function
 * the commit prices with and is then thrown away; pressing the button derives
 * every figure again inside the writing transaction.
 */

import { INVOICE_KINDS } from '@/lib/invoice/labels';

export const dynamic = 'force-dynamic';

/**
 * A subtraction row's figure, without ever printing `-$0.00`.
 *
 * `Intl` signs negative zero, so `-previouslyBilled` on the first draw of a job
 * renders as a debit of nothing -- which reads as a rendering fault beside
 * three figures that are right. `parseAmountToCents` refuses to produce a
 * negative zero for the same reason; this is that rule on the way out.
 */
function negated(cents: number): number {
  return cents === 0 ? 0 : -cents;
}

const INVOICE_STATUS: Record<InvoiceSummary['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'accent' },
  sent: { label: 'Sent', tone: 'info' },
  partial: { label: 'Part paid', tone: 'warning' },
  paid: { label: 'Paid', tone: 'positive' },
};

/**
 * The job this contract is billed against. `cache()`-wrapped so
 * `generateMetadata` and the page share this one read.
 */
const loadBillingJob = cache(async (projectId: string) => {
  const [job] = await db
    .select({
      project: projects,
      customerName: customers.name,
      customerCompany: customers.companyName,
    })
    .from(projects)
    .innerJoin(customers, eq(projects.customerId, customers.id))
    .where(eq(projects.id, projectId));

  return job ?? null;
});

/** "Billing", not the job's name first: every job's billing tab reads the same, and the job it belongs to is the part that changes. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (!isUuid(id)) return { title: 'Billing' };
  try {
    const job = await loadBillingJob(id);
    return { title: job ? `Billing — ${job.project.projectNumber}` : 'Billing' };
  } catch {
    return { title: 'Billing' };
  }
}

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ kind?: string; percent?: string; issue?: string; issued?: string }>;
}) {
  const { id: projectId } = await params;
  // A malformed id is a wrong URL, not a server fault: Postgres rejects a
  // non-uuid outright, so without this the answer to a typo is a 500.
  if (!isUuid(projectId)) notFound();

  const { kind: rawKind, percent: rawPercent, issue: rawIssue, issued } = await searchParams;

  const job = await loadBillingJob(projectId);
  if (!job) notFound();
  const { project } = job;

  /**
   * Both rows, because this screen reads one field from each.
   *
   * `timezone` is the deployment's -- two companies in one office cannot
   * disagree about what today is. `holdbackReleaseDays` and
   * `taxDeferredOnHoldback` are the ISSUER's: the release clock and the Excise
   * Tax Act s.168(7) position belong to the corporation billing the job, and
   * reading them from a fixed row told a reader about the other company's
   * terms on this company's invoice.
   */
  const [org] = await db.select({ timezone: organization.timezone }).from(organization)
    .where(eq(organization.id, 1));
  const company = await companyOf(db, projectId);
  const today = tenantIsoToday(org?.timezone ?? 'UTC');

  const contract = await jobContract(projectId);
  const isJob = contract.acceptedQuoteCount > 0;
  const billable = isJob && project.recordStatus === 'active';

  const state = await jobBillingState(projectId);
  const invoices = await listProjectInvoices(projectId);

  const outstandingHoldbackCents = holdbackOutstandingCents(state);
  const leftToBillCents = contract.subtotalCents - state.previouslyBilledCents;
  // Guarded against a contract of zero, which is a job whose accepted quote
  // prices nothing: a meter dividing by it would render NaN percent.
  const billedPct =
    contract.subtotalCents === 0
      ? 0
      : (state.previouslyBilledCents / contract.subtotalCents) * 100;

  /**
   * What the person asked for, if they have asked for anything yet.
   *
   * The request lives in the query string rather than in component state, so
   * the whole preview is server-rendered and works with no JavaScript at all:
   * a plain GET form navigates here, and the figures below are computed by the
   * same engine that will bill them -- never by a copy of the arithmetic
   * running in the browser, which is how two figures that must agree start
   * disagreeing.
   */
  const asked = rawKind !== undefined || rawPercent !== undefined;
  const kind: BillingKind = rawKind === 'final' ? 'final' : 'progress';
  const percentText = rawPercent ?? '';
  const issueDate =
    rawIssue !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(rawIssue) ? rawIssue : today;

  let preview: InvoicePreview | null = null;
  let previewProblem: string | null = null;
  if (billable && asked) {
    const percentComplete = resolvePercentTenThou(kind, percentText);
    if (!percentComplete.ok) {
      previewProblem = percentComplete.error;
    } else {
      try {
        preview = await previewInvoice({
          projectId,
          kind,
          issueDate,
          percentCompleteTenThou: percentComplete.value,
        });
      } catch (error) {
        // The engine's own refusals -- a contract already over-billed, two
        // accepted quotes disagreeing about the withholding rate -- in the
        // engine's words, which are the words the commit would use too.
        previewProblem = error instanceof Error ? error.message : 'that draw could not be priced';
      }
    }
  }

  return (
    <div className="grid gap-4 px-4 py-4 sm:px-6">
      <PageHeader
        parent={{
          href: `/projects/${projectId}`,
          label: `${project.projectNumber} · ${project.name}`,
        }}
        eyebrow={
          <>
            <Pill tone={isJob ? 'positive' : 'neutral'}>{isJob ? 'Job' : 'Opportunity'}</Pill>
            {project.recordStatus === 'active' ? null : <Pill tone="negative">Void</Pill>}
          </>
        }
        title="Billing"
        description={
          <>
            <span className="num">{project.projectNumber}</span> · {project.name} ·{' '}
            {job.customerCompany ?? job.customerName}
          </>
        }
      />

      {issued ? (
        <Notice tone="positive" title="Invoice issued">
          <span className="num">{issued}</span> is on the job. It is listed below with everything
          else billed against this contract.
        </Notice>
      ) : null}

      {project.recordStatus === 'active' ? null : (
        <Notice tone="negative" title="This job is void">
          Nothing can be billed against a void job. The invoices already issued against it stay
          exactly as they were, because nothing here is ever deleted.
        </Notice>
      )}

      {isJob ? null : (
        <Notice tone="warning" title="There is nothing to bill yet">
          A job is a project with an accepted quote behind it, and the accepted quotes are what set
          the contract value. Nothing has been accepted here, so there is no agreed amount to bill a
          percentage of.{' '}
          <Link href={`/projects/${projectId}`} className="underline">
            Accept a quote on this opportunity
          </Link>{' '}
          first.
        </Notice>
      )}

      <SectionHeader title="Where the contract stands" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Contract value, before tax"
          from="accepted quotes"
          value={<Money plain cents={contract.subtotalCents} />}
          secondary={
            contract.acceptedQuoteCount === 1
              ? '1 accepted quote'
              : `${contract.acceptedQuoteCount} accepted quotes`
          }
        />
        <MetricCard
          label="Billed to date"
          from="issued invoices"
          value={<Money plain cents={state.previouslyBilledCents} />}
          secondary={`${formatCents(leftToBillCents)} of the contract is still unbilled`}
        >
          <ProgressBar
            pct={billedPct}
            tone={billedPct > 100 ? 'negative' : 'accent'}
            label="Billed against contract value"
          />
        </MetricCard>
        <MetricCard
          label="Holdback held"
          from="the holdback ledger"
          value={<Money plain cents={outstandingHoldbackCents} />}
          secondary={`${formatCents(state.holdbackAccruedCents)} withheld, ${formatCents(
            state.holdbackReleasedCents,
          )} released`}
        />
        <MetricCard
          label="Withholding rate"
          from="the accepted quote"
          value={formatPercent(contract.holdbackPctTenThou)}
          secondary={
            contract.holdbackPctTenThou === 0n
              ? 'This contract withholds nothing.'
              : 'The rate the contract was signed at, not the current default.'
          }
        />
      </div>

      {/*
        * A held balance with no way to bill it must SAY so.
        *
        * The engine bills `holdback_release` in full (`lib/invoice/compute.ts`)
        * and the kind has a label on this very page, but no screen collects
        * the figures a release needs -- so `issueCustomerInvoice` deliberately
        * narrows its accepted kinds to progress and final rather than issue
        * one with the rest silently defaulted. Correct, and it leaves this
        * screen showing money withheld beside a form that cannot return it.
        *
        * Until the release form exists, the balance is at least not silent.
        * An owner reading "Holdback held: $4,200" with no control is entitled
        * to know whether he has missed a button or the button does not exist.
        */}
      {outstandingHoldbackCents > 0 ? (
        <Notice tone="warning" title="This holdback cannot be released here yet">
          {formatCents(outstandingHoldbackCents)} is withheld on this contract. The invoice kind
          that returns it is built and priced, but the form that collects a release is part of
          the payments work that is not finished, so this balance cannot be billed from this
          screen today. It is recorded and it is not lost — nothing here writes it off.
        </Notice>
      ) : null}

      {billable ? (
        <Card>
          <CardHeader
            title="Issue an invoice"
            description="Price the draw first. Nothing is written until you press the button under the figures."
          />
          <CardBody>
            <div className="grid gap-4">
              <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
                <SelectField
                  label="What are you billing?"
                  name="kind"
                  defaultValue={kind}
                  options={[
                    { value: 'progress', label: 'A progress draw' },
                    { value: 'final', label: 'The contract in full (final)' },
                  ]}
                />
                <Field
                  label="Percent complete"
                  name="percent"
                  defaultValue={percentText}
                  numeric
                  inputMode="decimal"
                  autoComplete="off"
                  hint="0 to 100. A final invoice bills to 100 whatever this says."
                />
                <Field label="Issue date" name="issue" type="date" defaultValue={issueDate} />
                <div className="lg:pb-6">
                  {/* A GET that the browser posts, so React's form status
                      hook cannot see it -- `SubmitButton` watches the form's
                      own submit event instead. Pricing a draw is a round trip
                      that reads the whole invoice history of the job. */}
                  <SubmitButton variant="secondary" size="lg" pendingLabel="Pricing…">
                    Price this draw
                  </SubmitButton>
                </div>
              </form>

              {previewProblem ? (
                <Notice tone="negative" title="This draw cannot be billed" role="alert">
                  {previewProblem}
                </Notice>
              ) : null}

              {preview ? (
                <>
                  <PreviewTable preview={preview} contractCents={contract.subtotalCents} />
                  <IssueForm
                    projectId={projectId}
                    kind={kind}
                    percent={percentText}
                    issueDate={issueDate}
                    amountDueCents={preview.computed.amountDueCents}
                  />
                </>
              ) : previewProblem ? null : (
                <p className="max-w-prose t-small text-muted">
                  Billing is cumulative — a lower percent than before makes a negative draw.
                </p>
              )}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <SectionHeader title="Invoices on this job" />

      <Card>
        <CardBody padded={false}>
          {invoices.length === 0 ? (
            <EmptyState>
              Nothing has been billed against this contract yet.
              {billable ? ' Price a draw above to issue the first invoice.' : ''}
            </EmptyState>
          ) : (
            <TableWrap bare minWidth="58rem">
              <caption className="sr-only">
                Invoices issued against {project.projectNumber}, newest first
              </caption>
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader" scope="col">Invoice</th>
                  <th role="columnheader" scope="col">Billed</th>
                  <th role="columnheader" scope="col">Issued</th>
                  <th role="columnheader" scope="col" className="cell-num">
                    Complete
                  </th>
                  <th role="columnheader" scope="col" className="cell-num">
                    Draw
                  </th>
                  <th role="columnheader" scope="col" className="cell-num">
                    Holdback
                  </th>
                  <th role="columnheader" scope="col" className="cell-num">
                    Tax
                  </th>
                  <th role="columnheader" scope="col" className="cell-num">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {invoices.map((invoice) => (
                  <InvoiceRow key={invoice.id} invoice={invoice} />
                ))}
              </tbody>
            </TableWrap>
          )}
        </CardBody>
      </Card>

      {/* Voided invoices are LISTED rather than hidden, because the number
          series has no gaps a reader can otherwise explain: a jump from one
          number to the next but one reads as lost data. They count for nothing
          in the figures above -- the billing state is summed from the active
          rows -- which is what makes voiding a complete substitute for the
          delete the application role does not hold. */}
      {invoices.some((invoice) => invoice.recordStatus === 'void') ? (
        <p className="max-w-prose t-small text-muted">
          Voided invoices stay listed and no longer count toward billed totals.
        </p>
      ) : null}

      <SectionHeader title="Holdback" />

      {/* `Card` with a level-3 header rather than `Panel`, which hardcodes an
          h2: this panel sits UNDER the "Holdback" section label, which is
          already the h2, and two h2s at different depths are read out as a
          flat list. */}
      <Card>
        <CardHeader title="What is being withheld, and when it can be released" level={3} />
        <CardBody>
          <DetailList>
            <DetailRow label="Rate on this contract" numeric>
              {formatPercent(contract.holdbackPctTenThou)}
            </DetailRow>
            <DetailRow label="Withheld to date" numeric>
              {formatCents(state.holdbackAccruedCents)}
            </DetailRow>
            <DetailRow label="Released" numeric>
              {formatCents(state.holdbackReleasedCents)}
            </DetailRow>
            <DetailRow label="Still held" numeric>
              {formatCents(outstandingHoldbackCents)}
            </DetailRow>
            <DetailRow label="Substantial performance" value={project.substantialPerformanceDate} />
            <DetailRow
              label="Releasable from"
              value={
                project.substantialPerformanceDate === null || org === undefined
                  ? null
                  : holdbackReleaseEligibleDate(
                      project.substantialPerformanceDate,
                      company.holdbackReleaseDays,
                    )
              }
            />
          </DetailList>

          <p className="mt-3 max-w-prose t-small text-muted">
            {company.taxDeferredOnHoldback
              ? 'Tax on a construction holdback is not payable until the holdback is paid out, so a progress invoice taxes the draw less the withholding, and a release invoice taxes what was deferred.'
              : 'This tenant is set up without the holdback tax deferral, so the whole draw is taxed when it is billed and a release taxes nothing.'}
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * The derivation, printed as a derivation.
 *
 * Not a total with a tax line under it: every step from the contract to what
 * the customer owes today is its own row, because the two steps a person has
 * to be able to check are the ones a total hides -- that the draw is net of
 * what was already billed, and that the tax was charged on the draw LESS the
 * holdback rather than on the draw.
 */
function PreviewTable({
  preview,
  contractCents,
}: {
  preview: InvoicePreview;
  contractCents: number;
}) {
  const { computed, state, taxDeferredOnHoldback } = preview;
  const earnedToDateCents = state.previouslyBilledCents + computed.subtotalCents;

  return (
    <TableWrap minWidth="34rem">
      <caption className="sr-only">
        How this invoice is priced, from the contract value to the amount due
      </caption>
      <thead role="rowgroup">
        <tr role="row">
          <th role="columnheader" scope="col">What</th>
          <th role="columnheader" scope="col">Worked out from</th>
          <th role="columnheader" scope="col" className="cell-num">
            Amount
          </th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        <tr role="row">
          <td role="cell" data-label="What">Contract value, before tax</td>
          <td role="cell" data-label="Worked out from" className="t-small text-muted">
            accepted quotes
          </td>
          <AmountCell data-label="Amount" cents={contractCents} />
        </tr>
        <tr role="row">
          <td role="cell" data-label="What">Work earned to date</td>
          <td role="cell" data-label="Worked out from" className="t-small text-muted">
            {computed.percentCompleteTenThou === null
              ? null
              : `${formatPercent(computed.percentCompleteTenThou)} of the contract`}
          </td>
          <AmountCell data-label="Amount" cents={earnedToDateCents} />
        </tr>
        <tr role="row">
          <td role="cell" data-label="What">Less billed by earlier invoices</td>
          <td role="cell" data-label="Worked out from" className="t-small text-muted">
            gross of holdback, deposits excluded
          </td>
          <AmountCell data-label="Amount" cents={negated(state.previouslyBilledCents)} />
        </tr>
        <tr role="row">
          <td role="cell" data-label="What" className="font-semibold">
            This draw
          </td>
          <td role="cell" data-label="Worked out from" className="t-small text-muted">
            before tax
          </td>
          <AmountCell data-label="Amount" className="font-semibold" cents={computed.subtotalCents} />
        </tr>
        <tr role="row">
          <td role="cell" data-label="What">Holdback withheld</td>
          <td role="cell" data-label="Worked out from" className="t-small text-muted">
            {formatPercent(preview.holdbackPctTenThou)} of work billed to date
          </td>
          <AmountCell data-label="Amount" cents={negated(computed.holdbackCents)} />
        </tr>
        <tr role="row">
          <td role="cell" data-label="What" className="font-semibold">
            Taxable base
          </td>
          <td role="cell" data-label="Worked out from" className="t-small text-muted">
            {taxDeferredOnHoldback
              ? 'the draw less the holdback, because tax on a holdback is not payable until the holdback is paid out'
              : 'the whole draw, because this tenant defers no tax on holdback'}
          </td>
          <AmountCell
            data-label="Amount"
            className="font-semibold"
            cents={computed.taxableBaseCents}
          />
        </tr>

        {computed.taxes.length === 0 ? (
          <tr role="row">
            <td role="cell" data-label="What">No tax</td>
            <td role="cell" data-label="Worked out from" className="t-small text-muted">
              no rate in force on {computed.issueDate}, or the customer is exempt
            </td>
            <AmountCell data-label="Amount" cents={0} />
          </tr>
        ) : (
          computed.taxes.map((tax) => (
            <tr role="row" key={`${tax.label}-${tax.rateTenThou}`}>
              <td role="cell" data-label="What">{tax.label}</td>
              <td role="cell" data-label="Worked out from" className="t-small text-muted">
                {formatPercent(tax.rateTenThou)} of {formatCents(tax.taxableBaseCents)}
              </td>
              <AmountCell data-label="Amount" cents={tax.taxAmountCents} />
            </tr>
          ))
        )}

        <tr role="row">
          <td role="cell" data-label="What" className="font-semibold">
            Invoice total
          </td>
          <td role="cell" data-label="Worked out from" className="t-small text-muted">
            the draw less the holdback, plus tax
          </td>
          <AmountCell data-label="Amount" className="font-semibold" cents={computed.totalCents} />
        </tr>
        <tr role="row">
          <td role="cell" data-label="What" className="font-semibold">
            Amount due
          </td>
          <td role="cell" data-label="Worked out from" className="t-small text-muted">
            {computed.depositAppliedCents === 0
              ? 'no deposit applied'
              : `less ${formatCents(computed.depositAppliedCents)} of deposit already invoiced`}
          </td>
          <AmountCell
            data-label="Amount"
            className="font-semibold"
            cents={computed.amountDueCents}
          />
        </tr>
      </tbody>
    </TableWrap>
  );
}

function InvoiceRow({ invoice }: { invoice: InvoiceSummary }) {
  const voided = invoice.recordStatus === 'void';
  const status = INVOICE_STATUS[invoice.status];

  return (
    <tr role="row">
      <td role="cell" data-label="Invoice">
        <span className="flex flex-wrap items-center gap-2">
          <span className={`num ${voided ? 'text-muted line-through' : ''}`.trim()}>
            {invoice.invoiceNumber}
          </span>
          {voided ? (
            <Pill tone="negative">Void</Pill>
          ) : (
            <Pill tone={status.tone}>{status.label}</Pill>
          )}
        </span>
        {voided && invoice.voidReason ? (
          <span className="block t-small text-muted">{invoice.voidReason}</span>
        ) : null}
      </td>
      <td role="cell" data-label="Billed">{INVOICE_KINDS[invoice.kind]}</td>
      <td role="cell" data-label="Issued" className="num t-small">
        {invoice.issueDate}
      </td>
      <AmountCell data-label="Complete">
        {invoice.percentCompleteTenThou === null
          ? '—'
          : formatPercent(invoice.percentCompleteTenThou)}
      </AmountCell>
      <AmountCell data-label="Draw" cents={invoice.subtotalCents} />
      <AmountCell data-label="Holdback" cents={invoice.holdbackCents} />
      <AmountCell data-label="Tax" cents={invoice.taxTotalCents} />
      <AmountCell data-label="Total" cents={invoice.totalCents} />
    </tr>
  );
}
