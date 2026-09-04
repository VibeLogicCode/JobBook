import { describe, expect, it } from 'vitest';
import { computeInvoice } from '@/lib/invoice/compute';
import {
  holdbackAccruedToDateCents,
  holdbackDeltaCents,
  holdbackOutstandingCents,
  holdbackReleaseEligibleDate,
} from '@/lib/invoice/holdback';
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

/** Excise Tax Act s.168(7) applies: Ontario, and the seeded default. */
const DEFERRED: InvoiceContext = { taxDeferredOnHoldback: true, customerExempt: false };
/** A jurisdiction with no deferral. It must still bill correctly. */
const NOT_DEFERRED: InvoiceContext = { taxDeferredOnHoldback: false, customerExempt: false };

const HOLDBACK_10 = 1000n;
const FULL = 10000n;
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

/** Half the contract, then the rest, then the holdback released. */
function runJob(context: InvoiceContext) {
  const draw = computeInvoice(state(), request({ percentCompleteTenThou: 5000n }), [HST], context);
  const final = computeInvoice(
    draw.nextState,
    request({ kind: 'final', percentCompleteTenThou: FULL }),
    [HST],
    context,
  );
  const release = computeInvoice(
    final.nextState,
    request({ kind: 'holdback_release' }),
    [HST],
    context,
  );
  return { draw, final, release };
}

describe('holdbackAccruedToDateCents', () => {
  it('is a percentage of everything billed to date, rounded once', () => {
    expect(holdbackAccruedToDateCents(5_000_000, HOLDBACK_10)).toBe(500_000);
    expect(holdbackAccruedToDateCents(3_333, HOLDBACK_10)).toBe(333);
    expect(holdbackAccruedToDateCents(6_667, HOLDBACK_10)).toBe(667);
  });

  it('is zero at a zero rate, which is a residential job with no holdback', () => {
    expect(holdbackAccruedToDateCents(5_000_000, 0n)).toBe(0);
  });

  it('refuses a rate outside 0%..100%', () => {
    expect(() => holdbackAccruedToDateCents(5_000_000, 10_001n)).toThrow(/between 0% and 100%/);
    expect(() => holdbackAccruedToDateCents(5_000_000, -1n)).toThrow(/between 0% and 100%/);
  });
});

describe('holdbackDeltaCents', () => {
  it('is the move in the balance, not a percentage of this draw', () => {
    expect(holdbackDeltaCents({
      billedToDateCents: 6_667,
      holdbackPctTenThou: HOLDBACK_10,
      alreadyAccruedCents: 333,
    })).toBe(334);
  });

  it('is zero for an invoice that bills no new work', () => {
    // A deposit and a release both leave billedToDate where it was, which is
    // why neither needs a branch of its own in compute.ts.
    expect(holdbackDeltaCents({
      billedToDateCents: 5_000_000,
      holdbackPctTenThou: HOLDBACK_10,
      alreadyAccruedCents: 500_000,
    })).toBe(0);
  });

  it('reverses when the work billed to date goes down', () => {
    expect(holdbackDeltaCents({
      billedToDateCents: 4_500_000,
      holdbackPctTenThou: HOLDBACK_10,
      alreadyAccruedCents: 600_000,
    })).toBe(-150_000);
  });
});

