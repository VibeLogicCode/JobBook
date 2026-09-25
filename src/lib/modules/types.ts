/**
 * The parts of the product a deployment can switch off.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE, AND WHY
 * ---------------------------------------------------------------------------
 *
 * Today, Quotes, Invoices, People, Rates and Settings. Those six are the
 * product: a quote is priced from the rate book, addressed to a person, and
 * billed by an invoice. Switch any of them off and what is left cannot do the
 * one job the software is for, so they are not offered as choices — a setting
 * that can break the product is a support call waiting to happen.
 *
 * Rates in particular looks optional and is not: the starter packs ship a rate
 * book with no prices in it, so hiding the screen that prices it would strand
 * a new install on its first quote.
 *
 * Reminders IS here, even though follow-up matters, because the engine keeps
 * running when the screen is hidden and Today still shows what is outstanding.
 * Nothing stops happening; one destination stops being offered.
 */
export type ModuleKey = 'pipeline' | 'calendar' | 'expenses' | 'vendors' | 'templates' | 'reminders';

export const MODULES: readonly ModuleKey[] = [
  'pipeline',
  'calendar',
  'expenses',
  'vendors',
  'templates',
  'reminders',
];

export const MODULE_LABELS: Record<ModuleKey, string> = {
  pipeline: 'Pipeline',
  calendar: 'Calendar and schedule',
  expenses: 'Expenses',
  vendors: 'Vendors and subcontractors',
  templates: 'Templates',
  reminders: 'Reminders',
};

/** What the owner loses by switching it off, in his own terms. */
export const MODULE_SUMMARIES: Record<ModuleKey, string> = {
  pipeline: 'The board and list of jobs, by stage. Quotes and invoices still name the job they belong to.',
  calendar: 'Scheduled tasks by day, week and month, and who is on them.',
  expenses: 'What a job cost: receipts, mileage, and what is left against the quote.',
  vendors: 'Suppliers and subcontractors, their trades and their insurance dates.',
  templates: 'Saved line lists a quote is built from, and schedule templates.',
  reminders: 'The follow-up screen. The rules keep running either way, and Today still shows what is due.',
};

export type ModuleState = Record<ModuleKey, boolean>;

/**
 * Everything on, which is what every deployment before this feature had.
 *
 * Named rather than written inline, because "today's behaviour" is the thing
 * the column defaults, the fail-open reader and the wizard's "everything"
 * answer all have to agree about — and three copies is three chances for one
 * to drift.
 */
export const ALL_MODULES_ON: ModuleState = {
  pipeline: true,
  calendar: true,
  expenses: true,
  vendors: true,
  templates: true,
  reminders: true,
};

/**
 * What a deployment that wants a quote-and-invoice tool starts with.
 *
 * Everything off. The six core screens are not in this list at all, so what
 * remains is Today, Quotes, Invoices, People, Rates and Settings — which is
 * the whole of the request: price the work, send it, bill it.
 */
export const QUOTES_AND_INVOICES_ONLY: ModuleState = {
  pipeline: false,
  calendar: false,
  expenses: false,
  vendors: false,
  templates: false,
  reminders: false,
};

/** The column on `organization` that stores each one. */
export const MODULE_COLUMNS: Record<ModuleKey, string> = {
  pipeline: 'modulePipeline',
  calendar: 'moduleCalendar',
  expenses: 'moduleExpenses',
  vendors: 'moduleVendors',
  templates: 'moduleTemplates',
  reminders: 'moduleReminders',
};
