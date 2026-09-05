import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import type { entityTypeEnum } from '@/db/enums';
import { files } from '@/db/schema';
import {
  type Dimensions,
  type StoredType,
  describeUnacceptable,
  extensionFor,
  isInlineType,
  readDimensions,
  sniffType,
} from '@/lib/files/sniff';

/**
 * Local file storage: bytes on disk, one `files` row each.
 *
 * Local disk is authoritative and is what the application serves (design
 * section 7.5). Two rules from that section are load-bearing in every function
 * here:
 *
 * 1. A file is served BY ID from a UUID filename, never by `storage_path`. The
 *    path is an implementation detail of this module; no URL, form field or
 *    template ever contains one, so a request cannot name a file the database
 *    does not already know about.
 * 2. The stored name is derived from the SNIFFED type and a fresh UUID, never
 *    from the client filename. That name is display metadata and nothing else.
 * 3. WHAT may be stored is the sniff's answer intersected with the list the
 *    CALLER passed. `sniff.ts` says what this application knows how to store at
 *    all; a caller says which of those its own field takes. A receipt takes a
 *    PDF because a supplier emails invoices as PDFs; a logo does not, because a
 *    logo is rendered into a page and a PDF is deliberately never rendered into
 *    one. Widening the store must not widen every field that uses it, and the
 *    list is a required argument so a new caller has to answer the question.
 *
 * Nothing here deletes. The application role holds no DELETE privilege
 * (migration 0001), so an accidental delete is a permission error rather than a
 * destroyed record; superseded files are voided and their bytes stay put.
 *
 * The read calls below carry `turbopackIgnore`. The bundler sees a path it
 * cannot resolve statically and, assuming it is a build input, traces the whole
 * project into the standalone output -- the source tree and `public/` with it.
 * These paths are runtime data on a mounted volume that does not exist at build
 * time, so there is nothing to trace, and the marker says so.
 */

export type EntityType = (typeof entityTypeEnum.enumValues)[number];

/** The volume the container mounts, created and chowned in the Dockerfile. */
const CONTAINER_ROOT = '/data/files';

/**
 * Where the bytes live.
 *
 * Read per call rather than captured at module load: a test points this at a
 * scratch directory, and a constant frozen at import time would have every
 * suite writing into whichever root happened to be configured first.
 */
export function filesRoot(): string {
  const configured = process.env.FILES_ROOT?.trim();
  if (configured) return path.resolve(configured);
  // In development there is no /data volume, and on Windows that path is not
  // even meaningful. A directory beside the source tree keeps uploads with the
  // checkout they belong to.
  if (process.env.NODE_ENV === 'production') return CONTAINER_ROOT;
  return path.resolve(process.cwd(), '.data', 'files');
}

export class PathEscapeError extends Error {
  constructor(relative: string) {
    super(`refusing a storage path that leaves the file root: ${relative}`);
    this.name = 'PathEscapeError';
  }
}

/**
 * An absolute path for a stored file, proven to be inside the root.
 *
 * Every path this module writes is machine-built from a UUID, so in the code as
 * it stands this check cannot fire. It is here anyway, at the one place that
 * turns a relative path into an absolute one, because having the check at the
 * boundary is what makes a future caller with a less careful path harmless
 * rather than a directory traversal.
 */
export function resolveWithin(root: string, relative: string): string {
  if (relative.includes('\0')) throw new PathEscapeError(relative);
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  // path.relative, not a string prefix: it normalises separators and cannot be
  // fooled by a sibling directory whose name starts with the root name.
  const inside = path.relative(base, target);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new PathEscapeError(relative);
  }
  return target;
}

/** A logo is a letterhead image, not a photograph. Two megabytes is generous for one. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The `entity_id` for a file belonging to the tenant itself.
 *
 * NULL, not a sentinel. `organization` has an integer primary key by design
 * (CHECK id = 1), so there is no UUID to point at -- and the nil UUID this was
 * originally is the kind of value somebody later joins on, because it looks
 * like an id, it is unique, and it references nothing. `entity_type` already
 * identifies the table, and there is only ever one row in it.
 */
export const ORGANIZATION_ENTITY_ID = null;

export type FileRow = typeof files.$inferSelect;

export interface StoredFile {
  id: string;
  entityType: EntityType;
  entityId: string | null;
  fileName: string;
  mimeType: StoredType;
  sizeBytes: number;
  /** Relative to the root, so moving the volume does not rewrite every row. */
  storagePath: string;
  dimensions: Dimensions | null;
}

