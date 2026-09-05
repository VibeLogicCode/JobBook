import { describe, expect, it } from 'vitest';
import {
  costCodeProblem,
  isDuplicateName,
  paymentTermsLabel,
  toColumns,
  vendorFields,
  vendorKindLabel,
  type CostCodeRef,
} from '@/app/vendors/schema';

/**
 * The vendor directory's rules, tested where they live rather than through the
 * screen.
 *
 * Three of them are worth more than the rest. The name is normalised, because
 * the unique index is on `lower(name)` and a doubled space would otherwise
 * walk straight past it -- which is the "Dave, Dave M, Dave Masonry" failure
 * the table exists to prevent, wearing a disguise. The two tax numbers are
 * separate fields and stay separate. And a blank optional field has to arrive
 * as NULL rather than as the empty string, because a column that holds `''`
 * reads as present to every future query that asks whether a business number
 * was collected.
 */

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
  trade: '',
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

describe('the subcontractor flag', () => {
  it('is false when the box was not ticked, because a browser sends nothing', () => {
    // Absent is the off state, not an error: "this is a supplier" has to be
    // submittable, and it is submitted by the field simply not arriving. FORM
    // carries no `isSubcontractor` key for exactly that reason.
    expect('isSubcontractor' in FORM).toBe(false);
    const result = vendorFields.safeParse(FORM);
    expect(result.success && result.data.isSubcontractor).toBe(false);
  });

  it('is true when it was', () => {
    const result = parse({ isSubcontractor: 'true' });
    expect(result.success && result.data.isSubcontractor).toBe(true);
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
  it('names a supplier as one, so nobody reads it as a sub', () => {
    expect(vendorKindLabel({ isSubcontractor: false, trade: 'Framing' })).toBe('Supplier');
  });

  it('carries the trade for a subcontractor when there is one', () => {
    expect(vendorKindLabel({ isSubcontractor: true, trade: 'Framing' })).toBe(
      'Subcontractor · Framing',
    );
    expect(vendorKindLabel({ isSubcontractor: true, trade: null })).toBe('Subcontractor');
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
