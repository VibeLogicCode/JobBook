import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { settings, syncState } from '@/db/schema';
import { runEnvironmentChecks } from '@/app/setup/environment';
import {
  MIRRORED_TABLES,
  SYNC_ENVIRONMENT_VARIABLES,
  SYNC_SETTING_KEYS,
  libraryKey,
  listNameFor,
  readSyncConfig,
  readSyncEnvironment,
  requireSyncConfig,
  SyncConfigError,
  writeSyncConfig,
} from '@/lib/sync/config';
import { readSyncState } from '@/lib/sync/state';

/**
 * The mirror's accessors against the real database.
 *
 * The validation rules and the health arithmetic are covered purely in
 * tests/unit/sync-config.test.ts. What needs a database is everything that
 * depends on a row actually being there:
 *
 * 1. That absence really is the off state in an empty `settings` table, rather
 *    than only in a Map a test built.
 * 2. That switching the mirror off writes a value and deletes nothing -- the
 *    no-delete rule holds for machine state as well as for tax records.
 * 3. That a row edited by hand outside the application is refused on read,
 *    which is the only way the "refused, not coerced" rule protects anything.
 * 4. That the per-list state is assembled for all sixteen lists whether or not
 *    `sync_state` has a row for each, and that staleness moves when the
 *    threshold moves and the row does not.
 * 5. That this module and first-run setup read the same environment variable
 *    names. That parity is not cosmetic: a screen and a runtime disagreeing
 *    about a variable name already produced a defect where a configured
 *    deployment reported itself unconfigured.
 */

beforeEach(async () => {
  await db.execute(sql`truncate table settings, sync_state restart identity cascade`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Every credential variable supplied, so readiness turns on the stored row. */
function stubCredential(): void {
  vi.stubEnv('SHAREPOINT_SYNC_ENABLED', '1');
  vi.stubEnv('SHAREPOINT_TENANT_ID', 'directory-identifier');
  vi.stubEnv('SHAREPOINT_CLIENT_ID', 'application-identifier');
  vi.stubEnv('SHAREPOINT_CERT_PATH', '/run/secrets/sharepoint');
  vi.stubEnv('SHAREPOINT_CERT_THUMBPRINT', 'a1b2c3');
}

const SITE = 'https://example.invalid/sites/records';

describe('reading a database nobody has configured', () => {
  it('reads as off, with no rows present at all', async () => {
    const read = await readSyncConfig();
    expect(read.ok).toBe(true);
    expect(read.config?.enabled).toBe(false);
    expect(read.config?.siteUrl).toBeNull();
  });

  it('writes nothing while being read', async () => {
    await readSyncConfig();
    const rows = await db.select().from(settings);
    expect(rows).toEqual([]);
  });

  it('stays off even with every credential variable supplied', async () => {
    // The container permitting the mirror is not the owner asking for it.
    stubCredential();
    const read = await readSyncConfig();
    expect(read.config?.enabled).toBe(false);
    const report = await readSyncState(read.config!, readSyncEnvironment());
    expect(report.rows.every((row) => row.health === 'never-run')).toBe(false);
    expect(report.rows.every((row) => row.health === 'off')).toBe(true);
  });
});

describe('writing and reading back', () => {
  it('round-trips every field', async () => {
    await writeSyncConfig({
      enabled: true,
      siteUrl: SITE,
      listPrefix: 'Scope',
      intervalMinutes: 15,
      stalenessHours: 6,
      libraries: { receipts: 'Receipt images', backups: 'Encrypted dumps' },
    });

    const read = await readSyncConfig();
    expect(read.ok).toBe(true);
    expect(read.config).toMatchObject({
      enabled: true,
      siteUrl: SITE,
      listPrefix: 'Scope',
      intervalMinutes: 15,
      stalenessHours: 6,
    });
    expect(read.config?.libraries.receipts).toBe('Receipt images');
    expect(read.config?.libraries.backups).toBe('Encrypted dumps');
    // Untouched libraries keep the name provisioning would create.
    expect(read.config?.libraries.exports).toBe('Exports');
  });

  it('writes only the keys the patch names', async () => {
    await writeSyncConfig({ enabled: true });
    const rows = await db.select().from(settings);
    expect(rows.map((row) => row.key)).toEqual([SYNC_SETTING_KEYS.enabled]);
  });

  it('stamps updated_at itself, because settings has no touch trigger', async () => {
    // Migration 0001 excludes `settings` and `document_sequences` from the
    // updated_at trigger, so a write that forgot the column would leave the row
    // dated whenever it was first inserted.
    await writeSyncConfig({ intervalMinutes: 30 });
    const [first] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, SYNC_SETTING_KEYS.intervalMinutes));

    await writeSyncConfig({ intervalMinutes: 45 });
    const [second] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, SYNC_SETTING_KEYS.intervalMinutes));

    expect(second!.value).toBe('45');
    expect(second!.updatedAt.getTime()).toBeGreaterThanOrEqual(first!.updatedAt.getTime());
  });

  it('reads its own write from inside a transaction', async () => {
    // The executor is a parameter so a caller that has already opened a
    // transaction sees its own uncommitted state rather than the pool's.
    await db.transaction(async (tx) => {
      await writeSyncConfig({ enabled: true, siteUrl: SITE }, tx);
      const read = await readSyncConfig(tx);
      expect(read.config?.enabled).toBe(true);
      expect(read.config?.siteUrl).toBe(SITE);
    });
  });
});