export type SaveResult =
  | { ok: true; file: StoredFile }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'too-large'; maxBytes: number }
  /** `looksLike` is null when the bytes match nothing we recognise. */
  | { ok: false; reason: 'unsupported-type'; looksLike: string | null };

/**
 * The shape of an upload, which a web `File` satisfies.
 *
 * Structural rather than `File` so the store does not depend on the browser
 * types, and deliberately WITHOUT a `size` property: a size read before the
 * bytes are counted is a number to be checked against, and the point of the
 * capped read below is that no such number is trusted.
 */
export interface UploadSource {
  name: string;
  stream(): ReadableStream<Uint8Array>;
}

export interface SaveFileInput {
  entityType: EntityType;
  entityId: string | null;
  source: UploadSource;
  /** The `users` row that uploaded it, when a request has an actor. */
  uploadedBy?: string | null;
  maxBytes: number;
  /**
   * The stored types THIS field takes, which is a subset of what the store
   * knows. Required, not defaulted: a default would silently hand every future
   * caller whatever the widest set happens to be on the day it is written.
   */
  accept: readonly StoredType[];
}

/**
 * Reads at most `cap + 1` bytes and reports whether it stopped early.
 *
 * The extra byte is the whole trick: it is the smallest amount of evidence that
 * proves the file is over the limit, so a hundred-megabyte upload is refused
 * having buffered two megabytes rather than after the process exhausted its
 * heap trying to weigh it.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ bytes: Uint8Array; overCap: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total <= cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const room = cap + 1 - total;
      const slice = value.length <= room ? value : value.subarray(0, room);
      chunks.push(slice);
      total += slice.length;
    }
  } finally {
    // Releases the producer whether we stopped at the cap or ran to the end.
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, overCap: total > cap };
}

/**
 * The client filename, reduced to something safe to show and to store in a text
 * column.
 *
 * This value never reaches the filesystem, so it is not a path defence: it is a
 * display defence. A name carrying directory separators, control characters or
 * a kilobyte of padding renders badly in a table and worse in a response
 * header.
 */
function displayName(raw: string, type: StoredType): string {
  const lastSegment = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = Array.from(lastSegment)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, 200);
  return cleaned === '' || cleaned === '.' || cleaned === '..'
    ? `upload${extensionFor(type)}`
    : cleaned;
}

/**
 * Sniffs, stores, and records one file.
 *
 * Order matters. The UUID is generated here and the bytes are written before
 * the row is inserted, so a failed insert leaves an unreferenced file, which
 * nothing serves because serving starts from a row. The other order leaves a
 * row pointing at bytes that were never written, and a database whose rows
 * point at missing images is the half-recovery the design warns about
 * (section 8).
 */
export async function saveFile(input: SaveFileInput): Promise<SaveResult> {
  const { bytes, overCap } = await readCapped(input.source.stream(), input.maxBytes);

  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (overCap) return { ok: false, reason: 'too-large', maxBytes: input.maxBytes };

  // Two questions, in this order and both from the bytes. What IS this, and is
  // that one of the types this field takes? A PDF arriving at the logo field
  // fails the second, and `describeUnacceptable` still names it, so the refusal
  // reads "it looks like a PDF" rather than "it is not a PNG or a JPEG" about a
  // file the store elsewhere accepts.
  const mimeType = sniffType(bytes);
  if (!mimeType || !input.accept.includes(mimeType)) {
    return { ok: false, reason: 'unsupported-type', looksLike: describeUnacceptable(bytes) };
  }

  const id = randomUUID();
  // One directory per entity type, matching the SharePoint library the mirror
  // routes each file to. The filename is the row id, which is why the serve
  // route needs nothing from the client except that id.
  const storagePath = path.posix.join(input.entityType, `${id}${extensionFor(mimeType)}`);
  const absolute = resolveWithin(filesRoot(), storagePath);

  await mkdir(path.dirname(absolute), { recursive: true });
  // 'wx' fails rather than overwrites. A UUID collision is not a real
  // expectation, but silently truncating an existing file if one happened is
  // not a risk worth taking to save a flag.
  await writeFile(absolute, bytes, { flag: 'wx' });

  const fileName = displayName(input.source.name, mimeType);
  await db.insert(files).values({
    id,
    entityType: input.entityType,
    entityId: input.entityId,
    fileName,
    mimeType,
    sizeBytes: bytes.length,
    storagePath,
    uploadedBy: input.uploadedBy ?? null,
    createdBy: input.uploadedBy ?? null,
  });

  return {
    ok: true,
    file: {
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      fileName,
      mimeType,
      sizeBytes: bytes.length,
      storagePath,
      dimensions: readDimensions(bytes, mimeType),
    },
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The active row for an id, or null.
 *
 * Malformed ids are answered here rather than by the database. Postgres rejects
 * a non-UUID cast with an error, and a route that let that through would turn a
 * mistyped URL into a 500 carrying a database message.
 *
 * Void rows read as absent: voiding is this product's deletion, so a voided
 * file stops being served even though its bytes are still on disk.
 */
export async function activeFileRow(id: string): Promise<FileRow | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.recordStatus, 'active')));
  return row ?? null;
}

