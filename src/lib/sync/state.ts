import { db } from '@/db/client';
import { syncState } from '@/db/schema';
import {
  type Executor,
  type MirroredTable,
  type SyncConfig,
  type SyncEnvironment,
  MIRRORED_TABLES,
  listNameFor,
  mirrorIsOn,
} from '@/lib/sync/config';

/**
 * What the mirror has actually done, read from `sync_state`, and the verdict
 * that follows from it.
 *
 * ---------------------------------------------------------------------------
 * STALENESS IS DERIVED, NEVER STORED.
 *
 * There is no `is_stale` column and there will not be one. A stored verdict is
 * wrong the moment the clock passes it -- the same reason `quote_status` has no
 * `expired` member and time-in-stage is computed from `stage_history`. The
 * inputs are `last_success_at` and the configured threshold; the answer is
 * computed at read time, from the clock, every time.
 * ---------------------------------------------------------------------------
 *
 * Section 7.3 asks for a banner once the last success is older than twice the
 * interval, and section 8.5 for one past two hours. Both are the same rule with
 * a different number in it, so the number is configuration
 * (`sync.staleness_hours`) and this module reads it rather than hardcoding
 * either.
 */

/**
 * Five outcomes, and the distinctions matter more than the labels:
 *
 * - `off`     -- the mirror is not running, so it is not behind. A mirror
 *                nobody switched on must never report red: a red cross beside
 *                a feature the owner deliberately declined teaches him to
 *                ignore red, which is the one thing this screen cannot afford.
 * - `never-run` -- on, but this list has never been attempted. Distinct from
 *                stale because there is nothing wrong yet; enabling triggers a
 *                full backfill (section 7.0) and it has not happened.
 * - `healthy` -- a success inside the threshold, and no failure since.
 * - `stale`   -- the last success is older than the threshold. Nothing has
 *                reported an error; the sync has simply stopped arriving,
 *                which is how a scheduler that never fires looks.
 * - `failing` -- the last run recorded an error. Named separately from stale
 *                because it carries a cause and a remedy, and because "a sync
 *                that has been failing for a month is worse than no sync"
 *                (section 7.3) only holds if the failure is visible as one.
 */
export type SyncHealth = 'off' | 'never-run' | 'healthy' | 'stale' | 'failing';

/** Three in a row escalates (section 8.5). */
export const ESCALATION_FAILURES = 3;

export interface HealthInput {
  /** Whether the mirror is on at all. `mirrorIsOn` from the config module. */
  enabled: boolean;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  stalenessHours: number;
  /** Injected so a test does not have to wait two hours. */
  now?: Date;
}

/**
 * The verdict for one list.
 *
 * `failing` outranks `stale` deliberately. A list that has been failing for a
 * month is both, and the failure is the actionable half -- it has an error
 * message attached. The screen prints the age of the last success beside the
 * verdict, so a month-old failure cannot read as a hiccup.
 *
 * Pure, and takes its clock as an argument, because every one of these branches
 * is a boundary somebody has to be able to test.
 */
export function deriveHealth(input: HealthInput): SyncHealth {
  if (!input.enabled) return 'off';
  if (input.consecutiveFailures > 0) return 'failing';
  if (input.lastRunAt === null) return 'never-run';

  // A run with no success and no recorded failure should not happen -- a run
  // either succeeded or incremented the counter -- but the row is data, not a
  // promise. Reporting it as stale is the safe reading: something ran and
  // nothing arrived.
  if (input.lastSuccessAt === null) return 'stale';

  const now = (input.now ?? new Date()).getTime();
  const ageMs = now - input.lastSuccessAt.getTime();
  return ageMs > input.stalenessHours * 3_600_000 ? 'stale' : 'healthy';
}

export interface SyncTableState {
  /** The table this list mirrors, or null for a list nothing maps to. */
  table: MirroredTable | null;
  listName: string;
  /**
   * The keyset cursor's two halves, together. A bare timestamp watermark
   * truncates a cohort of rows sharing one `updated_at`; the pair cannot
   * (section 7.3).
   */
  cursorUpdatedAt: Date | null;
  cursorId: string | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  rowsSynced: number;
  lastError: string | null;
  consecutiveFailures: number;
  health: SyncHealth;
  /** Milliseconds since the last success, or null when there has never been one. */
  sinceSuccessMs: number | null;
  /** Whether the failure count has reached the escalation threshold. */
  escalated: boolean;
}

