/**
 * Bech32, as BIP-173 defines it and as age uses it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS HERE AND NOT A DEPENDENCY
 * ---------------------------------------------------------------------------
 *
 * It encodes the backup keypair. Forty lines with the standard's own published
 * test vectors beside them is a smaller thing to own than a dependency in the
 * path of the one operation whose failure is undetectable: an age key that is
 * subtly wrong still encrypts, the ciphertext still verifies, and nobody finds
 * out until a restore.
 *
 * `bech32`, not `bech32m`. age uses the original constant, and the two differ
 * only in the final XOR — so the wrong one produces strings that look exactly
 * right and are rejected by every real age implementation.
 *
 * The excluded characters are the point of the alphabet: `1`, `b`, `i` and `o`
 * are absent because they are what a person misreads. This product hands a
 * backup key over on paper, so that property is load-bearing rather than
 * incidental.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** BIP-173 caps the whole string at 90 characters. */
const MAX_LENGTH = 90;

function polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((top >>> i) & 1) checksum ^= GENERATOR[i]!;
    }
  }
  return checksum;
}

function expandHrp(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (let i = 0; i < hrp.length; i += 1) {
    const code = hrp.charCodeAt(i);
    high.push(code >>> 5);
    low.push(code & 31);
  }
  return [...high, 0, ...low];
}

/** Regroups bits, e.g. 8-bit bytes into the 5-bit symbols bech32 encodes. */
function convertBits(
  data: readonly number[],
  from: number,
  to: number,
  pad: boolean,
): number[] | null {
  let accumulator = 0;
  let bits = 0;
  const out: number[] = [];
  const maxValue = (1 << to) - 1;

  for (const value of data) {
    if (value < 0 || value >>> from !== 0) return null;
    accumulator = (accumulator << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((accumulator >>> bits) & maxValue);
    }
  }

  if (pad) {
    if (bits > 0) out.push((accumulator << (to - bits)) & maxValue);
  } else if (bits >= from || ((accumulator << (to - bits)) & maxValue) !== 0) {
    // Refused rather than truncated. Leftover non-zero bits mean the input was
    // not a whole number of output symbols, which for a key means it is not
    // the key somebody meant.
    return null;
  }

  return out;
}

export function bech32Encode(hrp: string, data: Uint8Array): string {
  const symbols = convertBits([...data], 8, 5, true);
  if (!symbols) throw new Error('bech32: could not regroup the payload');

  /**
   * LOWERCASED before the checksum, and this line is the whole reason this
   * module has an end-to-end test against the real `age` binary.
   *
   * BIP-173 computes the checksum over the lower-case form; a decoder
   * lowercases the string before checking, which `bech32Decode` below does.
   * Encoding with the hrp as PASSED therefore produces a valid-looking string
   * whose checksum a conforming decoder rejects -- but only when the caller
   * passed an upper-case part.
   *
   * `age1...` is lower case, so every unit test here passed. The private half
   * is `AGE-SECRET-KEY-`, and the real `age` answered
   * "malformed secret key: invalid checksum" on a key this module had just
   * generated and this module's own round-trip test had just approved.
   */
  const checksumInput = [...expandHrp(hrp.toLowerCase()), ...symbols, 0, 0, 0, 0, 0, 0];
  const mod = polymod(checksumInput) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i += 1) checksum.push((mod >>> (5 * (5 - i))) & 31);

  const body = [...symbols, ...checksum].map((symbol) => CHARSET[symbol]!).join('');
  return `${hrp}1${body}`.toLowerCase();
}

/**
 * Is the checksum on this string valid, whatever its payload encodes?
 *
 * Separate from `bech32Decode` because the two answer different questions and
 * conflating them cost an hour. Bech32 is a FIVE-bit encoding: a valid string's
 * payload need not be a whole number of bytes, and BIP-173's own vectors
 * include several that are not. `bech32Decode` is byte-oriented, because an
 * age key is 32 bytes and anything else is not one — so it rejects strings
 * this function accepts, correctly, and the standard's vectors can only be
 * used against this one.
 */
export function bech32ChecksumValid(encoded: string): boolean {
  const parts = split(encoded);
  return parts !== null && polymod([...expandHrp(parts.hrp), ...parts.symbols]) === 1;
}

/** The shared parsing and validation, before any question about the payload. */
function split(encoded: string): { hrp: string; symbols: number[] } | null {
  if (encoded.length > MAX_LENGTH) return null;

  // Mixed case is invalid per BIP-173. Case carries no information, so a
  // mixture means something between here and there mangled the string --
  // a mail client, a spreadsheet cell, a copy out of a PDF.
  const hasLower = encoded !== encoded.toUpperCase();
  const hasUpper = encoded !== encoded.toLowerCase();
  if (hasLower && hasUpper) return null;

  const lower = encoded.toLowerCase();
  const separator = lower.lastIndexOf('1');
  // The human-readable part may not be empty, and there must be room for the
  // six-symbol checksum.
  if (separator < 1 || separator + 7 > lower.length) return null;

  const hrp = lower.slice(0, separator);
  for (let i = 0; i < hrp.length; i += 1) {
    const code = hrp.charCodeAt(i);
    if (code < 33 || code > 126) return null;
  }

  const symbols: number[] = [];
  for (const character of lower.slice(separator + 1)) {
    const value = CHARSET.indexOf(character);
    if (value === -1) return null;
    symbols.push(value);
  }

  return { hrp, symbols };
}

export function bech32Decode(encoded: string): { hrp: string; data: Uint8Array } | null {

  const parts = split(encoded);
  if (!parts) return null;
  const { hrp, symbols } = parts;

  if (polymod([...expandHrp(hrp), ...symbols]) !== 1) return null;

  // `pad: false`, so a payload that is not a whole number of bytes is REFUSED
  // rather than truncated. For a key, leftover bits mean it is not the key
  // somebody meant, and silently dropping them would produce a valid-looking
  // recipient that decrypts nothing.
  const payload = convertBits(symbols.slice(0, -6), 5, 8, false);
  if (!payload) return null;

  return { hrp, data: new Uint8Array(payload) };
}
