import { describe, expect, it } from 'vitest';
import {
  BATCH_ROWS,
  amountField,
  distanceField,
  formatRatePerKm,
  mileageCostCents,
  mileageSummary,
  purchaseFields,
  readBatchRows,
  readTaxLines,
  signMismatch,
} from '@/app/expenses/schema';

/**
 * The parts of expense capture that have a correctness claim in them and no
 * database anywhere near them: what a typed figure means, what a trip costs,
 * and which half-filled rows a bulk grid is allowed to accept.
 */

/* -------------------------------------------------------------------------
   Money as a person types it
   ------------------------------------------------------------------------- */

describe('an amount off a receipt', () => {
  const parse = (raw: string) => amountField().safeParse(raw);

  it('reads the three shapes a receipt actually arrives in', () => {
    // Dressed: a currency mark and a thousands separator.
    expect(parse('$1,234.50').data).toBe(123450);
    // Short: the second decimal was a zero and nobody typed it.
    expect(parse('1234.5').data).toBe(123450);
    // Accounting notation for a negative, which on an expense is a return.
    expect(parse('(45.00)').data).toBe(-4500);
  });

  it('reads a minus the same way, whichever minus was typed', () => {
    expect(parse('-45.00').data).toBe(-4500);
    // U+2212, which a paste out of a spreadsheet or a document produces.
    expect(parse('−45.00').data).toBe(-4500);
  });

  it('treats a blank as zero rather than as an absence', () => {
    // Every money column on the row is NOT NULL with a default of zero: a
    // receipt with no tax on it had no tax, which is a figure.
    expect(parse('').data).toBe(0);
  });

  it('never lands on negative zero', () => {
    expect(Object.is(parse('(0.00)').data, -0)).toBe(false);
    expect(parse('(0.00)').data).toBe(0);
  });

  it('refuses a third decimal place rather than rounding it away', () => {
    // Nothing on a receipt has three decimals, so this is a typo or a quantity
    // in a money box. Silently making 12.345 into 12.35 is how a stored total
    // stops matching the paper it came from.
    expect(parse('12.345').success).toBe(false);
  });

  it('refuses words, and a figure with the decimal point in the wrong place', () => {
    expect(parse('forty five').success).toBe(false);
    expect(parse('99999999999').success).toBe(false);
  });

  it('builds cents from digits rather than by multiplying a float', () => {
    // 8.29 * 100 is 828.9999999999999 in IEEE 754. A parser that multiplied
    // would need a rounding rule here, and the rule is what drifts.
    expect(parse('8.29').data).toBe(829);
    expect(parse('1.005').success).toBe(false);
  });
});

