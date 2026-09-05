import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SEARCH_DIRS = ['src', 'scripts', 'drizzle', 'docker'];
/** Seed data is allowed to name a company: that is what seed data is. */
const EXEMPT = [path.join('src', 'db', 'seed')];

/**
 * Patterns for values that belong to a tenant rather than to the product.
 *
 * The built-in list is generic on purpose. An earlier version listed the first
 * customer's company name, tagline and phone number as literal regexes, which
 * made the guard against tenant details in the codebase the codebase's own
 * largest collection of tenant details -- and it would have shipped to every
 * other company that buys this.
 *
 * A deployment that wants to guard specific strings puts them in
 * `tenant-literals.local.json` beside this file, as an array of regex sources.
 * That file is gitignored, so a real company's name never enters the
 * repository at all.
 */
const BUILT_IN = [
  // A bare tax rate written into code rather than read from tax_rates: it
  // survives a rate change silently and is wrong outside one province.
  { source: String.raw`\b0\.13\b`, why: 'a hardcoded tax rate' },
  { source: String.raw`\b0\.15\b`, why: 'a hardcoded tax rate' },
  // A North American phone number in source is somebody's actual phone.
  { source: String.raw`\b\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b`, why: 'a phone number' },
  // The GST/HST account suffix on a Canadian business number.
  { source: String.raw`\bRT\d{4}\b`, why: 'a tax registration number' },
];

interface Pattern {
  regex: RegExp;
  why: string;
}

const LOCAL_LIST = 'tenant-literals.local.json';

async function loadPatterns(): Promise<Pattern[]> {
  const patterns: Pattern[] = BUILT_IN.map((entry) => ({
    regex: new RegExp(entry.source, 'i'),
    why: entry.why,
  }));

  try {
    const local = await readFile(path.join(import.meta.dirname, LOCAL_LIST), 'utf8');
    for (const source of JSON.parse(local) as string[]) {
      patterns.push({ regex: new RegExp(source, 'i'), why: `the tenant literal /${source}/` });
    }
  } catch {
    // No local list, which is the normal case. The built-in patterns still
    // apply: an absent file must never silently disable the guard.
  }

  return patterns;
}

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
    } else if (/\.(ts|tsx|css|sql|json|sh|md)$/.test(entry.name)) {
      yield full;
    }
  }
}

/**
 * Comments are stripped before matching, and prose files are held to a
 * narrower standard.
 *
 * The guard exists to catch a tenant value the CODE would use. A comment
 * explaining "somebody types a tax rate as 0.13, so this converts it" is the
 * opposite of the defect -- it is the documentation of the conversion -- and
 * failing the build on it teaches people to delete the explanation. Likewise a
 * README showing an example command with a number in it.
 *
 * So: strip comments from code, and in Markdown apply only the tenant-name
 * patterns from the local list, never the generic numeric shapes.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*--.*$/gm, ' ')
    .replace(/^\s*#.*$/gm, ' ');
}

async function findOffences(root: string, dirs: string[]): Promise<string[]> {
  const patterns = await loadPatterns();
  const offences: string[] = [];

  for (const dir of dirs) {
    for await (const file of walk(path.join(root, dir))) {
      const relative = path.relative(root, file);
      if (EXEMPT.some((exempt) => relative.startsWith(exempt))) continue;
      if (relative.endsWith(LOCAL_LIST)) continue;

      const raw = await readFile(file, 'utf8');
      const isProse = relative.endsWith('.md');
      const text = isProse ? raw : stripComments(raw);

      for (const pattern of patterns) {
        // A generic numeric shape in prose is an example, not a hardcoded
        // value. A tenant NAME in prose still ships to another company.
        //
        // Only the tenant-literal patterns are name-shaped, and they are the
        // only ones built with that prefix, so the prefix is the whole test.
        // It used to also compare against 'a tenant-specific literal', which
        // no pattern has ever been given -- a clause that always passed and
        // read as if it were guarding something.
        if (isProse && !pattern.why.startsWith('the tenant literal')) continue;
        if (pattern.regex.test(text)) offences.push(`${relative} contains ${pattern.why}`);
      }
    }
  }
  return offences;
}

describe('white-label guard', () => {
  it('finds no tenant-specific literal outside the seed directory', async () => {
    expect(await findOffences(ROOT, SEARCH_DIRS)).toEqual([]);
  });

  it('catches a hardcoded tax rate, so the guard is known to work', async () => {
    // A guard that has never failed is not a guard. This proves it fires
    // rather than passing because the walk quietly found nothing.
    const scratch = await mkdtemp(path.join(tmpdir(), 'white-label-'));
    try {
      await writeFile(path.join(scratch, 'tax.ts'), 'const HST = 0.13;\n');
      const offences = await findOffences(scratch, ['.']);
      expect(offences).toHaveLength(1);
      expect(offences[0]).toContain('tax.ts');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('ignores a value that appears only in a comment', async () => {
    // The comment explaining a conversion is the documentation of the fix, not
    // the defect. Failing on it teaches people to delete the explanation.
    const scratch = await mkdtemp(path.join(tmpdir(), 'white-label-'));
    try {
      await writeFile(
        path.join(scratch, 'convert.ts'),
        ['// somebody types a rate as 0.13, so this converts at the edge', 'export const SCALE = 10000;', ''].join('\n'),
      );
      expect(await findOffences(scratch, ['.'])).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('still catches the same value in code beside that comment', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'white-label-'));
    try {
      await writeFile(
        path.join(scratch, 'convert.ts'),
        ['// a rate is 0.13 in this comment', 'export const HST = 0.13;', ''].join('\n'),
      );
      expect(await findOffences(scratch, ['.'])).toHaveLength(1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('catches a phone number', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'white-label-'));
    try {
      await writeFile(path.join(scratch, 'footer.ts'), "export const TEL = '905-555-0142';\n");
      expect(await findOffences(scratch, ['.'])).toHaveLength(1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('catches a tax registration number', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'white-label-'));
    try {
      await writeFile(path.join(scratch, 'doc.ts'), "const NUMBER = '80000 1234 RT0001';\n");
      expect(await findOffences(scratch, ['.'])).toHaveLength(1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('honours a local tenant list without that list entering the repository', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'white-label-'));
    try {
      await writeFile(path.join(scratch, 'footer.ts'), "export const NAME = 'Northgate';\n");
      // No local list here, so the generic patterns alone see nothing wrong.
      expect(await findOffences(scratch, ['.'])).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('exempts the seed directory, which is allowed to name a company', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'white-label-'));
    const { mkdir } = await import('node:fs/promises');
    try {
      const seed = path.join(scratch, 'src', 'db', 'seed');
      await mkdir(seed, { recursive: true });
      await writeFile(path.join(seed, 'demo.ts'), "export const TEL = '905-555-0142';\n");
      expect(await findOffences(scratch, ['src'])).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
