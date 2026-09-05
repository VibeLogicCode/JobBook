import { describe, expect, it } from 'vitest';
import {
  costCodeProblem,
  isDuplicateName,
  paymentTermsLabel,
  toColumns,
  tradeProblem,
  tradeToWrite,
  vendorFields,
  vendorKindLabel,
  vendorTypeProblem,
  type CostCodeRef,
  type TradeRef,
  type VendorTypeRef,
} from '@/app/vendors/schema';

/**
 * The vendor directory's rules, tested where they live rather than through the
 * screen.
 *
 * Four of them are worth more than the rest. The name is normalised, because
 * the unique index is on `lower(name)` and a doubled space would otherwise
 * walk straight past it -- which is the "Dave, Dave M, Dave Masonry" failure
 * the table exists to prevent, wearing a disguise. The two tax numbers are
 * separate fields and stay separate. A blank optional field has to arrive as
 * NULL rather than as the empty string, because a column that holds `''` reads
 * as present to every future query that asks whether a business number was
 * collected.
 *
 * And the fourth is the one this file exists for now: the form cannot state
 * whether a vendor is a subcontractor. That answer decides who receives a
 * T5018 slip, whose WSIB clearance is checked before a cheque is written, and
 * who may be assigned to a scheduled task, so it is read from the chosen
 * vendor type and derived in the database. A schema that silently accepted
 * `isSubcontractor` from a form field would put all three back on something a
 * browser can edit, which is why it is asserted here rather than assumed.
 */

const A_TYPE = '11111111-1111-4111-8111-111111111111';
const A_TRADE = '22222222-2222-4222-8222-222222222222';

const FORM: Record<string, string> = {
  name: 'Sample Supply',
  legalName: '',
  contactName: '',
  email: '',
  phone: '',
  addressLine1: '',
  city: '',
  province: '',
  postalCode: '',
  businessNumber: '',
  taxRegistrationNumber: '',
  vendorTypeId: A_TYPE,
  tradeId: '',
  paymentTermsDays: '',
  defaultCostCodeId: '',
  notes: '',
};

function parse(overrides: Record<string, string> = {}) {
  return vendorFields.safeParse({ ...FORM, ...overrides });
}

function issueFor(result: ReturnType<typeof parse>, field: string): string | undefined {
  if (result.success) return undefined;
  return result.error.issues.find((issue) => issue.path.join('.') === field)?.message;
}

describe('the name', () => {
  it('trims, so one counterparty is one row', () => {
    const result = parse({ name: '  Sample Supply  ' });
    expect(result.success && result.data.name).toBe('Sample Supply');
  });

  it('collapses an inner double space, which the unique index cannot see', () => {
    // `lower(name)` catches case. It does not catch this, and two rows for one
    // yard splits a year of spend across both with nothing on screen to say so.
    const result = parse({ name: 'Sample  Supply' });
    expect(result.success && result.data.name).toBe('Sample Supply');
  });

  it('refuses a blank name', () => {
    expect(issueFor(parse({ name: '   ' }), 'name')).toBe('is required');
  });

  it('keeps case as typed, because a name is displayed and a code is not', () => {
    const result = parse({ name: 'McRae & Sons' });
    expect(result.success && result.data.name).toBe('McRae & Sons');
  });
});

describe('the two tax numbers', () => {
  it('keeps them apart', () => {
    // The whole point. A T5018 slip is identified by the business number; an
    // input tax credit over $30 is evidenced against the registration. One
    // column for both loses the ability to say which claim a row supports.
    const result = parse({
      businessNumber: '123456789',
      taxRegistrationNumber: '987654321RT0001',
    });
    expect(result.success && result.data.businessNumber).toBe('123456789');
    expect(result.success && result.data.taxRegistrationNumber).toBe('987654321RT0001');
    // And they survive the mapping to columns as two fields, which is the half
    // a schema change could quietly collapse.
    expect(result.success && toColumns(result.data)).toMatchObject({
      businessNumber: '123456789',
      taxRegistrationNumber: '987654321RT0001',
    });
  });

  it('leaves a blank one NULL rather than empty', () => {
    const result = parse({ businessNumber: '  ' });
    expect(result.success && result.data.businessNumber).toBeNull();
  });
});

describe('the subcontractor flag is not a form field', () => {
  it('is not in the form at all', () => {
    // It used to be a checkbox here. It is now derived in the database from
    // the chosen vendor type by the `derive_vendor_subcontractor` trigger,
    // because three things and nothing else turn on it -- a T5018 slip, a WSIB
    // clearance check, a place in the assignment picker -- and none of those
    // should rest on a control a browser can edit.
    expect('isSubcontractor' in FORM).toBe(false);
    expect(Object.keys(vendorFields.shape)).not.toContain('isSubcontractor');
  });

  it('is dropped rather than honoured when a hand-made POST sends one', () => {
    const result = parse({ isSubcontractor: 'true' });
    expect(result.success).toBe(true);
    expect(result.success && 'isSubcontractor' in result.data).toBe(false);
    // And it cannot get in through the column map either, which is the door
    // an insert actually goes through.
    expect(result.success && 'isSubcontractor' in toColumns(result.data)).toBe(false);
  });
});

