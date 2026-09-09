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
import { CompanyScopeNotice } from '@/components/settings/CompanyScopeNotice';
import { Reveal } from '@/components/ui/Reveal';
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

export default async function FinancialSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ company?: string }>;
}) {
  /**
   * Which company's letterhead this screen is editing.
   *
   * From the URL rather than from component state, because the form below
   * is filled on the SERVER from one company's values -- so switching has
   * to re-render it. A client-side switch that only changed a hidden field
   * would leave one company's address on screen while the form saved to the
   * other.
   *
   * Absent on a single-company installation, which is every one until
   * somebody deliberately adds a second.
   */
  const { company } = await searchParams;
  const context = await loadSettings('organization.edit', company ?? null);
  const org = context.org;
  const markup = org?.targetMarginBp ? markupForMargin(org.targetMarginBp) : null;

  return (
    <div className="flex flex-col gap-4">
      <CompanyScopeNotice
        companies={context.companies}
        companyId={context.companyId}
        basePath="/settings/financial"
      />
      {/*
       * Both the number and its label are configuration, not just the number:
       * a jurisdiction decides whether a document says one thing or another
       * above the same field, and a fixed label would be wrong the first time
       * this left the region it was written in.
       */}
      <Section title="Tax registration">
        <ActionForm
          action={saveFinancial}
          submitLabel="Save financial and legal settings"
          disabled={!context.allowed || context.companyId === null}
          disabledNote={readOnlyNote(context, OWNER_ONLY)}
        >
          {/* Which company this form was filled from, so the record that saves
              is the record that was rendered -- not whatever the server would
              resolve seconds later, which is a different question. Absent on a
              single-company install, where `patchOrganization` falls back to
              the only one. */}
          {context.companyId ? (
            <input type="hidden" name="companyId" value={context.companyId} />
          ) : null}
          <FieldGrid>
            <TextField
              name="taxRegistrationNumber"
              label="Tax registration number"
              maxLength={50}
              defaultValue={org?.taxRegistrationNumber}
              numeric
              hint="Printed on every document. Snapshotted onto each quote when issued."
            />
            <TextField
              name="taxRegistrationLabel"
              label="Tax registration label"
              maxLength={50}
              defaultValue={org?.taxRegistrationLabel}
              hint="Printed before the number. Word it as your jurisdiction requires."
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
              hint="Not assumed to be December."
            />
            <TextField
              name="fiscalYearEndDay"
              label="Fiscal year end day"
              inputMode="numeric"
              numeric
              maxLength={2}
              defaultValue={org?.fiscalYearEndDay ? String(org.fiscalYearEndDay) : ''}
              hint="Set with the month, or leave both blank. 29 February is accepted."
            />

            {/*
             * Only a default, not a company-wide rate: it is stored per quote,
             * so a job that withholds nothing prints no holdback block. A
             * single shared percentage would put a withholding line on every
             * residential quote, where most homeowners never expect one.
             */}
            <div className="sm:col-span-2">
              <h3 className="t-heading mt-2">Holdback</h3>
              <p className="mt-1 max-w-prose t-small text-muted">
                Withheld from each payment, released later. This is only the default —
                the actual holdback is set per quote.
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
              hint="What the block is headed on a document."
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
              wide
            />
            <div className="sm:col-span-2 -mt-2">
              <Reveal label="When this doesn't apply">
                Where a holdback is retained under legislation or a written contract, tax on the
                amount held back may not be payable until it is paid out. Turn this off for a
                jurisdiction with no such deferral.
              </Reveal>
            </div>
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
            {/* A quote can override this per job: a deposit that suits a
                bathroom does not suit a custom home. */}
            <TextAreaField
              name="paymentTermsText"
              label="Payment terms"
              rows={4}
              defaultValue={org?.paymentTermsText}
              hint="Deposit and draw structure. A quote can override this per job."
            />

            {/*
             * The allowance is the tax authority's and moves most years — the
             * value here is a starting point, not an authority; confirm it
             * against what's published before relying on it.
             *
             * Changing it sets what the next trip costs only. Every trip
             * already logged stored the rate it was driven at, the same way a
             * quote line keeps the price it was quoted at — a rate resolved
             * at display time would silently restate every trip ever logged.
             */}
            <div className="sm:col-span-2">
              <h3 className="t-heading mt-2">Mileage</h3>
              <p className="mt-1 max-w-prose t-small text-muted">
                Set by your tax authority. Applies to trips going forward only.
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
              hint="Four decimal places. Never appears on anything sent to a customer."
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
              hint="Sets the bands on the worksheet margin gauge."
            />
            <ReadOnlyField
              label="The same figure as a markup"
              value={markup ? <span className="num">{markup}</span> : '—'}
              hint="Margin is a share of price; markup a share of cost — different numbers."
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