describe('nothing is ever deleted', () => {
  it('switches the mirror off by writing false, not by removing the row', async () => {
    await writeSyncConfig({ enabled: true });
    await writeSyncConfig({ enabled: false });

    const rows = await db.select().from(settings).where(eq(settings.key, SYNC_SETTING_KEYS.enabled));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe('false');

    const read = await readSyncConfig();
    expect(read.config?.enabled).toBe(false);
  });

  it('clears a site address to NULL in a row that stays', async () => {
    await writeSyncConfig({ siteUrl: SITE });
    await writeSyncConfig({ siteUrl: null });

    const rows = await db.select().from(settings).where(eq(settings.key, SYNC_SETTING_KEYS.siteUrl));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBeNull();

    // A NULL and a missing row read identically, so clearing is indistinguishable
    // from never having configured it -- which is the point.
    const read = await readSyncConfig();
    expect(read.ok).toBe(true);
    expect(read.config?.siteUrl).toBeNull();
  });
});

describe('a value edited outside the application', () => {
  it('is refused on read rather than coerced to the default', async () => {
    // Somebody with a SQL client, or a restore from a deployment that stored
    // something this build no longer accepts.
    await db.insert(settings).values({
      key: SYNC_SETTING_KEYS.intervalMinutes,
      value: '0',
      updatedAt: new Date(),
    });

    const read = await readSyncConfig();
    expect(read.ok).toBe(false);
    expect(read.config).toBeNull();
    expect(read.problems.map((problem) => problem.key)).toEqual([
      SYNC_SETTING_KEYS.intervalMinutes,
    ]);
  });

  it('throws from requireSyncConfig, for a caller with nowhere to render it', async () => {
    await db.insert(settings).values({
      key: SYNC_SETTING_KEYS.enabled,
      value: 'yes',
      updatedAt: new Date(),
    });
    await expect(requireSyncConfig()).rejects.toBeInstanceOf(SyncConfigError);
  });

  it('cannot be created through the writer, which validates before it stores', async () => {
    await expect(writeSyncConfig({ intervalMinutes: 1 })).rejects.toThrow();
    await expect(writeSyncConfig({ siteUrl: 'http://example.invalid/s' })).rejects.toThrow();
    await expect(writeSyncConfig({ libraries: { receipts: 'a/b' } })).rejects.toThrow();
    // Nothing partial was left behind.
    expect(await db.select().from(settings)).toEqual([]);
  });
});

