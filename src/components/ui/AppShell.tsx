'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ClipboardList, FileText, Home, LayoutTemplate, Moon, Ruler, Settings, Sun, Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';

const DESTINATIONS = [
  { href: '/', label: 'Today', icon: Home },
  { href: '/quotes', label: 'Quotes', icon: FileText },
  { href: '/projects', label: 'Jobs', icon: ClipboardList },
  { href: '/customers', label: 'People', icon: Users },
  { href: '/rates', label: 'Rates', icon: Ruler },
  { href: '/templates', label: 'Templates', icon: LayoutTemplate },
  { href: '/settings', label: 'Setup', icon: Settings },
];

/**
 * The bottom bar carries five, per the UI spec's breakpoint table; the rail
 * carries all of them.
 *
 * Templates and Setup are the two that lose the seat. Both are things a person
 * does at a desk while configuring the system, not on a phone at a job site,
 * which is what a bottom tab bar is for.
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
                  className={`flex min-h-11 items-center gap-3 rounded-[4px] px-3 ${
                    active
                      ? 'bg-accent-soft text-accent-soft-fg'
                      : 'text-muted hover:bg-surface-2 hover:text-ink'
                  }`}
                >
                  <Icon size={18} aria-hidden />
                  <span className="hidden xl:inline">{label}</span>
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

        <main className="min-w-0 flex-1 pb-20 sm:pb-0">{children}</main>

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
      className="flex min-h-11 min-w-11 items-center justify-center rounded-[4px] text-muted hover:bg-surface-2 hover:text-ink"
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
      className={`flex min-h-11 items-center gap-2 rounded-[4px] px-3 t-small ${
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
