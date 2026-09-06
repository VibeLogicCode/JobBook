/**
 * The fixed ids behind `payment_methods`.
 *
 * Exactly the shape `project-lists.ts` documents for `PROJECT_TYPE_IDS` and
 * `LEAD_SOURCE_IDS`, applied to the enum migration 0019 promotes: these six
 * rows are written directly by that migration's SQL (which cannot import this
 * file, so the ids and names below are duplicated there, in literal form, and
 * must be kept in sync with it by hand). Every installation gets these rows
 * the moment it runs that migration -- there is no fresh-install gap for a
 * runtime "ensure" function to fill, which is why this file exports constants
 * rather than a seeding function the way `seed/vendor-lists.ts` does.
 *
 * What this file is actually FOR: giving the demo tenant and the automated
 * tests a stable id to point at, instead of a second copy of the old enum's
 * string values.
 */

export const PAYMENT_METHOD_IDS = {
  cash: 'c1a3e000-0000-4a00-9000-000000000001',
  debit: 'c1a3e000-0000-4a00-9000-000000000002',
  credit: 'c1a3e000-0000-4a00-9000-000000000003',
  cheque: 'c1a3e000-0000-4a00-9000-000000000004',
  etransfer: 'c1a3e000-0000-4a00-9000-000000000005',
  account: 'c1a3e000-0000-4a00-9000-000000000006',
} as const;

/**
 * The six rows, in the order migration 0019 inserts them.
 *
 * Only `account` carries `isOnAccount: true` -- see `db/schema/payment-methods.ts`
 * for what that flag means and why it is fixed once a row exists. Every other
 * method is an instrument that settles the moment it is used.
 */
export const DEFAULT_PAYMENT_METHODS: readonly {
  id: string;
  name: string;
  isOnAccount: boolean;
  sortOrder: number;
}[] = [
  { id: PAYMENT_METHOD_IDS.cash, name: 'Cash', isOnAccount: false, sortOrder: 10 },
  { id: PAYMENT_METHOD_IDS.debit, name: 'Debit', isOnAccount: false, sortOrder: 20 },
  { id: PAYMENT_METHOD_IDS.credit, name: 'Credit card', isOnAccount: false, sortOrder: 30 },
  { id: PAYMENT_METHOD_IDS.cheque, name: 'Cheque', isOnAccount: false, sortOrder: 40 },
  { id: PAYMENT_METHOD_IDS.etransfer, name: 'Transfer', isOnAccount: false, sortOrder: 50 },
  {
    id: PAYMENT_METHOD_IDS.account,
    name: 'On account',
    isOnAccount: true,
    sortOrder: 60,
  },
];
