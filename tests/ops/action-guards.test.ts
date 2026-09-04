import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const APP = path.join(ROOT, 'src', 'app');

/**
 * Every server action must check a capability before it does anything.
 *
 * This exists because the worksheet's actions shipped without one. Nothing was
 * obviously wrong -- the screens looked right, the tests passed, and a
 * bookkeeper could edit a quote. Deny by default only holds if somebody
 * notices the omission, and a person reviewing a new action notices the
 * feature, not the missing line.
 *
 * So the rule is mechanical: a file marked `'use server'` may not export an
 * async function whose body lacks a guard. Adding an action without one fails
 * here rather than opening a door.
 */

/**
 * What counts as a guard.
 *
 * `persistStep` and `readSetupGate` are the first-run wizard's, and they count
 * because that wizard is authorized differently rather than unauthorized. A
 * capability check resolves the signed-in identity against `users` and refuses
 * an identity with no active row; at first run that table is empty, because
 * creating the owner is one of the steps, so a capability check would
 * correctly refuse every step of the wizard whose job is to create the row it
 * checks for. Its gate instead is "no company exists that this wizard did not
 * itself create", re-read inside the writing transaction so two concurrent
 * requests cannot both believe the database was theirs to claim.
 */
const GUARD_PATTERN =
  /\b(guard|requireCapability|requireOwner|assertCapability|persistStep|readSetupGate)\s*\(/;

/**
 * Actions that legitimately hold no capability check, each with a reason.
 *
 * Kept as an explicit list rather than a convention, so exempting something is
 * a decision somebody has to write down.
 */
const EXEMPT: Record<string, string> = {
  // Sign-out ends the caller's own session. Requiring a capability to stop
  // being signed in would strand a deactivated user with a live cookie.
  'auth/sign-out': 'ends the caller own session',
};

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

interface Finding {
  file: string;
  action: string;
}

/**
 * Splits a `'use server'` file at each exported async function and checks the
 * body that follows.
 *
 * Deliberately textual rather than a real parse. A TypeScript AST walk would
 * be more precise and would also be a second thing to maintain; the failure
 * mode here is a false positive on an oddly formatted file, which is loud and
 * fixable, rather than a false negative that ships an ungated action.
 */
async function ungatedActions(): Promise<Finding[]> {
  const findings: Finding[] = [];

  for await (const file of walk(APP)) {
    const text = await readFile(file, 'utf8');
    if (!/^\s*['"]use server['"]/m.test(text)) continue;

    const relative = path.relative(APP, file).split(path.sep).join('/');
    if (Object.keys(EXEMPT).some((prefix) => relative.startsWith(prefix))) continue;

    const matches = [...text.matchAll(/export\s+async\s+function\s+(\w+)/g)];
    for (const [index, match] of matches.entries()) {
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? text.length;
      const body = text.slice(start, end);
      if (!GUARD_PATTERN.test(body)) {
        findings.push({ file: relative, action: match[1]! });
      }
    }
  }

  return findings;
}

describe('server action guards', () => {
  it('finds no exported action without a capability check', async () => {
    const findings = await ungatedActions();
    expect(
      findings.map((finding) => `${finding.file}: ${finding.action}`),
      'every server action must call guard() or requireCapability() before it acts',
    ).toEqual([]);
  });

  it('actually inspects some files, so a passing run means something', async () => {
    // A walk that silently found nothing would make the test above vacuous --
    // which is exactly how the omission it exists to catch got shipped.
    let serverFiles = 0;
    for await (const file of walk(APP)) {
      const text = await readFile(file, 'utf8');
      if (/^\s*['"]use server['"]/m.test(text)) serverFiles += 1;
    }
    expect(serverFiles).toBeGreaterThan(3);
  });
});