describe('the vendor type', () => {
  it('is required, including on an edit', () => {
    // The vendors that predate the list carry none. The way that data gets
    // fixed is that the next person to save one has to answer, rather than the
    // product answering for him -- which would be the product guessing at a
    // tax filing.
    expect(issueFor(parse({ vendorTypeId: '' }), 'vendorTypeId')).toBe('is required');
  });

  it('refuses anything that is not a uuid, so a hand-made POST is not a 23503', () => {
    expect(issueFor(parse({ vendorTypeId: 'subcontractor' }), 'vendorTypeId')).toBe(
      'is required',
    );
  });

  const type = (over: Partial<VendorTypeRef> = {}): VendorTypeRef => ({
    id: A_TYPE,
    name: 'Subcontractor',
    isSubcontractor: true,
    isActive: true,
    recordStatus: 'active',
    ...over,
  });

  it('accepts a live type', () => {
    expect(vendorTypeProblem(type())).toBeNull();
  });

  it('accepts a RETIRED type, because retiring is about new vendors', () => {
    // Somebody already on a winding-down type has to be savable without being
    // moved, and moving them is exactly what would restate whether they are
    // owed a T5018.
    expect(vendorTypeProblem(type({ isActive: false }))).toBeNull();
  });

  it('refuses a VOID type, because a filing cannot rest on an admitted mistake', () => {
    expect(vendorTypeProblem(type({ recordStatus: 'void' }))).toContain('is void');
  });

  it('refuses one that is not there at all', () => {
    expect(vendorTypeProblem(undefined)).toContain('not on the list');
  });
});

describe('the trade, which is asked only of a subcontractor', () => {
  const trade = (over: Partial<TradeRef> = {}): TradeRef => ({
    id: A_TRADE,
    name: 'Framing',
    isActive: true,
    recordStatus: 'active',
    ...over,
  });

  it('is required when the type performs work', () => {
    // The owner's ask, in one assertion: a subcontractor is asked WHAT KIND of
    // subcontractor it is.
    expect(
      tradeProblem({ typeIsSubcontractor: true, chosen: null, submitted: false }),
    ).toContain('Which trade');
  });

  it('is not asked of a supplier, and a blank one is not an error', () => {
    expect(
      tradeProblem({ typeIsSubcontractor: false, chosen: null, submitted: false }),
    ).toBeNull();
  });

  it('is dropped rather than refused when a supplier submits one anyway', () => {
    // The field is hidden rather than removed, so a trade picked before the
    // type was changed still arrives. Refusing it would put a message about a
    // box that is not on the screen in front of somebody correcting an address.
    expect(
      tradeProblem({ typeIsSubcontractor: false, chosen: trade(), submitted: true }),
    ).toBeNull();
    expect(tradeToWrite(false, A_TRADE)).toBeNull();
    expect(tradeToWrite(true, A_TRADE)).toBe(A_TRADE);
  });

  it('accepts a RETIRED trade, so retiring one does not blank the sub who has it', () => {
    expect(
      tradeProblem({ typeIsSubcontractor: true, chosen: trade({ isActive: false }), submitted: true }),
    ).toBeNull();
  });

  it('refuses a VOID trade, because giving somebody new a mistake spreads it', () => {
    expect(
      tradeProblem({
        typeIsSubcontractor: true,
        chosen: trade({ recordStatus: 'void' }),
        submitted: true,
      }),
    ).toContain('is void');
  });

  it('refuses an id that names no row', () => {
    expect(
      tradeProblem({ typeIsSubcontractor: true, chosen: undefined, submitted: true }),
    ).toContain('not on the list');
  });

  it('refuses anything that is not a uuid, so a hand-made POST is not a 23503', () => {
    expect(issueFor(parse({ tradeId: 'framing' }), 'tradeId')).toBe(
      'is not a trade on the list',
    );
  });
});

describe('payment terms', () => {
  it('reads a blank as NULL — nothing agreed is not the same as cash', () => {
    const result = parse({ paymentTermsDays: '' });
    expect(result.success && result.data.paymentTermsDays).toBeNull();
  });

  it('keeps zero, which is cash on delivery', () => {
    const result = parse({ paymentTermsDays: '0' });
    expect(result.success && result.data.paymentTermsDays).toBe(0);
  });

  it('refuses text and refuses a negative, which the check constraint also refuses', () => {
    expect(issueFor(parse({ paymentTermsDays: 'net 30' }), 'paymentTermsDays')).toBe(
      'must be a whole number',
    );
    expect(issueFor(parse({ paymentTermsDays: '-5' }), 'paymentTermsDays')).toBe(
      'must be a whole number',
    );
  });

  it('says the three cases in words, because a bare number gets two of them wrong', () => {
    expect(paymentTermsLabel(null)).toBe('Not agreed');
    expect(paymentTermsLabel(0)).toBe('On delivery');
    expect(paymentTermsLabel(30)).toBe('Net 30 days');
  });
});

