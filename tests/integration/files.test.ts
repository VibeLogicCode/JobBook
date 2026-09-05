import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/files/[id]/route';
import { pointLogoAt } from '@/app/settings/identity/logo/logo';
import { db } from '@/db/client';
import { files, organization } from '@/db/schema';
import { INLINE_TYPES, STORABLE_TYPES } from '@/lib/files/sniff';
import {
  LOGO_MAX_BYTES,
  ORGANIZATION_ENTITY_ID,
  PathEscapeError,
  activeFileRow,
  filesRoot,
  resolveWithin,
  saveFile,
  voidFile,
} from '@/lib/files/store';

/**
 * The file store against the real database and a real directory.
 *
 * What needs both is everything the design's two rules are about: that the
 * stored name comes from the sniffed type and a UUID rather than from anything
 * the client sent, that a file is reachable only by its row id, and that
 * replacing a logo retires the old row instead of removing it.
 *
 * The scratch root is a fresh mkdtemp per run and is NOT cleaned up. That is
 * deliberate: the one rule this store has no exception to is that nothing is
 * deleted, and a suite reaching for rm is a suite teaching the next reader
 * where the exception lives. The operating system reclaims its own temp
 * directory.
 */

const ACTOR = '11111111-2222-4333-8444-555555555555';

beforeAll(async () => {
  process.env.FILES_ROOT = await mkdtemp(path.join(tmpdir(), 'scopeline-files-'));
});

/**
 * The directory listing as this test found it.
 *
 * Rows are truncated between tests but the bytes are not, because nothing here
 * deletes. So a test asserts on what it ADDED to the root; asserting on the
 * whole listing would be asserting on test order.
 */
let namesAtStart: string[] = [];

beforeEach(async () => {
  await db.execute(sql`truncate table files, organization, audit_log restart identity cascade`);
  namesAtStart = await storedNames();
});

// ---------------------------------------------------------------------------
// Fixtures, built byte by byte
// ---------------------------------------------------------------------------

/**
 * A PNG header with real dimensions in it.
 *
 * The chunk CRCs are zero, and that is the point of building this by hand
 * rather than pasting a base64 image: the store decides what a file is from
 * its leading signature, so a fixture that carries the signature and a
 * readable IHDR is exactly as acceptable to it as a photograph is. A genuine
 * encoder-produced PNG is used below as well, so both are covered.
 */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(8 + 25 + 12);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR payload length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24); // bit depth, colour type, compression, filter, interlace
  bytes.set([0x49, 0x45, 0x4e, 0x44], 37); // 'IEND', after its zero-length field
  return bytes;
}

/** A JPEG with a JFIF application segment and one baseline frame header. */
function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(2 + 18 + 13 + 2);
  const view = new DataView(bytes.buffer);
  let at = 0;
  const push = (...values: number[]) => {
    bytes.set(values, at);
    at += values.length;
  };

  push(0xff, 0xd8); // SOI
  push(0xff, 0xe0); // APP0
  view.setUint16(at, 16);
  at += 2;
  push(0x4a, 0x46, 0x49, 0x46, 0x00); // 'JFIF\0'
  push(1, 1, 0, 0, 1, 0, 1, 0, 0); // version, units, densities, no thumbnail

  push(0xff, 0xc0); // SOF0
  view.setUint16(at, 11);
  at += 2;
  push(8); // sample precision
  view.setUint16(at, height);
  at += 2;
  view.setUint16(at, width);
  at += 2;
  push(1, 1, 0x11, 0); // one component

  push(0xff, 0xd9); // EOI
  return bytes;
}

/**
 * A PDF, as a producer emits the front of one.
 *
 * The `%PDF-` header, one object, and the trailer, which is enough for the
 * store: what a file IS is decided from its leading signature, exactly as it is
 * for the two image formats above, so a fixture carrying the real signature is
 * as acceptable to it as a supplier's invoice is.
 */
const PDF_BYTES = new TextEncoder().encode(
  '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
);

