'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  href: string;
  label: string;
  /** One line saying what the section decides, read before it is opened. */
  summary: string;
}

/**
 * The settings section list.
 *
 * One tree, reflowed by CSS: a horizontal scroller of tabs below `sm`, a
 * vertical list above it. Branching to a separate mobile nav would put every
 * one of these links in the document twice, which is the ruling the data table
 * follows for the same reason -- one node per query, at every width.
 */
export function SettingsNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings sections" className="min-w-0">
      <ul className="flex gap-1 overflow-x-auto pb-1 sm:flex-col sm:overflow-x-visible sm:pb-0">
        {items.map((item) => {
          const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <li key={item.href} className="shrink-0 sm:shrink">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                title={item.summary}
                className={`flex min-h-11 items-center whitespace-nowrap rounded-[4px] px-3 t-small ${
                  active
                    ? 'bg-accent-soft font-semibold text-accent-soft-fg'
                    : 'text-muted hover:bg-surface-2 hover:text-ink'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
