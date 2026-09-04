import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SEARCH_DIRS = ['src', 'scripts', 'drizzle'];
/** Seed data is allowed to name a company: that is what seed data is. */
const EXEMPT = [path.join('src', 'db', 'seed')];

/**
 * Values that belong to a tenant, never to the product.
 *
 * The bare tax rate is included deliberately. An Ontario HST rate written into
 * code rather than read from tax_rates is exactly the defect this guard exists
 * to catch: it survives a rate change silently, and it is wrong for every
 * deployment outside one province.
 */
const FORBIDDEN = [
  /maple\s*custom\s*homes/i,
  /maplecustomhomes/i,
  /general contracting done right/i,
  /\b0\.13\b/,
  /\b647-?\s?960-?\s?4017\b/,
];

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // A search directory that does not exist yet is not an offence.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|css|sql|json)$/.test(entry.name)) {
      yield full;
    }
  }
}

async function findOffences(root: string, dirs: string[]): Promise<string[]> {
  const offences: string[] = [];
  for (const dir of dirs) {
    for await (const file of walk(path.join(root, dir))) {
      const relative = path.relative(root, file);
      if (EXEMPT.some((exempt) => relative.startsWith(exempt))) continue;
      const text = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) offences.push(`${relative} matches ${pattern}`);
      }
    }
  }
  return offences;
}

describe('white-label guard', () => {
  it('finds no tenant-specific literal outside the seed directory', async () => {
    expect(await findOffences(ROOT, SEARCH_DIRS)).toEqual([]);
  });

  it('catches a tenant name, so the guard is known to work', async () => {
    // A guard that has never failed is not a guard. This proves it fires
    // rather than passing because the walk quietly found nothing.
    const scratch = await mkdtemp(path.join(tmpdir(), 'white-label-'));
    try {
      await writeFile(
        path.join(scratch, 'offender.ts'),
        "export const FOOTER = 'Maple Custom Homes — General Contracting Done Right';\n",
      );
      const offences = await findOffences(scratch, ['.']);
      expect(offences.length).toBeGreaterThan(0);
      expect(offences[0]).toContain('offender.ts');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('catches a hardcoded tax rate', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'white-label-'));
    try {
      await writeFile(path.join(scratch, 'tax.ts'), 'const HST = 0.13;\n');
      expect(await findOffences(scratch, ['.'])).toHaveLength(1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('exempts the seed directory, which is allowed to name a company', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'white-label-'));
    try {
      const seed = path.join(scratch, 'src', 'db', 'seed');
      await writeFile(path.join(scratch, 'placeholder.ts'), 'export const X = 1;\n');
      await rm(seed, { recursive: true, force: true });
      const { mkdir } = await import('node:fs/promises');
      await mkdir(seed, { recursive: true });
      await writeFile(path.join(seed, 'demo.ts'), "export const NAME = 'Maple Custom Homes';\n");
      expect(await findOffences(scratch, ['src'])).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
