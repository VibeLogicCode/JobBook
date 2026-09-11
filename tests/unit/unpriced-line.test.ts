import { describe, expect, it } from 'vitest';
import { unpricedLineCodes, unpricedProblem, unsendableProblem } from '@/lib/quote/unpriced';

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

/**
 * The same rule, applied to a quote that already exists.
 *
 * This is the half that makes shipping an unpriced starter rate book safe. A
 * pack's scope template expands through `createQuoteFromTemplate`, which does
 * NOT consult `unpricedProblem` -- so the draft is full of zero-priced lines
 * by design, and the thing that must not happen is that draft being sent.
 */
describe('a quote that cannot be sent yet', () => {
  const line = (code: string, unitPriceTenThou: bigint, over = {}) => ({
    code, calcMode: 'qty' as const, unitPriceTenThou, isAllowance: false, ...over,
  });

  it('is silent when every line carries a price', () => {
    expect(unsendableProblem([line('LAB-EL', 950000n), line('DEV-REC', 45000n)])).toBeNull();
  });

  it('names the codes rather than counting them', () => {
    // "3 lines need a price" cannot be acted on without going hunting.
    const problem = unsendableProblem([line('LAB-EL', 0n), line('DEV-REC', 45000n), line('PANEL', 0n)]);
    expect(problem).toContain('LAB-EL');
    expect(problem).toContain('PANEL');
    expect(problem).not.toContain('DEV-REC');
    expect(problem).toContain('2 lines have');
  });

  it('says it in the singular for one line', () => {
    expect(unsendableProblem([line('LAB-EL', 0n)])).toContain('One line has');
  });

  it('stops naming them after six', () => {
    const many = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((code) => line(code, 0n));
    const problem = unsendableProblem(many)!;
    expect(problem).toContain('and 2 more');
    expect(problem).not.toContain('H,');
  });

  it('exempts a percentage line and an allowance, like the line editor does', () => {
    /**
     * One rule, read from two places -- the worksheet's warning and the send
     * refusal both call this -- so they cannot come to disagree about what a
     * legitimate zero is. An overhead percentage at zero states "no uplift";
     * an allowance is a placeholder with no figure yet by definition.
     */
    const rows = [
      line('OH-SUB', 0n, { calcMode: 'percent' as const }),
      line('ALLOW-FIN', 0n, { isAllowance: true }),
    ];
    expect(unpricedLineCodes(rows)).toEqual([]);
    expect(unsendableProblem(rows)).toBeNull();
  });

  it('tells the owner what to do instead of stating a rule', () => {
    // The reader has no IT support and no reason to know that a zero in a rate
    // column means "not done yet". The sentence has to say both what is wrong
    // and what to do -- price it, or call it an allowance.
    const problem = unsendableProblem([line('LAB-EL', 0n)])!;
    expect(problem).toMatch(/does not print/i);
    expect(problem).toMatch(/allowance/i);
  });
});
