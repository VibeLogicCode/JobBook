import { ELECTRICAL_PACK } from '@/db/seed/packs/electrical';
import { GENERAL_PACK, NONE_PACK } from '@/db/seed/packs/general';
import { HVAC_PACK } from '@/db/seed/packs/hvac';
import { MACHINING_PACK } from '@/db/seed/packs/machining';
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
 * FIVE trades and a plain start. Landscaping, roofing, painting and drywall
 * are still excluded, and the reason stands: each pack wants somebody who does
 * that trade to read it, and four lists nobody has checked is worse than two
 * that have been.
 *
 * `machining` is not a sixth construction trade, which is why it is here and
 * they are not. A machine shop quote has a different shape -- setup charged
 * once, run time per piece, material by weight, outside processing by the lot
 * -- and it is the shape that was worth proving the engine can carry. It also
 * needs holdback and the Construction Act dates OFF on every job type, since
 * selling a part is not an improvement to land; `machining.ts` says so in
 * full.
 */
export const PACKS: Record<Trade, TradePack> = {
  general: GENERAL_PACK,
  electrical: ELECTRICAL_PACK,
  plumbing: PLUMBING_PACK,
  hvac: HVAC_PACK,
  machining: MACHINING_PACK,
  none: NONE_PACK,
};
