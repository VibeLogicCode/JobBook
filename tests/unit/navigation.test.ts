import { describe, expect, it } from 'vitest';
import {
  BOTTOM_BAR,
  BOTTOM_BAR_SEATS,
  DESTINATIONS,
  OVERFLOW,
} from '@/components/ui/destinations';

/**
 * The bottom bar used to be `DESTINATIONS.slice(0, 5)` with nothing carrying
 * the rest, and the rail that "carries all of them" is `hidden` below `sm`.
 * Six screens -- People, Rates, Vendors, Expenses, Templates and Settings --
 * therefore had no entry point at all on a phone. Not clipped: absent. The
 * owner found it by trying to reach setup from one.
 *
 * These tests are about REACHABILITY rather than markup, which is why they can
 * live in a node environment with no DOM. The bar and the overflow are derived
 * from one list by construction, and the assertions below are what stop a
 * seventh destination from being appended and silently landing nowhere.
 */
describe('mobile navigation reachability', () => {
  it('reaches every destination through either the bar or the overflow', () => {
    const reachable = [...BOTTOM_BAR, ...OVERFLOW].map((entry) => entry.href);
    expect([...reachable].sort()).toEqual(DESTINATIONS.map((entry) => entry.href).sort());
  });

  it('puts no destination in both places', () => {
    const bar = new Set(BOTTOM_BAR.map((entry) => entry.href));
    for (const entry of OVERFLOW) {
      expect(bar.has(entry.href)).toBe(false);
    }
  });

  it('leaves a seat for the overflow button when there is an overflow', () => {
    // The bar renders BOTTOM_BAR plus a "More" control, so it may hold at most
    // one fewer than the seats available. Asserted rather than assumed: the
    // failure it prevents is a bar of six tabs plus More on a 375px screen.
    if (OVERFLOW.length > 0) {
      expect(BOTTOM_BAR.length).toBe(BOTTOM_BAR_SEATS - 1);
    } else {
      expect(BOTTOM_BAR.length).toBeLessThanOrEqual(BOTTOM_BAR_SEATS);
    }
  });

  it('keeps setup reachable from a phone', () => {
    // The specific failure the owner hit. Named on its own so the reason
    // survives a future reshuffle of the list.
    const reachable = [...BOTTOM_BAR, ...OVERFLOW].map((entry) => entry.href);
    expect(reachable).toContain('/settings');
  });

  it('does not label a destination "Setup", which is a different screen', () => {
    // `/settings` was labelled "Setup", so the one control that looked like a
    // way into the first-run wizard led somewhere else entirely -- and that
    // screen then said "run first-run setup" without saying where.
    for (const entry of DESTINATIONS) {
      expect(entry.label).not.toBe('Setup');
    }
  });
});
