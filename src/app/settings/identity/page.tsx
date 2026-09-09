import { saveIdentity } from '@/app/settings/actions';
import { LogoField } from '@/app/settings/identity/logo/LogoField';
import { loadSettings, readOnlyNote } from '@/app/settings/load';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, ReadOnlyField, TextField } from '@/components/settings/Fields';
import { Notice } from '@/components/ui/Notice';
import { CompanyScopeNotice } from '@/components/settings/CompanyScopeNotice';
import { Section } from '@/components/settings/Section';

export const dynamic = 'force-dynamic';

const OWNER_ONLY = 'Editing the company identity is reserved to an owner.';

export default async function IdentitySettingsPage({
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

  return (
    <div className="flex flex-col gap-4">
      <CompanyScopeNotice
        companies={context.companies}
        companyId={context.companyId}
        basePath="/settings/identity"
      />
      {/*
       * None of this is built into the product: the software is configured
       * for a company, not written about one, so a second deployment changes
       * these seven fields and nothing else.
       */}
      <Section
        title="Identity and branding"
        description={<p>Every value here appears on documents a customer receives.</p>}
      >
        <ActionForm
          action={saveIdentity}
          submitLabel="Save identity"
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
              name="legalName"
              label="Legal name"
              required
              maxLength={200}
              defaultValue={org?.legalName}
              hint="The registered entity, including any suffix."
            />
            <TextField
              name="displayName"
              label="Display name"
              required
              maxLength={200}
              defaultValue={org?.displayName}
              hint="What the application heading, the browser tab and a quote letterhead say."
            />
            <TextField
              name="operatingName"
              label="Operating name"
              maxLength={200}
              defaultValue={org?.operatingName}
              hint="A trading name, if the company advertises under one. Left blank if not."
            />
            <TextField
              name="tagline"
              label="Tagline"
              maxLength={200}
              defaultValue={org?.tagline}
              hint="One line under the name on a document. Also the page description."
            />
            <TextField
              name="ownerName"
              label="Owner name"
              maxLength={200}
              defaultValue={org?.ownerName}
              hint="Signs the quote."
            />
            <TextField
              name="ownerTitle"
              label="Owner title"
              maxLength={100}
              defaultValue={org?.ownerTitle}
              hint="Printed under the signature."
            />
            <TextField
              name="brandColor"
              label="Brand colour"
              maxLength={7}
              pattern="^#[0-9a-fA-F]{6}$"
              defaultValue={org?.brandColor}
              placeholder="#RRGGBB"
              numeric
              // Replaces the accent colour across the whole application —
              // buttons, the active navigation item, focus rings — and the
              // hover and text variants derive from it.
              hint="Six-digit hex, or blank for the product default."
            />
            <ReadOnlyField
              label="Current accent"
              value={
                org?.brandColor ? (
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-block size-4 rounded-control border border-line-strong"
                      style={{ background: org.brandColor }}
                    />
                    <span className="num">{org.brandColor}</span>
                  </span>
                ) : (
                  'Product default'
                )
              }
              hint="A swatch of the stored value, so a typo is visible before a customer sees it."
            />
          </FieldGrid>
        </ActionForm>
      </Section>

      <Section
        title="Logo and favicon"
        description="Printed on the letterhead of every document, and shown in the browser tab."
      >
        <LogoField allowed={context.allowed} disabledNote={readOnlyNote(context, OWNER_ONLY)} />
        <div className="mt-4">
          {/* The column exists and the same PNG-or-JPEG restriction is the
              rule it will enforce, once wired up. */}
          <Notice tone="warning" title="The favicon upload is not wired yet">
            The logo above stores through the file store; the favicon does not yet.
            {org?.faviconFileId ? ' A favicon is already on file.' : ''}
          </Notice>
        </div>
      </Section>
    </div>
  );
}