/** A real 1x1 PNG, as an encoder actually emits one. */
const GENUINE_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  ),
  (character) => character.charCodeAt(0),
);

function upload(bytes: Uint8Array, name: string, claimedType = 'image/png'): File {
  // Copied into a buffer of its own so the fixture is a File over plain bytes
  // whatever produced them -- an encoder, a text encoder, or a hand-built
  // header.
  //
  // The claimed type is passed on every fixture and read by nothing. It is
  // here to make the header the store ignores visible in the test.
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return new File([owned], name, { type: claimedType });
}

/**
 * The logo path, which takes only the types a PAGE renders.
 *
 * `INLINE_TYPES`, the same constant the action passes, so this test goes on
 * asserting what the logo field accepts rather than what the store happens to
 * know how to keep.
 */
function storeLogo(source: File) {
  return saveFile({
    entityType: 'organization',
    entityId: ORGANIZATION_ENTITY_ID,
    source,
    uploadedBy: ACTOR,
    maxBytes: LOGO_MAX_BYTES,
    accept: INLINE_TYPES,
  });
}

/** The receipt path, which takes everything the store keeps -- PDFs included. */
function storeReceipt(source: File) {
  return saveFile({
    entityType: 'receipt',
    entityId: null,
    source,
    uploadedBy: ACTOR,
    maxBytes: LOGO_MAX_BYTES,
    accept: STORABLE_TYPES,
  });
}

async function receiptNames(): Promise<string[]> {
  try {
    return (await readdir(path.join(filesRoot(), 'receipt'))).sort();
  } catch {
    return [];
  }
}

async function storedNames(): Promise<string[]> {
  try {
    return (await readdir(path.join(filesRoot(), 'organization'))).sort();
  } catch {
    return [];
  }
}

/** The filenames this test put on disk. */
async function namesAdded(): Promise<string[]> {
  const before = new Set(namesAtStart);
  return (await storedNames()).filter((name) => !before.has(name)).sort();
}

function request(id: string) {
  return GET(new Request(`http://127.0.0.1/api/files/${id}`), {
    params: Promise.resolve({ id }),
  });
}

// ---------------------------------------------------------------------------
// Storing
// ---------------------------------------------------------------------------

