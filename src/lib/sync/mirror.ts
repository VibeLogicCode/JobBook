/**
 * The seam the sync job plugs into, and nothing behind it.
 *
 * The mirror itself -- the Graph client, the provisioning generator, the
 * scheduled job -- is deliberately not built yet. This file declares the shape
 * it must present so that the configuration screen, the health verdict and the
 * eventual implementation are written against one interface rather than three
 * guesses, and so that anything importing it today fails loudly instead of
 * silently doing nothing.
 *
 * ===========================================================================
 * WHAT THE IMPLEMENTATION MUST RESPECT (design section 7.3)
 *
 * Each of these was a way an earlier draft lost data silently. They are
 * requirements on the implementer, not suggestions, and they are written here
 * because this interface is where the requirements land.
 *
 * 1. A KEYSET CURSOR, NOT A BARE WATERMARK.
 *    The cursor is the pair `(updated_at, id)` and the query is
 *    `WHERE (updated_at, id) > (cursor_updated_at, cursor_id) ORDER BY
 *    updated_at, id`. A bulk insert stamps many rows with one `updated_at`, so
 *    advancing to "the highest timestamp in this batch" and then asking for
 *    rows strictly greater skips the rest of that cohort -- a forty-line quote
 *    mirrors lines 1 to 20 and drops 21 to 40. Ordering and paging on the pair
 *    cannot skip a row. Hence `MirrorCursor` has two fields and
 *    `advanceCursor` takes both; there is no single-timestamp overload, on
 *    purpose.
 *
 * 2. A FIVE-MINUTE SAFETY LAG.
 *    Add `AND updated_at <= now() - interval '5 minutes'`. In PostgreSQL
 *    `now()` is transaction START time, so a row whose transaction began before
 *    the sync read its cursor but committed after it carries a timestamp below
 *    the new cursor and would never be sent again. The lag costs five minutes
 *    of recency and closes the hole. It is also why the configured interval has
 *    a five-minute floor.
 *
 * 3. `sp_item_map`, BECAUSE GRAPH HAS NO UPSERT BY ARBITRARY KEY.
 *    Writing a list item requires knowing its SharePoint item id, and there is
 *    no "upsert matched on pg_id" operation in the API -- an earlier draft
 *    specified one that does not exist. So the mapping is ours to keep:
 *    `mapItemId` reads it, and `upsertRows` records the id of anything it
 *    creates. A `$filter` lookup per row instead would be an extra round trip
 *    per row and would still race.
 *
 * 4. A 4xx IS SKIPPED AND SURFACED; A 429 OR 5xx RETRIES WITHOUT ADVANCING.
 *    A 400 on one row -- an over-length string, an unmapped value -- must be
 *    logged to `sync_state`, skipped, and shown on screen. Under a naive
 *    "advance only on success" rule one bad row blocks that table's cursor
 *    permanently and every later row stops syncing, which looks like a working
 *    backup and is not one. A 429 or 5xx is the opposite case: retry, honour
 *    `Retry-After` with capped exponential backoff and jitter, and do not
 *    advance. SharePoint write throttling is aggressive and real.
 *    `UpsertOutcome.disposition` exists to force that distinction into the
 *    type, so an implementation cannot collapse it to a boolean.
 *
 * 5. `$batch` IS NOT ATOMIC.
 *    Twenty sub-requests return twenty statuses and some can fail while others
 *    succeed. Every sub-response must be parsed; treating the batch as
 *    pass-or-fail either loses writes or repeats them. That is why
 *    `upsertRows` returns one outcome PER ROW rather than a single result.
 *
 * 6. UNSCALE ON THE WAY OUT.
 *    Money, quantities and rates are scaled integers in Postgres. A rate stored
 *    as 40000 must appear in SharePoint as 4.0000, and a value read back must
 *    re-scale to 40000 (section 11's scale-symmetry test). Getting this wrong
 *    is silent until somebody reads a report. `MirrorValue` therefore admits
 *    `number`, and the unscaling happens at this boundary -- which is also
 *    exactly why the mirror is not a restore path: the number that lands there
 *    has been through an IEEE double, and the byte-exact copy is the encrypted
 *    dump.
 *
 * Two more, from elsewhere in section 7, that this interface has to allow for:
 *
 * - NOTHING IS EVER DELETED. A voided row is written with its status, reason
 *   and timestamp set; it is never removed from SharePoint (sections 4 and
 *   7.3). There is no `deleteRow` on this interface and there must not be one.
 * - THE MIRROR IS ONE-WAY. There is no read-back method here beyond
 *   `mapItemId`, which reads our own mapping table rather than SharePoint. An
 *   unchanged Postgres row is never resent, so a human edit made in SharePoint
 *   is not overwritten -- it persists and diverges silently (section 7.2).
 *   Nothing on this interface may be used to pull a value back in.
 * ===========================================================================
 */

/**
 * The keyset cursor. Two fields, always, for the reason in note 1 above.
 */
export interface MirrorCursor {
  updatedAt: Date;
  id: string;
}

/**
 * What a mirrored column may hold once it has left Postgres.
 *
 * `number` is here because scaled integers are unscaled at this boundary, and
 * `string` because every enum mirrors as Text rather than Choice: a Choice
 * column validates against a fixed member list, so adding an enum value in a
 * migration would make every sync of that row fail with a 400 until somebody
 * edited the list by hand.
 */
export type MirrorValue = string | number | boolean | null;

