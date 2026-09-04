import { z } from 'zod';
import { db } from '@/db/client';
import type { entityTypeEnum } from '@/db/enums';
import { settings } from '@/db/schema';

/**
 * The SharePoint mirror's configuration: what a tenant sets, read back typed.
 *
 * ---------------------------------------------------------------------------
 * NOTHING SECRET PASSES THROUGH THIS MODULE.
 *
 * The directory id, the application id, the certificate path and its
 * thumbprint are environment variables and are never read from, written to, or
 * defaulted into a `settings` row. The reason is structural rather than
 * stylistic: a `settings` row is machine state that lands in every database
 * dump, and the database is dumped hourly to three destinations (design
 * sections 7.0 and 8.1). An earlier draft put those values in a
 * `feature_flags` table alongside the Graph credentials the wizard collected
 * -- and a mirrored table ends up in SharePoint, so the credentials would have
 * synced to the very site they authenticate against.
 *
 * What lives here is only what is safe in a backup somebody else can read: a
 * site address, list and library names, and two intervals. `readSyncEnvironment`
 * below reports whether the environment supplies the credential. It returns
 * booleans and variable names. It never returns, logs or interpolates a value.
 * ---------------------------------------------------------------------------
 *
 * Absence is the off state (design section 4, `settings`). No default in this
 * file may switch the mirror on for somebody who never asked: `enabled`
 * defaults to `false` with no row present, and the two gates in
 * `syncReadiness` mean even a stored `true` cannot start a sync on a
 * deployment whose environment does not carry `SHAREPOINT_SYNC_ENABLED`.
 */

export type EntityType = (typeof entityTypeEnum.enumValues)[number];

/**
 * Anything that can run a query: the pool, or a transaction.
 *
 * Taken as a parameter so a caller that has already opened a transaction reads
 * the configuration from inside it. The same shape `src/app/setup/state.ts`
 * uses, for the same reason.
 */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Every key this module owns, under one prefix, so a reader of the `settings`
 * table can tell the mirror's rows from the updater's and the wizard's at a
 * glance.
 */
export const SYNC_SETTING_PREFIX = 'sync.';

/** The six libraries design section 7.4 provisions. */
export const LIBRARY_KINDS = [
  'quote_documents',
  'project_files',
  'receipts',
  'vendor_invoices',
  'backups',
  'exports',
] as const;

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

/**
 * The names section 7.4 gives, as defaults.
 *
 * Product defaults rather than a tenant's choice: they are what the
 * provisioning generator will create if nobody renames them. A library name
 * cannot switch the mirror on, so defaulting one is safe in a way defaulting
 * `enabled` is not.
 */
export const DEFAULT_LIBRARY_NAMES: Record<LibraryKind, string> = {
  quote_documents: 'QuoteDocuments',
  project_files: 'ProjectFiles',
  receipts: 'Receipts',
  vendor_invoices: 'VendorInvoices',
  backups: 'Backups',
  exports: 'Exports',
};

/** What each library holds, for the screen. Section 7.4's table, in words. */
export const LIBRARY_PURPOSE: Record<LibraryKind, string> = {
  quote_documents: 'Generated quote PDFs, foldered by project number.',
  project_files: 'Plans, permits, site photos, signed contracts.',
  receipts: 'Receipt images.',
  vendor_invoices: 'Vendor invoices and purchase orders.',
  backups: 'Encrypted database dumps.',
  exports: 'Accountant-ready spreadsheets.',
};

/**
 * Which library an attachment kind's bytes belong in.
 *
 * `files` is polymorphic and routes by `entity_type` (section 7.5), so the
 * routing table belongs beside the library names rather than inside the sync.
 *
 * `null` is honest rather than convenient. Section 7.4 names six libraries and
 * not one of them is for a customer attachment or for the tenant's own logo
 * and favicon, so this module does not invent a destination for them: those
 * files stay on local disk, which is authoritative anyway, and the screen says
 * so. Guessing `ProjectFiles` would put a company logo in the library an
 * accountant filters by project.
 */
