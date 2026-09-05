/**
 * What a file actually is, decided from its bytes.
 *
 * A client-supplied `Content-Type` and a filename extension are both claims
 * made by whoever sent the request. Neither is a fact, and the gap between the
 * two matters here more than in most places: the design (section 7.5) refuses
 * SVG because an SVG served from this application's own origin runs script
 * with the application's rights, and a refusal that trusted the extension
 * would be defeated by renaming `payload.svg` to `logo.png`.
 *
 * So the allowlist is keyed on the leading signature, and the extension the
 * file is STORED under is derived from that signature rather than from the
 * name that arrived.
 */

/**
 * How a stored type is allowed to reach a browser.
 *
 * `inline` is "this application renders it into one of its own pages".
 * `attachment` is "the browser saves it, and this application never becomes its
 * document". The distinction is policy, not presentation: an SVG is refused
 * outright because one served inline from this origin runs script with this
 * application's rights, and a PDF is the same class of risk -- a PDF can carry
 * JavaScript, and one displayed inline from this origin is IN this origin.
 * Handing it over as a download puts it in the operating system's hands instead
 * of this application's.
 */
export type Rendering = 'inline' | 'attachment';

/**
 * The only types this application STORES, the extension each is stored under,
 * and how each may reach a browser.
 *
 * This was `SERVABLE_TYPES`, a plain map of type to extension, and that name
 * was doing real work: it meant "types this application serves into a page".
 * A PDF is the first type that may be stored and may NOT be rendered into a
 * page, so "storable" and "renderable inline" stopped being the same set, and
 * an entry here now carries both answers.
 *
 * One object rather than a second boolean beside the first map, because the
 * store and the serve route reading the same object is the property worth
 * keeping. A route that echoed back whatever `mime_type` its row happened to
 * contain would serve an SVG the moment some future upload path was looser than
 * this one -- the row is data, and data is not a policy. Splitting the answer
 * across two structures would let a type land in one and not the other, which
 * is that same failure wearing a different shape.
 */
export const STORED_TYPES = {
  'image/png': { extension: '.png', rendering: 'inline' },
  'image/jpeg': { extension: '.jpg', rendering: 'inline' },
  'application/pdf': { extension: '.pdf', rendering: 'attachment' },
} as const satisfies Record<string, { extension: string; rendering: Rendering }>;

export type StoredType = keyof typeof STORED_TYPES;

export function isStoredType(value: string): value is StoredType {
  return Object.hasOwn(STORED_TYPES, value);
}

/** Every type that may be stored, in the order they are declared above. */
export const STORABLE_TYPES: readonly StoredType[] = Object.keys(STORED_TYPES) as StoredType[];

/**
 * The types a page may render.
 *
 * Derived from the map rather than written out a second time: a hand-kept list
 * is a list that disagrees with the policy the day somebody adds a type to one
 * and forgets the other.
 */
export const INLINE_TYPES: readonly StoredType[] = STORABLE_TYPES.filter(
  (type) => STORED_TYPES[type].rendering === 'inline',
);

/**
 * Whether a stored type may be rendered into one of this application's pages.
 *
 * A predicate rather than a boolean, and narrowing to `StoredType` rather than
 * to some narrower alias: inline implies stored, so a caller that has asked
 * this may go on to read the extension or the dimensions without asking again.
 */
export function isInlineType(value: string): value is StoredType {
  return isStoredType(value) && STORED_TYPES[value].rendering === 'inline';
}

export function renderingFor(type: StoredType): Rendering {
  return STORED_TYPES[type].rendering;
}

/** PNG: the eight-byte signature, which includes the CRLF/EOF sequences the format uses to detect mangled transfers. */
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
/** JPEG: SOI followed by the first marker's introducer. */
const JPEG_SIGNATURE = Uint8Array.of(0xff, 0xd8, 0xff);
/**
 * PDF: the `%PDF-` the specification requires at the head of the file, ahead of
 * the version digits. Sniffed like the other two, and for the same reason --
 * an extension and a `Content-Type` are claims, so a PNG named `receipt.pdf`
 * has to be stored and served as the PNG it is.
 */
