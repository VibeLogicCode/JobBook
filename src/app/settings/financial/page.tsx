import { saveFinancial } from '@/app/settings/actions';
import { loadSettings, readOnlyNote } from '@/app/settings/load';
import { formatPercent } from '@/app/settings/percent';
import { ActionForm } from '@/components/settings/ActionForm';
import {
  CheckboxField,
  FieldGrid,
  type Option,
  ReadOnlyField,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/settings/Fields';
import { Notice } from '@/components/ui/Notice';
import { Section } from '@/components/settings/Section';
import { formatBasisPoints, formatRate } from '@/lib/money/format';
import { RATE_SCALE, divRoundHalfUp } from '@/lib/money/scale';

export const dynamic = 'force-dynamic';

const OWNER_ONLY = 'Editing financial and legal settings is reserved to an owner.';

/**
 * Month names from the tenant's own language tag, so a French deployment does
 * not read a hardcoded English list. The day-of-month is arbitrary: only the
 * month name is taken from the formatted result.
 */
function monthOptions(locale: string): Option[] {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  } catch {
    formatter = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' });
  }
  return Array.from({ length: 12 }, (_unused, index) => ({
    value: String(index + 1),
    label: formatter.format(new Date(Date.UTC(2001, index, 15))),
  }));
}

/**
 * The markup that matches a margin.
 *
 * A 20% markup is a 16.7% margin, and contractors lose money on the confusion
 * routinely. The product stores and reports margin; this shows the markup
 * beside it so the owner setting a target can recognise the number he is used
 * to quoting.
 */
function markupForMargin(marginBp: number): string | null {
  if (marginBp <= 0 || marginBp >= 10_000) return null;
  const markupBp = divRoundHalfUp(BigInt(marginBp) * RATE_SCALE, RATE_SCALE - BigInt(marginBp));
  return formatBasisPoints(Number(markupBp));
}

