import { Readable } from 'node:stream';
import {
  type Rendering,
  type StoredType,
  extensionFor,
  isStoredType,
  renderingFor,
} from '@/lib/files/sniff';
import { activeFileRow, openStored, statStored } from '@/lib/files/store';

export const dynamic = 'force-dynamic';

/**
 * Serves one stored file, by id.
 *
 * By id from a UUID filename, never by `storage_path` (design section 7.5).
 * The only thing this route accepts from the caller is a UUID, which it looks
 * up: there is no path, no name and no extension in the request, so there is
 * nothing in it to traverse with.
 *
 * Authentication happens in `proxy.ts`, which covers every path that is not on
 * its short public list. This route is deliberately not on that list -- a
 * customer logo is tenant data.
 */

/** A year. Safe only because the URL contains the row id, which never changes meaning. */
const IMMUTABLE_MAX_AGE = 31_536_000;

/**
 * The download name.
 *
 * The stored name is display metadata that came from a client once, so what it
 * claims about the file's TYPE is a claim like any other: somebody can upload a
 * PDF called `receipt.png`. For a type the browser saves to disk that claim
 * would become the name on the filesystem, so the extension this application
 * decided from the bytes is appended when the name does not already carry it.
 * `receipt.png` lands as `receipt.png.pdf`, which is honest about both.
 *
 * Only for the attachment types. An inline image is never written to disk by
 * this response, and `photo.jpeg` becoming `photo.jpeg.jpg` would be noise.
 */
function downloadName(fileName: string, type: StoredType): string {
  if (renderingFor(type) === 'inline') return fileName;
  const extension = extensionFor(type);
  return fileName.toLowerCase().endsWith(extension) ? fileName : `${fileName}${extension}`;
}

/**
 * `filename` for the header, quoted safely, plus the RFC 5987 form for
 * anything outside ASCII.
 *
 * The stored name came from a client once, so it is escaped rather than
 * trusted: a quote or a newline in it would otherwise let the uploader inject
 * a second header parameter.
 *
 * The leading token is `inline` or `attachment` according to the type's own row
 * in `STORED_TYPES`, never according to anything in the request. It is the same
 * object the store consulted when it decided the file could be kept at all.
 */
function disposition(fileName: string, rendering: Rendering): string {
  const ascii = Array.from(fileName)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      const printable = code >= 0x20 && code < 0x7f;
      const quoteOrSlash = character === '"' || character === '\\';
      return printable && !quoteOrSlash ? character : '_';
    })
    .join('');
  return `${rendering}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const row = await activeFileRow(id);
  // One answer for three cases -- no such id, a voided row, a malformed id --
  // because they are the same answer. Voiding is this product's deletion, so a
  // voided file has to stop being served even though its bytes are still there.
  if (!row) return new Response('Not found', { status: 404 });

  // The allowlist, not the row. `mime_type` is data: it records what some
  // upload path sniffed, and a route that echoed it back would serve whatever
  // a future, looser upload path put there -- an SVG among it, which is the
  // cross-site scripting vector the upload restriction exists to close.
  //
  // The same object then decides HOW it goes out. A type this application
  // stores but does not render is sent as an attachment, so the row still
  // cannot be the policy in either direction.
  if (!isStoredType(row.mimeType)) return new Response('Not found', { status: 404 });
  const rendering = renderingFor(row.mimeType);

  // Rows outlive bytes: a database restored without its file volume has rows
  // whose images are genuinely gone, and that is a 404, not a 500.
  const sizeBytes = await statStored(row);
  if (sizeBytes === null) return new Response('Not found', { status: 404 });

  const body = Readable.toWeb(openStored(row)) as ReadableStream<Uint8Array>;

  return new Response(body, {
    headers: {
      'content-type': row.mimeType,
      'content-length': String(sizeBytes),
      // `inline` for an image a page displays; `attachment` for a PDF, which is
      // handed to the browser to save rather than opened in this origin. A PDF
      // can carry script, and a PDF viewer running on a document served from
      // here is running on a document of this origin -- the same reason an SVG
      // is not stored at all.
      'content-disposition': disposition(downloadName(row.fileName, row.mimeType), rendering),
      // private, not public. The bytes are tenant data behind Access, and a
      // shared cache holding a customer logo for a year is a cache serving one
      // deployment's branding from another's request.
      'cache-control': `private, max-age=${IMMUTABLE_MAX_AGE}, immutable`,
      // The content-type above was sniffed from the bytes; this stops the
      // browser sniffing its own second opinion and acting on it. It matters
      // more, not less, now that a stored type exists which must never be
      // rendered: without it a browser that decided a PDF looked like something
      // displayable could ignore the type this route stated.
      'x-content-type-options': 'nosniff',
    },
  });
}