export const LIBRARY_FOR_ATTACHMENT: Record<EntityType, LibraryKind | null> = {
  quote: 'quote_documents',
  project: 'project_files',
  receipt: 'receipts',
  vendor_invoice: 'vendor_invoices',
  purchase_order: 'vendor_invoices',
  customer: null,
  organization: null,
};

/** The library setting key for one kind. */
export function libraryKey(kind: LibraryKind): string {
  return `${SYNC_SETTING_PREFIX}library.${kind}`;
}

/**
 * The non-library keys, named once.
 *
 * Snake case inside the key and camel case in the type, matching the wizard's
 * `setup.*` rows: the key is data in a table a person may read with a SQL
 * client, and the property is TypeScript.
 */
export const SYNC_SETTING_KEYS = {
  enabled: `${SYNC_SETTING_PREFIX}enabled`,
  siteUrl: `${SYNC_SETTING_PREFIX}site_url`,
  listPrefix: `${SYNC_SETTING_PREFIX}list_prefix`,
  intervalMinutes: `${SYNC_SETTING_PREFIX}interval_minutes`,
  stalenessHours: `${SYNC_SETTING_PREFIX}staleness_hours`,
} as const;

/** Every key the mirror owns, for a test and for a reader. */
export function allSyncSettingKeys(): string[] {
  return [...Object.values(SYNC_SETTING_KEYS), ...LIBRARY_KINDS.map(libraryKey)];
}

// ---------------------------------------------------------------------------
// Mirrored tables
// ---------------------------------------------------------------------------

/**
 * One list per mirrored table, exactly as section 7.4 lists them.
 *
 * Written out here rather than derived from the Drizzle schema on purpose. The
 * generator that emits the provisioning template will read the schema, but this
 * screen has to name the lists BEFORE any of them exists, and `sync_state` is
 * keyed on `list_name` -- so a table with no state row yet still needs a row on
 * screen saying it has never run.
 */
export const MIRRORED_TABLES = [
  'organization',
  'users',
  'customers',
  'projects',
  'cost_codes',
  'rate_items',
  'scope_templates',
  'scope_template_items',
  'quotes',
  'quote_lines',
  'quote_taxes',
  'quote_clauses',
  'tax_rates',
  'document_sequences',
  'files',
  'stage_history',
] as const;

export type MirroredTable = (typeof MIRRORED_TABLES)[number];

/**
 * Deliberately not mirrored (section 7.4).
 *
 * The first three are machine state -- including the two tables this framework
 * itself reads and writes -- and `audit_log` has no `updated_at` to sync on,
 * will be the largest table in the database, and is already in every dump.
 */
export const NOT_MIRRORED_TABLES = ['settings', 'sync_state', 'sp_item_map', 'audit_log'] as const;

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/**
 * Every field is validated the same way whether it arrived from a form or from
 * a row somebody edited by hand.
 *
 * One exported schema per field, because the screen's actions validate the
 * submission and this module validates the stored value: two spellings of
 * "a site address" would let a value in through one door that the other
 * refuses, and the row would then fail every read.
 */

const MAX_URL = 400;

/**
 * The site the mirror writes to.
 *
 * HTTPS only, no query and no fragment, trailing slash removed. Graph builds
 * every request path from this string, so a fragment or a stray query produces
 * a URL that resolves to nothing and a 400 on every write; and an insecure
 * site address would send a company's records over the network in clear.
 */
export const siteUrlSchema = z
  .string()
  .trim()
  .max(MAX_URL, `must be ${MAX_URL} characters or fewer`)
  .refine((value) => value !== '', 'is required')
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.search === '' && url.hash === '' && url.host !== '';
    } catch {
      return false;
    }
  }, 'must be a full https site address, with no query string and no fragment')
  .transform((value) => value.replace(/\/+$/, ''));