export default async function FinancialSettingsPage() {
  const context = await loadSettings('organization.edit');
  const org = context.org;
  const markup = org?.targetMarginBp ? markupForMargin(org.targetMarginBp) : null;

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Tax registration"
        description={
          <p>
            Both the number and what it is <em>called</em> are configuration. A jurisdiction
            decides whether a document says one thing or another above the same field, and a
            product that printed a fixed label would be wrong the first time it left the
            region it was written in.
          </p>
        }
      >
        <ActionForm
          action={saveFinancial}
          submitLabel="Save financial and legal settings"
          disabled={!context.allowed}
          disabledNote={readOnlyNote(context, OWNER_ONLY)}
        >
          <FieldGrid>
            <TextField
              name="taxRegistrationNumber"
              label="Tax registration number"
              maxLength={50}
              defaultValue={org?.taxRegistrationNumber}
              numeric
              hint="Printed beside the tax line on every document. Snapshotted onto each quote as it is issued."
            />
            <TextField
              name="taxRegistrationLabel"
              label="Tax registration label"
              maxLength={50}
              defaultValue={org?.taxRegistrationLabel}
              hint="The words that print in front of the number. Type them exactly as your jurisdiction names them."
            />
            <TextField
              name="businessNumber"
              label="Business number"
              maxLength={50}
              defaultValue={org?.businessNumber}
              numeric
              hint="The company registration, where that differs from the tax registration."
            />
            <SelectField
              name="taxFilingFrequency"
              label="Filing frequency"
              defaultValue={org?.taxFilingFrequency}
              blankLabel="Not set"
              options={[
                { value: 'annual', label: 'Annual' },
                { value: 'quarterly', label: 'Quarterly' },
                { value: 'monthly', label: 'Monthly' },
              ]}
              hint="How often the company remits. It groups the accountant export into periods."
            />
            <SelectField
              name="fiscalYearEndMonth"
              label="Fiscal year end month"
              defaultValue={org?.fiscalYearEndMonth ? String(org.fiscalYearEndMonth) : ''}
              blankLabel="Not set"
              options={monthOptions(org?.locale ?? 'en')}
              hint="Not assumed to be the end of December. Plenty of companies close in another month."
            />
            <TextField
              name="fiscalYearEndDay"
              label="Fiscal year end day"
              inputMode="numeric"
              numeric
              maxLength={2}
              defaultValue={org?.fiscalYearEndDay ? String(org.fiscalYearEndDay) : ''}
              hint="Set with the month, or leave both blank. 29 February is accepted — leap years exist."
            />

            <div className="sm:col-span-2">
              <h3 className="t-heading mt-2">Holdback</h3>
              <p className="mt-1 max-w-prose t-small text-muted">
                A statutory or contractual amount withheld from each payment and released
                later. The percentage here is only the <em>default</em>: it is stored per
                quote, so a job that withholds nothing prints no holdback block at all.
                Applying one company-wide percentage would put a withholding invitation on
                every residential quote, where most homeowners neither expect nor ask for one.
              </p>
            </div>

            <TextField
              name="defaultHoldbackPct"
              label="Default holdback"
              inputMode="decimal"
              numeric
              suffix="%"
              maxLength={8}
              defaultValue={
                org?.defaultHoldbackPctTenThou === null ||
                org?.defaultHoldbackPctTenThou === undefined
                  ? ''
                  : formatPercent(org.defaultHoldbackPctTenThou)
              }
              hint="Blank means no holdback is proposed by default. Two decimal places at most."
            />
            <TextField
              name="holdbackLabel"
              label="Holdback label"
              maxLength={100}
              defaultValue={org?.holdbackLabel}
              hint="What the block is headed on a document. Every jurisdiction names this differently."
            />
            <TextField
              name="holdbackReleaseDays"
              label="Holdback release days"
              inputMode="numeric"
              numeric
              required
              maxLength={4}
              suffix="days"
              defaultValue={String(org?.holdbackReleaseDays ?? '')}
              hint="Counted from the date that starts the release clock on a project."
            />
            <CheckboxField
              name="taxDeferredOnHoldback"
              label="Tax on the holdback is deferred until it is released"
              defaultChecked={org?.taxDeferredOnHoldback ?? true}
              hint="Where a holdback is retained under legislation or a written contract, tax on the held-back amount may not be payable until it is paid out. Turn it off for a jurisdiction with no such deferral."
            />
            <TextAreaField
              name="holdbackTermsText"
              label="Holdback terms"
              rows={3}
              defaultValue={org?.holdbackTermsText}
              hint="The paragraph that prints under the holdback block."
            />

            <div className="sm:col-span-2">
              <h3 className="t-heading mt-2">Payment and insurance</h3>
            </div>

            <TextField
              name="paymentTermsDays"
              label="Payment terms days"
              inputMode="numeric"
              numeric
              maxLength={4}
              suffix="days"
              defaultValue={
                org?.paymentTermsDays === null || org?.paymentTermsDays === undefined
                  ? ''
                  : String(org.paymentTermsDays)
              }
              hint="How long an invoice has before it is late. Some jurisdictions legislate this."
            />
            <TextField
              name="insuranceStatement"
              label="Insurance statement"
              maxLength={500}
              defaultValue={org?.insuranceStatement}
              hint="One line about cover and registration, printed on a quote. Yours to word."
            />
            <TextAreaField
              name="paymentTermsText"
              label="Payment terms"
              rows={4}
              defaultValue={org?.paymentTermsText}
              hint="Deposit and draw structure. A quote can override it per job, because a deposit that suits a bathroom does not suit a custom home."
            />

            <div className="sm:col-span-2">
              <h3 className="t-heading mt-2">Mileage</h3>
              <p className="mt-1 max-w-prose t-small text-muted">
                What a kilometre driven on a job costs. It is configuration rather than a figure
                written into the product, because the allowance is your tax authority&apos;s and
                it moves most years — the value below is a starting point, not an authority.
                Confirm it against whatever is published for the year before you rely on it.
              </p>
              <p className="mt-1 max-w-prose t-small text-muted">
                Changing it sets what the <em>next</em> trip costs. Every trip already logged
                stored the rate it was driven at on its own entry and is not touched, for the
                same reason a quote line keeps the price it was quoted at: a trip taken this year
                has to go on costing what this year cost, and a rate resolved at display time
                would silently restate every trip ever logged the first January after a change.
              </p>
            </div>

            <TextField
              name="mileageRatePerKm"
              label="Mileage rate"
              inputMode="decimal"
              numeric
              required
              suffix="per km"
              maxLength={10}
              defaultValue={
                org?.mileageRatePerKmTenThou === null ||
                org?.mileageRatePerKmTenThou === undefined
                  ? ''
                  : formatRate(org.mileageRatePerKmTenThou)
              }
              hint="Four decimal places. Mileage is a cost only — it moves the margin on a job and never appears on anything a customer is sent."
            />

            <div className="sm:col-span-2">
              <h3 className="t-heading mt-2">Target margin</h3>
            </div>

            <TextField
              name="targetMargin"
              label="Target margin"
              inputMode="decimal"
              numeric
              suffix="%"
              maxLength={8}
              defaultValue={
                org?.targetMarginBp === null || org?.targetMarginBp === undefined
                  ? ''
                  : formatPercent(BigInt(org.targetMarginBp))
              }
              hint="Stored in basis points. It sets the bands on the worksheet margin gauge, so a quote drifting toward a loss is visible before it is sent."
            />
            <ReadOnlyField
              label="The same figure as a markup"
              value={markup ? <span className="num">{markup}</span> : '—'}
              hint="Margin is a share of the price; markup is a share of the cost. They are different numbers on the same job."
            />
          </FieldGrid>
        </ActionForm>
      </Section>

      <Section title="What is not here">
        <Notice tone="info">
          Tax rates are not on this page. They are effective-dated rows of their own, because
          a rate that changes must not erase what was correct before it —{' '}
          <span className="font-semibold">Tax rates</span> in the list on the left.
        </Notice>
      </Section>
    </div>
  );
}
