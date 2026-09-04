import { can, type Role } from '@/app/settings/actor';

/**
 * What this screen shows when the person reading it may not change anything.
 *
 * The capability itself is no longer here. It was, while `actor.ts` had no
 * `sync.*` entry and this area owned the sync screen but not that file; the
 * entry now exists, so the guard is the same `requireCapability('sync.configure')`
 * every other settings action calls, and a second module for one mapping would
 * be a second place for the answer to drift.
 */

/** Owner only, per the section 10.2 matrix. */
export function canSync(role: Role): boolean {
  return can(role, 'sync.configure');
}

/**
 * The sentence a read-only screen shows in place of a save button. It names
 * the role, because "you cannot do this" without saying who you are reads as a
 * bug more often than as a permission.
 */
export const OWNER_ONLY =
  'Configuring the SharePoint mirror is reserved to an owner: it decides whether this ' +
  "company's records leave this machine.";
