import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { type ActionResult, refused } from '@/app/settings/result';
import {
  type ClosedGate,
  type Executor,
  type OpenGate,
  markStepComplete,
  readSetupGate,
  stepIsReachable,
} from '@/app/setup/state';
import { type SetupStepSlug, stepAt } from '@/app/setup/steps';

/**
 * The gate every setup step writes through.
 *
 * This lives in its own module, deliberately not marked `'use server'`, for a
 * reason that is easy to get wrong: in a `'use server'` file EVERY export
 * becomes a callable action endpoint. Exporting the gate from the module that
 * holds the actions would publish the gate itself as something a client can
 * POST to. So the actions import it from here instead.
 *
 * It used to exist twice -- once in `actions.ts` and once, hand-copied, in
 * `access/actions.ts`. Two copies of an authorization check is the one
 * duplication worth going out of the way to remove: they drift, and the drift
 * is silent, because fixing the copy you are looking at leaves the other one
 * admitting writes it should refuse.
 */

function gateRefusal(gate: ClosedGate): ActionResult {
  if (gate.reason === 'unreachable') {
    return refused(`Nothing was saved: the database did not answer. ${gate.detail}`);
  }
  return refused(
    `${gate.detail} This wizard writes nothing once a company exists, because the only thing ` +
      'it could do to a live one is overwrite it.',
  );
}

/**
 * The guard and the write, in one transaction.
 *
 * The gate is re-read INSIDE the transaction rather than before it. Read
 * outside, two requests could both see an unclaimed database and both believe
 * the tenant was theirs to create; read inside, the second one sees the first
 * one's claim.
 *
 * This is also what closes the wizard to a live deployment. Once a company
 * exists the gate is shut, and a step re-submitted afterwards -- by a stale
 * tab, or by a POST straight at the action -- is refused here rather than
 * silently overwriting a tenant's own legal name and tax registration.
 */
export async function persistStep(
  slug: SetupStepSlug,
  write: (tx: Executor, gate: OpenGate) => Promise<ActionResult>,
  /** True on the final step, which closes the wizard for good. */
  closesSetup = false,
): Promise<ActionResult> {
  const result = await db.transaction(async (tx) => {
    const gate = await readSetupGate(tx);
    if (!gate.open) return gateRefusal(gate);

    if (!stepIsReachable(gate, slug)) {
      const waiting = stepAt(gate.resumeAt);
      return refused(
        `The ${waiting.title.toLowerCase()} step has not been completed yet, and each step ` +
          'builds on the one before it. Nothing was saved.',
      );
    }

    const written = await write(tx, gate);
    if (written.ok) {
      await markStepComplete(tx, slug, closesSetup ? 'complete' : 'in_progress');
    }
    return written;
  });

  if (result.ok) {
    // The root layout reads the organization row for the tab title, the shell
    // heading and the accent colour, so a step that names the company has to
    // invalidate the layout and not only this route. The access step needs the
    // same call for a different reason: the environment report on the next
    // step reads the file it just wrote.
    revalidatePath('/', 'layout');
  }
  return result;
}
