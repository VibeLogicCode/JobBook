import { saveIdentity } from '@/app/settings/actions';
import { loadSettings, readOnlyNote } from '@/app/settings/load';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, ReadOnlyField, TextField } from '@/components/settings/Fields';
import { Notice } from '@/components/settings/Notice';
import { Section } from '@/components/settings/Section';

export const dynamic = 'force-dynamic';

const OWNER_ONLY = 'Editing the company identity is reserved to an owner.';

export default async function IdentitySettingsPage() {
  const context = await loadSettings('organization.edit');
  const org = context.org;

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Identity and branding"
        description={
          <>
            <p>
              Every value here appears on documents a customer receives. None of it is built
              into the product: the software is configured for a company, not written about
              one, so a second deployment changes these seven fields and nothing else.
            </p>
          </>
        }
      >
        <ActionForm
          action={saveIdentity}
          submitLabel="Save identity"
          disabled={!context.allowed}
          disabledNote={readOnlyNote(context, OWNER_ONLY)}
        >
          <FieldGrid>
            <TextField
              name="legalName"
              label="Legal name"
              required
              maxLength={200}
              defaultValue={org?.legalName}
              hint="The registered entity, including any suffix. Contracts and tax documents use this."
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
              hint="Printed under the signature. A company decides its own words for this."
            />
            <TextField
              name="brandColor"
              label="Brand colour"
              maxLength={7}
              pattern="^#[0-9a-fA-F]{6}$"
              defaultValue={org?.brandColor}
              placeholder="#RRGGBB"
              numeric
              hint={
                <>
                  Six-digit hex. It replaces the accent colour across the whole application —
                  buttons, the active navigation item, focus rings — and the hover and text
                  variants derive from it. Leave it blank for the product default.
                </>
              }
            />
            <ReadOnlyField
              label="Current accent"
              value={
                org?.brandColor ? (
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="inline-block size-4 rounded-[4px] border border-line-strong"
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
        {/*
          Left disabled rather than faked. The upload needs the file store --
          a row in `files` plus a byte range on local disk, served by id from a
          UUID filename -- which this screen does not own. A field that
          accepted a file and dropped it would be worse than one that says so.
        */}
        <FieldGrid>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label htmlFor="logo" className="t-small font-semibold">
              Logo
            </label>
            <input
              id="logo"
              name="logo"
              type="file"
              disabled
              accept="image/png,image/jpeg"
              aria-describedby="logo-hint"
              className="field opacity-60"
            />
            <p id="logo-hint" className="t-small text-subtle">
              PNG or JPEG. SVG is refused deliberately: an SVG can carry script, and one
              served from this application&apos;s own origin would run with the same rights as
              the application — a cross-site scripting vector on every page that shows the
              logo.
            </p>
          </div>
        </FieldGrid>
        <div className="mt-4">
          <Notice tone="warning" title="Upload is not wired yet">
            Storing the file needs the file store, which is not part of this screen. The
            columns exist and the restriction above is the rule the upload will enforce.
            {org?.logoFileId ? ' A logo is already on file for this deployment.' : ''}
            {org?.faviconFileId ? ' A favicon is already on file.' : ''}
          </Notice>
        </div>
      </Section>
    </div>
  );
}
