import { asc } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db/client';
import { taxRates, users } from '@/db/schema';
import { formatPercent } from '@/app/settings/percent';
import { finishSetup } from '@/app/setup/actions';
import { checkSummary, runEnvironmentChecks } from '@/app/setup/environment';
import { requireOpenSetup } from '@/app/setup/guard';
import { ActionForm } from '@/components/settings/ActionForm';
import { Notice } from '@/components/ui/Notice';
import { StepPanel } from '@/components/setup/StepPanel';
import { formatCents } from '@/lib/money/format';
import { TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

/** A sample amount for the currency preview. Deliberately not a real figure. */
const SAMPLE_CENTS = 123_456;

/** A field the owner left blank, shown as blank rather than omitted from the summary. */
const notSet = <span className="text-subtle">Not set</span>;

/**
 * Step 8. What was created, and the way in.
 *
 * The summary is read back out of the database rather than remembered from the
 * forms, so what it reports is what was actually stored — including a field
 * the owner left blank, which is worth seeing before the wizard closes rather
 * than discovering on a customer's quote.
 */
export default async function DoneStepPage() {
  const gate = await requireOpenSetup('done');
  const org = gate.org;

  const rates = await db.select().from(taxRates).orderBy(asc(taxRates.sortOrder));
  const accounts = await db.select().from(users).orderBy(asc(users.displayName));
  const checks = await runEnvironmentChecks();
  const summary = checkSummary(checks);

  let currencySample: string;
  try {
    currencySample = formatCents(SAMPLE_CENTS, {
      locale: org?.locale ?? 'en',
      currencyCode: org?.currency ?? 'XXX',
    });
  } catch {
    currencySample = 'unavailable — the stored currency code is not one this system knows';
  }

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: 'Legal name', value: org?.legalName ?? notSet },
    { label: 'Display name', value: org?.displayName ?? notSet },
    { label: 'Signs quotes', value: org?.ownerName ?? notSet },
    {
      label: 'Address',
      value:
        [org?.addressLine1, org?.city, org?.province, org?.postalCode, org?.country]
          .filter(Boolean)
          .join(', ') || notSet,
    },
    { label: 'Contact', value: [org?.phone, org?.email].filter(Boolean).join(' · ') || notSet },
    {
      label: 'Money prints as',
      value: <span className="num">{currencySample}</span>,
    },
    {
      label: 'Dates are computed in',
      value: <span className="num">{org?.timezone ?? 'not set'}</span>,
    },
    {
      label: 'Fiscal year ends',
      value:
        org?.fiscalYearEndMonth && org?.fiscalYearEndDay
          ? `month ${org.fiscalYearEndMonth}, day ${org.fiscalYearEndDay}`
          : notSet,
    },
    {
      label: 'Tax registration',
      value: [org?.taxRegistrationLabel, org?.taxRegistrationNumber].filter(Boolean).join(' ') || notSet,
    },
    {
      label: 'Default holdback',
      value:
        org?.defaultHoldbackPctTenThou === null || org?.defaultHoldbackPctTenThou === undefined ? (
          <span className="text-subtle">None proposed by default</span>
        ) : (
          <span className="num">{formatPercent(org.defaultHoldbackPctTenThou)}%</span>
        ),
    },
    {
      label: 'Target margin',
      value:
        org?.targetMarginBp === null || org?.targetMarginBp === undefined ? (
          notSet
        ) : (
          <span className="num">{formatPercent(BigInt(org.targetMarginBp))}%</span>
        ),
    },
    {
      label: `Tax rate${rates.length === 1 ? '' : 's'}`,
      value:
        rates.length === 0
          ? notSet
          : rates
              .map(
                (rate) =>
                  `${rate.label} ${formatPercent(rate.rateTenThou)}% from ${rate.effectiveFrom}`,
              )
              .join(' · '),
    },
    {
      label: 'Accounts',
      value:
        accounts.length === 0
          ? notSet
          : accounts.map((account) => `${account.displayName} (${account.role})`).join(' · '),
    },
  ];

  return (
    <StepPanel slug="done" gate={gate}>
      <ActionForm action={finishSetup} submitLabel="Finish setup">
        <TableWrap minWidth="30rem">
          <caption className="sr-only">What first-run setup created</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Setting</th>
              <th role="columnheader" scope="col">Stored value</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((row) => (
              <tr role="row" key={row.label}>
                <td role="cell" data-label="Setting">{row.label}</td>
                <td role="cell" data-label="Stored value" className="t-small">
                  {row.value}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>

        {summary.failing > 0 ? (
          <Notice tone="warning" title={`${summary.failing} environment check${summary.failing === 1 ? '' : 's'} still failing`}>
            Quoting works regardless — none of them is a field on a document. They decide
            whether documents render, and whether this company&apos;s records survive the
            machine they&apos;re on. See the report on the previous step, or the dashboard
            afterwards.
          </Notice>
        ) : null}

        {/* Deliberate: the only thing these forms could do to a company that
            already exists is replace it wholesale, and a legal name or a tax
            registration replaced by mistake is wrong on documents already in
            a customer's inbox. */}
        <Notice tone="info" title="Finishing closes this wizard permanently">
          <p>
            After this, <span className="num">/setup</span> redirects into the application —
            these forms can&apos;t be reached again on this deployment.
          </p>
          <p className="mt-2">
            Every field above stays editable under{' '}
            <Link className="underline" href="/settings">Settings</Link>, owner role only. A
            tax rate is the exception: changing one adds a new effective-dated row instead of
            overwriting it.
          </p>
        </Notice>
      </ActionForm>
    </StepPanel>
  );
}
