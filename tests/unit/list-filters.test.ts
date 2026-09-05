import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { customers, projects } from '@/db/schema';
import { escapeLike, normalizeSearch, searchCondition } from '@/lib/list/search';
import { filterHref } from '@/components/ui/FilterBar';

/**
 * The list screens' search and filter, tested where it can be tested without a
 * database or a DOM: the text that goes into the pattern, and the statement
 * that comes out.
 *
 * The statement is read through the dialect rather than trusted, because the
 * property that matters is not what the SQL says -- it is that the person's
 * typing arrives as a bound parameter and never as SQL text.
 */

const dialect = new PgDialect();

function compile(condition: ReturnType<typeof searchCondition>) {
  if (condition === undefined) throw new Error('expected a condition');
  return dialect.sqlToQuery(condition);
}

describe('normalizeSearch', () => {
  it('drops the trailing space an owner types constantly', () => {
    expect(normalizeSearch('  kitchen  ')).toBe('kitchen');
  });

  it('collapses the run of spaces between two words', () => {
    expect(normalizeSearch('kitchen   refit')).toBe('kitchen refit');
  });

  it('treats absent and blank alike', () => {
    expect(normalizeSearch(undefined)).toBe('');
    expect(normalizeSearch(null)).toBe('');
    expect(normalizeSearch('   ')).toBe('');
  });
});

describe('escapeLike', () => {
  it('escapes the wildcard that would otherwise match everything', () => {
    // A search for a percentage is the one that gives the game away: unescaped,
    // `%50%%` matches every row in the table and the filter looks broken.
    expect(escapeLike('50%')).toBe('50\\%');
  });

  it('escapes the single-character wildcard too', () => {
    expect(escapeLike('P_0001')).toBe('P\\_0001');
  });

  it('escapes the backslash first, so it does not escape its own escape', () => {
    expect(escapeLike('a\\%')).toBe('a\\\\\\%');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLike('QT-2026-0004')).toBe('QT-2026-0004');
  });
});

describe('searchCondition', () => {
  it('says nothing when nothing was typed', () => {
    // `undefined` rather than a true condition: Drizzle drops it out of
    // `and(...)`, so no page writes its own `q ? cond : undefined`.
    expect(searchCondition('', [customers.name])).toBeUndefined();
    expect(searchCondition('kitchen', [])).toBeUndefined();
  });

  it('binds the pattern as a parameter rather than writing it into the SQL', () => {
    const { sql, params } = compile(searchCondition('kitchen', [customers.name]));
    expect(params).toEqual(['%kitchen%']);
    expect(sql).not.toContain('kitchen');
    expect(sql.toLowerCase()).toContain('ilike');
  });

  it('carries an injection attempt through as data, not as syntax', () => {
    // Split into words like any other search, and every word arrives bound.
    const { sql, params } = compile(searchCondition("'; drop table quotes; --", [customers.name]));
    expect(params).toEqual(["%';%", '%drop%', '%table%', '%quotes;%', '%--%']);
    expect(sql).not.toContain('drop');
    expect(sql).not.toContain('--');
  });

  it('escapes the wildcards on their way into the parameter', () => {
    const { params } = compile(searchCondition('50%', [customers.name]));
    expect(params).toEqual(['%50\\%%']);
  });

  it('asks every column about one word', () => {
    const { sql, params } = compile(
      searchCondition('halton', [customers.name, customers.companyName]),
    );
    expect(params).toEqual(['%halton%', '%halton%']);
    expect(sql.toLowerCase()).toContain(' or ');
  });

  it('narrows on a second word rather than looking for a longer literal', () => {
    // "kitchen smith" is a job and a customer. No single column holds both, so
    // one `%kitchen smith%` matches nothing -- which is the opposite of what a
    // person means by typing a second word.
    const { sql, params } = compile(
      searchCondition('kitchen smith', [projects.name, customers.name]),
    );
    expect(params).toEqual(['%kitchen%', '%kitchen%', '%smith%', '%smith%']);
    const lower = sql.toLowerCase();
    expect(lower).toContain(' and ');
    expect(lower).toContain(' or ');
  });
});

describe('filterHref', () => {
  it('drops the empty values, so a shared link carries only what is set', () => {
    expect(filterHref('/quotes', { q: 'halton', status: '', closed: '1' })).toBe(
      '/quotes?q=halton&closed=1',
    );
  });

  it('returns the bare path when nothing is set', () => {
    expect(filterHref('/quotes', { q: '', status: undefined })).toBe('/quotes');
  });

  it('encodes what a person typed', () => {
    expect(filterHref('/customers', { q: 'a&b c' })).toBe('/customers?q=a%26b+c');
  });
});
