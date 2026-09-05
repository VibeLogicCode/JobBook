import type { NavItem } from '@/components/settings/SettingsNav';

/**
 * The sections, in the order the owner meets them: who the company is, how to
 * reach it, where it is in the world, what it owes, what it prints, what it
 * charges, how it categorises what it spends, and who may touch any of it.
 *
 * Cost codes sit here rather than beside the rate list because the two are
 * different kinds of thing on the same subject. The rate list is worked on --
 * a supplier moves a price and an item changes that afternoon. The cost code
 * list is a decision about how this company reports itself, made once, changed
 * rarely, and read by every job for years afterwards. That is the same shape
 * as the tax rates and the users already on this nav, and it is why the entry
 * sits directly under Tax rates.
 *
 * Vendor types and trades sit immediately after it, in that order, because
 * they are the same kind of thing -- taxonomies the working screens are built
 * against -- and because the second is only meaningful in terms of the first:
 * a trade is asked of a vendor only when its TYPE says the vendor performs
 * work. Reading them the other way round is reading the answer before the
 * question.
 *
 * Reminder rules sit last of the lists, immediately before Users, because they
 * are the only setting in this area that WRITES rows on its own. Everything
 * above decides what a document says when somebody makes one; this decides
 * what the machine puts in front of him at seven on a Tuesday whether he asked
 * or not. It is the entry an owner comes looking for when the list has started
 * making noise, which is the only moment anybody opens it.
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
    href: '/settings/cost-codes',
    label: 'Cost codes',
    summary: 'How spend is categorised. Retiring one is not voiding it, and nothing is deleted.',
  },
  {
    href: '/settings/vendor-types',
    label: 'Vendor types',
    summary: 'What kind of counterparty a vendor is, and which kinds count as subcontractors.',
  },
  {
    href: '/settings/trades',
    label: 'Trades',
    summary: 'What kind of subcontractor somebody is. Retiring one never blanks the sub who has it.',
  },
  {
    href: '/settings/reminder-rules',
    label: 'Reminder rules',
    summary: 'What the hourly job decides to chase you about. Off is not gone, and never was.',
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