/**
 * An optional prefix on every list name.
 *
 * Letters and digits only, starting with a letter. A SharePoint list's internal
 * name is derived from its title, and punctuation and spaces are either
 * rejected or silently escaped into something no query can address -- so this
 * refuses at the form rather than at the 400.
 *
 * Absence means the lists are named exactly as the tables, which is what
 * section 7.4 spells out. A prefix exists for the site that already holds
 * lists of its own.
 */
export const listPrefixSchema = z
  .string()
  .trim()
  .max(16, 'must be 16 characters or fewer')
  .refine((value) => value === '' || /^[A-Za-z][A-Za-z0-9]*$/.test(value), {
    message: 'must start with a letter and contain only letters and digits',
  })
  .transform((value) => (value === '' ? null : value));

/**
 * A document library name.
 *
 * The refused characters are the ones SharePoint itself refuses in a title; a
 * leading dot is refused for the same reason. Every one of them would be
 * accepted by this form and then rejected by Graph on every upload, forever --
 * the failure section 7.3 has to log, skip and surface. Better never stored.
 */
export const libraryNameSchema = z
  .string()
  .trim()
  .min(1, 'is required')
  .max(50, 'must be 50 characters or fewer')
  .refine((value) => !/["*:<>?/\\|]/.test(value), {
    message: 'cannot contain any of " * : < > ? / \\ |',
  })
  .refine((value) => !value.startsWith('.'), 'cannot start with a dot');

/**
 * Minutes between runs -- the recovery point objective, in other words
 * (section 7.3): a four-hour interval means losing up to four hours of quoting
 * work when the hardware fails.
 *
 * The floor is the five-minute safety lag. A run cannot see a row younger than
 * that lag, so an interval below it schedules work with nothing to do. The
 * ceiling is a day, past which the mirror is not a recovery source in any
 * useful sense.
 */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 1440;
export const DEFAULT_INTERVAL_MINUTES = 60;

export const intervalMinutesSchema = z
  .number()
  .int('must be a whole number of minutes')
  .min(MIN_INTERVAL_MINUTES, `must be at least ${MIN_INTERVAL_MINUTES} minutes`)
  .max(MAX_INTERVAL_MINUTES, `must be ${MAX_INTERVAL_MINUTES} minutes or fewer`);

/**
 * How old the last success may get before the mirror is called stale.
 *
 * The design gives this in two places, and they agree at the defaults: section
 * 7.3 wants a banner once the last success is older than twice the interval,
 * and section 8.5 wants one past two hours. Two hours IS twice the default
 * hourly interval. Rather than carry two rules that can disagree, the threshold
 * is one configured number defaulting to two hours, and the screen says when it
 * no longer matches twice the interval.
 */
export const MIN_STALENESS_HOURS = 1;
export const MAX_STALENESS_HOURS = 168;
export const DEFAULT_STALENESS_HOURS = 2;

export const stalenessHoursSchema = z
  .number()
  .int('must be a whole number of hours')
  .min(MIN_STALENESS_HOURS, `must be at least ${MIN_STALENESS_HOURS} hour`)
  .max(MAX_STALENESS_HOURS, `must be ${MAX_STALENESS_HOURS} hours or fewer`);

/**
 * The stored on/off value, and only two spellings of it.
 *
 * This module is the only writer, and it writes `true` or `false`, so anything
 * else in the row is a hand edit. It is refused rather than guessed at: reading
 * `yes` as on would switch a mirror on from a typo, and reading it as off would
 * leave an owner who believes the mirror is running with nothing happening.
 * Neither is a decision code gets to make quietly.
 */
export const storedBooleanSchema = z
  .enum(['true', 'false'], { message: 'must be stored as true or false' })
  .transform((value) => value === 'true');

/** A stored integer, refused rather than coerced when it is not one. */
const storedIntegerSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,9}$/, 'must be a whole number')
  .transform((value) => Number(value));

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface SyncConfig {
  /** The owner's request. Not on its own enough to make the mirror run. */
  enabled: boolean;
  siteUrl: string | null;
  listPrefix: string | null;
  libraries: Record<LibraryKind, string>;
  intervalMinutes: number;
  stalenessHours: number;
}