describe('saving a file', () => {
  it('stores a PNG and returns the row it wrote', async () => {
    const result = await storeLogo(upload(GENUINE_PNG, 'letterhead.png'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.file.mimeType).toBe('image/png');
    expect(result.file.sizeBytes).toBe(GENUINE_PNG.length);
    expect(result.file.fileName).toBe('letterhead.png');

    const [row] = await db.select().from(files).where(eq(files.id, result.file.id));
    expect(row).toBeDefined();
    expect(row?.entityType).toBe('organization');
    // NULL, because the tenant has no UUID to point at, and a nil-UUID
    // sentinel is a value somebody eventually joins on.
    expect(row?.entityId).toBeNull();
    expect(row?.mimeType).toBe('image/png');
    expect(row?.sizeBytes).toBe(GENUINE_PNG.length);
    expect(row?.uploadedBy).toBe(ACTOR);
    expect(row?.recordStatus).toBe('active');

    // The stored name is the row id plus the extension the SNIFF chose.
    expect(row?.storagePath).toBe(`organization/${result.file.id}.png`);
    const onDisk = await readFile(path.join(filesRoot(), row!.storagePath));
    expect(new Uint8Array(onDisk)).toEqual(GENUINE_PNG);
  });

  it('reads the dimensions out of the PNG header', async () => {
    const result = await storeLogo(upload(pngBytes(320, 120), 'wide.png'));
    expect(result.ok && result.file.dimensions).toEqual({ width: 320, height: 120 });
  });

  it('stores a JPEG, under a jpg extension it chose itself', async () => {
    // Named .png on purpose: the extension that arrives is a claim, and the
    // one the file is stored under has to come from the bytes.
    const result = await storeLogo(upload(jpegBytes(600, 200), 'photo.png', 'image/png'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.file.mimeType).toBe('image/jpeg');
    expect(result.file.storagePath).toBe(`organization/${result.file.id}.jpg`);
    expect(result.file.dimensions).toEqual({ width: 600, height: 200 });
  });
});

describe('storing a PDF', () => {
  it('sniffs the %PDF- signature and stores it under .pdf', async () => {
    // Named .jpg on purpose. The extension is a claim; the signature is not.
    const result = await storeReceipt(upload(PDF_BYTES, 'invoice.jpg', 'image/jpeg'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.file.mimeType).toBe('application/pdf');
    expect(result.file.storagePath).toBe(`receipt/${result.file.id}.pdf`);
    // Points, not pixels. There is no honest answer in these units.
    expect(result.file.dimensions).toBeNull();

    const [row] = await db.select().from(files).where(eq(files.id, result.file.id));
    expect(row?.mimeType).toBe('application/pdf');
    expect(await receiptNames()).toContain(`${result.file.id}.pdf`);
  });

  it('judges a renamed PNG by its bytes, not by the .pdf it claims to be', async () => {
    // The whole point of the sniff, stated in the direction that matters now
    // that one stored type is downloaded and the others are rendered: calling a
    // PNG `receipt.pdf` must not get it treated as a PDF, any more than calling
    // an SVG `logo.png` got it treated as a PNG.
    const result = await storeReceipt(upload(GENUINE_PNG, 'receipt.pdf', 'application/pdf'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.file.mimeType).toBe('image/png');
    expect(result.file.storagePath).toBe(`receipt/${result.file.id}.png`);
    // The display name is what arrived, because it is display metadata and
    // nothing routes off it.
    expect(result.file.fileName).toBe('receipt.pdf');

    const response = await request(result.file.id);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toContain('inline');
  });

  it('refuses a PDF on the logo field, which stores only what a page renders', async () => {
    // Widening the STORE must not widen every field that uses it. The refusal
    // names the format rather than saying "not a PNG or a JPEG" about a file
    // this application stores perfectly well somewhere else.
    const result = await storeLogo(upload(PDF_BYTES, 'letterhead.pdf', 'application/pdf'));
    expect(result).toEqual({ ok: false, reason: 'unsupported-type', looksLike: 'a PDF' });
    expect(await db.select().from(files)).toHaveLength(0);
    expect(await namesAdded()).toEqual([]);
  });
});

describe('refusing a file', () => {
  it('refuses a text file renamed .png, whatever the browser called it', async () => {
    const text = new TextEncoder().encode('This is a quote, not a logo.\n');
    const result = await storeLogo(upload(text, 'logo.png', 'image/png'));

    expect(result).toEqual({ ok: false, reason: 'unsupported-type', looksLike: 'a text file' });
    expect(await db.select().from(files)).toHaveLength(0);
    expect(await namesAdded()).toEqual([]);
  });

  it('refuses an SVG, which is the whole reason the allowlist is a sniff', async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const result = await storeLogo(upload(svg, 'logo.png', 'image/png'));

    expect(result).toEqual({ ok: false, reason: 'unsupported-type', looksLike: 'an SVG' });
    expect(await db.select().from(files)).toHaveLength(0);
  });

  it('refuses an SVG that hides behind an XML declaration', async () => {
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
    const result = await storeLogo(upload(svg, 'brand.png'));
    expect(result).toEqual({ ok: false, reason: 'unsupported-type', looksLike: 'an SVG' });
  });

  it('refuses a file over the cap without writing anything', async () => {
    const huge = new Uint8Array(LOGO_MAX_BYTES + 1);
    huge.set(pngBytes(4000, 4000), 0); // A real header, so only the size is wrong.
    const result = await storeLogo(upload(huge, 'enormous.png'));

    expect(result).toEqual({ ok: false, reason: 'too-large', maxBytes: LOGO_MAX_BYTES });
    expect(await db.select().from(files)).toHaveLength(0);
    expect(await namesAdded()).toEqual([]);
  });

  it('accepts a file exactly at the cap, so the limit is not off by one', async () => {
    const atCap = new Uint8Array(LOGO_MAX_BYTES);
    atCap.set(pngBytes(1000, 1000), 0);
    const result = await storeLogo(upload(atCap, 'exact.png'));
    expect(result.ok).toBe(true);
  });

  it('refuses an empty file as empty rather than as the wrong type', async () => {
    const result = await storeLogo(upload(new Uint8Array(0), 'nothing.png'));
    expect(result).toEqual({ ok: false, reason: 'empty' });
  });
});

// ---------------------------------------------------------------------------
// The path is never the client's
// ---------------------------------------------------------------------------

describe('storage paths', () => {
  it('cannot be escaped by a traversal filename', async () => {
    const name = '../../../../etc/cron.d/payload.png';
    const result = await storeLogo(upload(GENUINE_PNG, name));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The name survives as display metadata, stripped to its last segment...
    expect(result.file.fileName).toBe('payload.png');
    // ...and contributes nothing at all to where the bytes went.
    expect(result.file.storagePath).toBe(`organization/${result.file.id}.png`);

    const root = filesRoot();
    const absolute = path.resolve(root, result.file.storagePath);
    expect(path.relative(root, absolute).startsWith('..')).toBe(false);
    expect(await namesAdded()).toEqual([`${result.file.id}.png`]);
  });

  it('keeps a Windows-style traversal name out of the path too', async () => {
    const result = await storeLogo(upload(GENUINE_PNG, '..\\..\\windows\\system32\\logo.png'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.fileName).toBe('logo.png');
    expect(result.file.storagePath).toBe(`organization/${result.file.id}.png`);
  });

  it('refuses a relative path that leaves the root', () => {
    const root = filesRoot();
    expect(() => resolveWithin(root, '../escaped.png')).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, 'organization/../../escaped.png')).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, '')).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, path.resolve(root, '..', 'sibling.png'))).toThrow(
      PathEscapeError,
    );
    // A sibling directory sharing the root's name as a prefix is not inside it.
    expect(() => resolveWithin(root, `../${path.basename(root)}-other/x.png`)).toThrow(
      PathEscapeError,
    );
    expect(resolveWithin(root, 'organization/a.png')).toBe(
      path.join(root, 'organization', 'a.png'),
    );
  });
});

