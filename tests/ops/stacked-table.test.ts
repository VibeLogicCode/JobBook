import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const STYLESHEET = path.join('src', 'app', 'globals.css');
const STACK = 'data-table--stack';

/**
 * The stacked table is one DOM tree reflowed by CSS -- a <table> at `sm` and
 * above, the same rows as cards below it, each cell's column name printed from
 * its `data-label`. Two of its rules cannot be checked by looking at a screen,
 * because both fail on data that happens not to be on the screen you looked
 * at.
 *
 * 1. Nothing in the stack rules may hide a cell that could hold a figure. The
 *    cards are shortened by dropping cells that are EMPTY, and `:empty` reads
 *    child nodes, so $0.00, a bare 0 and the em-dash placeholder each hold a
 *    text node and survive it. A rule that hid by column position or by class
 *    instead -- "the cost column is noise on a phone" -- takes the zero with
 *    it, and a line the owner cannot see is a line he reads as unpriced.
 *
 * 2. Every cell in a table that stacks carries a data-label, because below the
 *    breakpoint that attribute IS the column header. A cell without one turns
 *    into a figure with nothing to say what it is, which on a phone is worse
 *    than the desktop column it came from. The action column is the exception
 *    and names itself: it holds controls, never a figure, and prints nothing.
 */

/* -------------------------------------------------------------------------
   The stylesheet
   ------------------------------------------------------------------------- */

interface Rule {
  selector: string;
  declarations: string;
}

/**
 * Flattens a stylesheet to its declaration blocks.
 *
 * Brace matching rather than one regex: the rules under test sit two levels
 * deep, inside `@layer components` and then `@media (max-width: 639px)`, and a
 * regex over the whole file reads the at-rule prelude as part of the first
 * selector inside it -- which is exactly the rule this guard is about.
 */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out: Rule[] = [];
  const open: { selector: string; from: number }[] = [];
  let prelude = '';

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    if (character === '{') {
      // Statement at-rules (`@import`, `@custom-variant`) end at a semicolon
      // and would otherwise ride along in front of the next selector.
      const selector = prelude.split(';').pop() ?? '';
      open.push({ selector: selector.trim(), from: i + 1 });
      prelude = '';
    } else if (character === '}') {
      const block = open.pop();
      prelude = '';
      if (!block) continue;
      const body = text.slice(block.from, i);
      // A block holding braces is a wrapper -- its own rules came out already.
      if (body.includes('{')) continue;
      out.push({ selector: block.selector, declarations: body });
    } else {
      prelude += character;
    }
  }

  return out;
}

const HIDDEN = /(^|[;\s])display\s*:\s*none/;

/**
 * The two selectors allowed to hide something once a table has stacked.
 *
 * `thead` goes because its contents reappear as each cell's data-label, and a
 * cell matching `:empty` goes because it has nothing in it to lose.
 */
const MAY_HIDE = /:empty|\bthead\b/;

function stackRules(css: string): Rule[] {
  return rules(css).filter((rule) => rule.selector.includes(STACK));
}

function hidingOffences(css: string): string[] {
  return stackRules(css)
    .filter((rule) => HIDDEN.test(rule.declarations) && !MAY_HIDE.test(rule.selector))
    .map((rule) => `${rule.selector.replace(/\s+/g, ' ')} hides a cell that may hold a value`);
}

/* -------------------------------------------------------------------------
   The markup
   ------------------------------------------------------------------------- */

/**
 * Files holding cells that never stack, each with a reason.
 *
 * An explicit list rather than a convention, so a new file full of `<td>`s
 * fails here until somebody writes down why its cells need no data-label.
 */
const NO_STACK: Record<string, string> = {
  // The print document is laid out for paper at one width. It has no phone
  // rendering to reflow into, and a data-label would print as a second column
  // heading inside every row of the customer's copy.
  [path.join('src', 'app', 'print', 'quote', '[id]', 'page.tsx')]:
    'a print layout, never reflowed to cards',
};

/** A cell that holds controls rather than a figure, so it prints no label. */
const ACTION_COLUMN = /\bno-print\b/;

