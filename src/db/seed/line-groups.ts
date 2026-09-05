import { db } from '@/db/client';
import { lineGroups } from '@/db/schema';

/**
 * The line groups a fresh install starts with.
 *
 * Here rather than in the migration, for the reason `seed/vendor-lists.ts`
 * gives for its own two lists: `tests/ops/white-label.test.ts` only exempts
 * this directory, so a specific list written into a migration or a screen
 * ships to every other company that buys the product. Every name below is a
 * generic construction phase, not a tenant's own vocabulary, and every row is
 * an ordinary record the owner can rename, reorder, retire or void.
 *
 * The eleven are the values already typed, free text, into `line_group` on
 * existing scope template items, quote lines and invoice lines. Seeding
 * exactly those and no others is what lets this table go live under a
 * deployment that already has quotes without a single heading failing to
 * match anything on the new list. The order is the build-and-print order
 * those documents already read in, not alphabetical, for the same reason
 * `DEFAULT_TRADES` is ordered that way: a list somebody reads while deciding
 * what to call a section reads better in the order it prints.
 *
 * Ids are fixed so that loading this twice is a no-op and so that a row the
 * owner has already edited, retired or voided is never quietly restored to
 * the shipped wording on the next boot.
 */
export interface DefaultLineGroup {
  id: string;
  name: string;
  sortOrder: number;
}

export const DEFAULT_LINE_GROUPS: readonly DefaultLineGroup[] = [
  { id: 'b4d1e6a0-0000-4a00-9000-000000000001', name: 'General', sortOrder: 10 },
  { id: 'b4d1e6a0-0000-4a00-9000-000000000002', name: 'Demolition', sortOrder: 20 },
  { id: 'b4d1e6a0-0000-4a00-9000-000000000003', name: 'Framing', sortOrder: 30 },
  { id: 'b4d1e6a0-0000-4a00-9000-000000000004', name: 'Drywall', sortOrder: 40 },
  { id: 'b4d1e6a0-0000-4a00-9000-000000000005', name: 'Electrical', sortOrder: 50 },
  { id: 'b4d1e6a0-0000-4a00-9000-000000000006', name: 'Plumbing', sortOrder: 60 },
  { id: 'b4d1e6a0-0000-4a00-9000-000000000007', name: 'Concrete', sortOrder: 70 },
  { id: 'b4d1e6a0-0000-4a00-9000-000000000008', name: 'Flooring', sortOrder: 80 },
  { id: 'b4d1e6a0-0000-4a00-9000-000000000009', name: 'Finishing', sortOrder: 90 },
  { id: 'b4d1e6a0-0000-4a00-9000-00000000000a', name: 'Overhead', sortOrder: 100 },
  { id: 'b4d1e6a0-0000-4a00-9000-00000000000b', name: 'Available upgrades', sortOrder: 110 },
];

/**
 * Loads the list, idempotently. Safe to call on every render of the screen
 * that reads it -- a row whose id, or whose name, is already present is left
 * exactly as it is.
 */
export async function seedLineGroups(): Promise<void> {
  await db
    .insert(lineGroups)
    .values(
      DEFAULT_LINE_GROUPS.map((group) => ({
        id: group.id,
        name: group.name,
        sortOrder: group.sortOrder,
        isActive: true,
      })),
    )
    .onConflictDoNothing();
}

/**
 * The same thing, run once per process -- see `ensureVendorLists` for why
 * this lives beside the screen rather than only in `scripts/seed.ts`: the demo
 * seed does not run on a real installation, and an installation that reached
 * this screen with an empty list would be an installation where every line
 * group has to be typed in by hand before the first one can be reused.
 */
let pending: Promise<void> | null = null;

export function ensureLineGroups(): Promise<void> {
  pending ??= seedLineGroups().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}
