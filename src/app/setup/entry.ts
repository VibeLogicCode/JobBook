import type { SetupGate } from '@/app/setup/state';
import { setupHref } from '@/app/setup/steps';

/**
 * Where `/` should send somebody instead of rendering, or null to render.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * The nine-step wizard was reachable only by typing `/setup` into the address
 * bar. Every `setupHref` call site was inside the wizard itself, and the one
 * navigation entry that looked like a way in -- labelled "Setup" -- pointed at
 * `/settings`, which then said "run first-run setup" without saying where. So
 * a fresh deployment showed "Setup required" and offered no next step, which
 * is the screen a customer's first five minutes consists of.
 *
 * A redirect rather than a link, because there is nothing else on that screen
 * to choose instead. The wizard already sits outside the permission guard --
 * it has to, since the owner's account is step six -- so this exposes no route
 * that was not already open.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES TO DO
 * ---------------------------------------------------------------------------
 *
 * A closed gate is never redirected, and each of the three reasons matters for
 * a different reason:
 *
 * - `complete`: setup is done. Every field stays editable under Settings.
 * - `live-tenant`: a company exists that this wizard did not create. Walking
 *   its owner into these forms would offer to replace his legal name, tax
 *   registration and holdback terms with whatever somebody typed.
 * - `unreachable`: the database did not answer. That must never read as
 *   "nobody has claimed this deployment yet" -- it is the same mistake in a
 *   different coat, and it is the one `readSetupGate` is built to refuse. `/`
 *   keeps failing the way it already fails, rather than acquiring a new and
 *   more alarming failure mode on a transient blip.
 */
export function firstRunDestination(gate: SetupGate): string | null {
  return gate.open ? setupHref(gate.resumeAt) : null;
}
