import { describe, expect, it } from 'vitest';
import { normalizePrefix, prefixProblem } from '@/lib/company/prefix';

/**
 * The company code that goes on every document.
 *
 * Pure, so it is assertable in a `node` environment -- the same reason
 * `components/ui/destinations.ts` and `lib/quote/unpriced.ts` are pure. The
 * rule is what matters here, not the form that collects it.
 */
describe('prefixProblem', () => {
  const taken = [{ displayName: 'Maple Contracting', prefix: 'MAP' }];

  it('allows a plain code', () => {
    expect(prefixProblem('RENO', taken)).toBeNull();
    expect(prefixProblem('SVC2', taken)).toBeNull();
  });

  it('allows nothing at all, which means no code', () => {
    // One company has nothing to distinguish itself from, and QT-2026-0001 is
    // shorter and says as much. Every existing installation is this case.
    expect(prefixProblem('', taken)).toBeNull();
    expect(prefixProblem('   ', taken)).toBeNull();
  });

  it('refuses the separators the format already owns', () => {
    // `RENO_` would compose to RENO__QT, and a dash would put a third one in a
    // string a person parses by counting dashes.
    expect(prefixProblem('RENO_', taken)).toContain('already');
    expect(prefixProblem('RE-NO', taken)).toContain('already');
  });

  it('refuses anything that would reach a filename or a URL', () => {
    // The PDF is served as `quote-${number}-v${version}.pdf`.
    expect(prefixProblem('RE NO', taken)).not.toBeNull();
    expect(prefixProblem('RE/NO', taken)).not.toBeNull();
  });

  it('refuses a code too long to read down the phone', () => {
    const problem = prefixProblem('RENOVATIONS', taken);
    // Names the length and the fix, because "too long" leaves the person
    // guessing how much to cut.
    expect(problem).toContain('11 characters');
    expect(problem).toContain('RENO');
  });

  it('refuses a code another company already issues, and names it', () => {
    const problem = prefixProblem('MAP', taken);
    // "That code is taken" sends somebody looking through a list. Naming the
    // company means they already know which one to ask about.
    expect(problem).toContain('Maple Contracting');
    expect(problem).toContain('MAP');
  });

  it('treats case as noise, in both directions', () => {
    // Codes are stored upper-cased, so `map` and `MAP` are one code to a
    // reader and must be one code to this guard -- otherwise the duplicate
    // gets in through the door the guard is on.
    expect(prefixProblem('map', taken)).not.toBeNull();
    expect(prefixProblem('Reno', taken)).toBeNull();
    expect(prefixProblem('RENO', [{ displayName: 'Other', prefix: 'reno' }])).not.toBeNull();
  });

  it('normalises to the stored form', () => {
    expect(normalizePrefix('  reno  ')).toBe('RENO');
  });
});
