'use server';

import { isNull, not, or } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { syncState } from '@/db/schema';
import { requireCapability } from '@/app/settings/actor';
import { type ActionResult, saved } from '@/app/settings/result';
import { checkbox, formValues, invalid, requiredInt } from '@/app/settings/validate';
import {
  LIBRARY_KINDS,
  type LibraryKind,
  MAX_INTERVAL_MINUTES,
  MAX_STALENESS_HOURS,
  MIN_INTERVAL_MINUTES,
  MIN_STALENESS_HOURS,
  SYNC_FIELD_LABELS,
  SYNC_SETTING_KEYS,
  libraryKey,
  libraryNameSchema,
  listPrefixSchema,
  readSyncConfig,
  siteUrlSchema,
  writeSyncConfig,
} from '@/lib/sync/config';

/**
 * The mirror's configuration, written from the screen.
 *
 * Four actions rather than one form, because the on/off decision is a different
 * kind of decision from the library names and must not be made by accident
 * while correcting a typo in one. Each validates with zod and returns the typed
 * result the rest of the settings area returns -- a thrown error in a server
 * action reaches the browser as an opaque digest, which tells the owner nothing
 * about the address he mistyped.
 *
 * Nothing here touches a credential. The tenant id, client id, certificate path
 * and thumbprint are environment variables and are not offered as fields
 * anywhere on this screen, because a form writes to the database and the
 * database is mirrored to SharePoint and dumped into every backup (design
 * sections 7.0 and 7.6).
 */

const PATH = '/settings/sync';

/**
 * A blank text input means "clear this", not "the empty string".
 *
 * The union is ordered so the blank case is decided first; the field schema
 * then sees only a value somebody actually typed, and its error message lands
 * on the right form control because the path stays inside the object.
 */
const blankOr = <T extends z.ZodType>(schema: T) =>
  z.union([z.literal('').transform(() => null), schema]);

// ---------------------------------------------------------------------------
// On and off
// ---------------------------------------------------------------------------

const enabledSchema = z.object({ enabled: checkbox });

/**
 * Switches the mirror on or off.
 *
 * Two things this action deliberately does NOT do:
 *
 * - It cannot start a sync. `SHAREPOINT_SYNC_ENABLED` in the container is the
 *   hard gate (section 7.0) and a database row can never override it, which is
 *   what keeps a dump restored from a mirroring tenant from pushing this
 *   company's records to a site it has no credential for.
 * - It does not tear anything down. Disabling leaves the existing SharePoint
 *   data in place; it stops updating. Nothing in this product deletes.
 *
 * What it does do on the way ON is reset the keyset cursors, because section
 * 7.0 says enabling triggers a full backfill: every row is pushed again. That
 * is safe to repeat -- every write is an idempotent upsert keyed through
 * `sp_item_map` -- and it is the only way a mirror that was off for a month
 * catches up on what it missed, since an unchanged row is never resent. The
 * reset nulls two cursor columns; it deletes no row and loses no history.
 */
export async function setMirrorEnabled(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('sync.configure');
  if (!guard.ok) return guard.result;

  const parsed = enabledSchema.safeParse(formValues(formData));
  if (!parsed.success) {
    return invalid(parsed.error, { enabled: SYNC_FIELD_LABELS[SYNC_SETTING_KEYS.enabled]! });
  }

  const wanted = parsed.data.enabled;

  const backfilled = await db.transaction(async (tx) => {
    const before = await readSyncConfig(tx);
    // A read that failed on some other field must not block the toggle: the
    // switch that stops data leaving the machine has to work even when the rest
    // of the configuration is in a state this module refuses to parse.
    const wasEnabled = before.ok ? before.config.enabled : false;

    await writeSyncConfig({ enabled: wanted }, tx);

    if (wanted && !wasEnabled) {
      const reset = await tx
        .update(syncState)
        .set({ cursorUpdatedAt: null, cursorId: null })
        .where(or(not(isNull(syncState.cursorUpdatedAt)), not(isNull(syncState.cursorId))))
        .returning({ listName: syncState.listName });
      return reset.length;
    }
    return 0;
  });

  revalidatePath(PATH);

  if (!wanted) {
    return saved(
      'The mirror is off. Whatever is already in SharePoint stays there and stops updating — ' +
        'nothing is torn down. If no USB backup destination is configured either, this ' +
        "company's records now exist on one disk.",
    );
  }

  return saved(
    'The mirror is on as far as this database is concerned' +
      (backfilled > 0
        ? `, and ${backfilled} list cursor${backfilled === 1 ? '' : 's'} ${
            backfilled === 1 ? 'was' : 'were'
          } reset so the first run pushes every row.`
        : ', and the first run will push every row.') +
      ' Nothing has been sent: the sync job is not built yet, and the container also has to ' +
      'carry SHAREPOINT_SYNC_ENABLED and the credential before anything can be.',
  );
}

