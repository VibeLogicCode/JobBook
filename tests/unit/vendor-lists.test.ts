import { describe, expect, it } from 'vitest';
import {
  isDuplicateName,
  listOptionLabel,
  newVendorTypeFields,
  toTradeColumns,
  toVendorTypeColumns,
  tradeFields,
  vendorTypeFields,
} from '@/app/settings/vendor-lists';
import { DEFAULT_TRADES, DEFAULT_VENDOR_TYPES } from '@/db/seed/vendor-lists';

/**
 * The two maintainable lists behind the vendor form, tested where the rules
 * live rather than through the screens.
 *
 * One rule matters more than the rest, and it is a rule about what CANNOT be
 * done. `vendor_types.is_subcontractor` decides who receives a T5018 statement
 * of contract payments, whose WSIB clearance is checked before a cheque is
 * written, and who may be assigned to a scheduled task. Paying a sub whose
 * clearance has lapsed transfers liability for their premiums to the general
 * contractor, so this is a bill rather than a label.
 *
 * The list is therefore maintainable and the rule is not: the flag is chosen
 * once, when a type is created, and no edit path can express it. If that ever
 * stops being true, renaming a row would silently restate the tax and
 * insurance standing of every vendor filed under it, with nothing on any
 * vendor's record to say so.
 */

describe('the flag is set once and is never editable', () => {
  it('is offered when a type is added', () => {
    const result = newVendorTypeFields.safeParse({
      name: 'Equipment rental',
      sortOrder: '30',
      isSubcontractor: 'true',
    });
    expect(result.success && result.data.isSubcontractor).toBe(true);
  });

  it('is false when the box was not ticked, because a browser sends nothing', () => {
    // Absent is the off state, not an error: "this type does not perform work"
    // is a real answer and the commonest one.
    const result = newVendorTypeFields.safeParse({ name: 'Material supplier', sortOrder: '' });
    expect(result.success && result.data.isSubcontractor).toBe(false);
  });

  it('is not part of an edit at all', () => {
    expect(Object.keys(vendorTypeFields.shape)).not.toContain('isSubcontractor');
  });

  it('cannot get in through the edit path even from a hand-made POST', () => {
    // The column map is the door an update actually goes through, so it is the
    // one worth asserting on rather than the schema alone.
    const result = vendorTypeFields.safeParse({
      name: 'Material supplier',
      sortOrder: '10',
      isSubcontractor: 'true',
    });
    expect(result.success).toBe(true);
    expect(result.success && 'isSubcontractor' in result.data).toBe(false);
    expect(result.success && 'isSubcontractor' in toVendorTypeColumns(result.data)).toBe(false);
  });

  it('is not on a trade at all, which carries no rule of its own', () => {
    expect(Object.keys(tradeFields.shape)).not.toContain('isSubcontractor');
    const result = tradeFields.safeParse({ name: 'Framing', sortOrder: '40' });
    expect(result.success && toTradeColumns(result.data)).toEqual({
      name: 'Framing',
      sortOrder: 40,
    });
  });
});

describe('the name', () => {
  const issue = (value: string) => {
    const result = tradeFields.safeParse({ name: value, sortOrder: '' });
    return result.success
      ? undefined
      : result.error.issues.find((one) => one.path.join('.') === 'name')?.message;
  };

  it('trims, so one trade is one row', () => {
    const result = tradeFields.safeParse({ name: '  Framing  ', sortOrder: '' });
    expect(result.success && result.data.name).toBe('Framing');
  });

  it('collapses an inner double space, which the unique index cannot see', () => {
    // `lower(name)` catches case. It does not catch this, and two rows for one
    // trade splits the subs across both with nothing on screen to say so.
    const result = tradeFields.safeParse({ name: 'Windows  and doors', sortOrder: '' });
    expect(result.success && result.data.name).toBe('Windows and doors');
  });

  it('refuses a blank', () => {
    expect(issue('   ')).toBe('is required');
  });

  it('keeps case as typed, because a name is displayed', () => {
    const result = tradeFields.safeParse({ name: 'HVAC', sortOrder: '' });
    expect(result.success && result.data.name).toBe('HVAC');
  });

  it('refuses one longer than the column', () => {
    expect(issue('x'.repeat(121))).toBe('must be 120 characters or fewer');
  });
});

describe('the order', () => {
  it('reads a blank as nought rather than refusing', () => {
    const result = tradeFields.safeParse({ name: 'Framing', sortOrder: '' });
    expect(result.success && result.data.sortOrder).toBe(0);
  });

  it('refuses text and refuses a negative', () => {
    for (const value of ['first', '-5']) {
      const result = tradeFields.safeParse({ name: 'Framing', sortOrder: value });
      expect(result.success).toBe(false);
    }
  });
});

