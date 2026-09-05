import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { taxRates } from '@/db/schema';
import { formatPercent } from '@/app/settings/percent';
import { saveTaxRateStep } from '@/app/setup/actions';
import { requireOpenSetup } from '@/app/setup/guard';
import { TAX_RATE_ID_KEY } from '@/app/setup/state';
import { ActionForm } from '@/components/settings/ActionForm';
import { CheckboxField, FieldGrid, TextField } from '@/components/settings/Fields';
import { Notice } from '@/components/ui/Notice';
import { StepPanel } from '@/components/setup/StepPanel';
import { tenantToday } from '@/lib/quote/dates';

export const dynamic = 'force-dynamic';

/**
 * Step 5. The first tax rate, and the day it took effect.
 *
 * A table rather than a percentage on the organization record, because one
 * percentage is wrong outside the region it was written for. And effective
 * dated, because a rate that changes must not erase what was correct before
 * it: the date on this form is a priced fact, not metadata.
 */
export default async function TaxRateStepPage() {
  const gate = await requireOpenSetup('tax-rate');

  // The row this wizard already created, if the installer has been here
  // before. Re-submitting corrects it rather than adding a second rate in
  // force on the same day.
  const existingId = gate.values.get(TAX_RATE_ID_KEY);
  const [existing] = existingId
    ? await db.select().from(taxRates).where(eq(taxRates.id, existingId))
    : [];

  // The tenant's own calendar day, not the container's, and the reason this
  // step comes after the locale step. Offered as a default because a new
  // deployment usually starts with the rate currently in force.
  let today: string | null = null;
  try {
    today = await db.transaction(async (tx) => tenantToday(tx));
  } catch {
    // No organization row, or an unknown zone. The field is simply left empty
    // rather than defaulted to a date computed in the wrong day.
  }

  return (
    <StepPanel slug="tax-rate" gate={gate}>
      <ActionForm action={saveTaxRateStep} submitLabel="Save tax rate">
        {/* Closing the old row and inserting a new one is what an audit asks
            for, and what a filing period straddling a change needs in order
            to split. */}
        <Notice tone="warning" title="Why the date on this form matters more than it looks">
          <p>
            Rates are <em>versioned</em>, never edited — so what applied on any past date stays
            answerable years later.
          </p>
          <p className="mt-2">
            The date below is the day this rate <em>actually took effect</em>, not the day
            you&apos;re typing — back-dating is allowed. A quote keeps its own snapshot forever,
            so nothing entered here can alter a document already sent.
          </p>
        </Notice>

        <FieldGrid>
          <TextField
            name="label"
            label="Label"
            required
            maxLength={50}
            defaultValue={existing?.label}
            placeholder="As it prints on a document"
            hint="The name your jurisdiction gives this tax."
          />
          <TextField
            name="shortLabel"
            label="Short label"
            maxLength={20}
            defaultValue={existing?.shortLabel}
            placeholder="For a narrow column"
          />
          <TextField
            name="rate"
            label="Rate"
            required
            numeric
            inputMode="decimal"
            suffix="%"
            maxLength={8}
            defaultValue={existing ? formatPercent(existing.rateTenThou) : ''}
            // Refused rather than rounded: a rate quietly altered in the
            // third decimal reprices every future quote.
            hint="Two decimal places at most — refused, not rounded."
          />
          <TextField
            name="effectiveFrom"
            label="In force from"
            type="date"
            required
            defaultValue={existing?.effectiveFrom ?? today ?? ''}
            hint="The first day this rate applies, in your timezone."
          />
          <TextField
            name="registrationNumber"
            label="Registration number"
            maxLength={50}
            numeric
            defaultValue={existing?.registrationNumber}
            placeholder="Printed beside this tax"
            hint="It can differ from the company's other numbers."
          />
          <TextField
            name="sortOrder"
            label="Order"
            required
            numeric
            inputMode="numeric"
            maxLength={3}
            defaultValue={existing ? String(existing.sortOrder) : '1'}
            hint="The order taxes apply in, which matters only where one compounds on another."
          />
          <CheckboxField
            name="isCompound"
            label="Applies on the subtotal plus taxes already added"
            defaultChecked={existing?.isCompound ?? false}
            wide
            hint="Leave off unless your jurisdiction charges one tax on top of another."
          />
        </FieldGrid>

        <Notice tone="info" title="One rate now; more later">
          A jurisdiction that bills two lines takes a second row, added later under Settings.
          This step asks for one so the first quote can be priced.
        </Notice>
      </ActionForm>
    </StepPanel>
  );
}
