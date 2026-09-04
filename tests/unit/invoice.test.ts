import { describe, expect, it } from 'vitest';
import { computeInvoice } from '@/lib/invoice/compute';
import { earnedToDateCents, progressAmountCents } from '@/lib/invoice/progress';
import type { InvoiceContext, InvoiceRequest, JobBillingState } from '@/lib/invoice/types';
import { applyPercentCents } from '@/lib/money/scale';
import type { TaxRateInput } from '@/lib/quote/tax';

const HST: TaxRateInput = {
  label: 'HST',
  registrationNumber: '123456789RT0001',
  rateTenThou: 1300n,
  effectiveFrom: '2000-01-01',
  effectiveTo: null,
  isCompound: false,
  sortOrder: 1,
};

/** Ontario as configured: the s.168(7) deferral applies. */
const DEFERRED: InvoiceContext = { taxDeferredOnHoldback: true, customerExempt: false };

/** 10%, the Construction Act figure -- passed in, never assumed by the engine. */
const HOLDBACK_10 = 1000n;
const FULL = 10000n;

/** $100,000.00. */
const CONTRACT = 10_000_000;

function state(over: Partial<JobBillingState> = {}): JobBillingState {
  return {
    contractValueCents: CONTRACT,
    previouslyBilledCents: 0,
    holdbackAccruedCents: 0,
    holdbackReleasedCents: 0,
    depositHeldCents: 0,
    ...over,
  };
}

function request(over: Partial<InvoiceRequest> = {}): InvoiceRequest {
  return {
    kind: 'progress',
    issueDate: '2026-06-01',
    holdbackPctTenThou: HOLDBACK_10,
    ...over,
  };
}

/** A schedule of evenly spaced draws whose last one lands on exactly 100%. */
function percentsFor(draws: number): bigint[] {
  return Array.from({ length: draws }, (_, index) =>
    index === draws - 1 ? FULL : BigInt(Math.round(((index + 1) * 10000) / draws)),
  );
}

function runSchedule(args: {
  contractValueCents: number;
  percents: bigint[];
  holdbackPctTenThou?: bigint;
  context?: InvoiceContext;
}) {
  let current = state({ contractValueCents: args.contractValueCents });
  const invoices = args.percents.map((percentCompleteTenThou, index) => {
    const invoice = computeInvoice(
      current,
      request({
        kind: index === args.percents.length - 1 ? 'final' : 'progress',
        percentCompleteTenThou,
        holdbackPctTenThou: args.holdbackPctTenThou ?? HOLDBACK_10,
      }),
      [HST],
      args.context ?? DEFERRED,
    );
    current = invoice.nextState;
    return invoice;
  });
  return { invoices, finalState: current };
}

/**
 * The rejected implementation, kept as a test fixture: each draw's own share of
 * the contract, rounded on its own. Every drift assertion below is written
 * against this, so a future "simplification" back to it fails loudly instead of
 * shorting the job by a cent.
 */