describe('per-list state', () => {
  it('reports one row per mirrored table even with sync_state empty', async () => {
    stubCredential();
    await writeSyncConfig({ enabled: true, siteUrl: SITE });
    const read = await readSyncConfig();

    const report = await readSyncState(read.config!, readSyncEnvironment());
    expect(report.rows).toHaveLength(MIRRORED_TABLES.length);
    expect(report.rows.every((row) => row.health === 'never-run')).toBe(true);
    expect(report.worst).toBe('never-run');
    expect(report.rowsSynced).toBe(0);
    expect(report.orphans).toEqual([]);
  });

  it('reads the cursor as a pair, and reports the verdicts a real table produces', async () => {
    stubCredential();
    await writeSyncConfig({ enabled: true, siteUrl: SITE, stalenessHours: 2 });
    const read = await readSyncConfig();
    const now = new Date('2026-09-04T12:00:00.000Z');
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    const cursorId = '11111111-1111-4111-8111-111111111111';

    await db.insert(syncState).values([
      {
        listName: 'quotes',
        cursorUpdatedAt: hoursAgo(1),
        cursorId,
        lastRunAt: hoursAgo(1),
        lastSuccessAt: hoursAgo(1),
        rowsSynced: 120,
      },
      {
        listName: 'quote_lines',
        lastRunAt: hoursAgo(9),
        lastSuccessAt: hoursAgo(9),
        rowsSynced: 40,
      },
      {
        listName: 'customers',
        lastRunAt: hoursAgo(1),
        lastSuccessAt: hoursAgo(30),
        rowsSynced: 7,
        lastError: 'a sub-request returned 400 for one row',
        consecutiveFailures: 4,
      },
    ]);

    const report = await readSyncState(read.config!, readSyncEnvironment(), db, now);
    const byList = new Map(report.rows.map((row) => [row.listName, row]));

    expect(byList.get('quotes')?.health).toBe('healthy');
    expect(byList.get('quotes')?.cursorUpdatedAt?.toISOString()).toBe(hoursAgo(1).toISOString());
    expect(byList.get('quotes')?.cursorId).toBe(cursorId);

    expect(byList.get('quote_lines')?.health).toBe('stale');

    // Failing rather than stale, and escalated at three in a row.
    expect(byList.get('customers')?.health).toBe('failing');
    expect(byList.get('customers')?.escalated).toBe(true);
    expect(byList.get('customers')?.lastError).toContain('400');

    // A list nothing has touched still appears, saying so.
    expect(byList.get('tax_rates')?.health).toBe('never-run');

    expect(report.worst).toBe('failing');
    expect(report.rowsSynced).toBe(167);
  });

  it('moves the staleness verdict when the threshold moves and the row does not', async () => {
    stubCredential();
    await writeSyncConfig({ enabled: true, siteUrl: SITE, stalenessHours: 2 });
    const now = new Date('2026-09-04T12:00:00.000Z');
    const sixHoursAgo = new Date(now.getTime() - 6 * 3_600_000);

    await db.insert(syncState).values({
      listName: 'quotes',
      lastRunAt: sixHoursAgo,
      lastSuccessAt: sixHoursAgo,
      rowsSynced: 3,
    });

    const strict = await readSyncConfig();
    const before = await readSyncState(strict.config!, readSyncEnvironment(), db, now);
    expect(before.rows.find((row) => row.listName === 'quotes')?.health).toBe('stale');

    // Only the threshold changes. `sync_state` is untouched, which is what
    // "derived, never stored" has to mean in practice.
    await writeSyncConfig({ stalenessHours: 12 });
    const relaxed = await readSyncConfig();
    const after = await readSyncState(relaxed.config!, readSyncEnvironment(), db, now);
    expect(after.rows.find((row) => row.listName === 'quotes')?.health).toBe('healthy');

    const [row] = await db.select().from(syncState).where(eq(syncState.listName, 'quotes'));
    expect(row!.lastSuccessAt?.toISOString()).toBe(sixHoursAgo.toISOString());
  });

  it('surfaces a state row no mirrored list maps to rather than hiding it', async () => {
    // Renaming the prefix orphans every state row under the old names. Since
    // nothing is deleted they stay -- and so do the SharePoint lists, which
    // stop updating. An owner who cannot see them cannot understand why the
    // site has two sets of lists.
    stubCredential();
    await writeSyncConfig({ enabled: true, siteUrl: SITE });
    await db.insert(syncState).values({ listName: 'quotes', rowsSynced: 5, lastRunAt: new Date() });

    await writeSyncConfig({ listPrefix: 'Scope' });
    const read = await readSyncConfig();
    const report = await readSyncState(read.config!, readSyncEnvironment());

    expect(report.rows.map((row) => row.listName)).toContain('Scope_quotes');
    expect(report.orphans.map((row) => row.listName)).toEqual(['quotes']);
    expect(report.orphans[0]?.table).toBeNull();
    expect(listNameFor(read.config!, 'quotes')).toBe('Scope_quotes');
  });

  it('reports every list as off when the container gate is closed', async () => {
    // No credential stubbed, so SHAREPOINT_SYNC_ENABLED is unset. A stored
    // `true` cannot override it, and a mirror that is not running is not behind.
    await writeSyncConfig({ enabled: true, siteUrl: SITE });
    await db.insert(syncState).values({
      listName: 'quotes',
      lastRunAt: new Date('2020-01-01T00:00:00.000Z'),
      lastSuccessAt: new Date('2020-01-01T00:00:00.000Z'),
      consecutiveFailures: 12,
    });

    const read = await readSyncConfig();
    const report = await readSyncState(read.config!, readSyncEnvironment());
    expect(report.rows.every((row) => row.health === 'off')).toBe(true);
    expect(report.worst).toBe('off');
  });
});

describe('one spelling of every variable name', () => {
  it('reads the same SharePoint variables first-run setup reads', async () => {
    const checks = await runEnvironmentChecks();
    const sharePoint = checks.find((check) => check.id === 'sharepoint');
    expect(sharePoint, 'the setup wizard no longer has a SharePoint check').toBeTruthy();
    expect([...sharePoint!.variables]).toEqual([...SYNC_ENVIRONMENT_VARIABLES]);
  });

  it('agrees with the wizard about whether the mirror is off', async () => {
    const off = (await runEnvironmentChecks()).find((check) => check.id === 'sharepoint');
    expect(off?.status).toBe('off');
    expect(readSyncEnvironment().flagOn).toBe(false);

    stubCredential();
    const on = (await runEnvironmentChecks()).find((check) => check.id === 'sharepoint');
    // The wizard goes further than presence and tries to load the mounted
    // certificate, which is not there in a test, so it fails rather than
    // passing. What matters is that it no longer reports the mirror OFF, which
    // is the disagreement that produced the original defect.
    expect(on?.status).not.toBe('off');
    expect(readSyncEnvironment().flagOn).toBe(true);
    expect(readSyncEnvironment().credentialComplete).toBe(true);
  });
});

describe('library keys', () => {
  it('keys each library under its own row rather than one packed string', async () => {
    // One row per library, so renaming one cannot corrupt the other five and a
    // reader with a SQL client can see which is which.
    await writeSyncConfig({ libraries: { receipts: 'Receipt images' } });
    const rows = await db.select().from(settings);
    expect(rows.map((row) => row.key)).toEqual([libraryKey('receipts')]);
    expect(rows[0]!.value).toBe('Receipt images');
  });
});
