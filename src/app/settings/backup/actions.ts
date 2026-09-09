'use server';

import { revalidatePath } from 'next/cache';
import { guard } from '@/lib/auth/guard';
import { generateAgeKeypair, isAgeRecipient, publicKeyFor } from '@/lib/backup/age-key';
import {
  type AuthConfigEntries,
  MANAGED_KEYS,
  readAuthConfig,
  writeAuthConfig,
} from '@/lib/deploy/auth-config';

/**
 * Backup key generation.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE
 * ---------------------------------------------------------------------------
 *
 * **The private half is returned to the caller and never written anywhere.**
 * Not to the database, not to `/data/config`, not to a log line. It exists in
 * this process for the length of one request and reaches the operator's screen
 * in the action's return value, which lives in the browser's memory until he
 * navigates away.
 *
 * That is the whole design. §10 of the backlog calls the alternative the
 * "backup key hostage problem": a customer holding a drive of backups he
 * cannot read. Storing the private key here would solve that by defeating the
 * encryption -- the threat this protects against is somebody carrying the NAS
 * out of the office, and a private key on the NAS is a private key in the
 * thief's hands.
 *
 * The cost is accepted rather than hidden: the key briefly exists in the app's
 * memory, and an operator who loses it loses every backup taken with it. That
 * is worse than a stored key for exactly one threat model and better for the
 * real one, and it is what every disk-encryption recovery key does.
 *
 * ---------------------------------------------------------------------------
 * WHY REGENERATION IS NOT REFUSED
 * ---------------------------------------------------------------------------
 *
 * A new key does not make old backups unreadable -- they are still encrypted
 * to the old recipient, and the old private half still opens them. It does
 * mean the operator must keep BOTH halves to read his whole history, which is
 * a sentence the screen has to say plainly rather than a reason to refuse.
 */

export type BackupKeyResult =
  | {
      ok: true;
      publicKey: string;
      /** Shown once. Never persisted, by design. */
      privateKey: string;
      /** True when this replaced an existing recipient. */
      replaced: boolean;
    }
  | { ok: false; error: string };

/**
 * Everything already in the file, so writing one key does not drop the rest.
 *
 * `writeAuthConfig` emits the WHOLE file from the entries it is given -- there
 * is no merge inside it -- so a caller that passed only its own key would
 * silently erase the tunnel token and the SSO secrets next to it.
 */
async function existingEntries(): Promise<{ entries: AuthConfigEntries; had: boolean }> {
  const file = await readAuthConfig();
  if (!file) return { entries: {}, had: false };

  const entries: AuthConfigEntries = {};
  for (const key of MANAGED_KEYS) {
    const value = file.entries.get(key);
    if (value !== undefined && value !== '') entries[key] = value;
  }
  return { entries, had: entries.BACKUP_AGE_PUBLIC_KEY !== undefined };
}

export async function generateBackupKey(
  _previous: BackupKeyResult | null,
  formData: FormData,
): Promise<BackupKeyResult> {
  const allowed = await guard('backup:configure');
  if (!allowed.ok) return { ok: false, error: allowed.error };

  // A deliberate act, not a button somebody lands on. The word is checked
  // because a mis-click here is not destructive today and becomes so the
  // moment the operator stops keeping the previous key.
  if (formData.get('confirm') !== 'generate') {
    return { ok: false, error: 'Type generate to confirm, then press the button.' };
  }

  const keypair = generateAgeKeypair();

  // Belt and braces on the one thing that must never be wrong. `isAgeRecipient`
  // and `publicKeyFor` both run over freshly generated values, so a failure
  // here means the encoder is broken -- and a broken encoder that reached the
  // config file would produce backups nobody can read, discovered at a
  // restore. Cheap, and the only check positioned to catch it.
  if (!isAgeRecipient(keypair.publicKey) || publicKeyFor(keypair.privateKey) !== keypair.publicKey) {
    return {
      ok: false,
      error:
        'The generated key did not verify against itself, so nothing was saved. This is a ' +
        'fault in the software rather than anything you did.',
    };
  }

  const { entries, had } = await existingEntries();

  try {
    await writeAuthConfig({ ...entries, BACKUP_AGE_PUBLIC_KEY: keypair.publicKey });
  } catch (error) {
    // The private half is dropped with this request either way. Saying so
    // matters: an operator who has already written the key down needs to know
    // it is not the one in use.
    return {
      ok: false,
      error: `${
        error instanceof Error ? error.message : 'the configuration file could not be written'
      }. No key was saved, and the one just generated is gone — press the button again.`,
    };
  }

  revalidatePath('/settings/backup');

  // NOTHING IS LOGGED HERE. Not the private key, obviously, but not a
  // "generated a key" line either while the value is in scope -- a future
  // edit adding context to such a line is the likeliest way this key ends up
  // in a log file, and the audit trail for this lives in the config file's
  // own timestamp.
  return { ok: true, publicKey: keypair.publicKey, privateKey: keypair.privateKey, replaced: had };
}
