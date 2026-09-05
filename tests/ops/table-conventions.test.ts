import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PRIMITIVE = path.join('src', 'components', 'ui', 'Table.tsx');

/**
 * The table wrapper is written once, in the primitive, and nowhere else.
 *
 * Four decisions travel together on every data screen: the scroll container,
 * the `data-table data-table--stack` class pair, an inline min-width, and a
 * `data-label` on every cell. Held apart they drift -- three of the four are
 * invisible until somebody opens the screen on a phone, and the fourth is
 * invisible until a column collapses on data that was not on the screen the
 * author looked at. `stacked-table.test.ts` guards the labels; this file
 * guards the other three by making the primitive the only place they exist.
 *
 * The list below is the debt, not an exemption anyone should grow. A file on
 * it fails the moment it stops hand-rolling, so converting a screen means
 * deleting its line here, and a new screen fails until somebody writes down
 * why it is not using the primitive.
 */
const HAND_ROLLED: Record<string, string> = {
  // Both of these put `aria-busy` on the table element itself, so that a
  // commit in flight is announced on the grid rather than on a row that may
  // be about to move. The primitive takes no table-level attributes, and
  // plumbing one through for two callers buys less than it costs.
  [path.join('src', 'app', 'quotes', '[id]', 'Acceptance.tsx')]:
    'sets aria-busy on the table while a commit is in flight',
  [path.join('src', 'components', 'worksheet', 'Worksheet.tsx')]:
    'sets aria-busy on the table while a commit is in flight',
};

/* -------------------------------------------------------------------------
   Scanning
   ------------------------------------------------------------------------- */

/**
 * The opening tags of one element in a file.
 *
 * Scanned rather than parsed, the same way `stacked-table.test.ts` reads
 * cells: the tag ends at the first `>` outside a string and outside a JSX
 * expression, which survives an attribute broken across lines and a
 * `className={`a ${b}`}`.
 */
function openingTags(source: string, name: string): string[] {
  const out: string[] = [];
  const opening = new RegExp(`<${name}(?=[\\s/>])`, 'g');
  let match: RegExpExecArray | null;

  while ((match = opening.exec(source)) !== null) {
    let depth = 0;
    let quote = '';
    let i = match.index + name.length + 1;

    for (; i < source.length; i += 1) {
      const character = source[i];
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character;
        continue;
      }
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      else if (character === '>' && depth === 0) break;
    }

    out.push(source.slice(match.index, i + 1));
  }

  return out;
}

interface Sweep {
  offences: string[];
  /** Table elements read, so a pass cannot mean the scanner found nothing. */
  tables: number;
  /** Call sites of the primitive, same reason. */
  wrappers: number;
  amountCells: number;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // A directory that does not exist yet is not an offence.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      yield* walk(full);
    } else if (entry.name.endsWith('.tsx')) {
      yield full;
    }
  }
}

async function sweep(root: string, allowed: Record<string, string> = HAND_ROLLED): Promise<Sweep> {
  const offences: string[] = [];
  let tables = 0;
  let wrappers = 0;
  let amountCells = 0;

  for await (const file of walk(path.join(root, 'src'))) {
    const source = await readFile(file, 'utf8');
    const relative = path.relative(root, file);
    wrappers += openingTags(source, 'TableWrap').length;

    for (const tag of openingTags(source, 'table')) {
      tables += 1;
      if (relative === PRIMITIVE || relative in allowed) continue;
      const flat = tag.replace(/\s+/g, ' ');
      // The class pair and the width are the primitive's, and a page that
      // writes either has re-derived the whole convention around it.
      if (/\bdata-table\b/.test(tag)) {
        offences.push(`${relative}: ${flat} sets the data-table classes outside the primitive`);
      }
      if (/minWidth/.test(tag)) {
        offences.push(`${relative}: ${flat} sets its own min-width outside the primitive`);
      }
    }

    for (const tag of openingTags(source, 'AmountCell')) {
      amountCells += 1;
      if (!/\bdata-label=/.test(tag)) {
        // The type requires it, but the type cannot be read from a diff, and
        // this is the attribute that becomes the column header on a phone.
        offences.push(`${relative}: ${tag.replace(/\s+/g, ' ')} carries no data-label`);
      }
    }
  }

  return { offences, tables, wrappers, amountCells };
}