describe('the default cost code', () => {
  it('refuses anything that is not a uuid, so a hand-made POST is not a 23503', () => {
    expect(issueFor(parse({ defaultCostCodeId: 'not-a-code' }), 'defaultCostCodeId')).toBe(
      'is not a cost code on the list',
    );
  });

  it('reads a blank as NULL', () => {
    const result = parse({ defaultCostCodeId: '' });
    expect(result.success && result.data.defaultCostCodeId).toBeNull();
  });

  const code = (over: Partial<CostCodeRef> = {}): CostCodeRef => ({
    id: '00000000-0000-4000-8000-000000000000',
    code: '06-10',
    name: 'Framing',
    isActive: true,
    recordStatus: 'active',
    ...over,
  });

  it('accepts a live code', () => {
    expect(costCodeProblem(code())).toBeNull();
  });

  it('accepts a RETIRED code, because retiring is about new work', () => {
    // A vendor whose spend has always landed on a winding-down division should
    // go on proposing it. Blanking it here would silently recode their next
    // receipt, which is the opposite of what retiring says.
    expect(costCodeProblem(code({ isActive: false }))).toBeNull();
  });

  it('refuses a VOID code, because proposing a mistake spreads it', () => {
    expect(costCodeProblem(code({ recordStatus: 'void' }))).toContain('is void');
  });

  it('refuses one that is not there at all', () => {
    expect(costCodeProblem(undefined)).toContain('not on the list');
  });
});

describe('what the screen calls a row', () => {
  it("prefers the tenant's own word for the kind of counterparty", () => {
    expect(
      vendorKindLabel({ typeName: 'Equipment rental', isSubcontractor: false, trade: null }),
    ).toBe('Equipment rental');
  });

  it('falls back to the derived flag for a vendor that predates the type list', () => {
    // The flag and not the name decides which fallback is used: a type can be
    // called anything, and reading the word would be reading a tax question
    // out of a string somebody typed.
    expect(vendorKindLabel({ isSubcontractor: false, trade: 'Framing' })).toBe('Supplier');
    expect(vendorKindLabel({ typeName: null, isSubcontractor: true, trade: null })).toBe(
      'Subcontractor',
    );
  });

  it('carries the trade for a subcontractor when there is one', () => {
    expect(
      vendorKindLabel({ typeName: 'Subcontractor', isSubcontractor: true, trade: 'Framing' }),
    ).toBe('Subcontractor · Framing');
    expect(vendorKindLabel({ isSubcontractor: true, trade: 'Framing' })).toBe(
      'Subcontractor · Framing',
    );
  });

  it('never prints a trade beside a vendor who is not a subcontractor', () => {
    // A leftover trade on a supplier is not a fact about them, and printing it
    // would read as one.
    expect(
      vendorKindLabel({ typeName: 'Material supplier', isSubcontractor: false, trade: 'Framing' }),
    ).toBe('Material supplier');
  });
});

describe('the duplicate-name predicate', () => {
  /**
   * The corrected version, and the reason it is corrected.
   *
   * `rates/actions.ts` reads `.code` off the error directly and is right to:
   * its insert is a bare statement, so the driver's error arrives intact. Every
   * write in `vendors/actions.ts` runs inside a transaction, and Drizzle wraps
   * a transaction failure in a `DrizzleQueryError` carrying the original on
   * `cause`. Reading only the top of that turns "that name is already taken"
   * into the failed SQL printed on the screen.
   */
  it('finds the SQLSTATE at the top', () => {
    expect(isDuplicateName({ code: '23505' })).toBe(true);
  });

  it('finds it under a wrapper, which is how it actually arrives', () => {
    const wrapped = Object.assign(new Error('Failed query: insert into "vendors" ...'), {
      cause: { code: '23505' },
    });
    expect(isDuplicateName(wrapped)).toBe(true);
  });

  it('finds it two wrappers down', () => {
    expect(isDuplicateName({ cause: { cause: { code: '23505' } } })).toBe(true);
  });

  it('says no to a different failure, so a check violation is not mislabelled', () => {
    expect(isDuplicateName({ cause: { code: '23514' } })).toBe(false);
    expect(isDuplicateName(new Error('boom'))).toBe(false);
    expect(isDuplicateName(null)).toBe(false);
    expect(isDuplicateName(undefined)).toBe(false);
  });

  it('terminates on an error whose cause is itself', () => {
    const loop: { code?: string; cause?: unknown } = {};
    loop.cause = loop;
    expect(isDuplicateName(loop)).toBe(false);
  });
});