describe('the accrued balance across a draw schedule', () => {
  /** 3333/6667/10000 on a $100.00 contract: the case per-draw rounding loses. */
  const PERCENTS = [3333n, 6667n, FULL];
  const SMALL_CONTRACT = 10_000;

  function draws() {
    let current = state({ contractValueCents: SMALL_CONTRACT });
    return PERCENTS.map((percentCompleteTenThou, index) => {
      const invoice = computeInvoice(
        current,
        request({
          kind: index === PERCENTS.length - 1 ? 'final' : 'progress',
          percentCompleteTenThou,
        }),
        [HST],
        DEFERRED,
      );
      current = invoice.nextState;
      return invoice;
    });
  }

  it('ends at exactly the holdback percentage of the contract', () => {
    const invoices = draws();

    expect(invoices.map((invoice) => invoice.subtotalCents)).toEqual([3_333, 3_334, 3_333]);
    expect(invoices.map((invoice) => invoice.holdbackCents)).toEqual([333, 334, 333]);
    expect(invoices.at(-1)!.nextState.holdbackAccruedCents).toBe(1_000);
    expect(invoices.at(-1)!.nextState.holdbackAccruedCents).toBe(
      Number(applyPercentCents(BigInt(SMALL_CONTRACT), HOLDBACK_10)),
    );
  });

  it('would fall a cent short if each draw were rounded on its own', () => {
    // The rejected implementation, stated as an assertion: 10% of 3,333 and 10%
    // of 3,334 both round to 333, so three draws withhold 999 and the release
    // invoice pays out a figure that is 9.99% of the contract. A lien claim is
    // the one place that number gets checked.
    const perDraw = [3_333, 3_334, 3_333].map((subtotal) =>
      Number(applyPercentCents(BigInt(subtotal), HOLDBACK_10)),
    );
    expect(perDraw).toEqual([333, 333, 333]);
    expect(perDraw.reduce((total, value) => total + value, 0)).toBe(999);
    expect(perDraw.reduce((total, value) => total + value, 0)).not.toBe(1_000);
  });
});

describe('tax when the holdback deferral applies', () => {
  it('taxes the progress amount less the holdback', () => {
    const { draw } = runJob(DEFERRED);

    expect(draw.subtotalCents).toBe(5_000_000);
    expect(draw.holdbackCents).toBe(500_000);
    expect(draw.taxableBaseCents).toBe(4_500_000);
    expect(draw.taxTotalCents).toBe(585_000);
    // 650,000 is 13% of the full progress amount: the answer an earlier draft
    // of the spec gave, and the intuitive one, since a holdback is withheld
    // from payment. It is wrong under s.168(7) and it is wrong here.
    expect(draw.taxTotalCents).not.toBe(650_000);
  });

  it('taxes the holdback on the release invoice, where it was deferred to', () => {
    const { release } = runJob(DEFERRED);

    expect(release.subtotalCents).toBe(0);
    expect(release.holdbackCents).toBe(-1_000_000);
    expect(release.holdbackReleasedCents).toBe(1_000_000);
    expect(release.taxableBaseCents).toBe(1_000_000);
    expect(release.taxTotalCents).toBe(130_000);
    expect(release.totalCents).toBe(1_130_000);
    expect(release.amountDueCents).toBe(1_130_000);
  });
});

describe('tax when the deferral does not apply', () => {
  it('taxes the full progress amount', () => {
    const { draw } = runJob(NOT_DEFERRED);

    expect(draw.taxableBaseCents).toBe(5_000_000);
    expect(draw.taxTotalCents).toBe(650_000);
    // Still withheld from what the customer pays: the deferral is about when
    // the tax is payable, not about whether the money is held back.
    expect(draw.holdbackCents).toBe(500_000);
    expect(draw.totalCents).toBe(5_150_000);
  });

  it('taxes nothing on the release, because the tax was charged up front', () => {
    const { release } = runJob(NOT_DEFERRED);

    expect(release.taxableBaseCents).toBe(0);
    expect(release.taxTotalCents).toBe(0);
    expect(release.taxTotalCents).not.toBe(130_000);
    expect(release.totalCents).toBe(1_000_000);
  });
});

describe('the deferral changes when the tax is collected, never how much', () => {
  it('collects the same total either way', () => {
    const deferred = runJob(DEFERRED);
    const notDeferred = runJob(NOT_DEFERRED);

    const total = (job: ReturnType<typeof runJob>) =>
      job.draw.taxTotalCents + job.final.taxTotalCents + job.release.taxTotalCents;

    const onTheWholeContract = Number(applyPercentCents(BigInt(CONTRACT), HST.rateTenThou));
    expect(total(deferred)).toBe(onTheWholeContract);
    expect(total(notDeferred)).toBe(onTheWholeContract);
    expect(total(deferred)).toBe(total(notDeferred));

    // The timing is the whole of the difference: 130,000 of it moves from the
    // draws to the release. A test asserting only the total would pass with the
    // rule backwards, which is why both branches are asserted above as well.
    expect(deferred.draw.taxTotalCents).not.toBe(notDeferred.draw.taxTotalCents);
    expect(deferred.release.taxTotalCents).not.toBe(notDeferred.release.taxTotalCents);
  });

  it('bills the same money either way, once the holdback is released', () => {
    const deferred = runJob(DEFERRED);
    const notDeferred = runJob(NOT_DEFERRED);
    const due = (job: ReturnType<typeof runJob>) =>
      job.draw.amountDueCents + job.final.amountDueCents + job.release.amountDueCents;

    expect(due(deferred)).toBe(due(notDeferred));
    expect(due(deferred)).toBe(CONTRACT + Number(applyPercentCents(BigInt(CONTRACT), HST.rateTenThou)));
  });
});