export interface SyncStateReport {
  rows: SyncTableState[];
  /** The worst verdict across every list, for a banner. */
  worst: SyncHealth;
  /** Rows summed, so the screen can say whether anything has ever been written. */
  rowsSynced: number;
  /**
   * Lists in `sync_state` that no mirrored table maps to.
   *
   * Surfaced rather than hidden. Renaming the list prefix orphans every state
   * row under the old names, and since nothing is ever deleted they stay --
   * which is the honest outcome, because those SharePoint lists also stay and
   * stop updating. An owner who cannot see them cannot understand why the site
   * has two sets of lists.
   */
  orphans: SyncTableState[];
  /** When this report was computed, so the screen can date what it shows. */
  observedAt: Date;
}

/** Worst-first, so a report's headline is the thing that needs attention. */
const SEVERITY: Record<SyncHealth, number> = {
  failing: 4,
  stale: 3,
  'never-run': 2,
  healthy: 1,
  off: 0,
};

export function worstHealth(verdicts: readonly SyncHealth[]): SyncHealth {
  return verdicts.reduce<SyncHealth>(
    (worst, verdict) => (SEVERITY[verdict] > SEVERITY[worst] ? verdict : worst),
    'off',
  );
}

/**
 * Every mirrored table's state, whether or not `sync_state` has a row for it.
 *
 * A table with no row is the normal case before the first run, and it has to
 * appear on screen saying so: sixteen lists with fifteen rows on screen is a
 * table somebody has to count to notice.
 *
 * The configuration is a parameter rather than read here, because the caller
 * has already read it -- the screen needs the same object to render the form,
 * and reading it twice invites two answers.
 */
export async function readSyncState(
  config: SyncConfig,
  environment: SyncEnvironment,
  executor: Executor = db,
  now: Date = new Date(),
): Promise<SyncStateReport> {
  const stored = await executor.select().from(syncState);
  const byList = new Map(stored.map((row) => [row.listName, row]));
  const enabled = mirrorIsOn(config, environment);

  const build = (listName: string, table: MirroredTable | null): SyncTableState => {
    const row = byList.get(listName);
    const lastSuccessAt = row?.lastSuccessAt ?? null;
    const consecutiveFailures = row?.consecutiveFailures ?? 0;

    return {
      table,
      listName,
      cursorUpdatedAt: row?.cursorUpdatedAt ?? null,
      cursorId: row?.cursorId ?? null,
      lastRunAt: row?.lastRunAt ?? null,
      lastSuccessAt,
      rowsSynced: row?.rowsSynced ?? 0,
      lastError: row?.lastError ?? null,
      consecutiveFailures,
      health: deriveHealth({
        enabled,
        lastRunAt: row?.lastRunAt ?? null,
        lastSuccessAt,
        consecutiveFailures,
        stalenessHours: config.stalenessHours,
        now,
      }),
      sinceSuccessMs: lastSuccessAt ? now.getTime() - lastSuccessAt.getTime() : null,
      escalated: consecutiveFailures >= ESCALATION_FAILURES,
    };
  };

  const rows = MIRRORED_TABLES.map((table) => build(listNameFor(config, table), table));
  const expected = new Set(rows.map((row) => row.listName));
  const orphans = stored
    .filter((row) => !expected.has(row.listName))
    .map((row) => build(row.listName, null));

  return {
    rows,
    worst: worstHealth([...rows, ...orphans].map((row) => row.health)),
    rowsSynced: [...rows, ...orphans].reduce((total, row) => total + row.rowsSynced, 0),
    orphans,
    observedAt: now,
  };
}

/**
 * How old, in words a person reads rather than a duration they decode.
 *
 * Here rather than in the component because the same sentence belongs in a
 * dashboard banner later, and because "2 hours ago" computed in two places
 * eventually rounds two different ways.
 */
export function describeAge(ms: number | null): string {
  if (ms === null) return 'never';
  if (ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

/** The one-line verdict, worded so colour is never carrying the meaning. */
export const HEALTH_LABEL: Record<SyncHealth, string> = {
  off: 'Off',
  'never-run': 'Never run',
  healthy: 'Up to date',
  stale: 'Stale',
  failing: 'Failing',
};

export const HEALTH_EXPLANATION: Record<SyncHealth, string> = {
  off: 'The mirror is not running, so this list is not behind — it is simply not being written.',
  'never-run': 'The mirror is on and this list has not been attempted yet.',
  healthy: 'A run succeeded inside the staleness threshold, and nothing has failed since.',
  stale: 'No error was recorded, but the last success is older than the threshold. A scheduler that never fires looks exactly like this.',
  failing: 'The last run recorded an error. The message is in the row.',
};