/**
 * The table primitive, which sets the stack class for every page that renders
 * through it.
 *
 * A file declares that its cells stack either by writing the class itself or
 * by importing this: the class pair, the scroll container and the min-width
 * moved into `src/components/ui/Table.tsx`, so a converted page no longer
 * holds the literal this sweep looks for. Its cells are still swept, which is
 * the part that matters -- what changed is how a file says it stacks, not
 * whether it has to.
 */
const PRIMITIVE = "from '@/components/ui/Table'";

interface Cell {
  tag: string;
  body: string;
}

/**
 * The `<td>`s in a file, with whatever each one renders between its tags.
 *
 * Scanned, not parsed: the opening tag ends at the first `>` that is outside
 * both a string and a JSX expression, which survives an attribute broken
 * across lines and a `className={`a ${b}`}`, and a `</td>` cannot turn up
 * inside another cell.
 */
function cells(source: string): Cell[] {
  const out: Cell[] = [];
  const opening = /<td(?=[\s/>])/g;
  let match: RegExpExecArray | null;

  while ((match = opening.exec(source)) !== null) {
    let depth = 0;
    let quote = '';
    let i = match.index + 3;

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

    const tag = source.slice(match.index, i + 1);
    if (tag.endsWith('/>')) {
      out.push({ tag, body: '' });
      continue;
    }
    const close = source.indexOf('</td>', i);
    out.push({ tag, body: close === -1 ? '' : source.slice(i + 1, close) });
  }

  return out;
}

/**
 * Whether a cell renders a space and nothing else.
 *
 * This is the one blank `:empty` cannot see, and therefore the one the
 * stylesheet cannot shorten away: a space is a text node, so the cell keeps
 * its height, its rule and its label, and prints them against nothing.
 *
 * Whitespace that carries a newline does not count -- JSX drops it, and an
 * action cell written across two lines is genuinely empty at runtime.
 */
