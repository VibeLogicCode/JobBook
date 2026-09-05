import { describe, expect, it } from 'vitest';
import { autoMap, emptyMapping, mappingProblems, type RateImportMapping } from '@/lib/import/mapping';
import { columnOptions, planImport, type PlanContext } from '@/lib/import/preview';
import { ImportLimitError, decodeBytes, detectDelimiter, splitRows, toGrid } from '@/lib/import/text';

/**
 * The rate-item importer's parsing, mapping and validation.
 *
 * The money cases are the ones with teeth. A spreadsheet hands over
 * `$1,234.50`, `1234.5`, `(45.00)` and an empty cell for the same column in
 * the same file, and every one of them has to land on a scaled integer or be
 * refused with a sentence -- never on a JavaScript number, and never on a
 * guess. A rate is multiplied by a quantity on every quote that uses it, so a
 * hundredth of a cent wrong here is wrong on every document that follows.
 */

const NO_CONTEXT: PlanContext = { existingCodes: [], costCodes: [] };

/** Code, Description, Unit, Cost, Sell -- the mapping most of these tests use. */
function fiveColumnMapping(over: Partial<RateImportMapping['columns']> = {}): RateImportMapping {
  const mapping = emptyMapping(true);
  mapping.columns.code = 0;
  mapping.columns.description = 1;
  mapping.columns.unitLabel = 2;
  mapping.columns.costRate = 3;
  mapping.columns.sellRate = 4;
  Object.assign(mapping.columns, over);
  return mapping;
}

function planOf(text: string, mapping = fiveColumnMapping(), context = NO_CONTEXT) {
  return planImport(toGrid(text).rows, mapping, context);
}

function created(plan: ReturnType<typeof planImport>) {
  return plan.rows.flatMap((row) => (row.outcome === 'create' ? [row] : []));
}

function skipped(plan: ReturnType<typeof planImport>) {
  return plan.rows.flatMap((row) => (row.outcome === 'skip' ? [row] : []));
}

/* ------------------------------------------------------------------------- */