const PDF_SIGNATURE = Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d);

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

/** The type these bytes really are, or null when they are not a type this application stores. */
export function sniffType(bytes: Uint8Array): StoredType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  if (startsWith(bytes, PDF_SIGNATURE)) return 'application/pdf';
  return null;
}

export function extensionFor(type: StoredType): string {
  return STORED_TYPES[type].extension;
}

/** ASCII from a byte range, for the format signatures that are plain text. */
function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < start + length && i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
}

/** Whether every byte is something a person could have typed. */
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = Math.min(bytes.length, 512);
  if (sample === 0) return false;
  for (let i = 0; i < sample; i += 1) {
    const byte = bytes[i]!;
    const printable = byte >= 0x20 && byte <= 0x7e;
    const whitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (!printable && !whitespace) return false;
  }
  return true;
}

/**
 * A human name for a file we refused, so the error can say what arrived
 * instead of only what was wanted.
 *
 * "That is not a PNG or a JPEG" leaves the owner guessing when he exported an
 * SVG from a design tool and it is named `logo.png`. Naming the format he
 * actually has is the difference between a message he can act on and one he
 * reads twice.
 *
 * The PDF line below survives PDFs becoming storable, and does more work than
 * before rather than less. A caller states which of the stored types IT
 * accepts, so a PDF dropped on the logo field is a type this application stores
 * and that field does not take, and the message still has to name it.
 */
export function describeUnacceptable(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return 'an empty file';

  const head = ascii(bytes, 0, 64).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'an SVG';
  }
  if (ascii(bytes, 0, 4) === 'GIF8') return 'a GIF';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'a WebP image';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'a PDF';
  if (ascii(bytes, 0, 2) === 'BM') return 'a bitmap';
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return 'a Windows icon file';
  }
  if (startsWith(bytes, Uint8Array.of(0x50, 0x4b, 0x03, 0x04))) return 'a zip archive';
  if (looksLikeText(bytes)) return 'a text file';
  return null;
}

export interface Dimensions {
  width: number;
  height: number;
}

/** PNG stores width and height as the first eight bytes of the IHDR chunk, which the format requires to come first. */
function pngDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** SOF0 through SOF15, excluding the three markers in that range that are not frame headers. */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * JPEG carries no dimensions at a fixed offset: they live in a frame header
 * somewhere after any number of application segments, and a photo with an
 * embedded thumbnail can push that header tens of kilobytes in. So the
 * segments are walked rather than indexed.
 */
function jpegDimensions(bytes: Uint8Array): Dimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1; // Padding between segments is legal; resynchronise on it.
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // A run of fill bytes.
      continue;
    }
    // Standalone markers, which carry no length field.
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Entropy-coded data starts here and the frame header is behind us.
    if (marker === 0xda || marker === 0xd9) return null;

    const length = view.getUint16(offset + 2);
    if (isStartOfFrame(marker)) {
      if (offset + 9 > bytes.length) return null;
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    if (length < 2) return null; // Malformed: a zero length would not advance.
    offset += 2 + length;
  }
  return null;
}

/**
 * The pixel dimensions, or null when the header does not say.
 *
 * Null is a real answer rather than an error: the dimensions are shown to the
 * owner as a courtesy, and a logo that stored and serves correctly must not be
 * reported as broken because its frame header sits past the bytes we read.
 */
export function readDimensions(bytes: Uint8Array, type: StoredType): Dimensions | null {
  if (type === 'image/png') return pngDimensions(bytes);
  if (type === 'image/jpeg') return jpegDimensions(bytes);
  // A PDF's pages are measured in points, not pixels. There is no honest answer
  // in the units this returns, so it says nothing rather than inventing one.
  return null;
}
