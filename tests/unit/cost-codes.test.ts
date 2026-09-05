import { describe, expect, it } from 'vitest';
import {
  CATEGORY_OPTIONS,
  costCodeFields,
  isCategory,
  isDuplicateCode,
  parentProblem,
  toColumns,
  type ParentRow,
} from '@/app/settings/cost-codes/schema';

/**
 * The cost code list's rules, tested where they live rather than through the
 * screen.
 *
 * Two of them are worth more than the rest. The code is normalised, because
 * the price-list importer matches a pasted column against it case-insensitively
 * while the unique index is case-sensitive -- so `dem` and `DEM` as two rows is
 * a list that imports differently depending on which one a supplier typed. And
 * the hierarchy is two levels, which is what makes a cycle impossible without
 * walking the tree.
 */

const FORM = {
  code: '02-40',
  name: 'Demolition',
  parentId: '',
  category: '',
  sortOrder: '',
};

function parse(overrides: Partial<typeof FORM> = {}) {
  return costCodeFields.safeParse({ ...FORM, ...overrides });
}

function issueFor(result: ReturnType<typeof parse>, field: string): string | undefined {
  if (result.success) return undefined;
  return result.error.issues.find((issue) => issue.path.join('.') === field)?.message;
}

describe('the code itself', () => {
  it('trims and upper-cases, so one code is one row', () => {
    const result = parse({ code: '  dem-01 ' });
    expect(result.success && result.data.code).toBe('DEM-01');
  });

  it('refuses a blank code', () => {
    expect(issueFor(parse({ code: '   ' }), 'code')).toBe('is required');
  });

  it.each([',', ';', '|', '\t'])(
    'refuses %j, which is a delimiter the price-list importer splits on',
    (character) => {
      expect(issueFor(parse({ code: `02${character}40` }), 'code')).toContain('may hold letters');
    },
  );

  it('accepts the separators a real numbering standard uses', () => {
    for (const code of ['01-00', '06.10.100', 'DIV 2', 'SUB_01', '09/60']) {
      expect(parse({ code }).success, code).toBe(true);
    }
  });

  it('refuses a code that opens with a separator', () => {
    // `-01` sorts oddly, reads as a negative number in a spreadsheet, and is
    // almost always a paste that lost its first character.
    expect(issueFor(parse({ code: '-01' }), 'code')).toContain('may hold letters');
  });

  it('refuses a code past the column width the rate list uses', () => {
    expect(issueFor(parse({ code: 'A'.repeat(61) }), 'code')).toBe(
      'must be 60 characters or fewer',
    );
  });
});

describe('the rest of the record', () => {
  it('reads a blank parent as a division rather than as an empty string', () => {
    const result = parse({ parentId: '' });
    expect(result.success && result.data.parentId).toBeNull();
  });

  it('refuses a parent that is not an identifier', () => {
    expect(issueFor(parse({ parentId: 'the demolition one' }), 'parentId')).toBe(
      'is not a cost code on the list',
    );
  });

  it('reads a blank category as uncategorised, and refuses one off the list', () => {
    expect(parse({ category: '' }).success && parse({ category: '' }).data?.category).toBeNull();
    expect(issueFor(parse({ category: 'Labor' }), 'category')).toBe(
      'is not one of the categories offered',
    );
  });

  it('offers every category it is willing to store', () => {
    for (const option of CATEGORY_OPTIONS) {
      expect(parse({ category: option.value }).success, option.value).toBe(true);
      expect(isCategory(option.value)).toBe(true);
    }
    expect(isCategory(null)).toBe(false);
    // Not an inherited property of the labels object, either.
    expect(isCategory('toString')).toBe(false);
  });

  it('reads a blank order as zero, not as null in a NOT NULL column', () => {
    const result = parse({ sortOrder: '' });
    expect(result.success && result.data.sortOrder).toBe(0);
  });

  it('maps form names to column names in one place', () => {
    const result = parse({ code: 'flr-01', name: 'Flooring', category: 'material', sortOrder: '7' });
    expect(result.success).toBe(true);
    expect(result.success ? toColumns(result.data) : null).toEqual({
      code: 'FLR-01',
      name: 'Flooring',
      parentId: null,
      category: 'material',
      sortOrder: 7,
    });
  });

  it('never produces an updatedAt, which a trigger maintains', () => {
    const result = parse();
    expect(result.success && Object.keys(toColumns(result.data))).not.toContain('updatedAt');
  });
});

