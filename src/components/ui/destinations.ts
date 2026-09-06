import {
  BellRing, CalendarDays, ClipboardList, FileText, HardHat, Home, LayoutTemplate, Receipt,
  Ruler, Settings, Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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
