import { uploadLogo } from '@/app/settings/identity/logo/actions';
import {
  LOGO_ACCEPT,
  currentLogo,
  formatBytes,
  formatDimensions,
} from '@/app/settings/identity/logo/logo';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid } from '@/components/settings/Fields';
import { LOGO_MAX_BYTES } from '@/lib/files/store';

/**
 * The logo upload, and the logo already on file.
 *
 * A server component, so the current file is read on the server and the only
 * client code involved is the one thing that genuinely needs a browser:
 * reporting whether the upload worked. The field itself is a plain HTML file
 * input.
 */
export async function LogoField({
  allowed,
  disabledNote,
}: {
  allowed: boolean;
  disabledNote: React.ReactNode;
}) {
  const logo = await currentLogo();

  return (
    <ActionForm
      action={uploadLogo}
      submitLabel="Upload logo"
      // Not "Saving…". This is a file crossing the wire, which is the one
      // control in settings where the wait is long enough to be noticed and
      // long enough to be pressed twice.
      pendingLabel="Uploading…"
      disabled={!allowed}
      disabledNote={disabledNote}
      resetOnSuccess
    >
      <FieldGrid>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="t-small font-semibold">Current logo</p>
          {logo ? (
            <>
              <span className="flex w-fit items-center justify-center rounded-control border border-line-strong bg-surface-2 p-2">
                {/*
                  A plain img, not next/image. The optimiser fetches the source
                  through its own loader, which would have to reach this
                  route -- and the route is authenticated on purpose, because a
                  logo is tenant data. The file is already small enough to be a
                  letterhead, so there is nothing to optimise.

                  The src is the row id and nothing else: no path, no name, no
                  extension. That is what makes the URL safe to build from data.
                */}
                <img
                  src={`/api/files/${logo.row.id}`}
                  alt={`The logo currently on file, ${logo.row.fileName}`}
                  className="max-h-24 w-auto max-w-full"
                />
              </span>
              <p className="t-small text-subtle">
                <span className="num">{formatDimensions(logo.dimensions)}</span>
                {' · '}
                <span className="num">{formatBytes(logo.sizeBytes)}</span>
                {' · '}
                {logo.row.mimeType === 'image/png' ? 'PNG' : 'JPEG'}
                {' · '}
                {logo.row.fileName}
              </p>
            </>
          ) : (
            <p className="t-small text-subtle">
              None yet — documents print the company name until one is uploaded.
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="logo" className="t-small font-semibold">
            Replace with
          </label>
          <input
            id="logo"
            name="logo"
            type="file"
            accept={LOGO_ACCEPT}
            disabled={!allowed}
            aria-describedby="logo-hint"
            className={`field ${allowed ? '' : 'opacity-60'}`}
          />
          {/*
           * The file is identified by its contents rather than its name, so
           * renaming something .png will not get it past this. SVG is
           * refused deliberately: it can carry script, and one served from
           * this application's own origin would run with the same rights as
           * the application — a cross-site scripting vector on every page
           * that shows the logo.
           */}
          <p id="logo-hint" className="t-small text-subtle">
            PNG or JPEG, up to <span className="num">{formatBytes(LOGO_MAX_BYTES)}</span>.
          </p>
          {logo ? (
            <p className="t-small text-subtle">
              A replacement doesn&apos;t delete the old file — an already-sent quote still
              renders with its own.
            </p>
          ) : null}
        </div>
      </FieldGrid>
    </ActionForm>
  );
}