/** One stored value that failed its schema, named so the screen can say which. */
export interface SyncConfigProblem {
  key: string;
  /** What the field is called on screen. */
  label: string;
  message: string;
}

/**
 * `problems` is the same array type in both branches on purpose. A zero-length
 * tuple in the success case would read more precisely and would make
 * `read.problems.map(...)` a call against a union of two array types, which is
 * exactly the shape TypeScript refuses to resolve -- so every caller would have
 * to narrow on `ok` before it could even count them.
 */
export type SyncConfigRead =
  | { ok: true; config: SyncConfig; problems: readonly SyncConfigProblem[] }
  | { ok: false; config: null; problems: readonly SyncConfigProblem[] };

/** What each key is called on screen, for a problem message and for the form. */
export const SYNC_FIELD_LABELS: Record<string, string> = {
  [SYNC_SETTING_KEYS.enabled]: 'Mirror enabled',
  [SYNC_SETTING_KEYS.siteUrl]: 'SharePoint site address',
  [SYNC_SETTING_KEYS.listPrefix]: 'List name prefix',
  [SYNC_SETTING_KEYS.intervalMinutes]: 'Interval',
  [SYNC_SETTING_KEYS.stalenessHours]: 'Staleness threshold',
  ...Object.fromEntries(
    LIBRARY_KINDS.map((kind) => [libraryKey(kind), `${DEFAULT_LIBRARY_NAMES[kind]} library`]),
  ),
};

/** The configuration a deployment that has never been configured has. */
export function defaultSyncConfig(): SyncConfig {
  return {
    enabled: false,
    siteUrl: null,
    listPrefix: null,
    libraries: { ...DEFAULT_LIBRARY_NAMES },
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    stalenessHours: DEFAULT_STALENESS_HOURS,
  };
}

function problem(key: string, message: string): SyncConfigProblem {
  return { key, label: SYNC_FIELD_LABELS[key] ?? key, message };
}

/**
 * The stored rows, typed -- or the list of rows that are not what they claim.
 *
 * ---------------------------------------------------------------------------
 * A BAD VALUE IS REFUSED, NEVER COERCED TO THE DEFAULT.
 *
 * Falling back would be worse than failing. An interval stored as `0` and
 * coerced to sixty means a deployment syncing on a schedule nobody chose; a
 * malformed site address coerced to null means a mirror pointed at no site
 * while the screen shows a green tick. Both are the shape of defect this whole
 * area exists to prevent -- a configured deployment and a running process
 * disagreeing about what was configured -- so the read fails and names the row.
 * ---------------------------------------------------------------------------
 *
 * Absence is not a bad value. A missing row is the off state, and for the two
 * intervals and the six library names it is the documented default.
 */
