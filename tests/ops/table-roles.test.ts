import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(process.cwd(), 'src');

/**
 * Every table element that stacks carries the role it would otherwise imply.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS HAS TO BE A TEST AND NOT A CONVENTION
 * ---------------------------------------------------------------------------
 *
 * Below 640px `.data-table--stack` sets `display: block` on the table, its row
 * groups, its rows and its cells. That is what turns each row into a card, and
 * it also strips the implicit table/rowgroup/row/cell roles in EVERY browser --
 * so a list announced as a table on a desktop is announced as a pile of
 * unrelated blocks on a phone, and at 400% desktop zoom, which is the WCAG
 * 1.4.10 reflow case.
 *
 * The roles are invisible in the rendered page and cost nothing to forget. The
 * only thing that keeps 36 files honest is a scanner, which is exactly the
 * argument `stacked-table.test.ts` already makes for `data-label`.
 *
 * `role` is required rather than preferred because these elements have no
 * other way to say what they are once their display changes.
 */

const EXPECTED: Record<string, string> = {
  thead: 'rowgroup',
  tbody: 'rowgroup',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
};

const TAG = /<(thead|tbody|tr|td|th)(?=[\s>/])/g;

interface Offence {
  file: string;
  tag: string;
  line: number;
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (entry.name.endsWith('.tsx')) found.push(full);
  }
  return found;
}

async function sweep(): Promise<{ offences: Offence[]; tags: number; files: number }> {
  const offences: Offence[] = [];
  let tags = 0;
  let files = 0;

  for (const file of await walk(ROOT)) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
    // The print document renders a real table on paper. It never stacks, so
    // its implicit roles are intact and an explicit one would be noise.
    if (rel.includes('/app/print/')) continue;

    const source = await readFile(file, 'utf8');
    if (!source.includes('<td') && !source.includes('<th')) continue;
    files += 1;

    for (const match of source.matchAll(TAG)) {
      const tag = match[1]!;
      const after = source.slice(match.index! + match[0].length);
      const close = after.indexOf('>');
      const attrs = close === -1 ? after.slice(0, 400) : after.slice(0, close);
      tags += 1;

      if (!attrs.includes(`role="${EXPECTED[tag]}"`)) {
        offences.push({
          file: rel,
          tag,
          line: source.slice(0, match.index).split('\n').length,
        });
      }
    }
  }

  return { offences, tags, files };
}

describe('table semantics survive the card layout', () => {
  it('gives every row group, row and cell its explicit role', async () => {
    const result = await sweep();
    expect(result.offences).toEqual([]);
    // Guards against the sweep silently matching nothing and passing.
    expect(result.files).toBeGreaterThan(20);
    expect(result.tags).toBeGreaterThan(400);
  });

  it('puts role="table" on the one element that renders every table', async () => {
    // Written once, in `TableWrap`, because every stacking table in the
    // product goes through it.
    const source = await readFile(path.join(ROOT, 'components/ui/Table.tsx'), 'utf8');
    expect(source).toContain('<table role="table"');
  });
});
