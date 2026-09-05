import { z } from 'zod';

/**
 * Which column of the pasted file holds which field of a rate item.
 *
 * Ported from the sibling project's `src/lib/import/mapping.ts`, which is the
 * file the reuse spec says carries most directly, and rewritten to this
 * product's target shape. Deleted rather than ported: `amountMode`,
 * `signConvention`, `debitCol`/`creditCol`, `balanceCol`, `cardCol`,
 * `skipRules`, `dateCol`/`dateFormat` and the whole `encoding` choice -- every
 * one of them is a bank statement's problem. A price list has no debit side,
 * no running balance and no date.
 *
 * What is kept is the shape of the idea: a field maps to a 0-based column
 * index or to null, the mapping is validated before it is trusted, and a
 * header row is a separate fact from how many lines to skip.
 */

/**
 * Every field of `rate_items` a person can fill from a spreadsheet.
 *
 * `id`, `isActive` and the audit columns are deliberately absent. An import
 * creates active rows; a row arriving already retired is a row nobody meant
 * to type, and letting a file set `created_by` would let a file forge one.
 */
export const RATE_FIELDS = [
  'code',
  'description',
  'costCode',
  'calcMode',
  'unitLabel',
  'costRate',
  'sellRate',
  'isTaxable',
  'isAllowance',
  'defaultQty',
  'sortOrder',
] as const;

export type RateField = (typeof RATE_FIELDS)[number];

/** What each field is called on screen, and whether the import can proceed without it. */
export const FIELD_LABELS: Record<RateField, string> = {
  code: 'Code',
  description: 'Description',
  costCode: 'Cost code',
  calcMode: 'How it calculates',
  unitLabel: 'Unit',
  costRate: 'Cost',
  sellRate: 'Sell',
  isTaxable: 'Taxable',
  isAllowance: 'Allowance',
  defaultQty: 'Default quantity',
  sortOrder: 'Order',
};

/**
 * The two a rate item cannot exist without.
 *
 * `sellRate` is a third notNull column, but it is not on this list: a list
 * with no price column at all is a mistake worth catching per row rather than
 * up front, and the row-level refusal says which cell was empty.
 */
export const REQUIRED_FIELDS: RateField[] = ['code', 'description', 'sellRate'];

export interface RateImportMapping {
  /** The first row names the columns rather than holding data. */
  hasHeader: boolean;
  /** 0-based column index per field, or null when the file does not carry it. */
  columns: Record<RateField, number | null>;
}

const columnIndex = z.number().int().min(0).max(300).nullable();

export const rateImportMappingSchema: z.ZodType<RateImportMapping> = z.object({
  hasHeader: z.boolean(),
  columns: z.object({
    code: columnIndex,
    description: columnIndex,
    costCode: columnIndex,
    calcMode: columnIndex,
    unitLabel: columnIndex,
    costRate: columnIndex,
    sellRate: columnIndex,
    isTaxable: columnIndex,
    isAllowance: columnIndex,
    defaultQty: columnIndex,
    sortOrder: columnIndex,
  }),
});

export function emptyMapping(hasHeader = true): RateImportMapping {
  const columns = {} as Record<RateField, number | null>;
  for (const field of RATE_FIELDS) columns[field] = null;
  return { hasHeader, columns };
}

/**
 * Header text a person might reasonably have typed, per field.
 *
 * Matched against a normalized form -- lowercased, everything that is not a
 * letter or a digit removed -- so `Unit Price`, `unit_price` and `UNIT-PRICE`
 * are one entry rather than three. The lists are the vocabulary a residential
 * contractor's own price list uses, not a bank's.
 */
const SYNONYMS: Record<RateField, string[]> = {
  code: ['code', 'itemcode', 'item', 'sku', 'ref', 'reference', 'itemno', 'itemnumber', 'number'],
  description: ['description', 'desc', 'item', 'itemdescription', 'name', 'work', 'scope', 'details'],
  costCode: ['costcode', 'costcodes', 'division', 'phase', 'category', 'trade', 'costcategory'],
  calcMode: ['calcmode', 'type', 'howitcalculates', 'pricingtype', 'linetype', 'mode', 'basis'],
  unitLabel: ['unit', 'units', 'uom', 'unitofmeasure', 'measure', 'per'],
  costRate: ['cost', 'unitcost', 'costrate', 'ourcost', 'buy', 'buyrate', 'costeach', 'materialcost'],
  sellRate: ['sell', 'sellrate', 'price', 'unitprice', 'rate', 'sellprice', 'charge', 'retail', 'selleach'],
  isTaxable: ['taxable', 'tax', 'istaxable', 'gst', 'hst', 'vat'],
  isAllowance: ['allowance', 'isallowance', 'allow', 'provisionalsum'],
  defaultQty: ['defaultqty', 'defaultquantity', 'qty', 'quantity', 'defaultamount'],
  sortOrder: ['sortorder', 'order', 'sort', 'seq', 'sequence', 'position'],
};

export function normalizeHeader(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A first guess at the mapping from the header row.
 *
 * A guess, not a decision: the preview screen shows every choice as a
 * changeable dropdown, because the cost of a wrong guess accepted silently is
 * a price list imported with cost and sell the wrong way round -- which reads
 * as a negative margin on every quote until somebody works out why.
 *
 * Order matters twice over. Fields are walked in `RATE_FIELDS` order so `code`
 * claims a column headed "Item" before `description` can, which is the common
 * collision; and a synonym list is walked in its own order so an exact
 * `cost` beats a fuzzy `materialcost`. A column already claimed is never
 * claimed twice.
 */
export function autoMap(headerCells: string[]): RateImportMapping {
  const mapping = emptyMapping(true);
  const normalized = headerCells.map(normalizeHeader);
  const taken = new Set<number>();

  // Exact matches first, across every field, before any fuzzy match is
  // allowed to take a column: a header reading exactly "cost" must not lose
  // its column to `defaultQty` matching "defaultamount" inside it.
  for (const pass of ['exact', 'fuzzy'] as const) {
    for (const field of RATE_FIELDS) {
      if (mapping.columns[field] !== null) continue;
      for (const synonym of SYNONYMS[field]) {
        const index = normalized.findIndex((header, at) => {
          if (taken.has(at) || header === '') return false;
          return pass === 'exact' ? header === synonym : header.includes(synonym);
        });
        if (index !== -1) {
          mapping.columns[field] = index;
          taken.add(index);
          break;
        }
      }
    }
  }

  return mapping;
}

/**
 * What is wrong with a mapping, in sentences, or an empty list.
 *
 * Returned rather than thrown so the preview screen can show every problem at
 * once instead of the first one; the commit action treats a non-empty list as
 * a refusal.
 */
export function mappingProblems(mapping: RateImportMapping): string[] {
  const problems: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (mapping.columns[field] === null) {
      problems.push(`Nothing is mapped to ${FIELD_LABELS[field]}, and a rate item cannot be created without it.`);
    }
  }

  const seen = new Map<number, RateField>();
  for (const field of RATE_FIELDS) {
    const index = mapping.columns[field];
    if (index === null) continue;
    const already = seen.get(index);
    if (already) {
      problems.push(
        `${FIELD_LABELS[already]} and ${FIELD_LABELS[field]} are both reading column ${index + 1}. One column holds one field.`,
      );
    } else {
      seen.set(index, field);
    }
  }

  return problems;
}
