import type { NavItem } from '@/components/settings/SettingsNav';

/**
 * The sections, in the order the owner meets them: who the company is, how to
 * reach it, where it is in the world, what it owes, what it prints, what it
 * charges, and who may touch any of it.
 */
export const SETTINGS_SECTIONS: NavItem[] = [
  {
    href: '/settings/identity',
    label: 'Identity and branding',
    summary: 'The names, the owner, and the accent colour every document carries.',
  },
  {
    href: '/settings/contact',
    label: 'Contact',
    summary: 'The address and contact block printed on quotes.',
  },
  {
    href: '/settings/locale',
    label: 'Locale',
    summary: 'Currency, language, timezone and area unit.',
  },
  {
    href: '/settings/financial',
    label: 'Financial and legal',
    summary: 'Tax registration, fiscal year, holdback, payment terms, target margin.',
  },
  {
    href: '/settings/documents',
    label: 'Documents',
    summary: 'Validity, terms and footer text.',
  },
  {
    href: '/settings/tax-rates',
    label: 'Tax rates',
    summary: 'Effective-dated rates. Editing one supersedes it, never overwrites it.',
  },
  {
    href: '/settings/users',
    label: 'Users',
    summary: 'Who has an account, and what their role permits.',
  },
  {
    href: '/settings/sync',
    label: 'SharePoint mirror',
    summary: 'Optional, off by default, one-way, and not a restore path.',
  },
];
