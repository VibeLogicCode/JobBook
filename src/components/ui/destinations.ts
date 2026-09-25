import {
  BellRing, CalendarDays, ClipboardList, FileText, HardHat, Home, LayoutTemplate, Receipt,
  ReceiptText,
  Ruler, Settings, Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ModuleKey, ModuleState } from '@/lib/modules/types';

export interface Destination {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Every screen in the product, in rail order.
 *
 * Lifted out of `AppShell` so the reachability rules below can be asserted
 * without a DOM. This project's suite runs in a node environment and has no
 * component tests, so a rule that only exists inside JSX is a rule nothing
 * checks -- which is how six destinations came to have no entry point on a
 * phone without a single test noticing.
 *
 * Reminders sits second, directly under Today, because the two are one
 * question asked twice: what is happening, and what do I have to do about it.
 * Anywhere further down the rail it becomes a screen he has to remember to
 * visit, and a reminder system nobody opens is worse than no reminder system.
 */
export const DESTINATIONS: readonly Destination[] = [
  { href: '/', label: 'Today', icon: Home },
  { href: '/reminders', label: 'Reminders', icon: BellRing },
  { href: '/quotes', label: 'Quotes', icon: FileText },
  /**
   * Directly under Quotes, and that position is a decision with a cost.
   *
   * These are the two documents the business runs on -- one asks for the work,
   * the other asks for the money -- and reading them as a pair is how an owner
   * checks whether what he sold has been billed. Anywhere below the fold they
   * become a screen he opens when he already suspects something is wrong.
   *
   * The cost is that it takes the fourth bottom-bar seat and PIPELINE MOVES TO
   * "More" on a phone. Paid knowingly: a job board is read at a desk while
   * planning a week, and "has that been invoiced" is asked standing in a
   * merchant's car park.
   */
  { href: '/invoices', label: 'Invoices', icon: ReceiptText },
  { href: '/projects', label: 'Pipeline', icon: ClipboardList },
  // Directly after the pipeline, because it is the same book of work read by
  // the day instead of by the job -- and because that position puts it on the
  // bottom bar. See `BOTTOM_BAR`.
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/customers', label: 'People', icon: Users },
  { href: '/rates', label: 'Rates', icon: Ruler },
  // Appended after the fifth, so it reaches the rail without displacing
  // anything on the bottom bar. Vendors are looked up at a desk when a bill
  // arrives or a sub is hired, not thumbed at on site.
  { href: '/vendors', label: 'Vendors', icon: HardHat },
  // Beside vendors rather than beside the pipeline: these two are the
  // money-going-out pair, and a bill is entered in the same sitting as the
  // counterparty it is owed to.
  { href: '/expenses', label: 'Expenses', icon: Receipt },
  { href: '/templates', label: 'Templates', icon: LayoutTemplate },
  /**
   * "Settings", not "Setup".
   *
   * It said Setup, and that is a different screen: `/setup` is the nine-step
   * first-run wizard. The owner of a fresh deployment read the one word on
   * screen that matched what he was trying to do, arrived at a settings index
   * that told him to "run first-run setup", and had nowhere to go from there.
   * A label that names another feature is worse than a vague one.
   */
  { href: '/settings', label: 'Settings', icon: Settings },
];

/**
 * How many controls fit across the bottom of a phone.
 *
 * Five, per the UI spec's breakpoint table. At 375px that is 75px each, which
 * holds a 20px icon over a `t-micro` word; a sixth would take them to 62px and
 * "Reminders" would stop fitting on one line.
 */
export const BOTTOM_BAR_SEATS = 5;

/**
 * The four destinations that keep a seat of their own, and the rest.
 *
 * The bar was `slice(0, 5)` with nothing carrying the remainder, and the rail
 * that "carries all of them" is `hidden` below `sm` -- so on a phone the last
 * six screens did not exist. The fifth seat now belongs to the overflow
 * control, and the split is derived from one list rather than written twice,
 * because two lists is how a destination ends up on one and not the other.
 *
 * WHAT THE BAR IS FOR decides which four keep their seats: the screens
 * somebody opens standing outside with one hand free. Today and Reminders are
 * the morning. Quotes and the pipeline are the job. The calendar loses the
 * seat it was given -- it is the only screen that can answer "is anybody
 * promised to two places at once", but it is also one tap away in the
 * overflow, and a bar with no overflow control is what stranded six screens in
 * the first place. Rates, vendors, expenses and templates are desk work;
 * people and settings are reached from the records that link to them.
 */
export const BOTTOM_BAR: readonly Destination[] = DESTINATIONS.slice(0, BOTTOM_BAR_SEATS - 1);
export const OVERFLOW: readonly Destination[] = DESTINATIONS.slice(BOTTOM_BAR_SEATS - 1);

/**
 * Which optional part of the product each destination belongs to.
 *
 * A destination with no entry here is CORE and cannot be switched off: Today,
 * Quotes, Invoices, People, Rates, Settings. See `lib/modules/types.ts` for
 * why those six are not offered as choices.
 */
const MODULE_OF: Partial<Record<string, ModuleKey>> = {
  '/reminders': 'reminders',
  '/projects': 'pipeline',
  '/calendar': 'calendar',
  '/vendors': 'vendors',
  '/expenses': 'expenses',
  '/templates': 'templates',
};

/**
 * The rail for a deployment, with the parts it does not use left out.
 *
 * Filtered rather than hidden with CSS, because a link that is not offered
 * must also not be in the tab order -- `sr-only` on a destination is how eight
 * links came to be announced as "link" once before.
 *
 * The routes themselves keep working. This decides what is OFFERED, exactly as
 * a retired list row stops being offered and is still accepted if submitted.
 */
export function destinationsFor(modules: ModuleState): Destination[] {
  return DESTINATIONS.filter((destination) => {
    const key = MODULE_OF[destination.href];
    return key === undefined || modules[key];
  });
}

/**
 * The phone bar and its overflow, SPLIT AFTER FILTERING.
 *
 * This is the trap the constants above would have walked into: they slice the
 * full list, so a deployment with the pipeline switched off would have kept a
 * seat for a destination that is not there, and one of the remaining screens
 * would have silently lost its place on the bar. Derived from whatever list is
 * actually being rendered, so the bar is always full and the overflow always
 * holds the rest.
 */
export function barFor(list: readonly Destination[]): {
  bar: Destination[];
  overflow: Destination[];
} {
  return {
    bar: list.slice(0, BOTTOM_BAR_SEATS - 1),
    overflow: list.slice(BOTTOM_BAR_SEATS - 1),
  };
}