describe('a job with no holdback', () => {
  it('taxes the whole progress amount even under the deferral', () => {
    const invoice = computeInvoice(
      state(),
      request({ percentCompleteTenThou: 5000n, holdbackPctTenThou: 0n }),
      [HST],
      DEFERRED,
    );

    expect(invoice.holdbackCents).toBe(0);
    expect(invoice.taxableBaseCents).toBe(5_000_000);
    expect(invoice.taxTotalCents).toBe(650_000);
    expect(invoice.amountDueCents).toBe(5_650_000);
  });

  it('has nothing to release', () => {
    const invoice = computeInvoice(
      state({ previouslyBilledCents: CONTRACT }),
      request({ kind: 'holdback_release', holdbackPctTenThou: 0n }),
      [HST],
      DEFERRED,
    );

    expect(invoice.holdbackCents).toBe(0);
    expect(invoice.totalCents).toBe(0);
  });
});

describe('releasing the holdback', () => {
  const held = () =>
    state({ previouslyBilledCents: CONTRACT, holdbackAccruedCents: 1_000_000 });

  it('defaults to the whole outstanding balance', () => {
    const invoice = computeInvoice(held(), request({ kind: 'holdback_release' }), [HST], DEFERRED);

    expect(invoice.holdbackReleasedCents).toBe(1_000_000);
    expect(holdbackOutstandingCents(invoice.nextState)).toBe(0);
  });

  it('releases part of the balance when asked', () => {
    const invoice = computeInvoice(
      held(),
      request({ kind: 'holdback_release', releaseHoldbackCents: 400_000 }),
      [HST],
      DEFERRED,
    );

    expect(invoice.holdbackReleasedCents).toBe(400_000);
    expect(invoice.taxableBaseCents).toBe(400_000);
    expect(invoice.taxTotalCents).toBe(52_000);
    expect(invoice.totalCents).toBe(452_000);
    expect(holdbackOutstandingCents(invoice.nextState)).toBe(600_000);
  });

  it('recognises no revenue, because the work was billed when it was withheld', () => {
    // The holdback already sat inside the subtotals of the draws that withheld
    // it. Putting it in this invoice's subtotal too would report 110% of the
    // contract as revenue on the WIP schedule.
    const invoice = computeInvoice(held(), request({ kind: 'holdback_release' }), [HST], DEFERRED);

    expect(invoice.subtotalCents).toBe(0);
    expect(invoice.nextState.previouslyBilledCents).toBe(CONTRACT);
    expect(invoice.nextState.holdbackAccruedCents).toBe(1_000_000);
  });

  it('refuses to release more than was ever withheld', () => {
    expect(() => computeInvoice(
      held(),
      request({ kind: 'holdback_release', releaseHoldbackCents: 1_500_000 }),
      [HST],
      DEFERRED,
    )).toThrow(/only 1000000 cents are outstanding/);
  });

  it('refuses to release twice', () => {
    const first = computeInvoice(held(), request({ kind: 'holdback_release' }), [HST], DEFERRED);

    expect(() => computeInvoice(
      first.nextState,
      request({ kind: 'holdback_release', releaseHoldbackCents: 1 }),
      [HST],
      DEFERRED,
    )).toThrow(/only 0 cents are outstanding/);
  });

  it('refuses a negative release', () => {
    expect(() => computeInvoice(
      held(),
      request({ kind: 'holdback_release', releaseHoldbackCents: -1 }),
      [HST],
      DEFERRED,
    )).toThrow(/cannot be negative/);
  });
});

