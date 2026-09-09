import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { bech32Decode, bech32Encode } from '@/lib/backup/bech32';

/**
 * An age X25519 keypair, generated here rather than by `age-keygen`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE APP GENERATES THIS AT ALL
 * ---------------------------------------------------------------------------
 *
 * The runbook used to say: run `age-keygen` on another machine and paste the
 * public half into the compose file. A correct instruction that almost nobody
 * follows, because it needs a tool they do not have, on a computer they are
 * not looking at, while setting up a NAS. The observed result on the first
 * real install was an empty key, a backup container in `Exited(1)`, and a
 * deployment taking no backups at all.
 *
 * A deployment taking no backups is the worst outcome this product has, so the
 * bar is not "correct advice" but "the thing that actually happens".
 *
 * ---------------------------------------------------------------------------
 * WHY NOT SHELL OUT TO age-keygen
 * ---------------------------------------------------------------------------
 *
 * It exists in the container (`/usr/bin/age-keygen`, installed beside `age`
 * for `backup.sh`), so shelling out would work in production and nowhere
 * else. There is no `age` on the development machine, which means no test
 * could run outside a container -- and this is the one piece of code whose
 * failure is undetectable until a restore. Node has X25519 in `node:crypto`,
 * and the only thing `age-keygen` adds is the bech32 wrapper.
 *
 * ---------------------------------------------------------------------------
 * THE FORMAT
 * ---------------------------------------------------------------------------
 *
 * Both halves are the raw 32-byte X25519 key in bech32:
 *
 *   public   `age1...`               human-readable part "age", lower case
 *   private  `AGE-SECRET-KEY-1...`   part "AGE-SECRET-KEY-", UPPER case
 *
 * The private half is uppercased AFTER encoding. bech32 is case-insensitive
 * and carries no information in case, so this is presentation -- but it is the
 * presentation every age implementation writes and every operator recognises,
 * and a lowercase secret key would read as something else entirely.
 *
 * Node hands back DER, and the raw key is its trailing 32 bytes in both cases
 * (SPKI is 44 bytes, PKCS#8 is 48). Sliced from the END rather than at a fixed
 * offset, so a longer prefix from a future Node cannot silently shift the key.
 */

export const PUBLIC_HRP = 'age';
export const PRIVATE_HRP = 'AGE-SECRET-KEY-';

/** 32 bytes. Anything else is not an X25519 key. */
const KEY_BYTES = 32;

export interface AgeKeypair {
  /** Goes on the machine taking backups. Safe to display, print and store. */
  publicKey: string;
  /**
   * NEVER stored, never logged, never written to the database or to
   * `/data/config`. Shown to the operator once and then dropped. Everything
   * that touches this value is on the caller's conscience.
   */
  privateKey: string;
}

function rawFromDer(der: Buffer): Uint8Array {
  if (der.length < KEY_BYTES) {
    throw new Error('age-key: DER shorter than a key');
  }
  return new Uint8Array(der.subarray(der.length - KEY_BYTES));
}

export function generateAgeKeypair(): AgeKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');

  return {
    publicKey: bech32Encode(
      PUBLIC_HRP,
      rawFromDer(publicKey.export({ type: 'spki', format: 'der' })),
    ),
    privateKey: bech32Encode(
      PRIVATE_HRP,
      rawFromDer(privateKey.export({ type: 'pkcs8', format: 'der' })),
    ).toUpperCase(),
  };
}

/**
 * The public half belonging to a private key.
 *
 * Exists so the operator can be told, later, whether the key he kept is the
 * one this deployment has been encrypting to. That question is otherwise
 * unanswerable without attempting a restore, and "attempt a restore to find
 * out whether you can restore" is not a check anybody runs.
 */
export function publicKeyFor(privateKey: string): string | null {
  const decoded = bech32Decode(privateKey);
  if (!decoded) return null;
  if (decoded.hrp !== PRIVATE_HRP.toLowerCase()) return null;
  if (decoded.data.length !== KEY_BYTES) return null;

  // Wrapped back into PKCS#8 because `node:crypto` has no raw X25519 import.
  // The prefix is the fixed algorithm identifier for X25519; only the 32 bytes
  // after it vary.
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b656e04220420', 'hex'),
    Buffer.from(decoded.data),
  ]);

  try {
    const key = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
    return bech32Encode(PUBLIC_HRP, rawFromDer(key.export({ type: 'spki', format: 'der' })));
  } catch {
    // A well-formed bech32 string that is not a usable key. Refused rather
    // than reported as a mismatch, because "this is not a key" and "this is
    // the wrong key" are different sentences to show somebody.
    return null;
  }
}

/**
 * Is this a public age recipient?
 *
 * `backup.sh` already refuses a private key in `BACKUP_AGE_PUBLIC_KEY` with
 * its own check, and this is the same refusal one layer earlier, where it can
 * be a sentence on a screen instead of a container that exits.
 */
export function isAgeRecipient(value: string): boolean {
  const decoded = bech32Decode(value);
  return decoded !== null && decoded.hrp === PUBLIC_HRP && decoded.data.length === KEY_BYTES;
}