/** One row on its way out, keyed by the Postgres primary key as text. */
export interface MirrorRow {
  /**
   * Text, not uuid: `organization` has an integer primary key by design, and
   * `sp_item_map.pg_id` is text for the same reason.
   */
  pgId: string;
  /** Column name to unscaled value. Named as the SharePoint column is named. */
  fields: Record<string, MirrorValue>;
  /** The row's own cursor position, so the caller can advance to the last written. */
  cursor: MirrorCursor;
}

/**
 * What happened to one row, per note 4.
 *
 * - `created` / `patched` -- written. `spItemId` is set.
 * - `skipped`  -- a 4xx that will never succeed. Log it, surface it, and let
 *                 the cursor move past it, or this list stops forever.
 * - `deferred` -- a 429 or 5xx. Retry later; the cursor must NOT advance past
 *                 it.
 */
export type UpsertDisposition = 'created' | 'patched' | 'skipped' | 'deferred';

export interface UpsertOutcome {
  pgId: string;
  disposition: UpsertDisposition;
  /** The SharePoint item id, for anything written. */
  spItemId: string | null;
  /** The sub-response status, kept because 4xx and 429 are handled oppositely. */
  httpStatus: number | null;
  /** Why, for `sync_state.last_error` and for the screen. */
  error: string | null;
  /** Honour this before retrying a `deferred` row. */
  retryAfterMs: number | null;
}

export interface UpsertResult {
  /** One entry per row submitted. Never a single pass-or-fail (note 5). */
  outcomes: UpsertOutcome[];
  /**
   * The furthest cursor position it is safe to advance to: the last row that
   * was written or deliberately skipped, stopping at the first `deferred` one.
   * Null when nothing may be advanced past.
   */
  safeCursor: MirrorCursor | null;
}

/**
 * The interface the sync job will implement. One-way, by construction.
 */
export interface Mirror {
  /**
   * Creates or patches a batch of rows in one list.
   *
   * The implementation batches through Graph `$batch`, 20 sub-requests at a
   * time, and returns one outcome per row.
   */
  upsertRows(listName: string, rows: readonly MirrorRow[]): Promise<UpsertResult>;

  /**
   * Records how far this list has been mirrored, in `sync_state`.
   *
   * Separate from `upsertRows` so the cursor moves only after the writes are
   * accounted for, and so a run that wrote nothing advances nothing.
   */
  advanceCursor(listName: string, cursor: MirrorCursor): Promise<void>;

  /**
   * The SharePoint item id for a Postgres row, from `sp_item_map`, or null when
   * this row has never been written.
   */
  mapItemId(tableName: string, pgId: string): Promise<string | null>;
}

/**
 * Thrown by every method of `NotImplementedMirror`.
 *
 * A named error class rather than a bare `Error` so a caller can tell "the
 * mirror is not built" from "the mirror failed", and so a test can assert on
 * the distinction. If this ever reaches a screen, the screen should say what
 * this message says.
 */
export class MirrorNotBuiltError extends Error {
  constructor(operation: string) {
    super(
      `the SharePoint mirror is not built yet, so ${operation} cannot run. ` +
        'The configuration under Settings, SharePoint mirror is real and is stored; ' +
        'the Graph client, the provisioning generator and the scheduled job are not ' +
        'written. Nothing has been sent to SharePoint and nothing will be until they are.',
    );
    this.name = 'MirrorNotBuiltError';
  }
}

/**
 * The only implementation that exists today. Every method throws.
 *
 * Deliberately not a no-op. A silent stub is the worse failure by a wide
 * margin: the sync would appear to run, `sync_state` would fill with successes,
 * the screen would show green, and the owner would believe he had an offsite
 * copy of his tax records that had never existed. Throwing is the honest state
 * of a thing that is not built.
 */
export class NotImplementedMirror implements Mirror {
  upsertRows(listName: string, rows: readonly MirrorRow[]): Promise<UpsertResult> {
    // The arguments are named and unused on purpose: the signature is the
    // deliverable here, and a shorter one would have to be widened later by
    // whoever builds the real client.
    void listName;
    void rows;
    return Promise.reject(new MirrorNotBuiltError('writing rows to a SharePoint list'));
  }

  advanceCursor(listName: string, cursor: MirrorCursor): Promise<void> {
    void listName;
    void cursor;
    return Promise.reject(new MirrorNotBuiltError('advancing a sync cursor'));
  }

  mapItemId(tableName: string, pgId: string): Promise<string | null> {
    void tableName;
    void pgId;
    return Promise.reject(new MirrorNotBuiltError('looking up a SharePoint item id'));
  }
}

/**
 * How a caller gets a mirror.
 *
 * A function rather than an exported instance, so the day a real client exists
 * this is the one line that changes and no call site has to. It takes no
 * configuration argument yet for the same reason it returns a stub: guessing
 * the constructor's parameters before the client exists would be inventing the
 * design rather than leaving the seam.
 */
export function resolveMirror(): Mirror {
  return new NotImplementedMirror();
}

/**
 * Whether a real implementation exists.
 *
 * Read by the screen, which has to say plainly that switching the mirror on
 * changes a stored setting and starts nothing -- otherwise an owner enables it
 * and waits for data that will never arrive. This is a constant rather than a
 * feature check because it is a fact about the codebase, not about the
 * deployment.
 */
export const MIRROR_IS_BUILT: boolean = false;
