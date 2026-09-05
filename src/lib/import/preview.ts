import { parseQtyToMilli, parseRateToTenThou } from '@/lib/money/format';
import {
  FIELD_LABELS,
  mappingProblems,
  type RateField,
  type RateImportMapping,
} from '@/lib/import/mapping';

/**
 * The preview pass: what committing this file would do, row by row, and why.
 *
 * Ported from the sibling project's `src/lib/import/preview.ts` -- the other
 * file the reuse spec calls out -- and cut to this product. Deleted rather
 * than ported: dedup hashing, the merchant normalizer, the categorisation
 * engine, the transfer detector, the cardholder summary, the date-format
 * detector and the OFX branch. Every one of them answers a question a bank
 * statement asks. What survives is the shape that made the file worth
 * copying: one pure function that turns a grid plus a mapping into a decision
 * per row, with the decision's reason attached to the row rather than
 * summarised away from it.
 *
 * Pure on purpose. It takes the database's contribution -- which codes already
 * exist, which cost codes exist -- as plain arguments, so the same function
 * runs in the browser to draw the preview and on the server to decide the
 * commit. A preview computed by different code than the commit is a preview
 * that can lie, and this one cannot.
 */

export type CalcMode = 'qty' | 'flat' | 'percent';

/** Exactly the columns an import may fill, in the types the schema stores. */
export interface PlannedItem {
  code: string;
  description: string;
  costCodeId: string | null;
  calcMode: CalcMode;
  unitLabel: string;
  costRateTenThou: bigint;
  sellRateTenThou: bigint;
  isTaxable: boolean;
  isAllowance: boolean;
  defaultQtyMilli: bigint | null;
  sortOrder: number;
}

export interface PlanContext {
  /** Every `rate_items.code` already in the deployment, active, retired or void. */
  existingCodes: string[];
  costCodes: { id: string; code: string; name: string }[];
}

export type PlannedRow =
  | {
      outcome: 'create';
      /** The line number in the pasted text, counting the header. What a person can point at. */
      rowNumber: number;
      cells: string[];
      item: PlannedItem;
      /** Something was assumed rather than read. Never a refusal. */
      notes: string[];
    }
  | {
      outcome: 'skip';
      rowNumber: number;
      cells: string[];
      reason: string;
    };

export interface ImportPlan {
  headerCells: string[];
  rows: PlannedRow[];
  createCount: number;
  skipCount: number;
  /** How many creatable rows assumed something. Surfaced so it is not buried per-row. */
  noteCount: number;
  /** Wrong with the MAPPING, not with a row. A non-empty list refuses the whole import. */
  problems: string[];
}

/* -------------------------------------------------------------------------
   Cell readers
   ------------------------------------------------------------------------- */