function drawsRoundedIndependently(contractValueCents: number, percents: bigint[]): number[] {
  return percents.map((percent, index) => {
    const shareTenThou = percent - (percents[index - 1] ?? 0n);
    return Number(applyPercentCents(BigInt(contractValueCents), shareTenThou));
  });
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe('progressAmountCents', () => {
  it('bills contract times percent, less what was billed before', () => {
    expect(progressAmountCents({
      contractValueCents: CONTRACT,
      percentCompleteTenThou: 5000n,
      previouslyBilledCents: 0,
    })).toBe(5_000_000);

    expect(progressAmountCents({
      contractValueCents: CONTRACT,
      percentCompleteTenThou: 5000n,
      previouslyBilledCents: 2_000_000,
    })).toBe(3_000_000);
  });

  it('bills the whole contract at 100% with no prior draws', () => {
    expect(progressAmountCents({
      contractValueCents: CONTRACT,
      percentCompleteTenThou: FULL,
      previouslyBilledCents: 0,
    })).toBe(CONTRACT);
  });

  it('returns a negative amount when the percent goes backwards', () => {
    // The owner billed 60% and then found the work was 45% done. The engine
    // returns the correction rather than refusing it; see progress.ts for why.
    expect(progressAmountCents({
      contractValueCents: CONTRACT,
      percentCompleteTenThou: 4500n,
      previouslyBilledCents: 6_000_000,
    })).toBe(-1_500_000);
  });

  it('refuses a percent above 100', () => {
    expect(() => progressAmountCents({
      contractValueCents: CONTRACT,
      percentCompleteTenThou: 11000n,
      previouslyBilledCents: 0,
    })).toThrow(/between 0% and 100%/);
  });

  it('refuses a negative percent', () => {
    expect(() => progressAmountCents({
      contractValueCents: CONTRACT,
      percentCompleteTenThou: -1n,
      previouslyBilledCents: 0,
    })).toThrow(/between 0% and 100%/);
  });

  it('rounds the cumulative figure, not the increment', () => {
    // $10,000.01 at one third: the earned-to-date figure is what gets rounded.
    expect(earnedToDateCents(1_000_001, 3333n)).toBe(333_300);
    expect(earnedToDateCents(1_000_001, 6667n)).toBe(666_701);
    expect(earnedToDateCents(1_000_001, FULL)).toBe(1_000_001);
  });
});

describe('a draw schedule sums to the contract exactly', () => {
  // Contracts chosen so that none of them divides evenly across 3, 7 or 13.
  const AWKWARD = [1_000_001, 999_997, 3_333_333, 10_000_007, 12_345_679];

  for (const contractValueCents of AWKWARD) {
    for (const draws of [3, 7, 13]) {
      it(`${draws} draws on ${contractValueCents} cents`, () => {
        const { invoices, finalState } = runSchedule({
          contractValueCents,
          percents: percentsFor(draws),
        });

        expect(sum(invoices.map((invoice) => invoice.subtotalCents))).toBe(contractValueCents);
        expect(finalState.previouslyBilledCents).toBe(contractValueCents);
        // No draw is negative on a schedule that only moves forward, so the
        // exact sum is not being reached by one draw cancelling another.
        expect(invoices.every((invoice) => invoice.subtotalCents > 0)).toBe(true);
        // The holdback balance at completion is exactly 10% of the contract,
        // which is what the Construction Act withholding has to be.
        expect(finalState.holdbackAccruedCents).toBe(
          Number(applyPercentCents(BigInt(contractValueCents), HOLDBACK_10)),
        );
      });
    }
  }

  it('drifts a cent if the draws are rounded independently', () => {
    const percents = percentsFor(3);
    const { invoices } = runSchedule({ contractValueCents: 1_000_001, percents });

    expect(invoices.map((invoice) => invoice.subtotalCents)).toEqual([333_300, 333_401, 333_300]);

    // The same schedule with each share rounded on its own leaves the job a
    // cent short of its own contract, and the customer's arithmetic disagrees
    // with the last invoice.
    const naive = drawsRoundedIndependently(1_000_001, percents);
    expect(naive).toEqual([333_300, 333_400, 333_300]);
    expect(sum(naive)).toBe(1_000_000);
    expect(sum(naive)).not.toBe(1_000_001);
  });

  it('lands on the contract even when a mid-schedule draw is a correction', () => {
    // 60%, corrected back to 45%, then finished. The cumulative form makes the
    // correction fall out of the same arithmetic as a forward draw.
    const { invoices, finalState } = runSchedule({
      contractValueCents: 1_000_001,
      percents: [6000n, 4500n, FULL],
    });

    expect(invoices.map((invoice) => invoice.subtotalCents)).toEqual([600_001, -150_001, 550_001]);
    expect(sum(invoices.map((invoice) => invoice.subtotalCents))).toBe(1_000_001);
    expect(finalState.previouslyBilledCents).toBe(1_000_001);
  });
});

describe('a progress invoice', () => {
  it('withholds holdback and taxes what is left', () => {
    const invoice = computeInvoice(
      state(),
      request({ percentCompleteTenThou: 5000n }),
      [HST],
      DEFERRED,
    );

    expect(invoice.subtotalCents).toBe(5_000_000);
    expect(invoice.holdbackCents).toBe(500_000);
    expect(invoice.taxableBaseCents).toBe(4_500_000);
    expect(invoice.taxTotalCents).toBe(585_000);
    expect(invoice.totalCents).toBe(5_085_000);
    expect(invoice.amountDueCents).toBe(5_085_000);
  });

  it('snapshots what it was computed from', () => {
    const invoice = computeInvoice(
      state({ previouslyBilledCents: 2_000_000 }),
      request({ percentCompleteTenThou: 5000n }),
      [HST],
      DEFERRED,
    );

    // Spec 4.5: without these the invoice cannot be reproduced once a later
    // change order moves the contract value.
    expect(invoice.contractValueAtInvoiceCents).toBe(CONTRACT);
    expect(invoice.percentCompleteTenThou).toBe(5000n);
    expect(invoice.previouslyBilledCents).toBe(2_000_000);
  });

  it('bills the whole contract at 100% with no prior draws', () => {
    const invoice = computeInvoice(
      state(),
      request({ percentCompleteTenThou: FULL }),
      [HST],
      DEFERRED,
    );

    expect(invoice.subtotalCents).toBe(CONTRACT);
    expect(invoice.holdbackCents).toBe(1_000_000);
    expect(invoice.nextState.previouslyBilledCents).toBe(CONTRACT);
  });
});

describe('invoice kinds', () => {
  it('computes a final invoice identically to progress at 100%', () => {
    // A full invoice is the degenerate progress case, so the two must agree
    // figure for figure; a second code path for "bill everything" is exactly
    // what this asserts does not exist.
    const base = state({ previouslyBilledCents: 4_000_000, holdbackAccruedCents: 400_000 });
    const progress = computeInvoice(base, request({ kind: 'progress', percentCompleteTenThou: FULL }), [HST], DEFERRED);
    const final = computeInvoice(base, request({ kind: 'final', percentCompleteTenThou: FULL }), [HST], DEFERRED);

    expect({ ...final, kind: 'progress' }).toEqual(progress);
  });

  it('refuses a final invoice below 100%', () => {
    expect(() => computeInvoice(
      state(),
      request({ kind: 'final', percentCompleteTenThou: 9000n }),
      [HST],
      DEFERRED,
    )).toThrow(/bills the contract to 100%/);
  });

  it('needs a percent complete on a progress invoice', () => {
    expect(() => computeInvoice(state(), request(), [HST], DEFERRED))
      .toThrow(/needs a percent complete/);
  });

  it('refuses a percent complete on a deposit', () => {
    expect(() => computeInvoice(
      state(),
      request({ kind: 'deposit', amountCents: 100_000, percentCompleteTenThou: 5000n }),
      [HST],
      DEFERRED,
    )).toThrow(/does not bill by percent complete/);
  });

  it('refuses an amount on a progress invoice', () => {
    expect(() => computeInvoice(
      state(),
      request({ percentCompleteTenThou: 5000n, amountCents: 100_000 }),
      [HST],
      DEFERRED,
    )).toThrow(/does not take an amount/);
  });

  it('refuses a release figure on anything but a release', () => {
    expect(() => computeInvoice(
      state(),
      request({ percentCompleteTenThou: 5000n, releaseHoldbackCents: 100 }),
      [HST],
      DEFERRED,
    )).toThrow(/does not release holdback/);
  });

  it('refuses a negative deposit', () => {
    expect(() => computeInvoice(
      state(),
      request({ kind: 'deposit', amountCents: -100_000 }),
      [HST],
      DEFERRED,
    )).toThrow(/refund the deposit as a payment/);
  });

  it('refuses a malformed issue date rather than billing no tax', () => {
    // selectRatesInForce compares ISO strings, so '01/06/2026' would match no
    // rate at all and produce a zero-tax invoice that looks deliberate.
    expect(() => computeInvoice(
      state(),
      request({ percentCompleteTenThou: 5000n, issueDate: '01/06/2026' }),
      [HST],
      DEFERRED,
    )).toThrow(/expected an ISO date/);
  });
});

describe('a percentage outside 0-100 is refused on the path callers use', () => {
  /**
   * A regression, and a nasty one: `progressAmountCents` asserted the range,
   * but `computeInvoice` reaches `earnedToDateCents` through `billedFigures`
   * and never went near that assertion. So the only bounded path was the one
   * the tests called and not the one the application called.
   *
   * At 150% on a $100,000 contract it returned a $150,000 draw and a state
   * billed to $150,000, with no error anywhere -- an invoice for work that was
   * never agreed, internally consistent enough that nothing would look wrong.
   */
  it('refuses a progress invoice above 100%', () => {
    expect(() =>
      computeInvoice(state(), request({ percentCompleteTenThou: 15000n }), [HST], DEFERRED),
    ).toThrow(/percent complete/i);
  });

  it('refuses a negative percentage', () => {
    expect(() =>
      computeInvoice(state(), request({ percentCompleteTenThou: -1n }), [HST], DEFERRED),
    ).toThrow(/percent complete/i);
  });

  it('still allows exactly 100%', () => {
    const invoice = computeInvoice(state(), request({ percentCompleteTenThou: FULL }), [HST], DEFERRED);
    expect(invoice.subtotalCents).toBe(CONTRACT);
  });

  it('still allows exactly 0%, which bills nothing', () => {
    const invoice = computeInvoice(state(), request({ percentCompleteTenThou: 0n }), [HST], DEFERRED);
    expect(invoice.subtotalCents).toBe(0);
  });
});

describe('a deposit', () => {
  it('charges tax in full when it is issued', () => {
    const invoice = computeInvoice(
      state(),
      request({ kind: 'deposit', amountCents: 2_500_000 }),
      [HST],
      DEFERRED,
    );

    expect(invoice.subtotalCents).toBe(2_500_000);
    expect(invoice.taxableBaseCents).toBe(2_500_000);
    expect(invoice.taxTotalCents).toBe(325_000);
    expect(invoice.totalCents).toBe(2_825_000);
    expect(invoice.amountDueCents).toBe(2_825_000);
  });

  it('withholds no holdback, because it measures no work', () => {
    const invoice = computeInvoice(
      state(),
      request({ kind: 'deposit', amountCents: 2_500_000 }),
      [HST],
      DEFERRED,
    );
    expect(invoice.holdbackCents).toBe(0);
    expect(invoice.nextState.holdbackAccruedCents).toBe(0);
  });

  it('creates the advance it will later draw down', () => {
    const invoice = computeInvoice(
      state(),
      request({ kind: 'deposit', amountCents: 2_500_000 }),
      [HST],
      DEFERRED,
    );
    expect(invoice.nextState.depositHeldCents).toBe(2_500_000);
  });

  it('does not count as work already billed', () => {
    // The trap: treating the deposit as previously invoiced would shrink the
    // first progress draw AND then have it credited again as a drawdown, which
    // is the same dollar taken off twice.
    const afterDeposit = computeInvoice(
      state(),
      request({ kind: 'deposit', amountCents: 2_500_000 }),
      [HST],
      DEFERRED,
    ).nextState;

    expect(afterDeposit.previouslyBilledCents).toBe(0);

    const draw = computeInvoice(
      afterDeposit,
      request({ percentCompleteTenThou: 5000n }),
      [HST],
      DEFERRED,
    );
    expect(draw.subtotalCents).toBe(5_000_000);
    expect(draw.subtotalCents).not.toBe(2_500_000);
  });
});

describe('a deposit drawdown', () => {
  const held = () => state({ depositHeldCents: 2_500_000 });

  it('reduces the taxable base before tax is computed, not the total after it', () => {
    const invoice = computeInvoice(
      held(),
      request({ percentCompleteTenThou: 5000n, depositApplyCents: 2_500_000 }),
      [HST],
      DEFERRED,
    );

    expect(invoice.depositAppliedCents).toBe(2_500_000);
    expect(invoice.taxableBaseCents).toBe(2_000_000);
    expect(invoice.taxTotalCents).toBe(260_000);
    // 585,000 is 13% of the post-holdback amount with the drawdown ignored --
    // the figure a version that subtracts the deposit after tax would print,
    // and the tax the owner would remit on a dollar he already remitted on.
    expect(invoice.taxTotalCents).not.toBe(585_000);
    expect(invoice.totalCents).toBe(4_760_000);
    expect(invoice.amountDueCents).toBe(2_260_000);
  });

  it('collects the tax on the work exactly once across the deposit and the drawdown', () => {
    const deposit = computeInvoice(
      state(),
      request({ kind: 'deposit', amountCents: 2_500_000 }),
      [HST],
      DEFERRED,
    );
    const draw = computeInvoice(
      deposit.nextState,
      request({ percentCompleteTenThou: 5000n, depositApplyCents: 2_500_000 }),
      [HST],
      DEFERRED,
    );

    // 13% of the $45,000 of work actually billed net of holdback, and not a
    // cent more: 325,000 collected early plus 260,000 collected now.
    expect(deposit.taxTotalCents + draw.taxTotalCents).toBe(585_000);
    expect(deposit.taxTotalCents + draw.taxTotalCents).toBe(
      Number(applyPercentCents(4_500_000n, HST.rateTenThou)),
    );
    expect(draw.nextState.depositHeldCents).toBe(0);
  });

  it('clamps to what is actually held', () => {
    const invoice = computeInvoice(
      state({ depositHeldCents: 400_000 }),
      request({ percentCompleteTenThou: 5000n, depositApplyCents: 2_500_000 }),
      [HST],
      DEFERRED,
    );
    expect(invoice.depositAppliedCents).toBe(400_000);
    expect(invoice.nextState.depositHeldCents).toBe(0);
  });

  it('clamps to what the invoice bills and carries the rest forward', () => {
    // A $60,000 advance against a $10,000 first draw: applying all of it would
    // give a negative taxable base and an invoice that refunds tax.
    const invoice = computeInvoice(
      state({ depositHeldCents: 6_000_000 }),
      request({ percentCompleteTenThou: 100n, depositApplyCents: 6_000_000 }),
      [HST],
      DEFERRED,
    );

    expect(invoice.subtotalCents).toBe(100_000);
    expect(invoice.holdbackCents).toBe(10_000);
    expect(invoice.depositAppliedCents).toBe(90_000);
    expect(invoice.taxableBaseCents).toBe(0);
    expect(invoice.taxTotalCents).toBe(0);
    expect(invoice.nextState.depositHeldCents).toBe(5_910_000);
  });

  it('applies nothing to a corrective invoice', () => {
    const invoice = computeInvoice(
      state({ previouslyBilledCents: 6_000_000, holdbackAccruedCents: 600_000, depositHeldCents: 1_000_000 }),
      request({ percentCompleteTenThou: 4500n, depositApplyCents: 1_000_000 }),
      [HST],
      DEFERRED,
    );
    expect(invoice.depositAppliedCents).toBe(0);
    expect(invoice.nextState.depositHeldCents).toBe(1_000_000);
  });

  it('refuses a negative drawdown', () => {
    expect(() => computeInvoice(
      held(),
      request({ percentCompleteTenThou: 5000n, depositApplyCents: -1 }),
      [HST],
      DEFERRED,
    )).toThrow(/cannot be negative/);
  });

  it('refuses to draw a deposit down against a deposit', () => {
    expect(() => computeInvoice(
      held(),
      request({ kind: 'deposit', amountCents: 100_000, depositApplyCents: 100_000 }),
      [HST],
      DEFERRED,
    )).toThrow(/does not draw down a deposit/);
  });
});

describe('change orders', () => {
  const ORIGINAL = 1_234_567;
  const REVISED = 1_777_777;

  it('bills a later draw against the revised contract', () => {
    const afterDraw = computeInvoice(
      state({ contractValueCents: ORIGINAL }),
      request({ percentCompleteTenThou: 4000n }),
      [HST],
      DEFERRED,
    ).nextState;

    expect(afterDraw.previouslyBilledCents).toBe(493_827);

    const afterChangeOrder = { ...afterDraw, contractValueCents: REVISED };
    const draw = computeInvoice(
      afterChangeOrder,
      request({ percentCompleteTenThou: 7000n }),
      [HST],
      DEFERRED,
    );

    // 70% of the revised contract, not of the original.
    expect(draw.subtotalCents).toBe(750_617);
    expect(draw.nextState.previouslyBilledCents).toBe(1_244_444);
  });

  it('sums to the revised contract exactly across the change order', () => {
    const first = computeInvoice(
      state({ contractValueCents: ORIGINAL }),
      request({ percentCompleteTenThou: 4000n }),
      [HST],
      DEFERRED,
    );
    const second = computeInvoice(
      { ...first.nextState, contractValueCents: REVISED },
      request({ percentCompleteTenThou: 7000n }),
      [HST],
      DEFERRED,
    );
    const third = computeInvoice(
      second.nextState,
      request({ kind: 'final', percentCompleteTenThou: FULL }),
      [HST],
      DEFERRED,
    );

    expect(sum([first, second, third].map((invoice) => invoice.subtotalCents))).toBe(REVISED);
    expect(third.nextState.previouslyBilledCents).toBe(REVISED);
    expect(third.nextState.holdbackAccruedCents).toBe(
      Number(applyPercentCents(BigInt(REVISED), HOLDBACK_10)),
    );
  });

  it('counts a change-order invoice towards work already billed', () => {
    // Billing the change order on its own invoice and then leaving
    // previouslyBilled alone would have the next progress draw bill the same
    // extra work a second time.
    const first = computeInvoice(
      state({ contractValueCents: ORIGINAL }),
      request({ percentCompleteTenThou: 4000n }),
      [HST],
      DEFERRED,
    );
    const extra = computeInvoice(
      { ...first.nextState, contractValueCents: REVISED },
      request({ kind: 'change_order', amountCents: REVISED - ORIGINAL }),
      [HST],
      DEFERRED,
    );

    expect(extra.subtotalCents).toBe(543_210);
    expect(extra.nextState.previouslyBilledCents).toBe(1_037_037);

    const final = computeInvoice(
      extra.nextState,
      request({ kind: 'final', percentCompleteTenThou: FULL }),
      [HST],
      DEFERRED,
    );
    expect(final.subtotalCents).toBe(740_740);
    expect(sum([first, extra, final].map((invoice) => invoice.subtotalCents))).toBe(REVISED);
  });

  it('withholds holdback on a change-order invoice at the contract rate', () => {
    const invoice = computeInvoice(
      state({ contractValueCents: REVISED, previouslyBilledCents: 493_827, holdbackAccruedCents: 49_383 }),
      request({ kind: 'change_order', amountCents: 543_210 }),
      [HST],
      DEFERRED,
    );
    expect(invoice.holdbackCents).toBe(54_321);
    expect(invoice.taxableBaseCents).toBe(543_210 - 54_321);
  });

  it('refuses a change-order invoice that over-bills the contract', () => {
    expect(() => computeInvoice(
      state({ contractValueCents: REVISED, previouslyBilledCents: 493_827 }),
      request({ kind: 'change_order', amountCents: 2_000_000 }),
      [HST],
      DEFERRED,
    )).toThrow(/accept the change order first/);
  });
});

describe('tax dating and exemption', () => {
  const oldRate: TaxRateInput = { ...HST, rateTenThou: 1300n, effectiveFrom: '2020-01-01', effectiveTo: '2026-03-31' };
  const newRate: TaxRateInput = { ...HST, rateTenThou: 1400n, effectiveFrom: '2026-04-01', effectiveTo: null };

  it('uses the rate in force on the issue date, not the current one', () => {
    const before = computeInvoice(
      state(),
      request({ percentCompleteTenThou: 5000n, issueDate: '2026-03-15' }),
      [oldRate, newRate],
      DEFERRED,
    );
    const after = computeInvoice(
      state(),
      request({ percentCompleteTenThou: 5000n, issueDate: '2026-04-01' }),
      [oldRate, newRate],
      DEFERRED,
    );

    expect(before.taxTotalCents).toBe(585_000);
    // Inclusive on the changeover day, which is what comparing ISO strings
    // gives and what a Date built in the host's timezone would not.
    expect(after.taxTotalCents).toBe(630_000);
  });

  it('charges no tax to an exempt customer but still withholds holdback', () => {
    const invoice = computeInvoice(
      state(),
      request({ percentCompleteTenThou: 5000n }),
      [HST],
      { taxDeferredOnHoldback: true, customerExempt: true },
    );

    expect(invoice.taxes).toEqual([]);
    expect(invoice.taxTotalCents).toBe(0);
    expect(invoice.holdbackCents).toBe(500_000);
    expect(invoice.totalCents).toBe(4_500_000);
  });

  it('reports the base each rate was charged on, through the quote engine', () => {
    const gst: TaxRateInput = { ...HST, label: 'GST', rateTenThou: 500n, sortOrder: 1 };
    const qst: TaxRateInput = { ...HST, label: 'QST', rateTenThou: 1000n, sortOrder: 2, isCompound: true };
    const invoice = computeInvoice(
      state(),
      request({ percentCompleteTenThou: 5000n }),
      [qst, gst],
      DEFERRED,
    );

    // Compounding and rate ordering are the quote engine's rules, reused rather
    // than reimplemented, so an invoice cannot disagree with its own quote.
    expect(invoice.taxes.map((tax) => tax.label)).toEqual(['GST', 'QST']);
    expect(invoice.taxes.map((tax) => tax.taxableBaseCents)).toEqual([4_500_000, 4_725_000]);
    expect(invoice.taxTotalCents).toBe(225_000 + 472_500);
  });
});