/** The absolute path of a row, checked against the current root. */
export function absolutePathOf(row: Pick<FileRow, 'storagePath'>): string {
  return resolveWithin(filesRoot(), row.storagePath);
}

/**
 * The size on disk, or null when the bytes are not there.
 *
 * Null is an expected answer, not a bug: a database restored without its file
 * volume has rows whose images are genuinely missing, and the serve route turns
 * that into a 404 rather than a stack trace.
 */
export async function statStored(row: Pick<FileRow, 'storagePath'>): Promise<number | null> {
  try {
    const info = await stat(/*turbopackIgnore: true*/ absolutePathOf(row));
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/** A byte stream for a response body, so serving a file never buffers all of it. */
export function openStored(row: Pick<FileRow, 'storagePath'>): Readable {
  return createReadStream(/*turbopackIgnore: true*/ absolutePathOf(row));
}

/**
 * Enough of the front of a file to read its header.
 *
 * PNG puts its dimensions in the first two dozen bytes; JPEG can push its frame
 * header past an embedded thumbnail, so this reads a generous prefix rather
 * than the whole image, which for a display courtesy is not worth the memory.
 */
const HEADER_BYTES = 64 * 1024;

export interface StoredDescription {
  sizeBytes: number;
  dimensions: Dimensions | null;
}

/**
 * Size and pixel dimensions of a stored file, read from disk.
 *
 * Dimensions are computed rather than stored because `files` has no columns for
 * them, and inventing a place to cache a value that is already in the bytes
 * would be a second source of truth for a caption.
 */
export async function describeStored(
  row: Pick<FileRow, 'storagePath' | 'mimeType'>,
): Promise<StoredDescription | null> {
  const size = await statStored(row);
  if (size === null) return null;
  // Only the types a page renders have pixel dimensions worth reading, and only
  // those have a caption to put them in. A PDF is neither, so its header is not
  // read at all rather than read and discarded.
  if (!isInlineType(row.mimeType)) return { sizeBytes: size, dimensions: null };

  let handle;
  try {
    handle = await open(/*turbopackIgnore: true*/ absolutePathOf(row), 'r');
    const buffer = new Uint8Array(Math.min(size, HEADER_BYTES));
    await handle.read(buffer, 0, buffer.length, 0);
    return { sizeBytes: size, dimensions: readDimensions(buffer, row.mimeType) };
  } catch {
    return { sizeBytes: size, dimensions: null };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Retires a file. Nothing is deleted: not the row, not the bytes.
 *
 * The bytes stay because the row stays. A voided logo is still the image that
 * was printed on last quarter's quotes, and a document regenerated from an
 * archived quote has to be able to look at it. Returns whether a row moved, so
 * a caller can tell "voided it" from "it was already void".
 */
export async function voidFile(
  id: string,
  options: VoidOptions,
): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) return false;
  const rows = await db
    .update(files)
    .set(voidColumns(options))
    .where(and(eq(files.id, id), eq(files.recordStatus, 'active')))
    .returning({ id: files.id });
  return rows.length > 0;
}

export interface VoidOptions {
  actorId?: string | null;
  reason: string;
}

/**
 * The four columns that retire a row, in one place.
 *
 * A caller that has to void a file inside its own transaction -- replacing the
 * logo does, because pointing the organization at the new file and retiring the
 * old one are one change -- writes these rather than composing its own set. Two
 * spellings of "voided" is how one of them ends up forgetting `voided_at`.
 */
export function voidColumns(options: VoidOptions) {
  return {
    recordStatus: 'void',
    voidedAt: new Date(),
    voidedBy: options.actorId ?? null,
    voidReason: options.reason,
  } as const;
}