/** A listed file that no longer hand-rolls has to leave the list. */
async function stale(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const relative of Object.keys(HAND_ROLLED)) {
    let source: string;
    try {
      source = await readFile(path.join(root, relative), 'utf8');
    } catch {
      out.push(`${relative} is listed as hand-rolling a table but does not exist`);
      continue;
    }
    if (!openingTags(source, 'table').some((tag) => /\bdata-table\b/.test(tag))) {
      out.push(`${relative} no longer hand-rolls a table wrapper; remove it from the list`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- */

describe('table conventions', () => {
  it('leaves the wrapper and the min-width to the primitive', async () => {
    const found = await sweep(ROOT);
    expect(found.offences).toEqual([]);
  });

  it('read the markup rather than passing on an empty search', async () => {
    const found = await sweep(ROOT);
    // The two counts moved past each other in the adoption pass, which is the
    // whole point of it: the wrapper is now written once and called eighteen
    // times, and what is left writing a `<table>` by hand is the print
    // document, the two screens that put `aria-busy` on the grid, and the one
    // screen still on the list above.
    expect(found.tables).toBeGreaterThan(5);
    expect(found.wrappers).toBeGreaterThan(15);
    expect(found.amountCells).toBeGreaterThan(10);
  });

  it('keeps the hand-rolled list honest', async () => {
    expect(await stale(ROOT)).toEqual([]);
  });

  it('catches a screen that hand-rolls the wrapper again', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'table-conventions-'));
    try {
      const dir = path.join(scratch, 'src', 'app');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'page.tsx'),
        [
          'export default function Page() {',
          '  return (',
          '    <div className="overflow-x-auto rounded-[6px] border border-line">',
          '      <table',
          '        className="data-table data-table--stack"',
          "        style={{ minWidth: '44rem' }}",
          '      >',
          '        <tbody />',
          '      </table>',
          '    </div>',
          '  );',
          '}',
          '',
        ].join('\n'),
      );
      const found = await sweep(scratch, {});
      expect(found.tables).toBe(1);
      expect(found.offences).toHaveLength(2);
      expect(found.offences[0]).toContain('data-table classes');
      expect(found.offences[1]).toContain('min-width');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('says nothing about a file the list accounts for', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'table-conventions-'));
    try {
      const dir = path.join(scratch, 'src', 'app');
      await mkdir(dir, { recursive: true });
      const relative = path.join('src', 'app', 'page.tsx');
      await writeFile(
        path.join(dir, 'page.tsx'),
        '<table className="data-table data-table--stack" aria-busy><tbody /></table>\n',
      );
      const found = await sweep(scratch, { [relative]: 'a reason somebody wrote down' });
      expect(found.tables).toBe(1);
      expect(found.offences).toEqual([]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('catches a figure cell added without its column name', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'table-conventions-'));
    try {
      const dir = path.join(scratch, 'src', 'app');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'page.tsx'),
        [
          '<TableWrap minWidth="44rem">',
          '  <tbody><tr>',
          '    <AmountCell data-label="Total" cents={row.totalCents} />',
          '    <AmountCell className="text-muted">{formatBasisPoints(row.marginBp)}</AmountCell>',
          '  </tr></tbody>',
          '</TableWrap>',
          '',
        ].join('\n'),
      );
      const found = await sweep(scratch, {});
      expect(found.wrappers).toBe(1);
      expect(found.amountCells).toBe(2);
      expect(found.offences).toHaveLength(1);
      expect(found.offences[0]).toContain('carries no data-label');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('reads a tag whose attributes span lines and hold braces', () => {
    const tags = openingTags(
      [
        '<AmountCell',
        '  data-label="Margin"',
        '  className={`${margin < 0 ? "text-negative" : ""}`}',
        '>',
        '  {formatBasisPoints(margin)}',
        '</AmountCell>',
      ].join('\n'),
      'AmountCell',
    );
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('data-label="Margin"');
  });
});