export function parseSyncConfig(values: ReadonlyMap<string, string | null>): SyncConfigRead {
  const problems: SyncConfigProblem[] = [];
  const config = defaultSyncConfig();

  // A row present with a NULL value is treated as absent throughout. That is
  // how this module CLEARS a field: nothing in this product is ever deleted
  // (section 4), so a cleared site address is a NULL in a row that stays.
  const stored = (key: string): string | null => {
    const value = values.get(key);
    return value === null || value === undefined || value.trim() === '' ? null : value;
  };

  const enabled = stored(SYNC_SETTING_KEYS.enabled);
  if (enabled !== null) {
    const parsed = storedBooleanSchema.safeParse(enabled.trim());
    if (parsed.success) config.enabled = parsed.data;
    else problems.push(problem(SYNC_SETTING_KEYS.enabled, parsed.error.issues[0]!.message));
  }

  const siteUrl = stored(SYNC_SETTING_KEYS.siteUrl);
  if (siteUrl !== null) {
    const parsed = siteUrlSchema.safeParse(siteUrl);
    if (parsed.success) config.siteUrl = parsed.data;
    else problems.push(problem(SYNC_SETTING_KEYS.siteUrl, parsed.error.issues[0]!.message));
  }

  const listPrefix = stored(SYNC_SETTING_KEYS.listPrefix);
  if (listPrefix !== null) {
    const parsed = listPrefixSchema.safeParse(listPrefix);
    if (parsed.success) config.listPrefix = parsed.data;
    else problems.push(problem(SYNC_SETTING_KEYS.listPrefix, parsed.error.issues[0]!.message));
  }

  for (const kind of LIBRARY_KINDS) {
    const key = libraryKey(kind);
    const name = stored(key);
    if (name === null) continue;
    const parsed = libraryNameSchema.safeParse(name);
    if (parsed.success) config.libraries[kind] = parsed.data;
    else problems.push(problem(key, parsed.error.issues[0]!.message));
  }

  const numbers = [
    {
      key: SYNC_SETTING_KEYS.intervalMinutes,
      schema: intervalMinutesSchema,
      assign: (value: number) => {
        config.intervalMinutes = value;
      },
    },
    {
      key: SYNC_SETTING_KEYS.stalenessHours,
      schema: stalenessHoursSchema,
      assign: (value: number) => {
        config.stalenessHours = value;
      },
    },
  ];

  for (const field of numbers) {
    const raw = stored(field.key);
    if (raw === null) continue;
    const asInteger = storedIntegerSchema.safeParse(raw);
    if (!asInteger.success) {
      problems.push(problem(field.key, asInteger.error.issues[0]!.message));
      continue;
    }
    const parsed = field.schema.safeParse(asInteger.data);
    if (parsed.success) field.assign(parsed.data);
    else problems.push(problem(field.key, parsed.error.issues[0]!.message));
  }

  if (problems.length > 0) return { ok: false, config: null, problems };
  return { ok: true, config, problems: [] };
}

/** Every `sync.*` row. A handful of rows, so filtering in JS is honest. */
async function readSyncSettings(executor: Executor): Promise<Map<string, string | null>> {
  const rows = await executor.select().from(settings);
  const values = new Map<string, string | null>();
  for (const row of rows) {
    if (row.key.startsWith(SYNC_SETTING_PREFIX)) values.set(row.key, row.value);
  }
  return values;
}

export async function readSyncConfig(executor: Executor = db): Promise<SyncConfigRead> {
  return parseSyncConfig(await readSyncSettings(executor));
}

export class SyncConfigError extends Error {
  constructor(readonly problems: readonly SyncConfigProblem[]) {
    super(
      `the SharePoint mirror configuration is not valid: ${problems
        .map((entry) => `${entry.key} ${entry.message}`)
        .join('; ')}`,
    );
    this.name = 'SyncConfigError';
  }
}

/**
 * The same read, for a caller with nowhere to render a problem -- the sync job
 * that does not exist yet, and a script. A screen uses `readSyncConfig` and
 * shows the problems instead of throwing them at the person reading it.
 */
export async function requireSyncConfig(executor: Executor = db): Promise<SyncConfig> {
  const read = await readSyncConfig(executor);
  if (!read.ok) throw new SyncConfigError(read.problems);
  return read.config;
}

/** The list a table mirrors to, prefix applied. */
export function listNameFor(config: SyncConfig, table: string): string {
  return config.listPrefix ? `${config.listPrefix}_${table}` : table;
}

