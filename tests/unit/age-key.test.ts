import { describe, expect, it } from 'vitest';
import {
  generateAgeKeypair,
  isAgeRecipient,
  publicKeyFor,
  PRIVATE_HRP,
  PUBLIC_HRP,
} from '@/lib/backup/age-key';

/**
 * The backup keypair.
 *
 * The properties asserted here are the ones that can be checked without an
 * `age` binary, which the development machine does not have. The one that
 * cannot -- that a REAL age implementation accepts both halves -- was checked
 * against `/usr/bin/age` inside the built image, and it is what caught the
 * checksum bug recorded in `bech32.ts`: every test in this file passed while
 * the private key was malformed, because self-consistency is not conformance.
 *
 * `publicKeyFor` is the closest thing to an independent check available here.
 * It re-derives the public half through `node:crypto`'s X25519, so agreement
 * means the bech32 layer and the key material are consistent with each other
 * AND with a second path through the crypto library.
 */
describe('generateAgeKeypair', () => {
  it('produces the shapes age recognises', () => {
    const { publicKey, privateKey } = generateAgeKeypair();
    expect(publicKey).toMatch(/^age1[0-9a-z]+$/);
    expect(privateKey).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/);
  });

  it('derives the same public half from the private one', () => {
    // The check that would have failed had the key material been mangled --
    // though NOT the one that catches a bad checksum, since both paths here
    // share this module's encoder.
    const { publicKey, privateKey } = generateAgeKeypair();
    expect(publicKeyFor(privateKey)).toBe(publicKey);
  });

  it('never repeats a key', () => {
    const keys = new Set(Array.from({ length: 16 }, () => generateAgeKeypair().publicKey));
    expect(keys.size).toBe(16);
  });

  it('encodes 32 bytes, which is the whole of an X25519 key', () => {
    // 32 bytes is 52 bech32 symbols. A key one byte short would still parse,
    // still look right, and encrypt to a recipient nobody holds.
    const { publicKey } = generateAgeKeypair();
    expect(publicKey.slice(PUBLIC_HRP.length + 1)).toHaveLength(52 + 6);
  });

  it('uses the upper-case private part every age implementation writes', () => {
    expect(PRIVATE_HRP).toBe('AGE-SECRET-KEY-');
    const { privateKey } = generateAgeKeypair();
    expect(privateKey.startsWith(PRIVATE_HRP)).toBe(true);
  });
});

describe('isAgeRecipient', () => {
  it('accepts a public key', () => {
    expect(isAgeRecipient(generateAgeKeypair().publicKey)).toBe(true);
  });

  it('REFUSES a private key', () => {
    // The mistake worth catching on a screen rather than in a container that
    // exits: `backup.sh` refuses a private key in BACKUP_AGE_PUBLIC_KEY, and
    // pasting one there would put the secret on the machine the encryption
    // exists to protect it from.
    expect(isAgeRecipient(generateAgeKeypair().privateKey)).toBe(false);
  });

  it('refuses a key with one character changed', () => {
    const { publicKey } = generateAgeKeypair();
    const broken = `${publicKey.slice(0, -1)}${publicKey.endsWith('q') ? 'p' : 'q'}`;
    expect(isAgeRecipient(broken)).toBe(false);
  });

  it('refuses an ssh key, which backup.sh accepts but this screen does not generate', () => {
    expect(isAgeRecipient('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample')).toBe(false);
  });

  it('refuses empty and obvious rubbish', () => {
    for (const value of ['', 'age1', 'not a key', 'AGE1XYZ']) {
      expect(isAgeRecipient(value), value).toBe(false);
    }
  });
});

describe('publicKeyFor', () => {
  it('refuses a public key handed to it by mistake', () => {
    expect(publicKeyFor(generateAgeKeypair().publicKey)).toBeNull();
  });

  it('refuses a corrupted private key rather than deriving a wrong answer', () => {
    // "This is not a key" and "this is the wrong key" are different sentences
    // to show somebody who is checking whether his backup is recoverable.
    const { privateKey } = generateAgeKeypair();

    /**
     * The replacement has to be a character the key does not already end with.
     *
     * This read `${privateKey.slice(0, -1)}Q`, which failed roughly one run in
     * thirty-two: `Q` is in the bech32 charset, so whenever a generated key
     * happened to end in `Q` the "corrupted" string was the valid key and
     * derivation correctly succeeded. A flake that rare is worse than a
     * frequent one -- it appears months later, in somebody else's unrelated
     * change, and reads as a real regression.
     */
    const last = privateKey.at(-1)!;
    const different = last === 'Q' ? 'P' : 'Q';
    expect(publicKeyFor(`${privateKey.slice(0, -1)}${different}`)).toBeNull();
    expect(publicKeyFor('AGE-SECRET-KEY-1NONSENSE')).toBeNull();
  });
});
