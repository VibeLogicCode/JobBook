import { saveCompanyStep } from '@/app/setup/actions';
import { requireOpenSetup } from '@/app/setup/guard';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, TextField } from '@/components/settings/Fields';
import { Notice } from '@/components/ui/Notice';
import { StepPanel } from '@/components/setup/StepPanel';

export const dynamic = 'force-dynamic';

/**
 * Step 1. The only step that CREATES the organization row; every later one
 * updates it.
 *
 * Every placeholder here is a description of the field, never an example of a
 * value. That rule is enforced by a guard test, and this screen is where
 * breaking it would do the most damage: a placeholder showing a real company's
 * name reads to the owner as "this is what mine should look like", and ships
 * to every other company that buys the product. There is no default company,
 * no default phone number and no default tax rate anywhere in this wizard.
 */
export default async function CompanyStepPage() {
  const gate = await requireOpenSetup('company');
  const org = gate.org;

  return (
    <StepPanel slug="company" gate={gate}>
      <ActionForm action={saveCompanyStep} submitLabel="Save company">
        <FieldGrid>
          <TextField
            name="legalName"
            label="Legal name"
            required
            maxLength={200}
            defaultValue={org?.legalName}
            placeholder="Registered entity name"
            hint="The registered entity, including any suffix. Contracts and tax documents use this one."
          />
          <TextField
            name="displayName"
            label="Display name"
            required
            maxLength={200}
            defaultValue={org?.displayName}
            placeholder="What customers call you"
            hint="The application heading, the browser tab and a quote letterhead all say this."
          />
          <TextField
            name="operatingName"
            label="Operating name"
            maxLength={200}
            defaultValue={org?.operatingName}
            placeholder="Trading name, if any"
            hint="A trading name, if the company advertises under one. Leave it blank if not."
          />
          <TextField
            name="tagline"
            label="Tagline"
            maxLength={200}
            defaultValue={org?.tagline}
            placeholder="One line under the name"
            hint="Printed under the name on a document, and used as the page description."
          />
          <TextField
            name="ownerName"
            label="Owner name"
            maxLength={200}
            defaultValue={org?.ownerName}
            placeholder="Who signs a quote"
            hint="Signs the quote. This is a name on a document, not an account — the account is step 6."
          />
          <TextField
            name="ownerTitle"
            label="Owner title"
            maxLength={100}
            defaultValue={org?.ownerTitle}
            placeholder="Title under the signature"
            hint="Printed under the signature. A company decides its own words for this."
          />
        </FieldGrid>

        <Notice tone="info" title="The logo comes later">
          Branding is a file upload, and uploads need the file store, which is not part of this
          wizard. The brand colour and both image slots are on the identity screen under
          Settings once you are through here — nothing about them blocks quoting.
        </Notice>
      </ActionForm>
    </StepPanel>
  );
}
