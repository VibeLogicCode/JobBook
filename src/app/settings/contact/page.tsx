import { saveContact } from '@/app/settings/actions';
import { loadSettings, readOnlyNote } from '@/app/settings/load';
import { CompanyScopeNotice } from '@/components/settings/CompanyScopeNotice';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, TextField } from '@/components/settings/Fields';
import { Section } from '@/components/settings/Section';

export const dynamic = 'force-dynamic';

const OWNER_ONLY = 'Editing the contact block is reserved to an owner.';

export default async function ContactSettingsPage({
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

  // The customer table carries no province default of its own — a default
  // in the schema would be a guess about a country.
  return (
    <div className="flex flex-col gap-4">
      <CompanyScopeNotice
        companies={context.companies}
        companyId={context.companyId}
        basePath="/settings/contact"
      />

    <Section
      title="Contact"
      description={
        <p>Prints under the letterhead. The province here also defaults new customer records.</p>
      }
    >
      <ActionForm
        action={saveContact}
        submitLabel="Save contact details"
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
            name="addressLine1"
            label="Address line 1"
            maxLength={200}
            defaultValue={org?.addressLine1}
          />
          <TextField
            name="addressLine2"
            label="Address line 2"
            maxLength={200}
            defaultValue={org?.addressLine2}
            hint="A unit or suite, if there is one."
          />
          <TextField name="city" label="City" maxLength={100} defaultValue={org?.city} />
          <TextField
            name="province"
            label="Province or state"
            maxLength={100}
            defaultValue={org?.province}
            // A list would be a country assumption.
            hint="Written as it should print — not validated against a list."
          />
          <TextField
            name="postalCode"
            label="Postal or ZIP code"
            maxLength={20}
            defaultValue={org?.postalCode}
          />
          <TextField
            name="country"
            label="Country"
            maxLength={100}
            defaultValue={org?.country}
          />
          <TextField
            name="phone"
            label="Phone"
            type="tel"
            inputMode="tel"
            maxLength={40}
            defaultValue={org?.phone}
            hint="Formatted the way it should appear on a document."
          />
          <TextField
            name="altPhone"
            label="Alternate phone"
            type="tel"
            inputMode="tel"
            maxLength={40}
            defaultValue={org?.altPhone}
            hint="A second number, if the company publishes one."
          />
          <TextField
            name="email"
            label="Email"
            type="email"
            inputMode="email"
            maxLength={200}
            defaultValue={org?.email}
            hint="Where a customer replies. The application sends no mail itself."
          />
          <TextField
            name="website"
            label="Website"
            type="url"
            inputMode="url"
            maxLength={200}
            defaultValue={org?.website}
            hint="Including http:// or https://, so the printed address is a working one."
          />
        </FieldGrid>
      </ActionForm>
    </Section>
    </div>
  );
}
