'use server';

import { revalidatePath } from 'next/cache';
import { requireCapability } from '@/app/settings/actor';
import { formatBytes, pointLogoAt } from '@/app/settings/identity/logo/logo';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import {
  LOGO_MAX_BYTES,
  ORGANIZATION_ENTITY_ID,
  type SaveResult,
  saveFile,
} from '@/lib/files/store';

/**
 * Uploading the company logo.
 *
 * The order here is the whole design of the action: check the capability
 * before reading a single field, then let the store decide what the file IS
 * from its bytes, and only then touch the organization row. Every refusal
 * comes back as a result rather than a throw, because a thrown error in a
 * server action reaches the browser as an opaque digest and the owner needs to
 * read which of his three files was the wrong kind.
 */

const LOGO_FIELD = { field: 'logo', label: 'Logo' };

/** The sentence for a refusal, naming what arrived rather than only what was wanted. */
function refusalFor(result: Extract<SaveResult, { ok: false }>): ActionResult {
  if (result.reason === 'empty') {
    return refused('That file is empty.', [
      { ...LOGO_FIELD, message: 'contained no bytes at all. Check the file and try again.' },
    ]);
  }

  if (result.reason === 'too-large') {
    return refused(`That file is over the ${formatBytes(result.maxBytes)} limit for a logo.`, [
      {
        ...LOGO_FIELD,
        message:
          'is too large. A letterhead logo needs far less than this; export it smaller rather than' +
          ' raising the limit.',
      },
    ]);
  }

  if (result.looksLike === 'an SVG') {
    return refused('An SVG cannot be used as the logo.', [
      {
        ...LOGO_FIELD,
        message:
          'is an SVG. That is refused deliberately: an SVG can carry script, and one served from' +
          ' this application’s own origin would run with the application’s rights on' +
          ' every page that shows the logo. Export it as a PNG or a JPEG.',
      },
    ]);
  }

  const looks = result.looksLike ? ` It looks like ${result.looksLike}.` : '';
  return refused('That file is not a PNG or a JPEG.', [
    {
      ...LOGO_FIELD,
      message:
        `is not a PNG or a JPEG.${looks} The contents are checked rather than the name, so` +
        ' renaming a file .png does not change what is inside it.',
    },
  ]);
}

export async function uploadLogo(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('organization.edit');
  if (!guard.ok) return guard.result;

  const source = formData.get('logo');
  // A form submitted with the picker untouched still sends the field, as an
  // empty file with an empty name. That is a person who pressed the button too
  // early, not a broken request.
  if (!(source instanceof File) || source.size === 0 || source.name === '') {
    return refused('No file was chosen.', [
      { ...LOGO_FIELD, message: 'needs a PNG or JPEG file to be selected first.' },
    ]);
  }

  const stored = await saveFile({
    entityType: 'organization',
    entityId: ORGANIZATION_ENTITY_ID,
    source,
    uploadedBy: guard.actor.id,
    maxBytes: LOGO_MAX_BYTES,
  });
  if (!stored.ok) return refusalFor(stored);

  const replacement = await pointLogoAt(stored.file.id, guard.actor.id);
  if (!replacement) {
    // The bytes and the row survive this. Nothing is deleted, and the file
    // becomes the logo as soon as there is a row to point at it.
    return refused(
      'There is no organization record yet. Run first-run setup before uploading a logo.',
    );
  }

  // The root layout reads the organization row for the tab title, the heading
  // and the accent colour, so a branding change has to invalidate the layout
  // and not only the section that produced it.
  revalidatePath('/', 'layout');

  const replaced = replacement.previousVoided
    ? ' The logo it replaces is voided rather than deleted, so documents already sent still render.'
    : '';
  return saved(`Logo saved: ${stored.file.fileName}.${replaced}`);
}