function rendersBlank(body: string): boolean {
  const literal = /\{\s*(['"])\s+\1\s*\}|&nbsp;|\{'\\u00a0'\}/g;
  const stripped = body.replace(literal, ' ');
  if (!/^\s*$/.test(stripped)) return false;
  if (stripped !== body) return true;
  return body.length > 0 && !body.includes('\n');
}

interface Sweep {
  offences: string[];
  files: number;
  cells: number;
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

async function sweepMarkup(root: string): Promise<Sweep> {
  const offences: string[] = [];
  let files = 0;
  let inspected = 0;

  for await (const file of walk(path.join(root, 'src'))) {
    const source = await readFile(file, 'utf8');
    const found = cells(source);
    if (found.length === 0) continue;

    const relative = path.relative(root, file);
    if (!source.includes(STACK) && !source.includes(PRIMITIVE)) {
      if (!(relative in NO_STACK)) {
        offences.push(`${relative} holds cells but declares no ${STACK}, and is not listed as exempt`);
      }
      continue;
    }

    files += 1;
    for (const cell of found) {
      inspected += 1;
      const tag = cell.tag.replace(/\s+/g, ' ');
      if (!/\bdata-label=/.test(cell.tag) && !ACTION_COLUMN.test(cell.tag)) {
        offences.push(`${relative}: ${tag} carries no data-label`);
      }
      if (rendersBlank(cell.body)) {
        offences.push(`${relative}: ${tag} renders a space, which no :empty rule can shorten`);
      }
    }
  }

  return { offences, files, cells: inspected };
}

/* ------------------------------------------------------------------------- */

describe('stacked table', () => {
  it('hides nothing that could hold a value', async () => {
    const css = await readFile(path.join(ROOT, STYLESHEET), 'utf8');
    expect(hidingOffences(css)).toEqual([]);
  });

  it('reads the stack rules rather than passing on an empty search', async () => {
    // The parser is the part most likely to quietly find nothing: the rules it
    // is aimed at are nested two at-rules deep.
    const css = await readFile(path.join(ROOT, STYLESHEET), 'utf8');
    const found = stackRules(css);
    expect(found.length).toBeGreaterThan(8);
    expect(found.some((rule) => /td:empty/.test(rule.selector))).toBe(true);
  });

  it('catches a rule that hides a cell by column position', () => {
    // The tempting fix for a tall card, and the one that eats a $0.00.
    const offences = hidingOffences(`@layer components {
      @media (max-width: 639px) {
        .data-table--stack tbody td:nth-child(6) { display: none; }
      }
    }`);
    expect(offences).toHaveLength(1);
    expect(offences[0]).toContain('nth-child(6)');
  });

  it('catches a rule that hides a cell by class', () => {
    const offences = hidingOffences(`@layer components {
      @media (max-width: 639px) {
        .data-table--stack .cell-num { display: none }
      }
    }`);
    expect(offences).toHaveLength(1);
  });

  it('allows the empty cell and the head to go', () => {
    expect(
      hidingOffences(`@layer components {
        @media (max-width: 639px) {
          .data-table--stack thead { display: none; }
          .data-table--stack tbody td:empty { display: none; }
        }
      }`),
    ).toEqual([]);
  });

  it('labels every cell in every table that stacks', async () => {
    const sweep = await sweepMarkup(ROOT);
    expect(sweep.offences).toEqual([]);
    expect(sweep.files).toBeGreaterThan(10);
    expect(sweep.cells).toBeGreaterThan(60);
  });

  it('catches a cell added without a data-label', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'stacked-table-'));
    try {
      const dir = path.join(scratch, 'src', 'app');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'page.tsx'),
        [
          'export default function Page() {',
          '  return (',
          '    <table className="data-table data-table--stack">',
          '      <tbody><tr>',
          '        <td data-label="Description">a</td>',
          '        <td className="cell-num">{total}</td>',
          '      </tr></tbody>',
          '    </table>',
          '  );',
          '}',
          '',
        ].join('\n'),
      );
      const sweep = await sweepMarkup(scratch);
      expect(sweep.cells).toBe(2);
      expect(sweep.offences).toHaveLength(1);
      expect(sweep.offences[0]).toContain('carries no data-label');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('catches a cell padded with a space, which stays as a labelled blank', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'stacked-table-'));
    try {
      const dir = path.join(scratch, 'src', 'app');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'page.tsx'),
        [
          'const table = "data-table--stack";',
          'export const Row = () => (',
          '  <tr>',
          '    <td data-label="Description">{line.description}</td>',
          "    <td data-label=\"Code\">{' '}</td>",
          '    <td data-label="Amount" className="cell-num">',
          '      {amount}',
          '    </td>',
          '    <td className="no-print" />',
          '  </tr>',
          ');',
          '',
        ].join('\n'),
      );
      const sweep = await sweepMarkup(scratch);
      expect(sweep.cells).toBe(4);
      expect(sweep.offences).toHaveLength(1);
      expect(sweep.offences[0]).toContain('renders a space');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('reads a cell whose attributes span lines and hold braces', () => {
    const found = cells(
      [
        '<td',
        '  data-label="Margin"',
        '  className={`cell-num ${margin < 0 ? "text-negative" : ""}`}',
        '>',
        '  {formatBasisPoints(margin)}',
        '</td>',
      ].join('\n'),
    );
    expect(found).toHaveLength(1);
    expect(found[0].tag).toContain('data-label="Margin"');
    expect(rendersBlank(found[0].body)).toBe(false);
  });

  it('leaves a figure alone, zero or dash', () => {
    // The values this guard exists to protect. Each is a text node, so each
    // keeps its cell.
    for (const body of ['$0.00', '0', '—', '{formatCents(0)}', '<span>—</span>']) {
      expect(rendersBlank(body)).toBe(false);
    }
  });

  it('treats a cell written across lines as empty rather than blank', () => {
    // JSX drops whitespace holding a newline, so this renders nothing at all
    // and `:empty` shortens it away.
    expect(rendersBlank('\n            ')).toBe(false);
    expect(rendersBlank('')).toBe(false);
  });
});
