import { Readable } from 'node:stream';
import { isServableType } from '@/lib/files/sniff';
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
 * `filename` for the header, quoted safely, plus the RFC 5987 form for
 * anything outside ASCII.
 *
 * The stored name came from a client once, so it is escaped rather than
 * trusted: a quote or a newline in it would otherwise let the uploader inject
 * a second header parameter.
 */
function disposition(fileName: string): string {
  const ascii = Array.from(fileName)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      const printable = code >= 0x20 && code < 0x7f;
      const quoteOrSlash = character === '"' || character === '\\';
      return printable && !quoteOrSlash ? character : '_';
    })
    .join('');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
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
  if (!isServableType(row.mimeType)) return new Response('Not found', { status: 404 });

  // Rows outlive bytes: a database restored without its file volume has rows
  // whose images are genuinely gone, and that is a 404, not a 500.
  const sizeBytes = await statStored(row);
  if (sizeBytes === null) return new Response('Not found', { status: 404 });

  const body = Readable.toWeb(openStored(row)) as ReadableStream<Uint8Array>;

  return new Response(body, {
    headers: {
      'content-type': row.mimeType,
      'content-length': String(sizeBytes),
      // inline: this is an image a page displays, not a download.
      'content-disposition': disposition(row.fileName),
      // private, not public. The bytes are tenant data behind Access, and a
      // shared cache holding a customer logo for a year is a cache serving one
      // deployment's branding from another's request.
      'cache-control': `private, max-age=${IMMUTABLE_MAX_AGE}, immutable`,
      // The content-type above was sniffed from the bytes; this stops the
      // browser sniffing its own second opinion and acting on it.
      'x-content-type-options': 'nosniff',
    },
  });
}
