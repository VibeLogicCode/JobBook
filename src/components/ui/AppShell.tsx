'use client';

import Link from 'next/link';
import { SaveBanner } from '@/components/ui/SaveBanner';
import { usePathname } from 'next/navigation';
import { Menu, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BOTTOM_BAR, DESTINATIONS, OVERFLOW } from '@/components/ui/destinations';
import { Sheet } from '@/components/ui/Sheet';

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
          {/* Mounted once, listening at the document, so a save made anywhere
              -- including inside a sheet that is closing as it fires -- has
              somewhere to be said. */}
          <SaveBanner />
          {children}
          <div
            aria-hidden
            className="no-print h-20 sm:hidden"
            style={{ height: 'calc(5rem + env(safe-area-inset-bottom))' }}
          />
        </main>

        <BottomBar pathname={pathname ?? ''} />
      </div>
    </div>
  );
}

/**
 * The phone navigation.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS AN OVERFLOW AT ALL
 * ---------------------------------------------------------------------------
 *
 * There was not, and the consequence was not cosmetic. The bar rendered
 * `DESTINATIONS.slice(0, 5)` and nothing carried the remaining six, while the
 * rail said to carry "all of them" -- true at `sm` and above, where it is
 * `flex`, and false below it, where it is `hidden`. So People, Rates, Vendors,
 * Expenses, Templates and Settings had no entry point on a phone whatsoever.
 * Not clipped, not scrolled past: absent. The owner found it while trying to
 * reach setup from one, which is also the screen he most needed.
 *
 * A sheet rather than a horizontally scrolling bar. Tabs that run off the edge
 * are invisible with no affordance saying so, which is the same failure in a
 * new coat -- somebody who does not know Templates exists will not swipe a nav
 * bar looking for it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NO LONGER `aria-hidden`
 * ---------------------------------------------------------------------------
 *
 * It was, on the reasoning that the rail above is the one nav a screen reader
 * announces. That reasoning holds only while the rail is in the tree, and
 * below `sm` it is `display: none`, which takes it out of the tree along with
 * the layout. Between the two, a phone had no announced navigation at all, and
 * `tabIndex={-1}` meant no keyboard path either. Now each is labelled
 * distinctly and exactly one is ever rendered, since each hides at the width
 * the other appears.
 */
function BottomBar({ pathname }: { pathname: string }) {
  const [more, setMore] = useState(false);
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  // Whether the thing the person is currently looking at lives behind the
  // button. Without this the bar shows nothing highlighted on six of eleven
  // screens, which reads as "you are nowhere".
  const inOverflow = OVERFLOW.some((entry) => isActive(entry.href));

  const seat =
    'flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-2 t-micro';

  return (
    <>
      <nav
        aria-label="Main, compact"
        className="no-print fixed inset-x-0 bottom-0 z-10 flex border-t border-line-strong bg-surface sm:hidden"
      >
        {BOTTOM_BAR.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(href) ? 'page' : undefined}
            className={`${seat} ${isActive(href) ? 'text-accent-text' : 'text-muted'}`}
          >
            <Icon size={20} aria-hidden />
            <span>{label}</span>
          </Link>
        ))}

        {OVERFLOW.length > 0 ? (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={more}
            onClick={() => setMore(true)}
            className={`${seat} ${inOverflow ? 'text-accent-text' : 'text-muted'}`}
          >
            <Menu size={20} aria-hidden />
            <span>More</span>
          </button>
        ) : null}
      </nav>

      {more ? (
        <Sheet label="More screens" title="More" onClose={() => setMore(false)}>
          <ul className="flex flex-col gap-1 pb-2">
            {OVERFLOW.map(({ href, label, icon: Icon }) => (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={isActive(href) ? 'page' : undefined}
                  // Closed on the way out rather than left to the route change:
                  // a sheet that survives the navigation covers the screen it
                  // just opened.
                  onClick={() => setMore(false)}
                  className={`flex min-h-12 items-center gap-3 rounded-control px-3 ${
                    isActive(href)
                      ? 'bg-accent-soft text-accent-soft-fg'
                      : 'text-ink hover:bg-surface-2'
                  }`}
                >
                  <Icon size={18} aria-hidden />
                  <span>{label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Sheet>
      ) : null}
    </>
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