describe('a distance', () => {
  const parse = (raw: string) => distanceField.safeParse(raw);

  it('reads kilometres as integer thousandths', () => {
    expect(parse('42.5').data).toBe(42500n);
    expect(parse('7').data).toBe(7000n);
    expect(parse('0.125').data).toBe(125n);
  });

  it('refuses a sign, because nobody un-drives a trip', () => {
    // A negative amount is a credit; a negative distance is nothing at all.
    // The correction for a wrong trip is a void and a re-entry.
    expect(parse('-40').success).toBe(false);
    expect(parse('(40)').success).toBe(false);
  });

  it('refuses zero, a fourth decimal, and a cross-country drive', () => {
    expect(parse('0').success).toBe(false);
    expect(parse('12.3456').success).toBe(false);
    expect(parse('5000').success).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   What a trip costs
   ------------------------------------------------------------------------- */

describe('the cost of a trip', () => {
  it('multiplies thousandths by ten-thousandths and lands on cents', () => {
    // 42.5 km at 0.7200 = $30.60.
    expect(mileageCostCents(42500n, 7200n)).toBe(3060);
    // 100 km at 0.7000 = $70.00.
    expect(mileageCostCents(100_000n, 7000n)).toBe(7000);
  });

  it('rounds halves away from zero, as the rest of the product does', () => {
    // 1 km at 0.1250 is 12.5 cents exactly, which goes to 13 rather than to
    // the nearest even. Half-away-from-zero is the house rule, and reusing
    // lineTotalCents is what keeps this from being a second opinion.
    expect(mileageCostCents(1000n, 1250n)).toBe(13);
    expect(mileageCostCents(1000n, 1150n)).toBe(12);
  });

  it('stays exact at a distance a JavaScript number could not hold', () => {
    // Not a realistic trip -- the form caps at 2000 km -- but the arithmetic
    // must be BigInt all the way, and this is what proves it is: the product
    // here is 4e18, well past Number.MAX_SAFE_INTEGER at 9.007e15.
    expect(mileageCostCents(500_000_000_000n, 9999n)).toBe(49_995_000_000);
  });

  it('costs a trip from the rate it is given and from nothing else', () => {
    // The whole design in one assertion: the same distance costs two different
    // amounts at two different rates, and the function has no way to reach a
    // configured rate even if somebody wanted it to.
    expect(mileageCostCents(100_000n, 7200n)).toBe(7200);
    expect(mileageCostCents(100_000n, 6800n)).toBe(6800);
  });
});

describe('how a trip reads back', () => {
  it('states the rate the row stored, not one it was handed', () => {
    const row = { distanceMilli: 42500n, ratePerKmTenThou: 6800n, subtotalCents: 2890 };
    expect(mileageSummary(row)).toBe('42.5 km at $0.6800/km = $28.90');
  });

  it('prints a rate at four decimals, never trimmed', () => {
    // $0.72 and $0.7150 must not look like the same stored value.
    expect(formatRatePerKm(7200n)).toBe('$0.7200');
    expect(formatRatePerKm(7150n)).toBe('$0.7150');
  });

  it('says so rather than inventing a figure when the row carries no rate', () => {
    expect(mileageSummary({ distanceMilli: null, ratePerKmTenThou: null, subtotalCents: 0 })).toBe('—');
  });
});

/* -------------------------------------------------------------------------
   Signs
   ------------------------------------------------------------------------- */

describe('subtotal and tax pointing in the same direction', () => {
  it('accepts a purchase and accepts a return', () => {
    expect(signMismatch(10_000, 1300)).toBeNull();
    expect(signMismatch(-10_000, -1300)).toBeNull();
  });

  it('accepts either half being zero', () => {
    expect(signMismatch(10_000, 0)).toBeNull();
    expect(signMismatch(0, 0)).toBeNull();
  });

  it('refuses a purchase with negative tax, and a return with positive tax', () => {
    expect(signMismatch(10_000, -1300)).not.toBeNull();
    expect(signMismatch(-10_000, 1300)).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------
   Tax lines
   ------------------------------------------------------------------------- */

const RATE_A = '11111111-1111-4111-8111-111111111111';
const RATE_B = '22222222-2222-4222-8222-222222222222';

describe('reading the tax boxes', () => {
  it('takes only the boxes somebody filled', () => {
    const { lines } = readTaxLines(
      { [`tax_${RATE_A}`]: '13.00', [`recoverable_${RATE_A}`]: 'on', [`tax_${RATE_B}`]: '' },
      [RATE_A, RATE_B],
    );
    expect(lines).toEqual([{ taxRateId: RATE_A, amountCents: 1300, isRecoverable: true }]);
  });

  it('reads an absent checkbox as unticked, which is how a browser posts one', () => {
    const { lines } = readTaxLines({ [`tax_${RATE_A}`]: '13.00' }, [RATE_A]);
    expect(lines[0]?.isRecoverable).toBe(false);
  });

  it('writes no row for a tax of zero', () => {
    // A zero row per configured rate would put noise in front of whoever
    // reconciles a return, and a receipt with no tax on it has no tax line.
    const { lines } = readTaxLines({ [`tax_${RATE_A}`]: '0.00' }, [RATE_A]);
    expect(lines).toEqual([]);
  });

  it('names the box it could not read rather than dropping it', () => {
    const { lines, malformed } = readTaxLines({ [`tax_${RATE_A}`]: 'thirteen' }, [RATE_A]);
    expect(lines).toEqual([]);
    expect(malformed).toEqual([RATE_A]);
  });

  it('ignores a box for a rate that was not rendered', () => {
    // The ids come from what the server rendered, so a hand-made POST cannot
    // name a fourth tax the form never offered.
    const { lines } = readTaxLines({ [`tax_${RATE_B}`]: '5.00' }, [RATE_A]);
    expect(lines).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   Bulk entry
   ------------------------------------------------------------------------- */

function batchRow(index: number, fields: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) out[`r${index}_${key}`] = value;
  return out;
}

describe('the bulk grid', () => {
  it('ignores a row nobody typed into', () => {
    // Eight rows are offered and three receipts are typed. The five left alone
    // are not five errors.
    const { rows, errors } = readBatchRows({});
    expect(rows).toEqual([]);
    expect(errors).toEqual([]);
  });

  const DEBIT = '44444444-4444-4444-8444-444444444444';

  it('reads a complete row', () => {
    const { rows, errors } = readBatchRows(
      batchRow(0, {
        date: '2026-08-14',
        desc: '  2x4   studs ',
        sub: '$1,234.50',
        tax: '160.49',
        pay: DEBIT,
        ref: 'A-9912',
      }),
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      index: 0,
      expenseDate: '2026-08-14',
      // Internal whitespace collapsed, the way a vendor name is.
      description: '2x4 studs',
      subtotalCents: 123450,
      taxCents: 16049,
      paymentMethodId: DEBIT,
      reference: 'A-9912',
      vendorId: null,
      costCodeId: null,
    });
  });

  it('refuses a row with an amount and no words beside it', () => {
    const { rows, errors } = readBatchRows(batchRow(2, { date: '2026-08-14', sub: '40.00' }));
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('r2_desc');
    // Named by row, so the person knows which of the eight to look at.
    expect(errors[0]?.label).toBe('Row 3');
  });

  it('refuses a row with words and no amount, which is a receipt somebody thinks they entered', () => {
    const { errors } = readBatchRows(batchRow(0, { date: '2026-08-14', desc: 'Dump run' }));
    expect(errors.map((error) => error.field)).toEqual(['r0_sub']);
  });

  it('refuses a date that does not exist', () => {
    const { errors } = readBatchRows(
      batchRow(0, { date: '2026-02-31', desc: 'Studs', sub: '10.00' }),
    );
    expect(errors.map((error) => error.field)).toEqual(['r0_date']);
  });

  it('refuses an id that is not one, so a hand-made POST cannot reach the column', () => {
    const { errors } = readBatchRows(
      batchRow(0, { date: '2026-08-14', desc: 'Studs', sub: '10.00', vendor: 'not-a-uuid' }),
    );
    expect(errors.map((error) => error.field)).toEqual(['r0_vendor']);
  });

  it('refuses a payment method that is not an id, the same way a vendor is', () => {
    // Payment methods live in a table now, not a fixed enum — this function
    // has no database to check the id against, so it can only shape it.
    const { errors } = readBatchRows(
      batchRow(0, { date: '2026-08-14', desc: 'Studs', sub: '10.00', pay: 'cash' }),
    );
    expect(errors.map((error) => error.field)).toEqual(['r0_pay']);
  });

  it('reads a credit row all the way through', () => {
    const { rows } = readBatchRows(
      batchRow(0, { date: '2026-08-14', desc: 'Returned two sheets', sub: '(45.00)', tax: '(5.85)' }),
    );
    expect(rows[0]).toMatchObject({ subtotalCents: -4500, taxCents: -585 });
  });

  it('reads every row the grid offers and stops there', () => {
    const values: Record<string, string> = {};
    for (let index = 0; index < BATCH_ROWS + 2; index += 1) {
      Object.assign(
        values,
        batchRow(index, { date: '2026-08-14', desc: `Row ${index}`, sub: '1.00' }),
      );
    }
    const { rows } = readBatchRows(values);
    expect(rows).toHaveLength(BATCH_ROWS);
  });
});

/* -------------------------------------------------------------------------
   The single form
   ------------------------------------------------------------------------- */

describe('the expense form', () => {
  const base = {
    projectId: '33333333-3333-4333-8333-333333333333',
    vendorId: '',
    costCodeId: '',
    expenseDate: '2026-08-14',
    description: 'Framing lumber',
    reference: '',
    subtotal: '1234.50',
    paymentMethodId: '',
    vendorTaxNumberCaptured: '',
    notes: '',
  };

  it('requires a job, because an expense with no job never reaches job costing', () => {
    expect(purchaseFields.safeParse({ ...base, projectId: '' }).success).toBe(false);
  });

  it('turns a blank optional id into null rather than an empty string', () => {
    const parsed = purchaseFields.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.vendorId).toBeNull();
    expect(parsed.data?.costCodeId).toBeNull();
    expect(parsed.data?.paymentMethodId).toBeNull();
  });

  it('reads an absent billable checkbox as off', () => {
    // A browser sends nothing for a box that is not ticked, and off is the
    // right default: a cost you have to remember to bill is a smaller problem
    // than an invoice that grew a line nobody decided on.
    expect(purchaseFields.safeParse(base).data?.isBillable).toBe(false);
  });

  it('keeps the tax number as typed rather than reaching for the vendor record', () => {
    // The claim is evidenced by what the receipt said on the day. Nothing in
    // this schema can see a vendor row, which is the point.
    const parsed = purchaseFields.safeParse({
      ...base,
      vendorTaxNumberCaptured: '  the number as printed  ',
    });
    expect(parsed.data?.vendorTaxNumberCaptured).toBe('the number as printed');
  });
});
