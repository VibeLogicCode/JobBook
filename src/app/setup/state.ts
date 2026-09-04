import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organization, settings } from '@/db/schema';
import {
  FIRST_STEP,
  SETUP_STEP_SLUGS,
  type SetupStepSlug,
  stepIndex,
} from '@/app/setup/steps';

/**
 * Whether first-run setup may still run, and how far it got.
 *
 * ---------------------------------------------------------------------------
 * This is the only thing standing between a live company's details and a form
 * that overwrites them, so it is written once, here, and every page and every
 * action in this area reads it before doing anything else.
 * ---------------------------------------------------------------------------
 *
 * The obvious rule -- "the wizard runs while the `organization` row is
 * missing" -- cannot be the whole rule, because step 1 INSERTS that row.
 * Under it, steps 2 to 7 would be locked out of the row they exist to fill in,
 * and a browser crash at step 5 would leave a half-configured tenant with no
 * way back in except SQL, which is precisely what white-labelling is supposed
 * to remove (design section 8.6).
 *
 * So completion is a marker in `settings`, and the marker is also a CLAIM on
 * the row:
 *
 * - No organization row and no marker: a fresh deployment. The wizard runs,
 *   and step 1 writes the row and the claim in one transaction.
 * - An organization row the wizard still holds the claim on: a setup somebody
 *   walked away from. It resumes.
 * - An organization row with no claim, or a claim already marked complete: a
 *   live tenant. The wizard refuses. This is the demo seed, a restored backup,
 *   and every finished installation -- none of which this screen may touch.
 *
 * `settings` is the right home for it: key/value machine state, not mirrored
 * to SharePoint, and absence is the off state, so no defaulted column can
 * declare a deployment set up that never was.
 */

/** The claim, and the completion flag, in one row. */
export const SETUP_STATE_KEY = 'setup.state';

/** One row per finished step, so progress survives a crash without parsing a list. */
export const stepMarkerKey = (slug: SetupStepSlug) => `setup.step.${slug}`;

/**
 * Identities the wizard created, so re-submitting a step corrects the row it
 * made rather than adding a second one. Without these, walking back to fix a
 * typo in the tax rate would leave two rates in force on the same day, and
 * fixing the owner's email address would leave two owners.
 */
export const TAX_RATE_ID_KEY = 'setup.first_tax_rate_id';
export const OWNER_USER_ID_KEY = 'setup.owner_user_id';

export type SetupStateValue = 'in_progress' | 'complete';

export type Organization = typeof organization.$inferSelect;

export interface OpenGate {
  open: true;
  /** Null only before step 1 has run. */
  org: Organization | null;
  completed: ReadonlySet<SetupStepSlug>;
  /** Where a resumed setup picks up: the first step with no marker. */
  resumeAt: SetupStepSlug;
  values: ReadonlyMap<string, string | null>;
}

export interface ClosedGate {
  open: false;
  /**
   * `complete` -- this wizard finished. `live-tenant` -- a company exists that
   * this wizard did not create. `unreachable` -- the database did not answer,
   * so completion is unknowable and nothing may be assumed either way.
   */
  reason: 'complete' | 'live-tenant' | 'unreachable';
  detail: string;
}

export type SetupGate = OpenGate | ClosedGate;

/**
 * Anything that can run a query: the pool, or a transaction. Taken as a
 * parameter so the claim can be re-read INSIDE the transaction that acts on
 * it -- a check made on the pool and then acted on separately is a window,
 * however narrow, in which two requests both believe setup is theirs.
 */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Every `setup.*` row, keyed. A handful of rows, so filtering in JS is honest. */
async function readSetupSettings(executor: Executor): Promise<Map<string, string | null>> {
  const rows = await executor.select().from(settings);
  const values = new Map<string, string | null>();
  for (const row of rows) {
    if (row.key.startsWith('setup.')) values.set(row.key, row.value);
  }
  return values;
}

export async function readSetupGate(executor: Executor = db): Promise<SetupGate> {
  let org: Organization | null;
  let values: Map<string, string | null>;

  try {
    [org = null] = await executor.select().from(organization).where(eq(organization.id, 1));
    values = await readSetupSettings(executor);
  } catch (error) {
    // A database that does not answer must not read as "no company yet". That
    // mistake would offer a first-run form to a deployment whose live tenant
    // simply could not be loaded.
    return {
      open: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.message : 'the database did not answer',
    };
  }

  const state = values.get(SETUP_STATE_KEY);

  if (state === 'complete') {
    return {
      open: false,
      reason: 'complete',
      detail: 'Setup has already been completed on this deployment.',
    };
  }

  if (org && state !== 'in_progress') {
    return {
      open: false,
      reason: 'live-tenant',
      detail:
        'A company already exists in this database, and this wizard did not create it. ' +
        'Its details are edited under Settings, where a change is one field rather than a replacement.',
    };
  }

  const completed = new Set<SetupStepSlug>(
    SETUP_STEP_SLUGS.filter((slug) => values.has(stepMarkerKey(slug))),
  );

  return { open: true, org, completed, resumeAt: firstIncomplete(completed), values };
}

/**
 * The resume point: the first step with no marker.
 *
 * First-incomplete rather than last-complete, so a step somehow skipped is
 * returned to instead of quietly stepped over.
 */
export function firstIncomplete(completed: ReadonlySet<SetupStepSlug>): SetupStepSlug {
  return SETUP_STEP_SLUGS.find((slug) => !completed.has(slug)) ?? FIRST_STEP;
}

/**
 * Whether a step may be OPENED: everything before it is done.
 *
 * A completed step stays open, because walking back to correct a typo before
 * finishing is the whole value of a wizard that persists as it goes.
 */
export function stepIsReachable(gate: OpenGate, slug: SetupStepSlug): boolean {
  return stepIndex(slug) <= stepIndex(gate.resumeAt);
}

/**
 * Upserts a `settings` row.
 *
 * `settings` and `document_sequences` are the two tables migration 0001
 * deliberately excludes from the `updated_at` trigger, so unlike every
 * mirrored table this one carries its own timestamp -- the same shape
 * `allocateDocumentNumber` uses for the same reason.
 */
export async function putSetting(
  executor: Executor,
  key: string,
  value: string | null,
): Promise<void> {
  await executor
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
}

/**
 * Records a step as finished, and sets the tenant claim in the same breath.
 *
 * The claim is written on EVERY step, not only the first: it is what tells a
 * later request that this half-built company belongs to a setup in progress
 * rather than to a live tenant, and a claim written once could be lost to a
 * restore that carried the organization row but not the settings row. Writing
 * it again costs one upsert.
 *
 * `state` is the caller's, so the final step can close the wizard through the
 * same write that records it. Two calls would race each other on one key.
 */
export async function markStepComplete(
  executor: Executor,
  slug: SetupStepSlug,
  state: SetupStateValue = 'in_progress',
): Promise<void> {
  await putSetting(executor, SETUP_STATE_KEY, state);
  await putSetting(executor, stepMarkerKey(slug), new Date().toISOString());
}
