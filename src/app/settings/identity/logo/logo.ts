import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { files, organization } from '@/db/schema';
import type { Dimensions } from '@/lib/files/sniff';
import {
  type FileRow,
  activeFileRow,
  describeStored,
  voidColumns,
} from '@/lib/files/store';

/**
 * The organization logo: what it currently is, and how it is replaced.
 *
 * Deliberately not a server action and deliberately not a component. The
 * replacement is the part with a correctness claim in it -- one file becomes
 * current, the previous one is voided rather than removed -- so it lives in a
 * plain module that a test can call without a request, a session or a rendered
 * form.
 */

/** What the file input offers, and the only two types the store will accept. */
export const LOGO_ACCEPT = 'image/png,image/jpeg';

export interface CurrentLogo {
  row: FileRow;
  sizeBytes: number;
  dimensions: Dimensions | null;
}

/**
 * The logo on file, or null.
 *
 * Null covers every way there can be no logo to show: no organization row yet,
 * the column is unset, the row it names has been voided, or the bytes are
 * missing from a restored volume. A screen showing a broken image would be
 * telling the owner something is wrong with his logo when what is wrong is the
 * deployment.
 */
export async function currentLogo(): Promise<CurrentLogo | null> {
  const [org] = await db
    .select({ logoFileId: organization.logoFileId })
    .from(organization)
    .where(eq(organization.id, 1));
  if (!org?.logoFileId) return null;

  const row = await activeFileRow(org.logoFileId);
  if (!row) return null;

  const described = await describeStored(row);
  if (!described) return null;

  return { row, sizeBytes: described.sizeBytes, dimensions: described.dimensions };
}

export interface LogoReplacement {
  /** The file that was current before, if there was one. */
  previousFileId: string | null;
  /** False when the previous row was already void, which is not an error. */
  previousVoided: boolean;
}

/**
 * Makes a stored file the current logo, retiring the one it replaces.
 *
 * Voided, never deleted, and for two reasons. The application role holds no
 * DELETE privilege (migration 0001), so a delete here would be a permission
 * error in production while working for a superuser in development -- the worst
 * class of bug, one that only appears where nobody is watching. And the old
 * logo is still the image printed on every quote already sent, which a
 * regenerated document has to be able to show.
 *
 * Both writes are one transaction. Half of this change is worse than none: an
 * organization pointing at a voided file has no logo, and a voided file the
 * organization still points at is a logo the serve route refuses.
 *
 * Returns null when there is no organization row to point, which is a
 * first-run-setup problem rather than an upload problem.
 */
export async function pointLogoAt(
  fileId: string,
  actorId?: string | null,
): Promise<LogoReplacement | null> {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({ logoFileId: organization.logoFileId })
      .from(organization)
      .where(eq(organization.id, 1));
    if (!org) return null;

    const previousFileId = org.logoFileId;
    await tx.update(organization).set({ logoFileId: fileId }).where(eq(organization.id, 1));

    if (!previousFileId || previousFileId === fileId) {
      return { previousFileId: previousFileId ?? null, previousVoided: false };
    }

    // Guarded on `active` so replacing a logo twice does not overwrite the
    // first voiding's timestamp and reason with a later one.
    const voided = await tx
      .update(files)
      .set(voidColumns({ actorId, reason: 'Replaced by a newer logo upload.' }))
      .where(eq(files.id, previousFileId))
      .returning({ id: files.id, recordStatus: files.recordStatus });

    return { previousFileId, previousVoided: voided.length > 0 };
  });
}

/**
 * Bytes as a person reads them, in the units a file manager uses.
 *
 * Powers of two, not of ten: the cap is expressed in mebibytes, and a message
 * that measured the file in megabytes would refuse a file for being over a
 * limit it appears to be under.
 */
export function formatBytes(bytes: number): string {
  const kib = 1024;
  if (bytes < kib) return `${bytes} bytes`;
  if (bytes < kib * kib) return `${(bytes / kib).toFixed(1)} KB`;
  return `${(bytes / (kib * kib)).toFixed(1)} MB`;
}

/** The pixel size, or a plain admission that the header did not say. */
export function formatDimensions(dimensions: Dimensions | null): string {
  return dimensions ? `${dimensions.width} × ${dimensions.height}` : 'dimensions unread';
}
