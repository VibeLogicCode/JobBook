/**
 * Delimited text into a grid of cells.
 *
 * Ported from the sibling project's `src/lib/import/{decode,parse}.ts` and cut
 * hard, per the reuse spec's rule: copy, then delete rather than leave
 * configurable. What was deleted, and why:
 *
 * - **papaparse.** The sibling leans on it for one function -- splitting a
 *   quoted CSV. Adding a dependency to this product's `package.json` to reach
 *   forty lines of state machine is a worse trade here than writing them,
 *   especially as this file also has to split TAB-separated text, which is
 *   what a spreadsheet actually puts on the clipboard.
 * - **iconv-lite.** The sibling needs it because its Node runtime predates
 *   full ICU. Node 22 ships `TextDecoder('windows-1252')`, so the fallback
 *   costs nothing.
 * - **Encoding as a mapping option.** The sibling lets a person force an
 *   encoding, because a bank hands out one file a month for years and a wrong
 *   guess is a recurring irritation. A price list is pasted once. Detection is
 *   strict UTF-8 or windows-1252, with no third answer to choose between.
 *
 * Nothing here knows what a rate item is. It hands back rows of strings.
 */

/** A price list that does not fit in this is a price list, not a paste. */
export const MAX_CHARS = 2_000_000;
/** Well past any hand-maintained rate list, and short of a browser stall. */
export const MAX_ROWS = 5_000;

export class ImportLimitError extends Error {
  readonly code: 'too_large' | 'too_many_rows';

  constructor(code: 'too_large' | 'too_many_rows', message: string) {
    super(message);
    this.name = 'ImportLimitError';
    this.code = code;
  }
}

export type Delimiter = ',' | '\t' | ';' | '|';

const DELIMITERS: Delimiter[] = [',', '\t', ';', '|'];

/**
 * Strict UTF-8 first, windows-1252 second.
 *
 * "Auto" never uses a lossy UTF-8 decode: a lossy decode is exactly what turns
 * a name carrying an accent into mojibake, and a rate description reading
 * `BÃ©ton` is a description somebody has to retype.
 */
export function decodeBytes(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'windows-1252' } {
  try {
    return { text: stripBom(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), encoding: 'utf-8' };
  } catch {
    return {
      text: stripBom(new TextDecoder('windows-1252').decode(bytes)),
      encoding: 'windows-1252',
    };
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Which character separates the columns.
 *
 * Counted only OUTSIDE quotes, and only over the first few lines: a
 * description reading `Drywall, taped` would otherwise vote for the comma in a
 * file that is genuinely tab-separated, and a spreadsheet paste is always
 * tab-separated. Ties resolve in DELIMITERS order, which puts the comma first
 * because a file with no delimiter at all is a one-column list and the comma
 * reads it correctly.
 */
export function detectDelimiter(text: string): Delimiter {
  const sample = text.split('\n').slice(0, 20).join('\n');
  let best: Delimiter = ',';
  let bestCount = 0;

  for (const candidate of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < sample.length; i += 1) {
      const character = sample[i];
      if (character === '"') {
        quoted = !quoted;
        continue;
      }
      if (!quoted && character === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  return best;
}

/**
 * Splits delimited text into rows of cells.
 *
 * RFC 4180 quoting: a quoted field may hold the delimiter, a newline, and a
 * doubled `""` standing for one quote. A bare quote in the middle of an
 * unquoted field is kept as a character rather than treated as an error --
 * `2" rigid insulation` is a real description, and refusing the row would be
 * refusing the price list.
 *
 * Wholly empty rows are dropped here rather than reported: a trailing newline
 * is not a row somebody has to be told about.
 */
export function splitRows(text: string, delimiter: Delimiter): string[][] {
  if (text.length > MAX_CHARS) {
    throw new ImportLimitError('too_large', 'That is larger than this screen will read at once.');
  }

  const rows: string[][] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = () => {
    cells.push(field);
    field = '';
    started = false;
  };
  const endRow = () => {
    endField();
    if (cells.some((cell) => cell.trim() !== '')) rows.push(cells);
    cells = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];

    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && !started) {
      quoted = true;
      started = true;
      continue;
    }
    if (character === delimiter) {
      endField();
      continue;
    }
    if (character === '\r') continue;
    if (character === '\n') {
      endRow();
      if (rows.length > MAX_ROWS) {
        throw new ImportLimitError('too_many_rows', `That is more than ${MAX_ROWS} rows.`);
      }
      continue;
    }

    field += character;
    started = true;
  }

  // A file with no trailing newline still ends on a row.
  if (field !== '' || cells.length > 0) endRow();

  if (rows.length > MAX_ROWS) {
    throw new ImportLimitError('too_many_rows', `That is more than ${MAX_ROWS} rows.`);
  }

  return rows;
}

/** Reads a pasted block or an uploaded file's text into a grid in one step. */
export function toGrid(text: string, delimiter?: Delimiter): { rows: string[][]; delimiter: Delimiter } {
  const resolved = delimiter ?? detectDelimiter(text);
  return { rows: splitRows(text, resolved), delimiter: resolved };
}
