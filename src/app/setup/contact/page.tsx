import { saveContactStep } from '@/app/setup/actions';
import { requireOpenSetup } from '@/app/setup/guard';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, TextField } from '@/components/settings/Fields';
import { StepPanel } from '@/components/setup/StepPanel';

export const dynamic = 'force-dynamic';

/**
 * Step 2. The contact block a customer reads off a quote.
 *
 * Nothing here is shape-validated beyond a length, and that is deliberate: a
 * postal code pattern is a jurisdiction assumption in the same class as a
 * hardcoded tax rate, and the first deployment outside one country would start
 * rejecting real addresses. A human reads these fields off a page.
 */
export default async function ContactStepPage() {
  const gate = await requireOpenSetup('contact');
  const org = gate.org;

  return (
    <StepPanel slug="contact" gate={gate}>
      <ActionForm action={saveContactStep} submitLabel="Save contact details">
        <FieldGrid>
          <TextField
            name="addressLine1"
            label="Address line 1"
            maxLength={200}
            defaultValue={org?.addressLine1}
            placeholder="Street address"
          />
          <TextField
            name="addressLine2"
            label="Address line 2"
            maxLength={200}
            defaultValue={org?.addressLine2}
            placeholder="Unit or suite, if any"
          />
          <TextField
            name="city"
            label="City"
            maxLength={100}
            defaultValue={org?.city}
            placeholder="City or town"
          />
          <TextField
            name="province"
            label="Province or state"
            maxLength={100}
            defaultValue={org?.province}
            placeholder="Province, state or region"
          />
          <TextField
            name="postalCode"
            label="Postal or ZIP code"
            maxLength={20}
            defaultValue={org?.postalCode}
            placeholder="As your post office writes it"
            hint="Not pattern-checked. A pattern written for one postal system rejects real addresses in another."
          />
          <TextField
            name="country"
            label="Country"
            maxLength={100}
            defaultValue={org?.country}
            placeholder="Country"
          />
          <TextField
            name="phone"
            label="Phone"
            type="tel"
            inputMode="tel"
            maxLength={40}
            defaultValue={org?.phone}
            placeholder="Main number, as you print it"
          />
          <TextField
            name="altPhone"
            label="Alternate phone"
            type="tel"
            inputMode="tel"
            maxLength={40}
            defaultValue={org?.altPhone}
            placeholder="Second number, if any"
          />
          <TextField
            name="email"
            label="Email"
            type="email"
            inputMode="email"
            maxLength={200}
            defaultValue={org?.email}
            placeholder="Address a customer replies to"
            hint="Printed on documents. This application sends no mail of its own."
          />
          <TextField
            name="website"
            label="Website"
            type="url"
            inputMode="url"
            maxLength={200}
            defaultValue={org?.website}
            placeholder="https://"
            hint="Must begin with http:// or https://."
          />
        </FieldGrid>
      </ActionForm>
    </StepPanel>
  );
}
