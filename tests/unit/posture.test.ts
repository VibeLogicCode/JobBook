import { describe, expect, it } from 'vitest';
import {
  ALL_FLAGS_ON,
  FLAG_KEYS,
  POSTURE_DEFAULTS,
  POSTURE_LABELS,
  POSTURES,
} from '@/lib/posture/types';
import { offersContract, offersService, postureOf, typeIsOffered } from '@/lib/posture/read';

/**
 * The posture vocabulary and the rules that follow from it.
 *
 * Pure, so it needs no database -- the same reason
 * `components/ui/destinations.ts` and `lib/quote/unpriced.ts` are pure. The
 * rules here are the ones a reader would otherwise have to infer from five
 * call sites.
 */
describe('the vocabulary', () => {
  it('offers exactly three, with Both first', () => {
    /**
     * `both` is today's behaviour, so it is the default AND the first option.
     * A picker whose default is not its first item is a picker people get
     * wrong.
     *
     * Three and not four: a middle tier was offered and declined, because a
     * $15,000 bathroom is contract work with no schedule template, which the
     * per-type flags already allow. A fourth posture would be a second way to
     * say what the flags say, and the two would disagree the day one changed.
     */
    expect(POSTURES).toEqual(['both', 'service', 'contract']);
  });

  it('names the work and never the trade', () => {
    // Naming the trade would make the product narrower than it is: an
    // electrician, a plumber and a home builder all have this same split
    // inside their own business.
    const words = Object.values(POSTURE_LABELS).join(' ');
    expect(words).not.toMatch(/builder|contractor|electric|plumb/i);
  });
});

describe('what a posture offers', () => {
  it('lets both do everything', () => {
    expect(offersService('both')).toBe(true);
    expect(offersContract('both')).toBe(true);
  });

  it('keeps service and contract to their own', () => {
    expect(offersService('service')).toBe(true);
    expect(offersContract('service')).toBe(false);
    expect(offersContract('contract')).toBe(true);
    expect(offersService('contract')).toBe(false);
  });

  it('resolves an absent company to both, which is failing OPEN', () => {
    /**
     * `readCompanies` swallows a database error to an empty list, so a blip
     * lands here as null and must produce the FULLER form.
     *
     * That is the safe direction and the reason this is asserted rather than
     * left to read off the `??`: posture is not a permission, it shortens
     * forms. An extra field is a nuisance; a holdback field missing from a
     * contract job is a wrong document.
     */
    expect(postureOf(null)).toBe('both');
  });
});

describe('which types a posture is offered', () => {
  it('shows a both-tagged type to everybody', () => {
    // How a pack ships `Panel upgrade`: one row, offered either way, rather
    // than one row per posture. Adding a posture must not multiply content.
    for (const posture of POSTURES) {
      expect(typeIsOffered('both', posture)).toBe(true);
    }
  });

  it('shows every type to a both company', () => {
    for (const tag of POSTURES) {
      expect(typeIsOffered(tag, 'both')).toBe(true);
    }
  });

  it('hides the other side from a single-posture company', () => {
    expect(typeIsOffered('contract', 'service')).toBe(false);
    expect(typeIsOffered('service', 'contract')).toBe(false);
  });
});

describe('what a new type is pre-set to', () => {
  it('gives a service company everything off', () => {
    // So a service-only business turns back on what it wants, rather than
    // hunting through five checkboxes to turn things off.
    for (const key of FLAG_KEYS) {
      expect(POSTURE_DEFAULTS.service[key]).toBe(false);
    }
  });

  it('gives contract and both everything on, identically', () => {
    /**
     * Not redundancy to collapse. They mean different things about which types
     * are OFFERED, and a contract-only company's new types should carry the
     * full paperwork exactly as a mixed company's do.
     */
    expect(POSTURE_DEFAULTS.contract).toEqual(ALL_FLAGS_ON);
    expect(POSTURE_DEFAULTS.both).toEqual(ALL_FLAGS_ON);
  });

  it('has a default for every posture and a value for every flag', () => {
    // The failure this catches is a flag added to the interface and forgotten
    // in one posture's table, which would read as `undefined` -- falsy, so a
    // NEW flag would silently arrive switched off.
    for (const posture of POSTURES) {
      for (const key of FLAG_KEYS) {
        expect(typeof POSTURE_DEFAULTS[posture][key]).toBe('boolean');
      }
    }
  });

  it('lists every key of the flag interface in FLAG_KEYS', () => {
    // `FLAG_KEYS` drives the two loops above and the settings form, so a flag
    // missing from it is a flag nothing checks.
    expect([...FLAG_KEYS].sort()).toEqual(Object.keys(ALL_FLAGS_ON).sort());
  });
});