describe('reading delimited text', () => {
  it('reads a spreadsheet paste, which is tab-separated', () => {
    const text = 'Code\tDescription\tSell\nDEM-01\tStrip existing\t4.00';
    expect(detectDelimiter(text)).toBe('\t');
    expect(splitRows(text, '\t')[1]).toEqual(['DEM-01', 'Strip existing', '4.00']);
  });

  it('does not let a comma inside a quoted description outvote the real separator', () => {
    // The failure this exists for: one description carrying a comma turning a
    // genuinely tab-separated paste into a one-column file.
    const text = 'Code\tDescription\nDRY-01\t"Drywall, taped and sanded"';
    expect(detectDelimiter(text)).toBe('\t');
  });

  it('keeps a comma, a newline and a doubled quote inside a quoted field', () => {
    const rows = splitRows('code,description\nINS-01,"2"" rigid, foil faced\nsecond line"\n', ',');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['INS-01', '2" rigid, foil faced\nsecond line']);
  });

  it('keeps a bare quote in an unquoted field rather than refusing the row', () => {
    // `2" rigid insulation` is a real description. Refusing it would be
    // refusing the price list over punctuation.
    expect(splitRows('INS-02,2" rigid insulation', ',')[0]).toEqual(['INS-02', '2" rigid insulation']);
  });

  it('drops wholly blank rows, including the one a trailing newline makes', () => {
    expect(splitRows('a,b\n\nc,d\n', ',')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('reads a last row that has no trailing newline', () => {
    expect(splitRows('a,b\nc,d', ',')).toHaveLength(2);
  });

  it('falls back to windows-1252 rather than decoding UTF-8 lossily', () => {
    // 0xE9 alone is not valid UTF-8. A lossy decode turns it into U+FFFD and
    // the owner retypes the description; the fallback reads it as "é".
    const bytes = Uint8Array.from([0x42, 0xe9, 0x74, 0x6f, 0x6e]);
    expect(decodeBytes(bytes)).toEqual({ text: 'Béton', encoding: 'windows-1252' });
  });

  it('strips a byte-order mark, which would otherwise hide inside the first header', () => {
    const bytes = new TextEncoder().encode('﻿Code,Sell');
    expect(decodeBytes(bytes).text).toBe('Code,Sell');
  });

  it('refuses a file with more rows than the screen will read', () => {
    const huge = Array.from({ length: 5_002 }, (_, i) => `C-${i},x`).join('\n');
    expect(() => splitRows(huge, ',')).toThrow(ImportLimitError);
  });
});

describe('guessing the mapping from a header row', () => {
  it('finds the ordinary column names', () => {
    const mapping = autoMap(['Code', 'Description', 'Unit', 'Unit Cost', 'Unit Price']);
    expect(mapping.columns.code).toBe(0);
    expect(mapping.columns.description).toBe(1);
    expect(mapping.columns.unitLabel).toBe(2);
    expect(mapping.columns.costRate).toBe(3);
    expect(mapping.columns.sellRate).toBe(4);
  });

  it('reads headers regardless of case, spacing and punctuation', () => {
    const mapping = autoMap(['ITEM_CODE', 'desc', 'U.O.M.', 'sell rate']);
    expect(mapping.columns.code).toBe(0);
    expect(mapping.columns.description).toBe(1);
    expect(mapping.columns.unitLabel).toBe(2);
    expect(mapping.columns.sellRate).toBe(3);
  });

  it('never gives one column to two fields', () => {
    const mapping = autoMap(['Item', 'Item', 'Price']);
    expect(mapping.columns.code).toBe(0);
    expect(mapping.columns.description).toBe(1);
    expect(mappingProblems(mapping)).toEqual([]);
  });

  it('leaves a column it does not recognise unmapped rather than guessing', () => {
    const mapping = autoMap(['Code', 'Description', 'Sell', 'Supplier lead time']);
    expect(Object.values(mapping.columns)).not.toContain(3);
  });

  it('labels the columns for the picker, header or no header', () => {
    const grid = [['Code', '', 'Sell'], ['A', 'x', '1']];
    expect(columnOptions(grid, true)).toEqual([
      { index: 0, label: 'Code' },
      { index: 1, label: 'Column 2' },
      { index: 2, label: 'Sell' },
    ]);
    expect(columnOptions(grid, false)[0]).toEqual({ index: 0, label: 'Column 1' });
  });
});

describe('refusing a mapping before any row is read', () => {
  it('names every required field that is unmapped', () => {
    const problems = mappingProblems(emptyMapping(true));
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toContain('Code');
    expect(problems.join(' ')).toContain('Description');
    expect(problems.join(' ')).toContain('Sell');
  });

  it('catches two fields pointed at one column', () => {
    const mapping = fiveColumnMapping({ costRate: 4 });
    expect(mappingProblems(mapping)[0]).toContain('column 5');
  });

  it('plans no rows at all while the mapping is broken', () => {
    // Half a plan against a mapping that cannot work is worse than none: it
    // would show rows "to create" that the commit would refuse.
    const plan = planOf('Code,Sell\nDEM-01,4.00', emptyMapping(true));
    expect(plan.rows).toEqual([]);
    expect(plan.createCount).toBe(0);
  });
});

describe('money, as a spreadsheet actually writes it', () => {
  const header = 'Code,Description,Unit,Cost,Sell\n';

  it('reads a currency symbol and thousands separators exactly', () => {
    const plan = planOf(`${header}FRM-01,Framing,sqft,900.00,"$1,234.50"`);
    expect(created(plan)[0]!.item.sellRateTenThou).toBe(12345000n);
    expect(created(plan)[0]!.item.costRateTenThou).toBe(9000000n);
  });

  it('pads a short fraction rather than multiplying a float', () => {
    // 1234.5 and $1,234.50 are the same figure and must produce the same
    // integer. `parseFloat('1234.5') * 10000` happens to be exact; the digit
    // concatenation the parser uses is exact for every input, which is the
    // point.
    expect(created(planOf(`${header}FRM-02,Framing,sqft,,1234.5`))[0]!.item.sellRateTenThou).toBe(
      12345000n,
    );
  });

  it('holds four decimals without rounding them away', () => {
    expect(created(planOf(`${header}FIN-01,Fasteners,ea,,0.0125`))[0]!.item.sellRateTenThou).toBe(125n);
  });

  it('reads accounting parentheses as a negative price', () => {
    // A negative sell rate is a real business figure -- a discount line, or a
    // deductive change order -- and the schema says so. Parentheses are how
    // every spreadsheet in the trade writes one.
    const plan = planOf(`${header}DIS-01,Repeat customer discount,,,(45.00)`);
    expect(created(plan)[0]!.item.sellRateTenThou).toBe(-450000n);
  });

  it('reads a negative cost the same way, because a deductive line removes cost too', () => {
    const plan = planOf(`${header}CO-01,Remove scope,,(45.00),(80.00)`);
    expect(created(plan)[0]!.item.costRateTenThou).toBe(-450000n);
    expect(created(plan)[0]!.item.sellRateTenThou).toBe(-800000n);
  });

  it('records an empty cost cell as zero, and says so on the row', () => {
    const plan = planOf(`${header}DEM-01,Strip existing,sqft,,4.00`);
    const row = created(plan)[0]!;
    expect(row.item.costRateTenThou).toBe(0n);
    expect(row.notes.join(' ')).toContain('zero');
    expect(plan.noteCount).toBe(1);
  });

  it('says the same thing differently when no cost column was mapped at all', () => {
    const mapping = fiveColumnMapping({ costRate: null });
    const row = created(planOf('Code,Description,Unit,Cost,Sell\nDEM-01,Strip,sqft,,4.00', mapping))[0]!;
    expect(row.notes[0]).toContain('No cost column');
  });

  it('refuses an empty sell cell rather than inventing a price', () => {
    const plan = planOf(`${header}DEM-02,Strip existing,sqft,3.00,`);
    expect(skipped(plan)[0]!.reason).toContain('no sell price');
  });

  it('refuses a figure carrying more decimals than the column holds, and counts them', () => {
    const reason = skipped(planOf(`${header}DEM-03,Strip,sqft,,4.12345`))[0]!.reason;
    expect(reason).toContain('5 decimal places');
    expect(reason).toContain('holds 4');
  });

  it('refuses text in a price column instead of reading it as zero', () => {
    const reason = skipped(planOf(`${header}DEM-04,Strip,sqft,,call for pricing`))[0]!.reason;
    expect(reason).toContain('cannot be read');
    expect(reason).toContain('not a number');
  });

  it('reads a quantity to thousandths and refuses a negative one', () => {
    const mapping = fiveColumnMapping({ defaultQty: 5 });
    const text = 'Code,Description,Unit,Cost,Sell,Qty\nA,Alpha,ea,,1.00,2.5\nB,Beta,ea,,1.00,(3)';
    const plan = planImport(toGrid(text).rows, mapping, NO_CONTEXT);
    expect(created(plan)[0]!.item.defaultQtyMilli).toBe(2500n);
    expect(skipped(plan)[0]!.reason).toContain('negative');
  });

  it('leaves an empty quantity null rather than zero', () => {
    const mapping = fiveColumnMapping({ defaultQty: 5 });
    const text = 'Code,Description,Unit,Cost,Sell,Qty\nA,Alpha,ea,,1.00,';
    expect(created(planImport(toGrid(text).rows, mapping, NO_CONTEXT))[0]!.item.defaultQtyMilli).toBeNull();
  });
});

describe('deciding what happens to a row', () => {
  const header = 'Code,Description,Unit,Cost,Sell\n';

  it('refuses a row with no code and a row with no description, separately', () => {
    const plan = planOf(`${header},Strip existing,sqft,,4.00\nDEM-01,,sqft,,4.00`);
    expect(skipped(plan)[0]!.reason).toContain('no code');
    expect(skipped(plan)[1]!.reason).toContain('no description');
  });

  it('refuses a code the deployment already holds, and names it', () => {
    const plan = planOf(`${header}DEM-01,Strip existing,sqft,,4.00`, fiveColumnMapping(), {
      existingCodes: ['DEM-01'],
      costCodes: [],
    });
    expect(skipped(plan)[0]!.reason).toContain('already in the list');
    expect(plan.createCount).toBe(0);
  });

  it('matches an existing code whatever its case, in the safe direction', () => {
    // The unique index is on the code as typed, so `dem-01` WOULD insert
    // beside `DEM-01`. An owner reading his own list would call that one item
    // entered twice, and a refusal he can see beats a duplicate he finds
    // months later on a quote.
    const plan = planOf(`${header}dem-01,Strip existing,sqft,,4.00`, fiveColumnMapping(), {
      existingCodes: ['DEM-01'],
      costCodes: [],
    });
    expect(plan.createCount).toBe(0);
  });

  it('keeps the first of two rows sharing a code and refuses the second by row number', () => {
    const plan = planOf(`${header}DEM-01,Strip existing,sqft,,4.00\nDEM-01,Strip again,sqft,,5.00`);
    expect(plan.createCount).toBe(1);
    expect(created(plan)[0]!.item.description).toBe('Strip existing');
    expect(skipped(plan)[0]!.reason).toContain('row 2');
  });

  it('numbers rows the way a person counts them, header included', () => {
    const plan = planOf(`${header}A,Alpha,ea,,1.00\nB,Beta,ea,,2.00`);
    expect(created(plan).map((row) => row.rowNumber)).toEqual([2, 3]);
  });

  it('numbers from one when the file has no header row', () => {
    const mapping = fiveColumnMapping();
    mapping.hasHeader = false;
    const plan = planImport(toGrid('A,Alpha,ea,,1.00').rows, mapping, NO_CONTEXT);
    expect(created(plan)[0]!.rowNumber).toBe(1);
  });
});

describe('the fields a price list only sometimes carries', () => {
  const header = 'Code,Description,Unit,Cost,Sell,Mode,Taxable,Allowance,CostCode\n';
  const wide = fiveColumnMapping({
    calcMode: 5,
    isTaxable: 6,
    isAllowance: 7,
    costCode: 8,
  });

  function planWide(body: string, context = NO_CONTEXT) {
    return planImport(toGrid(header + body).rows, wide, context);
  }

  it('infers quantity pricing from a unit and a flat amount from none', () => {
    const plan = planWide('A,Alpha,sqft,2.00,1.00,,,,\nB,Beta,,,500.00,,,,');
    expect(created(plan)[0]!.item.calcMode).toBe('qty');
    expect(created(plan)[1]!.item.calcMode).toBe('flat');
    // The inference deliberately leaves no note. Every row of a file with no
    // mode column would carry one, and a preview where every row says
    // something is a preview whose notes nobody reads. It is shown as its own
    // column instead.
    expect(created(plan)[0]!.notes).toEqual([]);
  });

  it('never infers a percentage, because that would change what a quote totals', () => {
    const modes = created(planWide('A,Alpha,,,10.00,,,,')).map((row) => row.item.calcMode);
    expect(modes).not.toContain('percent');
  });

  it('reads the words a person writes for how a line calculates', () => {
    const plan = planWide('A,Alpha,,,1.00,Lump sum,,,\nB,Beta,,,1.00,%,,,\nC,Gamma,ea,,1.00,Unit,,,');
    expect(created(plan).map((row) => row.item.calcMode)).toEqual(['flat', 'percent', 'qty']);
  });

  it('refuses a way of calculating it does not know', () => {
    expect(skipped(planWide('A,Alpha,,,1.00,per diem,,,'))[0]!.reason).toContain('not a way of calculating');
  });

  it('reads yes and no in the forms a spreadsheet writes them', () => {
    const plan = planWide('A,Alpha,,,1.00,,Y,no,\nB,Beta,,,1.00,,FALSE,1,');
    expect(created(plan)[0]!.item).toMatchObject({ isTaxable: true, isAllowance: false });
    expect(created(plan)[1]!.item).toMatchObject({ isTaxable: false, isAllowance: true });
  });

  it('defaults a blank flag to the column default rather than to false', () => {
    const item = created(planWide('A,Alpha,,,1.00,,,,'))[0]!.item;
    expect(item.isTaxable).toBe(true);
    expect(item.isAllowance).toBe(false);
  });

  it('refuses a flag cell that says neither yes nor no', () => {
    expect(skipped(planWide('A,Alpha,,,1.00,,maybe,,'))[0]!.reason).toContain('neither yes nor no');
  });

  it('resolves a cost code by its code, whatever the case', () => {
    const plan = planWide('A,Alpha,,,1.00,,,,02-40', {
      existingCodes: [],
      costCodes: [{ id: 'a1b2', code: '02-40', name: 'Demolition' }],
    });
    expect(created(plan)[0]!.item.costCodeId).toBe('a1b2');
  });

  it('creates the row without a cost code when the file names one that does not exist', () => {
    // Refusing here would refuse the price list -- the more valuable of the
    // two records -- because it mentions a division the owner has not created
    // yet. The row is created and the assumption is stated.
    const plan = planWide('A,Alpha,,,1.00,,,,99-99');
    expect(created(plan)[0]!.item.costCodeId).toBeNull();
    expect(created(plan)[0]!.notes.join(' ')).toContain('99-99');
  });
});

describe('the summary the preview shows', () => {
  it('counts creations, refusals and assumptions separately', () => {
    const plan = planOf(
      'Code,Description,Unit,Cost,Sell\nA,Alpha,ea,1.00,2.00\nB,Beta,ea,,3.00\n,Gamma,ea,1.00,2.00',
    );
    expect(plan.createCount).toBe(2);
    expect(plan.skipCount).toBe(1);
    expect(plan.noteCount).toBe(1);
    expect(plan.rows).toHaveLength(3);
  });

  it('keeps the raw cells on a refused row, so the screen can show what was in it', () => {
    const row = skipped(planOf('Code,Description,Unit,Cost,Sell\n,Gamma,ea,1.00,2.00'))[0]!;
    expect(row.cells).toEqual(['', 'Gamma', 'ea', '1.00', '2.00']);
  });
});