describe('what a picker calls a row', () => {
  const row = (over: Partial<{ isActive: boolean; recordStatus: string }> = {}) => ({
    name: 'Roofing',
    isActive: true,
    recordStatus: 'active',
    ...over,
  });

  it('says the plain name for a live row', () => {
    expect(listOptionLabel(row())).toBe('Roofing');
  });

  it('marks a retired row rather than hiding it', () => {
    // A vendor already carrying it has to keep it. A select whose defaultValue
    // matches no option silently shows the FIRST one instead, and the next
    // save would refile that vendor under whatever happened to sort first.
    expect(listOptionLabel(row({ isActive: false }))).toBe('Roofing (retired)');
  });

  it('marks a voided row, which is a different fact', () => {
    expect(listOptionLabel(row({ recordStatus: 'void' }))).toBe('Roofing (void)');
    // Void wins over active: a void row that was never retired is still void.
    expect(listOptionLabel(row({ recordStatus: 'void', isActive: true }))).toBe('Roofing (void)');
  });
});

describe('the duplicate-name predicate', () => {
  /**
   * The corrected version, and the reason it is corrected. Every write on
   * these screens that can conflict runs inside a transaction, and Drizzle
   * wraps a transaction failure in a `DrizzleQueryError` carrying the original
   * on `cause`. Reading only the top of that turns "that name is already
   * taken" into the failed SQL printed on the screen.
   */
  it('finds the SQLSTATE at the top', () => {
    expect(isDuplicateName({ code: '23505' })).toBe(true);
  });

  it('finds it under a wrapper, which is how it actually arrives', () => {
    const wrapped = Object.assign(new Error('Failed query: insert into "trades" ...'), {
      cause: { code: '23505' },
    });
    expect(isDuplicateName(wrapped)).toBe(true);
  });

  it('says no to a different failure, so a check violation is not mislabelled', () => {
    expect(isDuplicateName({ cause: { code: '23514' } })).toBe(false);
    expect(isDuplicateName(new Error('boom'))).toBe(false);
    expect(isDuplicateName(null)).toBe(false);
  });

  it('terminates on an error whose cause is itself', () => {
    const loop: { code?: string; cause?: unknown } = {};
    loop.cause = loop;
    expect(isDuplicateName(loop)).toBe(false);
  });
});

describe('the shipped lists', () => {
  it('names exactly one default type that performs work', () => {
    // Not a style rule. Every extra default with the flag set is a default
    // whose vendors are silently put on a T5018, and the safe error is leaving
    // somebody off -- which is noticed the same afternoon -- rather than
    // filing for a counterparty who was never owed it.
    const subcontractorTypes = DEFAULT_VENDOR_TYPES.filter((type) => type.isSubcontractor);
    expect(subcontractorTypes.map((type) => type.name)).toEqual(['Subcontractor']);
  });

  it('holds no two rows the unique index would collapse', () => {
    for (const list of [DEFAULT_VENDOR_TYPES, DEFAULT_TRADES]) {
      const names = list.map((row) => row.name.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('gives every row a fixed id, and no id twice', () => {
    // Fixed so that loading them again is a no-op, and so that a row the owner
    // has renamed, retired or voided is never restored to the shipped wording.
    const ids = [...DEFAULT_VENDOR_TYPES, ...DEFAULT_TRADES].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('ships generic categories rather than one tenant’s vocabulary', () => {
    // The white-label guard exempts src/db/seed, so nothing outside this file
    // is watching what goes in it. These are trades a general contractor hires
    // and kinds of counterparty any company pays; a name here that only one
    // deployment would recognise ships to every other one.
    expect(DEFAULT_TRADES.map((trade) => trade.name)).toEqual([
      'Excavation',
      'Concrete',
      'Masonry',
      'Framing',
      'Roofing',
      'Windows and doors',
      'Plumbing',
      'Electrical',
      'HVAC',
      'Insulation',
      'Drywall',
      'Painting',
    ]);
    expect(DEFAULT_VENDOR_TYPES.map((type) => type.name)).toEqual([
      'Material supplier',
      'Subcontractor',
      'Equipment rental',
      'Professional services',
    ]);
  });

  it('leaves gaps in the order, so an insertion needs no renumbering', () => {
    const orders = DEFAULT_TRADES.map((trade) => trade.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
    expect(Math.min(...orders.slice(1).map((n, i) => n - orders[i]!))).toBeGreaterThan(1);
  });
});