describe('recognising a code that is already taken', () => {
  /** What the driver throws when the unique index refuses a row. */
  const raw = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
  });

  it('reads the driver error directly', () => {
    expect(isDuplicateCode(raw)).toBe(true);
  });

  it('reads it through the wrapper a transaction adds', () => {
    // This is the case that shipped broken and was caught in a browser: the
    // writes here run in a transaction, Drizzle wraps the failure, and the
    // screen printed the failed SQL and its bound parameters instead of "that
    // code is already taken".
    const wrapped = Object.assign(new Error('Failed query: insert into "cost_codes" …'), {
      cause: raw,
    });
    expect(isDuplicateCode(wrapped)).toBe(true);
    expect(isDuplicateCode({ cause: { cause: raw } })).toBe(true);
  });

  it('says no to anything else, including a chain that never ends', () => {
    expect(isDuplicateCode(new Error('connection terminated'))).toBe(false);
    expect(isDuplicateCode({ code: '23503' })).toBe(false);
    expect(isDuplicateCode(null)).toBe(false);
    expect(isDuplicateCode('23505')).toBe(false);

    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(isDuplicateCode(loop)).toBe(false);
  });
});

describe('the hierarchy', () => {
  const division: ParentRow = {
    id: '11111111-1111-4111-8111-111111111111',
    code: '02-00',
    parentId: null,
    recordStatus: 'active',
  };
  const section: ParentRow = {
    id: '22222222-2222-4222-8222-222222222222',
    code: '02-40',
    parentId: division.id,
    recordStatus: 'active',
  };

  it('allows a division to hold a section', () => {
    expect(
      parentProblem({ childId: section.id, childHasChildren: false, parent: division }),
    ).toBeNull();
  });

  it('allows the same while the code is still being created', () => {
    expect(parentProblem({ childId: null, childHasChildren: false, parent: division })).toBeNull();
  });

  it('refuses a parent that is not on the list', () => {
    expect(
      parentProblem({ childId: section.id, childHasChildren: false, parent: undefined }),
    ).toContain('is not on the list');
  });

  it('refuses a code filed under itself', () => {
    expect(
      parentProblem({ childId: division.id, childHasChildren: false, parent: division }),
    ).toBe('A cost code cannot sit under itself.');
  });

  it('refuses a third level, which is what makes a cycle unreachable', () => {
    // A parent must have no parent of its own, so no chain longer than two
    // exists to close. That is why nothing here walks the tree.
    expect(
      parentProblem({
        childId: '33333333-3333-4333-8333-333333333333',
        childHasChildren: false,
        parent: section,
      }),
    ).toContain('two levels');
  });

  it('refuses filing a division that already holds sections', () => {
    expect(
      parentProblem({
        childId: '33333333-3333-4333-8333-333333333333',
        childHasChildren: true,
        parent: division,
      }),
    ).toContain('already has sections filed under it');
  });

  it('refuses a voided parent, and says the code is still taken by it', () => {
    const problem = parentProblem({
      childId: section.id,
      childHasChildren: false,
      parent: { ...division, recordStatus: 'void' },
    });
    expect(problem).toContain('02-00 is void');
  });

  it('judges a parent on record_status alone, so retiring one is not a bar', () => {
    // ParentRow carries no `isActive` on purpose. Retiring is not voiding: a
    // division winding down is still a real place to file the section that
    // finishes the last job under it, and the picker on the screen offers it
    // marked rather than hiding it. Voiding is the only standing that refuses.
    const fields = Object.keys(division);
    expect(fields).not.toContain('isActive');
    expect(fields).toEqual(['id', 'code', 'parentId', 'recordStatus']);
  });
});
