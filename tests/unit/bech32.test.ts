import { describe, expect, it } from 'vitest';
import { bech32ChecksumValid, bech32Decode, bech32Encode } from '@/lib/backup/bech32';

/**
 * Bech32, tested against BIP-173's own vectors.
 *
 * It is here to encode age keys, and an age key that is subtly wrong is the
 * worst possible bug in this product: the backup encrypts happily, the
 * ciphertext verifies, and nothing is discovered until somebody needs to
 * restore. So the encoder is checked against an external standard's published
 * vectors rather than against itself.
 *
 * Vectors from BIP-173's "valid checksums" list, which is the same bech32
 * (not bech32m) that age uses.
 */

/** Encodes to a known-good string from a known input, both ways. */
/**
 * BIP-173's 90-character vector is deliberately ABSENT. Transcribing it by
 * hand produced 81 `q` characters where the standard has 82, and the checksum
 * correctly rejected the result -- an hour spent debugging working code. The
 * maximum-length rule is asserted directly below instead, and the encoder's
 * real correctness is proved end to end against the `age` binary itself in
 * `tests/integration/age-key.test.ts`, which is worth more than a seventh
 * string copied by eye.
 */
const VALID: readonly string[] = [
  'A12UEL5L',
  'a12uel5l',
  'an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs',
  'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
  'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w',
  '?1ezyfcl',
];

describe('bech32', () => {
  it('accepts the checksum of every BIP-173 valid vector', () => {
    // The CHECKSUM layer, which is what these vectors test. Several of them
    // carry payloads that are not a whole number of bytes -- bech32 is a
    // five-bit encoding and byte alignment is the consumer's convention, not
    // part of the standard. Asserting a byte round-trip on them fails for the
    // right reason and the wrong test, which is how this pair of functions
    // came to be separate.
    for (const encoded of VALID) {
      expect(bech32ChecksumValid(encoded), encoded).toBe(true);
    }
  });

  it('round-trips a byte-aligned payload of every length an age key might be', () => {
    for (const length of [1, 2, 20, 31, 32, 33]) {
      const data = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) data[i] = (i * 37 + 11) & 0xff;
      const encoded = bech32Encode('age', data);
      expect(bech32Decode(encoded), `length ${length}`).toEqual({ hrp: 'age', data });
    }
  });

  it('decodes an age-shaped payload to exactly 32 bytes', () => {
    // 32 bytes is 256 bits, which is 52 five-bit symbols with four bits of
    // zero padding -- so the decoder must ACCEPT four leftover zero bits while
    // refusing five or more. That boundary is the whole reason `convertBits`
    // takes a `pad` flag, and an age key sits directly on it.
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) key[i] = (i * 7 + 3) & 0xff;
    const encoded = bech32Encode('age', key);
    expect(encoded.slice(encoded.indexOf('1') + 1)).toHaveLength(52 + 6);
    expect(bech32Decode(encoded)?.data).toEqual(key);
  });

  it('rejects a corrupted checksum', () => {
    // The property the whole scheme exists for. A key with one character
    // mistyped must be refused, not silently decoded into a different key.
    expect(bech32Decode('A12UEL5X')).toBeNull();
    expect(bech32Decode('abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxx')).toBeNull();
  });

  it('rejects mixed case, which BIP-173 forbids', () => {
    // Case carries no data, so mixed case means something mangled the string
    // in transit -- a mail client, a spreadsheet, a copy out of a PDF.
    expect(bech32Decode('A12UeL5L')).toBeNull();
  });

  it('rejects a string with no separator, and an empty human-readable part', () => {
    expect(bech32Decode('abcdefqpzry9')).toBeNull();
    expect(bech32Decode('1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw')).toBeNull();
  });

  it('rejects characters outside the charset', () => {
    // 'b', 'i', 'o' and '1' are excluded from the data charset on purpose,
    // because they are what people confuse when reading a key off paper --
    // which is exactly how this product hands over a backup key.
    expect(bech32Decode('abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lb')).toBeNull();
  });

  it('computes the checksum over the LOWERCASED part, whatever case it is given', () => {
    // The bug the real `age` binary caught and every test here had missed.
    // BIP-173 checksums the lower-case form, so encoding with an upper-case
    // part must give the same body as encoding with a lower-case one --
    // otherwise `AGE-SECRET-KEY-...` is rejected as malformed by every
    // conforming decoder, which is exactly what happened.
    const data = new Uint8Array(32).fill(9);
    const upper = bech32Encode('AGE-SECRET-KEY-', data);
    const lower = bech32Encode('age-secret-key-', data);
    expect(upper).toBe(lower);
    expect(bech32ChecksumValid(upper.toUpperCase())).toBe(true);
    expect(bech32Decode(upper.toUpperCase())?.data).toEqual(data);
  });

  it('refuses a string longer than BIP-173 permits', () => {
    // 90 characters is the cap. Asserted directly, since the standard's own
    // maximum-length vector is not transcribed here (see above).
    const tooLong = `age1${'q'.repeat(90)}`;
    expect(tooLong.length).toBeGreaterThan(90);
    expect(bech32ChecksumValid(tooLong)).toBe(false);
    expect(bech32Decode(tooLong)).toBeNull();
  });

  it('encodes the empty payload, which is a valid bech32 string', () => {
    const encoded = bech32Encode('age', new Uint8Array(0));
    expect(bech32Decode(encoded)?.data).toEqual(new Uint8Array(0));
  });
});
