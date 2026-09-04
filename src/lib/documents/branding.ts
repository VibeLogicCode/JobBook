import { readFile, stat } from 'node:fs/promises';
import { absolutePathOf, activeFileRow } from '@/lib/files/store';

/**
 * The tenant's logo, as a data URI, for a generated document.
 *
 * Inlined rather than linked, and this is a requirement rather than an
 * optimisation. Headless Chromium renders the print page over localhost
 * carrying only `INTERNAL_RENDER_SECRET`; `/api/files/[id]` is authenticated
 * like every other route, so an `<img src="/api/files/...">` in a document
 * would fetch a 401 and the customer would receive a contract with a broken
 * image where the letterhead should be.
 *
 * A data URI also makes the PDF self-contained, which matters for a document
 * that gets emailed on and opened somewhere with no access to this server at
 * all.
 */

/** Above this, a logo bloats every page of every document. */
const MAX_INLINE_BYTES = 512 * 1024;

export async function logoDataUri(fileId: string | null): Promise<string | null> {
  if (!fileId) return null;

  try {
    const row = await activeFileRow(fileId);
    if (!row) return null;

    // Only the two types the upload path accepts. A document is not the place
    // to discover that some other route stored something else.
    if (row.mimeType !== 'image/png' && row.mimeType !== 'image/jpeg') return null;

    const path = absolutePathOf(row);
    const info = await stat(path);
    if (info.size > MAX_INLINE_BYTES) return null;

    const bytes = await readFile(path);
    return `data:${row.mimeType};base64,${bytes.toString('base64')}`;
  } catch {
    // A missing file must not stop a quote printing. The document loses its
    // letterhead image and keeps every word of its content, which is the right
    // way round for something a customer is about to sign.
    return null;
  }
}
