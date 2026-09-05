'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BellRing, ClipboardList, FileText, HardHat, Home, LayoutTemplate, Moon, Receipt, Ruler, Settings,
  Sun, Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Reminders sits second, directly under Today, because the two are one
 * question asked twice: what is happening, and what do I have to do about it.
 * Anywhere further down the rail it becomes a screen he has to remember to
 * visit, and a reminder system nobody opens is worse than no reminder system.
 */
const DESTINATIONS = [
  { href: '/', label: 'Today', icon: Home },
  { href: '/reminders', label: 'Reminders', icon: BellRing },
  { href: '/quotes', label: 'Quotes', icon: FileText },
  { href: '/projects', label: 'Pipeline', icon: ClipboardList },
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
  { href: '/settings', label: 'Setup', icon: Settings },
];

/**
 * The bottom bar carries five, per the UI spec's breakpoint table; the rail
 * carries all of them.
 *
 * The bar was already full, so Reminders did not get appended -- it took a
 * seat, and Rates gave it up. Rates is the rate book: a thing maintained at a
 * desk, read by the worksheet rather than by a person, and reached from the
 * rail on the machine where prices actually get edited. Reminders is the
 * opposite -- it is the screen for a phone in a truck at 7am, which is exactly
 * what a bottom tab bar is for. Templates and Setup were already off it for
 * the same reason.
 *
 * Kept as `slice(0, 5)` rather than a second hand-written list: two lists is
 * how a destination ends up on one and not the other.
 */
const BOTTOM_BAR = DESTINATIONS.slice(0, 5);

/**
 * Desktop gets a rail, mobile gets a bottom tab bar -- one tree, reflowed by
 * CSS. The nav list exists once in the DOM at every width, so a test query for
 * a destination matches exactly one node.
 */
export function AppShell({
  displayName,
  ownerName,
  children,
}: {
  displayName: string;
  ownerName: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isPrint = pathname?.startsWith('/print');

  // The print route renders inside headless Chromium, where the shell would
  // print a navigation rail onto a customer's contract.
  if (isPrint) return <>{children}</>;

  return (
    <div className="flex min-h-dvh">
      <nav
        aria-label="Main"
        className="no-print hidden shrink-0 flex-col border-r border-line bg-surface sm:flex sm:w-16 xl:w-56"
      >
        <div className="flex h-14 items-center gap-2 border-b border-line px-4">
          <span className="t-heading truncate xl:inline hidden">{displayName}</span>
          <span className="t-heading xl:hidden" aria-hidden>
            {displayName.slice(0, 1)}
          </span>
        </div>
        <ul className="flex flex-1 flex-col gap-1 p-2">
          {DESTINATIONS.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname?.startsWith(href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  // `relative` so the collapsed label below has a containing
                  // block of its own: `.sr-only` is `position: absolute`, and
                  // an unpositioned ancestor hands it the page instead, which
                  // is how an off-screen span ends up widening the document.
                  className={`relative flex min-h-11 items-center gap-3 rounded-control px-3 ${
                    active
                      ? 'bg-accent-soft text-accent-soft-fg'
                      : 'text-muted hover:bg-surface-2 hover:text-ink'
                  }`}
                >
                  <Icon size={18} aria-hidden />
                  {/* `sr-only`, not `hidden`. Between `sm` and `xl` the rail is
                      icons only, and `hidden` removes the label from the
                      accessibility tree along with the layout -- so every
                      destination in this list became an unnamed link, on the
                      one navigation a screen reader is meant to use. The icon
                      is `aria-hidden`, so there was nothing else to fall back
                      on: eight links announced as "link". Now the word is
                      always in the tree and only its box collapses. */}
                  <span className="sr-only xl:not-sr-only xl:inline">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        {ownerName ? (
          <div className="hidden border-t border-line p-3 t-small text-subtle xl:block">
            {ownerName}
          </div>
        ) : null}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex h-14 items-center justify-between gap-3 border-b border-line bg-surface px-4">
          <span className="t-heading truncate sm:hidden">{displayName}</span>
          <div className="ml-auto flex items-center gap-2">
            <PresentToggle />
            <ThemeToggle />
          </div>
        </header>

        {/* Capped and centred. Unconstrained, a form on a 27-inch monitor
            renders two 800px-wide text inputs, and a table row's first and
            last cell end up a head-turn apart. The cap is generous because a
            wide worksheet genuinely wants the room; the forms narrow further
            themselves. */}
        {/* The bottom clearance is a MARGIN on the last box rather than
            padding on `main`.

            `main` is `flex-1` inside a column flex parent, so the flex
            algorithm decides its height and its content overflows it on a long
            page -- padding-bottom then sits above the overflow instead of
            below the last element, which is why 80px of it did nothing and the
            fixed tab bar covered the acceptance band's buttons entirely. They
            were not merely hard to hit: a hit test at their centre returned a
            nav link, so on a phone the button that wins a job could not be
            pressed at all.

            The margin is on a spacer sibling, which cannot be swallowed the
            same way, and it clears the bar plus the home-indicator inset. */}
        <main className="mx-auto min-w-0 w-full max-w-[100rem] flex-1">
          {children}
          <div
            aria-hidden
            className="no-print h-20 sm:hidden"
            style={{ height: 'calc(5rem + env(safe-area-inset-bottom))' }}
          />
        </main>

        {/* Bottom tabs are a second presentation of the same destinations, so
            they are marked presentational and hidden from the accessibility
            tree: the rail above is the one nav a screen reader announces. */}
        <nav
          aria-hidden
          className="no-print fixed inset-x-0 bottom-0 z-10 flex border-t border-line-strong bg-surface sm:hidden"
        >
          {BOTTOM_BAR.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname?.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                tabIndex={-1}
                className={`flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-2 ${
                  active ? 'text-accent-text' : 'text-muted'
                }`}
              >
                <Icon size={20} aria-hidden />
                <span className="t-micro">{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);

  return (
    <button
      type="button"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="flex min-h-11 min-w-11 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-ink"
      onClick={() => {
        const next = !dark;
        document.documentElement.classList.toggle('dark', next);
        try {
          localStorage.setItem('theme', next ? 'dark' : 'light');
        } catch {
          // Private browsing. The theme still applies for this page view.
        }
        setDark(next);
      }}
    >
      {dark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
    </button>
  );
}

/**
 * Present mode hides cost, margin, internal notes and rate codes.
 *
 * The reason is physical: he shows quotes on his own screen at the customer's
 * kitchen table, and without this, turning the laptop around shows the client
 * his cost. It persists per device, so the phone handed across the table stays
 * in Present mode.
 */
function PresentToggle() {
  const [present, setPresent] = useState(false);
  useEffect(
    () => setPresent(document.documentElement.getAttribute('data-present') === 'true'),
    [],
  );

  return (
    <button
      type="button"
      aria-pressed={present}
      className={`flex min-h-11 items-center gap-2 rounded-control px-3 t-small ${
        present ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-2 hover:text-ink'
      }`}
      onClick={() => {
        const next = !present;
        document.documentElement.setAttribute('data-present', String(next));
        try {
          localStorage.setItem('present', String(next));
        } catch {
          // Same as the theme: the state still applies for this page view.
        }
        setPresent(next);
      }}
    >
      {present ? 'Presenting' : 'Present'}
    </button>
  );
}