describe('a corrective draw and the holdback', () => {
  const overbilled = () =>
    state({ previouslyBilledCents: 6_000_000, holdbackAccruedCents: 600_000 });

  it('reverses the withholding along with the work', () => {
    const invoice = computeInvoice(
      overbilled(),
      request({ percentCompleteTenThou: 4500n }),
      [HST],
      DEFERRED,
    );

    expect(invoice.subtotalCents).toBe(-1_500_000);
    expect(invoice.holdbackCents).toBe(-150_000);
    expect(invoice.taxableBaseCents).toBe(-1_350_000);
    expect(invoice.taxTotalCents).toBe(-175_500);
    expect(invoice.totalCents).toBe(-1_525_500);
    // 10% of the 4,500,000 now billed, not 600,000 less a re-rounded figure.
    expect(invoice.nextState.holdbackAccruedCents).toBe(450_000);
  });

  it('reduces the accrued balance rather than releasing it', () => {
    // A reversal and a release both show as a negative holdback on the invoice
    // and mean opposite things to the ledger: nothing was paid out here, so
    // reporting it as released would show the customer as having received
    // money the owner never sent.
    const invoice = computeInvoice(
      overbilled(),
      request({ percentCompleteTenThou: 4500n }),
      [HST],
      DEFERRED,
    );

    expect(invoice.holdbackReleasedCents).toBe(0);
    expect(invoice.nextState.holdbackReleasedCents).toBe(0);
    expect(holdbackOutstandingCents(invoice.nextState)).toBe(450_000);
  });

  it('leaves the job on the contract once the work is finished', () => {
    const correction = computeInvoice(
      overbilled(),
      request({ percentCompleteTenThou: 4500n }),
      [HST],
      DEFERRED,
    );
    const final = computeInvoice(
      correction.nextState,
      request({ kind: 'final', percentCompleteTenThou: FULL }),
      [HST],
      DEFERRED,
    );

    expect(6_000_000 + correction.subtotalCents + final.subtotalCents).toBe(CONTRACT);
    expect(final.nextState.holdbackAccruedCents).toBe(1_000_000);
  });
});

describe('holdbackOutstandingCents', () => {
  it('is what has been withheld and not paid out', () => {
    expect(holdbackOutstandingCents(
      state({ holdbackAccruedCents: 1_000_000, holdbackReleasedCents: 400_000 }),
    )).toBe(600_000);
  });
});

describe('holdbackReleaseEligibleDate', () => {
  it('adds the statutory period to substantial performance', () => {
    // Ontario's 60 days, passed in rather than assumed: the period differs by
    // province and the product is white-label.
    expect(holdbackReleaseEligibleDate('2026-09-04', 60)).toBe('2026-11-03');
    expect(holdbackReleaseEligibleDate('2026-09-04', 45)).toBe('2026-10-19');
  });

  it('is unmoved by a daylight-saving change inside the period', () => {
    // Toronto's clocks go back on 1 November 2026. A Date-based calculation can
    // land a day either side of this, and this date closes a lien period.
    expect(holdbackReleaseEligibleDate('2026-10-15', 30)).toBe('2026-11-14');
  });

  it('crosses a month and a non-leap February correctly', () => {
    expect(holdbackReleaseEligibleDate('2026-02-28', 1)).toBe('2026-03-01');
    expect(holdbackReleaseEligibleDate('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('is the same day at a zero period', () => {
    expect(holdbackReleaseEligibleDate('2026-09-04', 0)).toBe('2026-09-04');
  });

  it('refuses a date that is not an ISO date', () => {
    expect(() => holdbackReleaseEligibleDate('04/09/2026', 60)).toThrow(/ISO date/);
  });

  it('refuses a period that is not a whole number of days', () => {
    expect(() => holdbackReleaseEligibleDate('2026-09-04', 60.5)).toThrow(/whole number/);
    expect(() => holdbackReleaseEligibleDate('2026-09-04', -1)).toThrow(/whole number/);
  });
});
