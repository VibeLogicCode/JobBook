import { ELECTRICAL_PACK } from '@/db/seed/packs/electrical';
import { GENERAL_PACK, NONE_PACK } from '@/db/seed/packs/general';
import { HVAC_PACK } from '@/db/seed/packs/hvac';
import { PLUMBING_PACK } from '@/db/seed/packs/plumbing';
import type { Trade, TradePack } from '@/db/seed/packs/types';

/**
 * Every pack, by trade.
 *
 * A `Record` over the `Trade` union rather than a lookup that can miss, so
 * adding a trade to the union without writing its pack does not compile. That
 * matters more than it looks: `loadPack` runs inside the wizard's transaction,
 * and a missing pack there would be a first-run crash on somebody's NAS.
 *
 * Four trades and a plain start, deliberately. Landscaping, roofing, painting
 * and drywall are the obvious next four and are excluded: each pack wants
 * somebody who does that trade to read it, and four lists nobody has checked
 * is worse than two that have been.
 */
export const PACKS: Record<Trade, TradePack> = {
  general: GENERAL_PACK,
  electrical: ELECTRICAL_PACK,
  plumbing: PLUMBING_PACK,
  hvac: HVAC_PACK,
  none: NONE_PACK,
};
