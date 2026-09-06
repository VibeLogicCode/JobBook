'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  href: string;
  label: string;
  /** One line saying what the section decides, read before it is opened. */
  summary: string;
}

/** One heading's worth of sections -- see `app/settings/nav.ts` for the three. */
export interface NavGroup {
  heading: string;
  items: NavItem[];
}

/**
 * The settings section list, grouped under headings.
 *
 * One tree, reflowed by CSS: a horizontal scroller of tabs below `sm`, a
 * vertical list above it, grouped there under a heading per `NavGroup` --
 * matching the data table's own ruling for the same reason, one node per
 * query at every width.
 *
 * The mobile scroller drops the headings rather than repeating one per
 * group: a heading has no row of its own to sit in among a strip of tabs,
 * and every section is still exactly as many taps away as it always was --
 * grouping is a sighted, vertical-list affordance, not a second navigation.
 */
export function SettingsNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();

  const isActive = (href: string) => pathname === href || pathname?.startsWith(`${href}/`);

  const link = (item: NavItem) => (
    <li key={item.href} className="shrink-0 sm:shrink">
      <Link
        href={item.href}
        aria-current={isActive(item.href) ? 'page' : undefined}
        title={item.summary}
        className={`flex min-h-11 items-center whitespace-nowrap rounded-control px-3 t-small ${
          isActive(item.href)
            ? 'bg-accent-soft font-semibold text-accent-soft-fg'
            : 'text-muted hover:bg-surface-2 hover:text-ink'
        }`}
      >
        {item.label}
      </Link>
    </li>
  );

  return (
    <nav aria-label="Settings sections" className="min-w-0">
      <ul className="flex gap-1 overflow-x-auto pb-1 sm:hidden">
        {groups.flatMap((group) => group.items.map(link))}
      </ul>

      <div className="hidden sm:flex sm:flex-col sm:gap-4">
        {groups.map((group) => (
          <div key={group.heading}>
            <p className="mb-1 px-3 t-small font-semibold text-subtle">{group.heading}</p>
            <ul className="flex flex-col">{group.items.map(link)}</ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
