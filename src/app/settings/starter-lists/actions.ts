'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues } from '@/app/settings/validate';
import { addStarterPack } from '@/db/seed/packs/load';
import { TRADE_LABELS, TRADES, type Trade } from '@/db/seed/packs/types';
import { primaryOf, readCompanies } from '@/lib/company/load';
import { offersContract, offersService, postureOf } from '@/lib/posture/read';

/**
 * Adds a trade's starter lists to a deployment that is already running.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SAFE, STATED PRECISELY
 * ---------------------------------------------------------------------------
 *
 * Every row `addStarterPack` writes is an `onConflictDoNothing` insert on a
 * fixed id, and it does not retire anything or rewrite the flags on a job type
 * that already exists -- see its docblock for the split between this and the
 * wizard's `loadPack`. So the worst this button can do is add rows the owner
 * then retires, which is the same cost as a mistake on any other list screen.
 *
 * What it CANNOT do is change a price, a job type's paperwork rules, or
 * anything on a document already issued. That is why it needs no confirmation
 * dialogue beyond the count the screen shows before it is pressed.
 *
 * `rates:edit`, the capability that already governs the rate book and the cost
 * codes this writes into.
 */

const schema = z.object({
  trade: z.enum(TRADES as readonly [Trade, ...Trade[]], { message: 'is not a trade' }),
});

const REFUSAL = 'Your role does not permit adding starter lists.';

export async function addStarterLists(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = schema.safeParse(formValues(formData));
  if (!parsed.success) return refused('That is not one of the trades.');
  const { trade } = parsed.data;

  /**
   * The posture decides the paperwork flags on the job types this adds --
   * holdback, draws, a schedule, measurements -- exactly as it does at first
   * run. Only for types that do not already exist; an existing one keeps
   * whatever it has.
   *
   * `primaryOf` returns null when two companies are active and they disagree,
   * and `postureOf` reads that as `both`: the fuller set of forms. Failing
   * open, the same direction every other posture reader takes, because the
   * dangerous mistake is a holdback missing from a job that agreed to one.
   */
  const posture = postureOf(primaryOf(await readCompanies()));

  try {
    await db.transaction(async (tx) => {
      await addStarterPack(tx, trade, posture);
    });
  } catch {
    return refused('Those lists could not be added. Nothing was written.');
  }

  // Every screen this could have written to.
  for (const path of [
    '/settings/starter-lists',
    '/settings/project-types',
    '/settings/cost-codes',
    '/settings/line-groups',
    '/settings/trades',
    '/settings/clauses',
    '/templates',
  ]) {
    revalidatePath(path);
  }

  const kinds = offersContract(posture) && offersService(posture) ? '' : ' for your kind of work';
  return saved(
    `${TRADE_LABELS[trade]} lists added${kinds}. Nothing you already had was changed or removed.`,
  );
}
