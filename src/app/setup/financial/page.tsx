import { formatPercent } from '@/app/settings/percent';
import { saveFinancialStep } from '@/app/setup/actions';
import { requireOpenSetup } from '@/app/setup/guard';
import { ActionForm } from '@/components/settings/ActionForm';
import {
  CheckboxField,
  FieldGrid,
  type Option,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/settings/Fields';
import { Notice } from '@/components/settings/Notice';
import { StepPanel } from '@/components/setup/StepPanel';

export const dynamic = 'force-dynamic';

/**
 * Step 4. Tax registration, fiscal year, holdback, payment terms, margin.
 *
 * The longest step, and asked now rather than later for one reason: the fiscal
 * year end and the filing frequency are what the accountant export groups
 * periods by, and retrofitting them means going back to the owner months after
 * he stopped thinking about setup.
 *
 * Every percentage on this page is parsed by the shared percentage field,
 * which composes the money parsers — so a rate reaches the database as an
 * exact integer in ten-thousandths and never as a float multiplied by ten
 * thousand.
 */

/**
 * Month names from the tenant's own language tag, so a French deployment does
 * not read a hardcoded English list. Only the month name is taken from the
 * formatted result; the day is arbitrary.
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

export default async function FinancialStepPage() {
  const gate = await requireOpenSetup('financial');
  const org = gate.org;

  return (
    <StepPanel slug="financial" gate={gate}>
      <ActionForm action={saveFinancialStep} submitLabel="Save financial settings">
        <FieldGrid>
          <TextField
            name="taxRegistrationNumber"
            label="Tax registration number"
            maxLength={50}
            defaultValue={org?.taxRegistrationNumber}
            numeric
            placeholder="Your registration, as issued"
            hint="Printed beside the tax line, and snapshotted onto each quote as it is issued."
          />
          <TextField
            name="taxRegistrationLabel"
            label="Tax registration label"
            maxLength={50}
            defaultValue={org?.taxRegistrationLabel}
            placeholder="What your jurisdiction calls it"
            hint="The words that print in front of the number. A product printing a fixed label is wrong the first time it leaves the region it was written in."
          />
          <TextField
            name="businessNumber"
            label="Business number"
            maxLength={50}
            defaultValue={org?.businessNumber}
            numeric
            placeholder="Company registration, if different"
            hint="Where the company registration differs from the tax registration."
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
            placeholder="Day of that month"
            hint="Set it with the month, or leave both blank. The 29th of February is accepted — leap years exist."
          />

          <div className="sm:col-span-2">
            <h3 className="t-heading mt-2">Holdback</h3>
            <p className="mt-1 max-w-prose t-small text-muted">
              An amount withheld from each payment and released later. What you enter here is
              only the <em>default</em>: it is stored per quote, so a job that withholds nothing
              prints no holdback block at all. Leave it blank if none of your work involves one.
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
              org?.defaultHoldbackPctTenThou === null || org?.defaultHoldbackPctTenThou === undefined
                ? ''
                : formatPercent(org.defaultHoldbackPctTenThou)
            }
            hint="Blank means no holdback is proposed. Two decimal places at most, because that is what the stored scale holds exactly."
          />
          <TextField
            name="holdbackLabel"
            label="Holdback label"
            maxLength={100}
            defaultValue={org?.holdbackLabel}
            placeholder="What the block is headed"
            hint="Every jurisdiction names this differently, so it is yours to word."
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
            placeholder="The paragraph that prints under the holdback block"
          />

          <div className="sm:col-span-2">
            <h3 className="t-heading mt-2">Payment, insurance and margin</h3>
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
            hint="Margin, not markup — a share of the price, not of the cost. It sets the bands on the worksheet gauge, so a quote drifting toward a loss is visible before it is sent."
          />
          <TextField
            name="insuranceStatement"
            label="Insurance statement"
            maxLength={500}
            defaultValue={org?.insuranceStatement}
            placeholder="One line about cover and registration"
            hint="Printed on a quote. Yours to word."
          />
          <TextAreaField
            name="paymentTermsText"
            label="Payment terms"
            rows={4}
            defaultValue={org?.paymentTermsText}
            placeholder="Deposit and draw structure"
            hint="A quote can override it per job, because a deposit that suits a bathroom does not suit a custom home."
          />
        </FieldGrid>

        <Notice tone="info" title="The tax rate is the next step, not this one">
          Rates are effective-dated rows of their own rather than a percentage on this record,
          because one percentage is wrong outside the region it was written for — some
          jurisdictions bill a single harmonized line, others a federal and a provincial line
          together, and one of them has no sales tax at all.
        </Notice>
      </ActionForm>
    </StepPanel>
  );
}
