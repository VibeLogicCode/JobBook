import { describe, expect, it } from 'vitest';
import { unpricedProblem } from '@/lib/quote/unpriced';

/**
 * A rate item with no sell price, added to a quote.
 *
 * Written because the trade starter packs (see
 * `2026-09-09-service-and-contract-work-design.md` §5.3) ship items with codes
 * and descriptions and NO prices, and `rate_items.sell_rate_ten_thou` is NOT
 * NULL — so an unpriced item is a zero-priced item.
 *
 * A zero on a quote is not a visible mistake. It contributes nothing to the
 * subtotal, `marginBasisPoints` returns 0 on zero revenue so the gauge reads
 * plausibly, and `pricingDisplay` defaults to `group_totals` under which the
 * line does not print at all. The customer receives a document silently
 * missing the price of real work.
 *
 * Which is worse than an empty rate book, for exactly the reason the design
 * gives against shipping invented prices: it looks like a price.
 */

describe('unpricedProblem', () => {
  it('refuses a quantity line priced at zero', () => {
    const problem = unpricedProblem({
      code: 'PLM-02',
      calcMode: 'qty',
      sellRateTenThou: 0n,
      isAllowance: false,
    });
    expect(problem).toMatch(/PLM-02/);
    // Must name where to fix it, or it reads as "this item is broken".
    expect(problem).toMatch(/rate/i);
  });

  it('refuses a flat line priced at zero', () => {
    expect(
      unpricedProblem({ code: 'X', calcMode: 'flat', sellRateTenThou: 0n, isAllowance: false }),
    ).not.toBeNull();
  });

  it('permits a priced line', () => {
    expect(
      unpricedProblem({ code: 'X', calcMode: 'qty', sellRateTenThou: 12500n, isAllowance: false }),
    ).toBeNull();
  });

  it('permits a negative price, which is how a discount is written', () => {
    // `rate_items` documents this: "May be negative: a discount line, or a
    // deductive change order." Refusing it would break a real feature.
    expect(
      unpricedProblem({ code: 'X', calcMode: 'qty', sellRateTenThou: -5000n, isAllowance: false }),
    ).toBeNull();
  });

  it('permits an allowance at zero', () => {
    // An allowance is a placeholder the customer spends against and is
    // reconciled later; nothing about it requires a figure at this moment.
    expect(
      unpricedProblem({ code: 'X', calcMode: 'qty', sellRateTenThou: 0n, isAllowance: true }),
    ).toBeNull();
  });

  it('permits a percent line at zero', () => {
    // For 'percent' the rate IS the percentage, so zero means "no uplift" --
    // a legitimate thing to state explicitly rather than a missing price.
    expect(
      unpricedProblem({ code: 'X', calcMode: 'percent', sellRateTenThou: 0n, isAllowance: false }),
    ).toBeNull();
  });
});
