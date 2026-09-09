import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { settings } from '@/db/schema';
import type { Trade } from '@/db/seed/packs/types';

/**
 * Which trade pack a deployment loaded.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE
 * ---------------------------------------------------------------------------
 *
 * To break a circular import, and the cycle is worth understanding because it
 * is inherent to the feature rather than accidental:
 *
 *   `seed/vendor-lists.ts` must ASK whether a pack was loaded, so it can stand
 *   down instead of appending twelve general-contracting trades over an
 *   electrician's five.
 *
 *   `seed/packs/general.ts` must READ `DEFAULT_TRADES` from that same file,
 *   because the general pack IS those twelve trades and a second copy of them
 *   would drift the first time somebody edited one.
 *
 * Both directions are right. So the marker -- which has nothing to do with
 * pack CONTENTS -- lives here, importing only the client and the settings
 * table. `packs/load.ts` imports this; the lazy seeds import this and never
 * the registry.
 *
 * The build error this fixes was `ReferenceError: Cannot access 'f' before
 * initialization` while collecting `/vendors`, which is what a module cycle
 * looks like after bundling: no import is named and no file is blamed.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A FEATURE FLAG
 * ---------------------------------------------------------------------------
 *
 * No screen behaves differently because of the trade, and none should -- the
 * same electrician does service calls and full rewires. This row exists so two
 * lazy seeds know their lists are already supplied, and is read by nothing
 * else.
 */
export const PACK_LOADED_KEY = 'setup.pack';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function loadedPack(executor: Executor = db): Promise<Trade | null> {
  const [row] = await executor
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, PACK_LOADED_KEY));
  return (row?.value ?? null) as Trade | null;
}

/**
 * Whether the lazy general-contracting seeds should stand down.
 *
 * True once ANY pack has been loaded, `none` included: somebody who chose to
 * start empty said so, and appending to his list would be overruling him.
 * `general` counts too and needs no special case -- its pack ships those same
 * rows with those same fixed ids, so the seed would be a no-op anyway. Reading
 * the marker rather than comparing against `'general'` keeps that a detail of
 * the pack instead of a rule here.
 */
export async function packHasSeededLists(executor: Executor = db): Promise<boolean> {
  return (await loadedPack(executor)) !== null;
}