/** Every list the mirror expects to exist, in section 7.4's order. */
export function expectedListNames(config: SyncConfig): string[] {
  return MIRRORED_TABLES.map((table) => listNameFor(config, table));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface SyncConfigPatch {
  enabled?: boolean;
  siteUrl?: string | null;
  listPrefix?: string | null;
  libraries?: Partial<Record<LibraryKind, string>>;
  intervalMinutes?: number;
  stalenessHours?: number;
}

/**
 * Upserts a `settings` row.
 *
 * `settings` and `document_sequences` are the two tables migration 0001
 * deliberately excludes from the `updated_at` trigger, so this table carries
 * its own timestamp and the write has to set it. Written here rather than
 * imported from the setup wizard's module: a library reaching up into
 * `src/app` for a two-line upsert is a dependency pointing the wrong way.
 */
async function putSetting(executor: Executor, key: string, value: string | null): Promise<void> {
  await executor
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/**
 * Writes part of the configuration, validating first.
 *
 * Every field goes through the schema that reads it back, so a value this
 * function stores is a value `parseSyncConfig` accepts -- otherwise a form
 * could write a row that makes every later read fail.
 *
 * Clearing writes NULL. It does not delete the row: nothing in this product is
 * ever deleted, a NULL and a missing row are read identically, and the moment
 * the field was cleared survives in `updated_at`.
 */
export async function writeSyncConfig(
  patch: SyncConfigPatch,
  executor: Executor = db,
): Promise<void> {
  const writes: [string, string | null][] = [];

  if (patch.enabled !== undefined) {
    writes.push([SYNC_SETTING_KEYS.enabled, patch.enabled ? 'true' : 'false']);
  }

  if (patch.siteUrl !== undefined) {
    const value = patch.siteUrl === null ? null : siteUrlSchema.parse(patch.siteUrl);
    writes.push([SYNC_SETTING_KEYS.siteUrl, value]);
  }

  if (patch.listPrefix !== undefined) {
    const value = patch.listPrefix === null ? null : listPrefixSchema.parse(patch.listPrefix);
    writes.push([SYNC_SETTING_KEYS.listPrefix, value]);
  }

  for (const kind of LIBRARY_KINDS) {
    const name = patch.libraries?.[kind];
    if (name === undefined) continue;
    writes.push([libraryKey(kind), libraryNameSchema.parse(name)]);
  }

  if (patch.intervalMinutes !== undefined) {
    writes.push([
      SYNC_SETTING_KEYS.intervalMinutes,
      String(intervalMinutesSchema.parse(patch.intervalMinutes)),
    ]);
  }

  if (patch.stalenessHours !== undefined) {
    writes.push([
      SYNC_SETTING_KEYS.stalenessHours,
      String(stalenessHoursSchema.parse(patch.stalenessHours)),
    ]);
  }

  for (const [key, value] of writes) await putSetting(executor, key, value);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * The variables the RUNNING application reads, spelled exactly as
 * `src/app/setup/environment.ts` spells them.
 *
 * Adopted rather than re-invented. A screen and a runtime disagreeing about a
 * variable name has already cost this project a defect where a configured
 * deployment reported itself unconfigured, and the only cure that holds is one
 * spelling of each name in the codebase.
 */
export const SYNC_ENVIRONMENT_VARIABLES = [
  'SHAREPOINT_SYNC_ENABLED',
  'SHAREPOINT_TENANT_ID',
  'SHAREPOINT_CLIENT_ID',
  'SHAREPOINT_CERT_PATH',
  'SHAREPOINT_CERT_THUMBPRINT',
] as const;

export type SyncEnvironmentVariable = (typeof SYNC_ENVIRONMENT_VARIABLES)[number];

/** The four that make up the app-only credential, section 7.6. */
export const CREDENTIAL_VARIABLES = [
  'SHAREPOINT_TENANT_ID',
  'SHAREPOINT_CLIENT_ID',
  'SHAREPOINT_CERT_PATH',
  'SHAREPOINT_CERT_THUMBPRINT',
] as const satisfies readonly SyncEnvironmentVariable[];

/** What each variable is for, for the screen. Never what is in it. */
export const VARIABLE_PURPOSE: Record<SyncEnvironmentVariable, string> = {
  SHAREPOINT_SYNC_ENABLED:
    'The gate. Off on a fresh install, and a database row cannot override it.',
  SHAREPOINT_TENANT_ID: 'Which directory the sync authenticates against. An identifier, not a secret.',
  SHAREPOINT_CLIENT_ID: 'The registered application the sync signs in as. An identifier, not a secret.',
  SHAREPOINT_CERT_PATH: 'Where the mounted certificate is. The sync is app-only, so it cannot log in interactively.',
  SHAREPOINT_CERT_THUMBPRINT: 'Which key the credential is presenting.',
};

export interface SyncEnvironment {
  /** Whether the container's gate variable is on. Section 7.0's hard gate. */
  flagOn: boolean;
  /** Set or not set, per variable. Never the value. */
  present: Record<SyncEnvironmentVariable, boolean>;
  /** The credential variables with nothing in them. */
  missing: SyncEnvironmentVariable[];
  /** Whether all four credential variables are supplied. */
  credentialComplete: boolean;
}

/** Present and not blank. An empty string in a Compose file is not a setting. */
function isSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * A shell boolean, as `docker/backup.sh` and the setup wizard both read it:
 * anything but unset, empty, zero or false is on.
 *
 * Matching that rule rather than inventing a stricter one, so this screen
 * cannot report a mirror off that the backup job counts as on.
 */
function flagIsOn(name: string): boolean {
  const value = process.env[name]?.trim();
  if (!value) return false;
  return value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * What the environment supplies, as booleans.
 *
 * ---------------------------------------------------------------------------
 * PRESENCE ONLY. NO VALUE LEAVES THIS FUNCTION.
 *
 * The thumbprint and the certificate path are read only to ask whether they
 * are blank, and are then dropped. Nothing here is returned, stored, logged or
 * interpolated into a message, because anything this module can persist ends up
 * in a database dump and, for the mirrored tables, in SharePoint.
 *
 * Whether the credential actually LOADS is a different and better question, and
 * `src/app/setup/environment.ts` already answers it against the mounted file.
 * The screen reuses that check rather than opening the file again here.
 * ---------------------------------------------------------------------------
 */
export function readSyncEnvironment(): SyncEnvironment {
  const present = Object.fromEntries(
    SYNC_ENVIRONMENT_VARIABLES.map((name) => [name, isSet(name)]),
  ) as Record<SyncEnvironmentVariable, boolean>;

  const missing = CREDENTIAL_VARIABLES.filter((name) => !present[name]);

  return {
    flagOn: flagIsOn('SHAREPOINT_SYNC_ENABLED'),
    present,
    missing: [...missing],
    credentialComplete: missing.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Why the mirror is not running, or that nothing in the configuration stops it.
 *
 * Two gates and not one, in this order:
 *
 * 1. `SHAREPOINT_SYNC_ENABLED` in the container. Section 7.0 puts the gate in
 *    the environment beside the credentials rather than in a database row, and
 *    the consequence is exactly this precedence: a `settings` row can never
 *    switch the mirror on. A dump restored from a tenant that used the mirror
 *    carries `sync.enabled` set to true, and it must not start pushing this
 *    company's records at a site it holds no credential for.
 * 2. The owner's own request, stored here. With the flag on and no request, the
 *    answer is "nobody asked", which is the fresh-install state.
 */
export type SyncReadiness =
  | 'environment-off'
  | 'not-requested'
  | 'credential-missing'
  | 'site-missing'
  | 'ready';

export function syncReadiness(config: SyncConfig, environment: SyncEnvironment): SyncReadiness {
  if (!environment.flagOn) return 'environment-off';
  if (!config.enabled) return 'not-requested';
  if (!environment.credentialComplete) return 'credential-missing';
  if (!config.siteUrl) return 'site-missing';
  return 'ready';
}

/**
 * Whether the mirror is on, for anything that only needs the boolean --
 * notably the health verdict, which reports `off` rather than `stale` for a
 * mirror nobody switched on.
 */
export function mirrorIsOn(config: SyncConfig, environment: SyncEnvironment): boolean {
  return syncReadiness(config, environment) === 'ready';
}