function cell(cells: string[], index: number | null): string {
  if (index === null) return '';
  const value = cells[index];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Why a figure did not parse, in the terms a person can act on.
 *
 * `parseRateToTenThou` and `parseQtyToMilli` answer only `null`, which is
 * right for them -- a parser that guesses is worse than one that refuses --
 * but "that is not a number" is a useless thing to print beside a cell reading
 * `12.34567`. This classifies the refusal without re-implementing it: the
 * helpers in `lib/money/format.ts` remain the only parsers, and this only
 * looks at the text again to choose a sentence.
 */
function whyNotNumeric(raw: string, decimals: number): string {
  const stripped = raw.replace(/[\s ,]/g, '').replace(/−/g, '-');
  const fraction = /^[-+(]?(?:CAD|USD)?\$?\d+\.(\d+)\)?$/i.exec(stripped);
  if (fraction && fraction[1]!.length > decimals) {
    return `it carries ${fraction[1]!.length} decimal places and this figure holds ${decimals}`;
  }
  return 'it is not a number';
}

/** Accounting parentheses and a leading minus both mean negative. */
function looksNegative(raw: string): boolean {
  const stripped = raw.replace(/[\s ]/g, '');
  return stripped.startsWith('-') || stripped.startsWith('−') || /^\(.*\)$/.test(stripped);
}

const TRUE_WORDS = new Set(['y', 'yes', 'true', 't', '1', 'x', 'taxable', 'on']);
const FALSE_WORDS = new Set(['n', 'no', 'false', 'f', '0', 'exempt', 'off']);

const CALC_MODES: Record<string, CalcMode> = {
  qty: 'qty',
  quantity: 'qty',
  unit: 'qty',
  unitrate: 'qty',
  each: 'qty',
  measured: 'qty',
  flat: 'flat',
  fixed: 'flat',
  lump: 'flat',
  lumpsum: 'flat',
  flatrate: 'flat',
  percent: 'percent',
  percentage: 'percent',
  pct: 'percent',
  '%': 'percent',
};

/* -------------------------------------------------------------------------
   The plan
   ------------------------------------------------------------------------- */

/**
 * Decides what every row would do, in file order.
 *
 * Rows are decided in order and against each other: the second row carrying a
 * code the first row already used is the one refused, because the first is the
 * one the person meant and refusing both would refuse a list over one typo.
 */
export function planImport(
  grid: string[][],
  mapping: RateImportMapping,
  context: PlanContext,
): ImportPlan {
  const problems = mappingProblems(mapping);
  const headerCells = mapping.hasHeader ? (grid[0] ?? []) : [];
  const dataRows = mapping.hasHeader ? grid.slice(1) : grid;

  // Case-insensitive on purpose, and in the safe direction. The unique index
  // is on the code exactly as typed, so `DEM-01` and `dem-01` would both
  // insert -- and an owner reading his own list would call that one item
  // entered twice. Refusing the second is a refusal he can see and undo;
  // creating both is a duplicate he finds months later on a quote.
  const taken = new Map<string, number>();
  for (const code of context.existingCodes) taken.set(code.trim().toUpperCase(), 0);

  const costCodeByCode = new Map(
    context.costCodes.map((row) => [row.code.trim().toUpperCase(), row]),
  );

  const rows: PlannedRow[] = [];

  dataRows.forEach((cells, index) => {
    const rowNumber = index + (mapping.hasHeader ? 2 : 1);
    if (problems.length > 0) return; // A broken mapping decides nothing per row.

    const skip = (reason: string) => {
      rows.push({ outcome: 'skip', rowNumber, cells, reason });
    };
    const notes: string[] = [];

    /* ---- code ---- */
    const code = cell(cells, mapping.columns.code);
    if (code === '') return skip('It has no code, and a rate item is found by its code.');
    if (code.length > 60) return skip('Its code is longer than 60 characters.');

    const key = code.toUpperCase();
    const clash = taken.get(key);
    if (clash !== undefined) {
      return skip(
        clash === 0
          ? `A rate item with the code ${code} is already in the list. Edit that one instead — importing it again would be a second copy.`
          : `The code ${code} is already used by row ${clash} of this file.`,
      );
    }

    /* ---- description ---- */
    const description = cell(cells, mapping.columns.description);
    if (description === '') {
      return skip('It has no description, so nothing on a quote would say what it is.');
    }
    if (description.length > 500) return skip('Its description is longer than 500 characters.');

    /* ---- sell rate ---- */
    const sellRaw = cell(cells, mapping.columns.sellRate);
    if (sellRaw === '') {
      return skip(`It has no ${FIELD_LABELS.sellRate.toLowerCase()} price, and every rate item carries one.`);
    }
    const sellRateTenThou = parseRateToTenThou(sellRaw);
    if (sellRateTenThou === null) {
      return skip(`Its sell price “${sellRaw}” cannot be read: ${whyNotNumeric(sellRaw, 4)}.`);
    }

    /* ---- cost rate ----
       Optional, and zero when it is absent. A supplier's price list carries
       what he charges and nothing about what it costs; refusing those rows
       would refuse the common case. Zero is not hidden -- the note says so,
       and the list will show a 100% margin until somebody fills it in, which
       is a visible wrong rather than a plausible one. */
    const costRaw = cell(cells, mapping.columns.costRate);
    let costRateTenThou = 0n;
    if (costRaw === '') {
      if (mapping.columns.costRate === null) {
        notes.push('No cost column was mapped, so its cost is recorded as zero.');
      } else {
        notes.push('Its cost cell is empty, so its cost is recorded as zero.');
      }
    } else {
      const parsed = parseRateToTenThou(costRaw);
      if (parsed === null) {
        return skip(`Its cost “${costRaw}” cannot be read: ${whyNotNumeric(costRaw, 4)}.`);
      }
      costRateTenThou = parsed;
    }

    /* ---- unit ---- */
    const unitLabel = cell(cells, mapping.columns.unitLabel);
    if (unitLabel.length > 20) return skip('Its unit label is longer than 20 characters.');

    /* ---- how it calculates ---- */
    const calcRaw = cell(cells, mapping.columns.calcMode);
    let calcMode: CalcMode;
    if (calcRaw === '') {
      // A unit was given, so the line is measured; nothing was, so it is a
      // flat amount. `percent` is never guessed: a percent line multiplies
      // another figure, and guessing that from a blank cell would silently
      // change what a quote totals.
      calcMode = unitLabel === '' ? 'flat' : 'qty';
      // Deliberately NOT a note. Every row of a file with no mode column would
      // carry one, and a preview where every row says something is a preview
      // where nobody reads the rows that do. The inference is shown instead:
      // the preview prints the calc mode as its own column, so it is visible
      // rather than narrated, and notes stay reserved for what was ASSUMED
      // about data the file actually meant to carry.
    } else {
      const resolved = CALC_MODES[calcRaw.toLowerCase().replace(/[^a-z%]/g, '')];
      if (!resolved) {
        return skip(
          `“${calcRaw}” is not a way of calculating. Use quantity, flat or percent.`,
        );
      }
      calcMode = resolved;
    }

    /* ---- cost code ----
       An unrecognised one is a note, not a refusal. Cost codes are a list the
       owner builds up over time; refusing his price list because it mentions a
       division he has not created yet would be refusing the more valuable of
       the two records for the sake of the less. */
    const costCodeRaw = cell(cells, mapping.columns.costCode);
    let costCodeId: string | null = null;
    if (costCodeRaw !== '') {
      const match = costCodeByCode.get(costCodeRaw.toUpperCase());
      if (match) {
        costCodeId = match.id;
      } else {
        notes.push(`No cost code matches “${costCodeRaw}”, so it is left unassigned.`);
      }
    }

    /* ---- flags ---- */
    const taxable = readFlag(cells, mapping.columns.isTaxable, true);
    if (taxable === null) {
      return skip(`Its ${FIELD_LABELS.isTaxable.toLowerCase()} cell reads “${cell(cells, mapping.columns.isTaxable)}”, which is neither yes nor no.`);
    }
    const allowance = readFlag(cells, mapping.columns.isAllowance, false);
    if (allowance === null) {
      return skip(`Its ${FIELD_LABELS.isAllowance.toLowerCase()} cell reads “${cell(cells, mapping.columns.isAllowance)}”, which is neither yes nor no.`);
    }

    /* ---- default quantity ---- */
    const qtyRaw = cell(cells, mapping.columns.defaultQty);
    let defaultQtyMilli: bigint | null = null;
    if (qtyRaw !== '') {
      const parsed = parseQtyToMilli(qtyRaw);
      if (parsed === null) {
        return skip(
          looksNegative(qtyRaw)
            ? `Its default quantity “${qtyRaw}” is negative, and a quantity never is — a reduction is a negative price on a positive quantity.`
            : `Its default quantity “${qtyRaw}” cannot be read: ${whyNotNumeric(qtyRaw, 3)}.`,
        );
      }
      defaultQtyMilli = parsed;
    }

    /* ---- order ---- */
    const sortRaw = cell(cells, mapping.columns.sortOrder);
    let sortOrder = 0;
    if (sortRaw !== '') {
      if (!/^\d{1,6}$/.test(sortRaw)) {
        return skip(`Its order “${sortRaw}” is not a whole number.`);
      }
      sortOrder = Number(sortRaw);
    }

    taken.set(key, rowNumber);
    rows.push({
      outcome: 'create',
      rowNumber,
      cells,
      notes,
      item: {
        code,
        description,
        costCodeId,
        calcMode,
        unitLabel,
        costRateTenThou,
        sellRateTenThou,
        isTaxable: taxable,
        isAllowance: allowance,
        defaultQtyMilli,
        sortOrder,
      },
    });
  });

  const createRows = rows.filter((row) => row.outcome === 'create');

  return {
    headerCells,
    rows,
    createCount: createRows.length,
    skipCount: rows.length - createRows.length,
    noteCount: createRows.filter((row) => row.notes.length > 0).length,
    problems,
  };
}

/** A yes/no cell. `null` means the cell said something that is neither. */
function readFlag(cells: string[], index: number | null, fallback: boolean): boolean | null {
  const raw = cell(cells, index);
  if (raw === '') return fallback;
  const word = raw.toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return null;
}

/** The columns a person can choose from, labelled by their header where there is one. */
export function columnOptions(grid: string[][], hasHeader: boolean): { index: number; label: string }[] {
  const width = grid.reduce((widest, row) => Math.max(widest, row.length), 0);
  const header = hasHeader ? (grid[0] ?? []) : [];
  return Array.from({ length: width }, (_, index) => {
    const text = (header[index] ?? '').trim();
    return { index, label: text === '' ? `Column ${index + 1}` : text };
  });
}

export type { RateField };