// ---------------------------------------------------------------------------
// Serving, by id and nothing else
// ---------------------------------------------------------------------------

describe('the serve route', () => {
  it('serves an active row with its sniffed type and a nosniff header', async () => {
    const result = await storeLogo(upload(GENUINE_PNG, 'letterhead.png'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const response = await request(result.file.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toContain('inline');
    expect(response.headers.get('cache-control')).toContain('immutable');
    // Private, not public: the bytes are tenant data behind authentication.
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('content-length')).toBe(String(GENUINE_PNG.length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(GENUINE_PNG);
  });

  it('hands a PDF over as a download, with nosniff kept', async () => {
    const result = await storeReceipt(upload(PDF_BYTES, 'supplier-invoice.pdf'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const response = await request(result.file.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    // The point of the whole exercise: never `inline`. A PDF displayed from
    // this origin is a document IN this origin, and a PDF can carry script.
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).not.toContain('inline');
    expect(response.headers.get('content-disposition')).toContain('supplier-invoice.pdf');
    // Nothing the images already had is weakened by the new branch.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('content-length')).toBe(String(PDF_BYTES.length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF_BYTES);
  });

  it('gives a downloaded PDF a name that does not lie about its type', async () => {
    // The stored name came from a client, so what it claims about the type is a
    // claim too -- and for an attachment that claim becomes the name on
    // somebody's disk.
    const result = await storeReceipt(upload(PDF_BYTES, 'receipt.png', 'image/png'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const response = await request(result.file.id);
    expect(response.headers.get('content-disposition')).toContain('receipt.png.pdf');
  });

  it('404s for an unknown id', async () => {
    const response = await request('7c9e6679-7425-40de-944b-e07fc1f90ae7');
    expect(response.status).toBe(404);
  });

  it('404s for an id that is not a UUID, rather than letting Postgres refuse it', async () => {
    const response = await request('../../etc/passwd');
    expect(response.status).toBe(404);
  });

  it('404s for a voided row, whose bytes are still on disk', async () => {
    const result = await storeLogo(upload(GENUINE_PNG, 'old.png'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(await voidFile(result.file.id, { actorId: ACTOR, reason: 'Superseded.' })).toBe(true);

    const response = await request(result.file.id);
    expect(response.status).toBe(404);

    // Voided means unserved, not gone: the row and the bytes both remain.
    const [row] = await db.select().from(files).where(eq(files.id, result.file.id));
    expect(row?.recordStatus).toBe('void');
    await expect(readFile(path.join(filesRoot(), row!.storagePath))).resolves.toBeDefined();
    expect(await activeFileRow(result.file.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Replacing the logo
// ---------------------------------------------------------------------------

describe('replacing the logo', () => {
  beforeEach(async () => {
    await db.insert(organization).values({
      id: 1,
      legalName: 'Test Holdings Ltd',
      displayName: 'Test Holdings',
    });
  });

  it('voids the previous row rather than removing it', async () => {
    const first = await storeLogo(upload(pngBytes(200, 80), 'first.png'));
    const second = await storeLogo(upload(jpegBytes(400, 160), 'second.jpg', 'image/jpeg'));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(await pointLogoAt(first.file.id, ACTOR)).toEqual({
      previousFileId: null,
      previousVoided: false,
    });

    const replacement = await pointLogoAt(second.file.id, ACTOR);
    expect(replacement).toEqual({ previousFileId: first.file.id, previousVoided: true });

    const [org] = await db.select().from(organization).where(eq(organization.id, 1));
    expect(org?.logoFileId).toBe(second.file.id);

    // Both rows are still there. Nothing in this product is deleted, and the
    // old logo is the image already printed on quotes that were sent.
    const rows = await db.select().from(files);
    expect(rows).toHaveLength(2);

    const previous = rows.find((row) => row.id === first.file.id);
    expect(previous?.recordStatus).toBe('void');
    expect(previous?.voidedAt).toBeInstanceOf(Date);
    expect(previous?.voidedBy).toBe(ACTOR);
    expect(previous?.voidReason).toBeTruthy();

    expect(rows.find((row) => row.id === second.file.id)?.recordStatus).toBe('active');

    // The retired file's bytes are untouched, and both are on disk.
    expect(await namesAdded()).toEqual([`${first.file.id}.png`, `${second.file.id}.jpg`].sort());
  });

  it('serves the new logo and refuses the retired one', async () => {
    const first = await storeLogo(upload(pngBytes(200, 80), 'first.png'));
    const second = await storeLogo(upload(pngBytes(300, 90), 'second.png'));
    if (!first.ok || !second.ok) throw new Error('fixture upload failed');

    await pointLogoAt(first.file.id, ACTOR);
    await pointLogoAt(second.file.id, ACTOR);

    expect((await request(second.file.id)).status).toBe(200);
    expect((await request(first.file.id)).status).toBe(404);
  });

  it('does not void the current logo when it is uploaded over itself', async () => {
    const only = await storeLogo(upload(GENUINE_PNG, 'logo.png'));
    if (!only.ok) throw new Error('fixture upload failed');

    await pointLogoAt(only.file.id, ACTOR);
    expect(await pointLogoAt(only.file.id, ACTOR)).toEqual({
      previousFileId: only.file.id,
      previousVoided: false,
    });
    const [row] = await db.select().from(files).where(eq(files.id, only.file.id));
    expect(row?.recordStatus).toBe('active');
  });

  it('reports no organization row rather than pointing at nothing', async () => {
    await db.execute(sql`truncate table organization restart identity cascade`);
    const stored = await storeLogo(upload(GENUINE_PNG, 'logo.png'));
    if (!stored.ok) throw new Error('fixture upload failed');
    expect(await pointLogoAt(stored.file.id, ACTOR)).toBeNull();
  });
});
