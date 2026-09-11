import type { NavGroup } from '@/components/settings/SettingsNav';

/**
 * The settings sections, grouped under three headings -- the owner's own
 * words for what was becoming a flat list of thirteen, soon to be fifteen:
 * *"settings is getting crowded with trade types, tax rates, cost codes, line
 * groups — should we group them under something?"*
 *
 * Three groups, not a hub page and not new routes -- every section keeps its
 * own URL, and grouping is a heading in the sidebar (`SettingsNav`) and a
 * heading above the same cards on `/settings` (`page.tsx` reads this same
 * array, so the two cannot disagree about which section is in which group).
 *
 * - **The company** -- who it is, how to reach it, where it is, what it owes,
 *   what it prints. Facts about the company itself, changed rarely.
 * - **Lists** -- every taxonomy a working screen is built against: rates,
 *   codes, types, trades, groups, project types, lead sources, payment
 *   methods. Tax rates moves here from "the company" for the reason financial
 *   and legal keeps the tax REGISTRATION number and not the rate table: a
 *   registration number is a fact about the company, and a rate is a row you
 *   add to, exactly like a cost code or a trade.
 * - **Access and automation** -- who may touch any of it, and the one setting
 *   that writes rows on its own rather than merely deciding what a document
 *   says.
 *
 * Project types, lead sources and payment methods land at the end of Lists
 * rather than reshuffling the taxonomies already there, for the same reason
 * line groups did: the order among a run of lists means nothing, and a picker
 * somebody hunts a list for looks in the run, not at its position within it.
 */
export const SETTINGS_GROUPS: NavGroup[] = [
  {
    heading: 'The company',
    items: [
      {
        href: '/settings/identity',
        label: 'Identity and branding',
        summary: 'The names, the owner, and the accent colour every document carries.',
      },
      {
        /**
         * First in the group, and listed even on a one-company install.
         *
         * Not hidden until a second company exists, unlike every OTHER
         * appearance of the concept: this is the one screen whose job is to
         * explain what a second company would mean and to be findable by
         * somebody who has just been asked the question by an accountant. A
         * feature nobody can find is a feature nobody knows they declined.
         *
         * Its own summary says most businesses have one, so a reader who does
         * not need it can stop there.
         */
        href: '/settings/companies',
        label: 'Companies',
        summary: 'Which legal company issues a job. Most businesses have one.',
      },
      {
        /**
         * Directly after Companies, because it is the same question one level
         * down: which legal company, then what that company does. It also has
         * to be FINDABLE by somebody who answered it wrong at first run --
         * the wizard promises this field is changeable afterwards, and for a
         * while it was not changeable anywhere.
         */
        href: '/settings/work',
        label: 'The kind of work',
        summary: 'Service work, contract work or both. Decides which job types and fields you get.',
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
    ],
  },
  {
    heading: 'Lists',
    items: [
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
        /**
         * First in Lists, because it is how the other lists get populated --
         * and because it answers a question the wizard leaves an owner with:
         * the trade is asked once, by a screen that then closes for good.
         */
        href: '/settings/starter-lists',
        label: 'Starter lists',
        summary: 'Add another trade’s job types, cost codes, rate book and templates. Adds only.',
      },
      {
        /**
         * With the lists rather than under The company, because it is content
         * the owner maintains and taps from, exactly like line groups -- and
         * because it is per DEPLOYMENT, not per company: `quote_clauses` has
         * no company column, and an exclusion about permit fees is not a fact
         * about which corporation issued the paper.
         */
        href: '/settings/clauses',
        label: 'Not included, and assumed',
        summary: 'The sentences you put on nearly every quote about what the price does not cover.',
      },
      {
        href: '/settings/line-groups',
        label: 'Line groups',
        summary: 'The section heading a quote prints. Retiring one never touches what already printed.',
      },
      {
        href: '/settings/project-types',
        label: 'Project types',
        summary: 'What kind of work a job is. Retiring one never blanks the job that has it.',
      },
      {
        href: '/settings/lead-sources',
        label: 'Lead sources',
        summary: 'How a customer found you. Retiring one never blanks the customer who has it.',
      },
      {
        href: '/settings/payment-methods',
        label: 'Payment methods',
        summary: 'How money leaves. One of them means the money has not left yet.',
      },
    ],
  },
  {
    heading: 'Access and automation',
    items: [
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
        href: '/settings/backup',
        label: 'Backups',
        summary:
          'The key every backup is encrypted to. Generated here, and the private half is shown once.',
      },
      {
        href: '/settings/sync',
        label: 'SharePoint mirror',
        summary: 'Optional, off by default, one-way, and not a restore path.',
      },
    ],
  },
];

/** The flat list, for anything that genuinely has no use for the grouping. */
export const SETTINGS_SECTIONS = SETTINGS_GROUPS.flatMap((group) => group.items);
