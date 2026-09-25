import { describe, expect, it } from 'vitest';
import { barFor, BOTTOM_BAR_SEATS, destinationsFor } from '@/components/ui/destinations';
import { settingsGroupsFor } from '@/app/settings/nav';
import { modulesOf } from '@/lib/modules/read';
import {
  ALL_MODULES_ON,
  MODULES,
  MODULE_LABELS,
  MODULE_SUMMARIES,
  QUOTES_AND_INVOICES_ONLY,
} from '@/lib/modules/types';

/**
 * Which parts of the product a deployment offers.
 *
 * Pure, so it needs no database -- the same reason the posture vocabulary is
 * tested this way. What matters here is not that a filter filters, but the
 * three rules that are easy to get wrong and impossible to see: the six core
 * screens can never be switched off, the phone bar is split AFTER filtering,
 * and everything fails open.
 */

const CORE = ['/', '/quotes', '/invoices', '/customers', '/rates', '/settings'];

describe('the core of the product', () => {
  it('keeps its six screens whatever is switched off', () => {
    const hrefs = destinationsFor(QUOTES_AND_INVOICES_ONLY).map((row) => row.href);
    for (const href of CORE) expect(hrefs, href).toContain(href);
  });

  it('is exactly what a quotes-and-invoices deployment gets', () => {
    // Nothing more, so the promise the setup question makes is the one kept.
    expect(destinationsFor(QUOTES_AND_INVOICES_ONLY).map((row) => row.href).sort()).toEqual(
      [...CORE].sort(),
    );
  });

  it('offers everything when everything is on', () => {
    const all = destinationsFor(ALL_MODULES_ON);
    expect(all.map((row) => row.href)).toContain('/projects');
    expect(all.map((row) => row.href)).toContain('/expenses');
    expect(all.length).toBeGreaterThan(CORE.length);
  });

  it('drops exactly the part that was switched off', () => {
    const hrefs = destinationsFor({ ...ALL_MODULES_ON, expenses: false }).map((row) => row.href);
    expect(hrefs).not.toContain('/expenses');
    expect(hrefs).toContain('/vendors');
    expect(hrefs).toContain('/projects');
  });
});

describe('the phone bar', () => {
  it('fills every seat from whatever is actually offered', () => {
    /**
     * THE TRAP this splits after filtering to avoid. The constants slice the
     * FULL list, so a deployment with the pipeline off would have kept a seat
     * for a destination that is not rendered -- one of the remaining screens
     * silently losing its place on the bar, on the one navigation a phone has.
     */
    const list = destinationsFor(QUOTES_AND_INVOICES_ONLY);
    const { bar, overflow } = barFor(list);

    expect(bar).toHaveLength(BOTTOM_BAR_SEATS - 1);
    expect(bar.map((row) => row.href)).not.toContain('/projects');
    // Every destination is on exactly one of the two, always.
    expect([...bar, ...overflow].map((row) => row.href)).toEqual(list.map((row) => row.href));
  });

  it('leads with the two documents the business runs on', () => {
    const { bar } = barFor(destinationsFor(QUOTES_AND_INVOICES_ONLY));
    expect(bar.map((row) => row.href)).toContain('/quotes');
    expect(bar.map((row) => row.href)).toContain('/invoices');
  });
});

describe('the settings menu', () => {
  it('drops the screens that configure a part that is off', () => {
    const hrefs = settingsGroupsFor({ ...ALL_MODULES_ON, vendors: false })
      .flatMap((group) => group.items)
      .map((item) => item.href);

    expect(hrefs).not.toContain('/settings/vendor-types');
    expect(hrefs).not.toContain('/settings/trades');
    // Lead sources is about customers, not vendors, and stays.
    expect(hrefs).toContain('/settings/lead-sources');
    // And the core of the company is never touched.
    expect(hrefs).toContain('/settings/identity');
    expect(hrefs).toContain('/settings/tax-rates');
  });

  it('keeps reminder rules only while reminders are on', () => {
    const on = settingsGroupsFor(ALL_MODULES_ON)
      .flatMap((group) => group.items)
      .map((item) => item.href);
    expect(on).toContain('/settings/reminder-rules');

    const off = settingsGroupsFor({ ...ALL_MODULES_ON, reminders: false })
      .flatMap((group) => group.items)
      .map((item) => item.href);
    expect(off).not.toContain('/settings/reminder-rules');
  });

  it('never renders an empty group', () => {
    for (const group of settingsGroupsFor(QUOTES_AND_INVOICES_ONLY)) {
      expect(group.items.length, group.heading).toBeGreaterThan(0);
    }
  });
});

describe('reading the row', () => {
  it('fails OPEN on a deployment it cannot read', () => {
    /**
     * A blip must not hide half the product. Nothing here protects anything --
     * the routes keep working when their entry point is gone -- so the cost of
     * failing open is one screen somebody had put away, and the cost of
     * failing closed is an owner opening the app to find his work missing with
     * no way to tell whether something broke or somebody changed a setting.
     */
    expect(modulesOf(null)).toEqual(ALL_MODULES_ON);
    expect(modulesOf(undefined)).toEqual(ALL_MODULES_ON);
    expect(modulesOf({})).toEqual(ALL_MODULES_ON);
  });

  it('reads each column through to its own switch', () => {
    expect(modulesOf({ modulePipeline: false }).pipeline).toBe(false);
    expect(modulesOf({ modulePipeline: false }).calendar).toBe(true);
  });
});

describe('the vocabulary', () => {
  it('describes every part it offers to switch off', () => {
    // A switch with no sentence under it is a switch nobody presses, and the
    // summary is what says what is LOST rather than what is hidden.
    for (const key of MODULES) {
      expect(MODULE_LABELS[key], key).toBeTruthy();
      expect(MODULE_SUMMARIES[key]?.length, key).toBeGreaterThan(20);
    }
  });

  it('has a state for every module in both presets', () => {
    for (const key of MODULES) {
      expect(typeof ALL_MODULES_ON[key], key).toBe('boolean');
      expect(typeof QUOTES_AND_INVOICES_ONLY[key], key).toBe('boolean');
    }
  });
});