// ---------------------------------------------------------------------------
// Site and list names
// ---------------------------------------------------------------------------

const siteLabels = {
  siteUrl: SYNC_FIELD_LABELS[SYNC_SETTING_KEYS.siteUrl]!,
  listPrefix: SYNC_FIELD_LABELS[SYNC_SETTING_KEYS.listPrefix]!,
};

const siteSchema = z.object({
  siteUrl: blankOr(siteUrlSchema),
  listPrefix: listPrefixSchema,
});

/**
 * Where the mirror writes, and what the lists are called there.
 *
 * The site address is the one field on this screen a sync cannot be run
 * without, which is why clearing it is allowed and reported as a state rather
 * than refused: an owner who is moving sites should be able to empty the field
 * without first switching the mirror off.
 */
export async function saveMirrorSite(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('sync.configure');
  if (!guard.ok) return guard.result;

  const parsed = siteSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, siteLabels);

  await writeSyncConfig(
    { siteUrl: parsed.data.siteUrl, listPrefix: parsed.data.listPrefix },
    db,
  );
  revalidatePath(PATH);

  if (parsed.data.siteUrl === null) {
    return saved(
      'The site address is cleared. The mirror has nowhere to write, so it is off in practice ' +
        'whatever the switch above says.',
    );
  }

  return saved(
    `The mirror is pointed at ${parsed.data.siteUrl}. Provisioning creates the lists there; ` +
      'it is run by hand against the tenant, from a workstation, not by this application.',
  );
}

// ---------------------------------------------------------------------------
// Document libraries
// ---------------------------------------------------------------------------

const libraryLabels = Object.fromEntries(
  LIBRARY_KINDS.map((kind) => [kind, SYNC_FIELD_LABELS[libraryKey(kind)]!]),
);

const librarySchema = z.object(
  Object.fromEntries(LIBRARY_KINDS.map((kind) => [kind, libraryNameSchema])) as Record<
    LibraryKind,
    typeof libraryNameSchema
  >,
);

/**
 * The document library names.
 *
 * Six names and not one setting, because each library holds a different kind of
 * file with different metadata and a different audience -- the accountant
 * filters receipts by project, and the encrypted dumps are nobody's reading
 * material. Attachments live in libraries rather than as list attachments
 * because Microsoft Graph cannot read or write SharePoint list item attachments
 * at all: there is no `attachments` relationship on `listItem` in v1.0
 * (section 7.5).
 *
 * Renaming one here does not rename it in SharePoint. Provisioning creates
 * lists and libraries and is idempotent, so a rename means re-running it, and
 * the old library stays with whatever is in it.
 */
export async function saveMirrorLibraries(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('sync.configure');
  if (!guard.ok) return guard.result;

  const parsed = librarySchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, libraryLabels);

  await writeSyncConfig({ libraries: parsed.data }, db);
  revalidatePath(PATH);

  return saved(
    'Library names saved. Re-run provisioning against the site to create or rename them — ' +
      'the template is idempotent, so running it again is safe, and a library that was ' +
      'renamed stays behind with its contents.',
  );
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

const scheduleLabels = {
  intervalMinutes: SYNC_FIELD_LABELS[SYNC_SETTING_KEYS.intervalMinutes]!,
  stalenessHours: SYNC_FIELD_LABELS[SYNC_SETTING_KEYS.stalenessHours]!,
};

const scheduleSchema = z.object({
  intervalMinutes: requiredInt(MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES),
  stalenessHours: requiredInt(MIN_STALENESS_HOURS, MAX_STALENESS_HOURS),
});

/**
 * How often the mirror runs, and how long a silence is tolerated.
 *
 * The interval is the recovery point objective (section 7.3): a four-hour
 * interval means losing up to four hours of quoting work when the hardware
 * fails. The threshold is what turns silence into a verdict -- and it is a
 * configured number rather than a derived one so that a deployment on a slow
 * link can widen it without also widening its exposure.
 */
export async function saveMirrorSchedule(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('sync.configure');
  if (!guard.ok) return guard.result;

  const parsed = scheduleSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, scheduleLabels);

  const { intervalMinutes, stalenessHours } = parsed.data;
  await writeSyncConfig({ intervalMinutes, stalenessHours }, db);
  revalidatePath(PATH);

  const twiceTheInterval = (intervalMinutes * 2) / 60;
  const note =
    stalenessHours < twiceTheInterval
      ? ` Note that ${stalenessHours} hours is less than twice the interval, so a single ` +
        'missed run will report as stale.'
      : '';

  return saved(
    `Every ${intervalMinutes} minutes, stale after ${stalenessHours} hours without a ` +
      `success.${note} Nothing is scheduled yet: the sync job is not built.`,
  );
}
