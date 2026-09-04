import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_VARIABLES,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_LIBRARY_NAMES,
  DEFAULT_STALENESS_HOURS,
  LIBRARY_FOR_ATTACHMENT,
  LIBRARY_KINDS,
  MIRRORED_TABLES,
  NOT_MIRRORED_TABLES,
  SYNC_ENVIRONMENT_VARIABLES,
  SYNC_SETTING_KEYS,
  allSyncSettingKeys,
  defaultSyncConfig,
  expectedListNames,
  libraryKey,
  listNameFor,
  mirrorIsOn,
  parseSyncConfig,
  readSyncEnvironment,
  syncReadiness,
} from '@/lib/sync/config';
import {
  ESCALATION_FAILURES,
  HEALTH_LABEL,
  type SyncHealth,
  deriveHealth,
  describeAge,
  worstHealth,
} from '@/lib/sync/state';
import { MIRROR_IS_BUILT, MirrorNotBuiltError, resolveMirror } from '@/lib/sync/mirror';

/**
 * The mirror's configuration and its health verdict, with no database.
 *
 * Everything asserted here is pure -- `db` is a lazy proxy, so importing these
 * modules opens no socket -- and everything here is a rule the design states in
 * words that code can get wrong quietly:
 *
 * 1. Absence is the off state. No default may switch the mirror on for somebody
 *    who never asked, and a stored `true` may not override the container's
 *    gate.
 * 2. An invalid stored value is refused, not coerced. A coerced interval means
 *    a deployment syncing on a schedule nobody chose.
 * 3. Nothing secret passes through the settings table.
 * 4. Staleness is derived from the last success and the configured threshold.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

/** No SharePoint variable set at all: a fresh box, which is the normal case. */
const NO_ENVIRONMENT = { flagOn: false } as const;

function environment(overrides: Partial<ReturnType<typeof readSyncEnvironment>> = {}) {
  const present = Object.fromEntries(
    SYNC_ENVIRONMENT_VARIABLES.map((name) => [name, true]),
  ) as ReturnType<typeof readSyncEnvironment>['present'];
  return {
    flagOn: true,
    present,
    missing: [],
    credentialComplete: true,
    ...overrides,
  } satisfies ReturnType<typeof readSyncEnvironment>;
}

const values = (entries: Record<string, string | null>) =>
  new Map<string, string | null>(Object.entries(entries));

describe('parseSyncConfig: absence is the off state', () => {
  it('reads a database with no sync rows at all as off', () => {
    const read = parseSyncConfig(values({}));
    expect(read.ok).toBe(true);
    expect(read.config?.enabled).toBe(false);
    expect(read.config?.siteUrl).toBeNull();
    expect(read.config?.listPrefix).toBeNull();
  });

  it('defaults the two intervals, because a number cannot switch a mirror on', () => {
    const read = parseSyncConfig(values({}));
    expect(read.config?.intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(read.config?.stalenessHours).toBe(DEFAULT_STALENESS_HOURS);
  });

  it('defaults every library name to the one provisioning creates', () => {
    expect(parseSyncConfig(values({})).config?.libraries).toEqual(DEFAULT_LIBRARY_NAMES);
  });

  it('treats a row present with a NULL value as absent, which is how clearing works', () => {
    // Nothing in this product is deleted, so a cleared field is a NULL in a row
    // that stays. It must read identically to a row that was never written.
    const read = parseSyncConfig(
      values({
        [SYNC_SETTING_KEYS.siteUrl]: null,
        [SYNC_SETTING_KEYS.enabled]: null,
      }),
    );
    expect(read.ok).toBe(true);
    expect(read.config?.siteUrl).toBeNull();
    expect(read.config?.enabled).toBe(false);
  });

  it('treats a blank string the same way', () => {
    const read = parseSyncConfig(values({ [SYNC_SETTING_KEYS.siteUrl]: '   ' }));
    expect(read.ok).toBe(true);
    expect(read.config?.siteUrl).toBeNull();
  });
});

describe('parseSyncConfig: a bad stored value is refused, never coerced', () => {
  const badValues: [string, string, string][] = [
    ['the on/off flag', SYNC_SETTING_KEYS.enabled, 'yes'],
    ['the on/off flag as a number', SYNC_SETTING_KEYS.enabled, '1'],
    ['a site address that is not a URL', SYNC_SETTING_KEYS.siteUrl, 'sharepoint'],
    ['an insecure site address', SYNC_SETTING_KEYS.siteUrl, 'http://example.invalid/sites/x'],
    ['a site address with a query string', SYNC_SETTING_KEYS.siteUrl, 'https://example.invalid/sites/x?a=1'],
    ['a site address with a fragment', SYNC_SETTING_KEYS.siteUrl, 'https://example.invalid/sites/x#top'],
    ['a prefix with punctuation', SYNC_SETTING_KEYS.listPrefix, 'my-prefix'],
    ['a prefix starting with a digit', SYNC_SETTING_KEYS.listPrefix, '1prefix'],
    ['an interval that is not a number', SYNC_SETTING_KEYS.intervalMinutes, 'hourly'],
    ['an interval below the safety lag', SYNC_SETTING_KEYS.intervalMinutes, '1'],
    ['an interval of zero', SYNC_SETTING_KEYS.intervalMinutes, '0'],
    ['a negative interval', SYNC_SETTING_KEYS.intervalMinutes, '-60'],
    ['an interval past a day', SYNC_SETTING_KEYS.intervalMinutes, '100000'],
    ['a fractional interval', SYNC_SETTING_KEYS.intervalMinutes, '60.5'],
    ['a staleness threshold of zero', SYNC_SETTING_KEYS.stalenessHours, '0'],
    ['a staleness threshold past a week', SYNC_SETTING_KEYS.stalenessHours, '1000'],
    ['a library name with a colon', libraryKey('receipts'), 'Receipts: 2026'],
    ['a library name with a slash', libraryKey('exports'), 'Exports/Year end'],
    ['a library name starting with a dot', libraryKey('backups'), '.Backups'],
  ];

  for (const [description, key, value] of badValues) {
    it(`refuses ${description} and returns no configuration at all`, () => {
      const read = parseSyncConfig(values({ [key]: value }));
      expect(read.ok).toBe(false);
      // The whole point: no partially-defaulted configuration comes back, so
      // no caller can act on a value the row does not actually contain.
      expect(read.config).toBeNull();
      expect(read.problems.map((problem) => problem.key)).toContain(key);
      expect(read.problems[0]?.label).toBeTruthy();
      expect(read.problems[0]?.message).toBeTruthy();
    });
  }

  it('reports every bad row at once rather than only the first', () => {
    const read = parseSyncConfig(
      values({
        [SYNC_SETTING_KEYS.enabled]: 'maybe',
        [SYNC_SETTING_KEYS.intervalMinutes]: '0',
        [libraryKey('receipts')]: 'a|b',
      }),
    );
    expect(read.ok).toBe(false);
    expect(read.problems).toHaveLength(3);
  });

  it('does not fall back to the default for the field that was wrong', () => {
    // The failure this asserts against: reading `0` as sixty. A caller that got
    // a config back would sync on an interval nobody chose and no screen shows.
    const read = parseSyncConfig(values({ [SYNC_SETTING_KEYS.intervalMinutes]: '0' }));
    expect(read.config).toBeNull();
    expect(defaultSyncConfig().intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
  });
});

describe('parseSyncConfig: valid values', () => {
  it('accepts the values this module itself writes', () => {
    const read = parseSyncConfig(
      values({
        [SYNC_SETTING_KEYS.enabled]: 'true',
        [SYNC_SETTING_KEYS.siteUrl]: 'https://example.invalid/sites/records',
        [SYNC_SETTING_KEYS.listPrefix]: 'Scope',
        [SYNC_SETTING_KEYS.intervalMinutes]: '30',
        [SYNC_SETTING_KEYS.stalenessHours]: '4',
        [libraryKey('receipts')]: 'Receipt images',
      }),
    );
    expect(read.ok).toBe(true);
    expect(read.config).toMatchObject({
      enabled: true,
      siteUrl: 'https://example.invalid/sites/records',
      listPrefix: 'Scope',
      intervalMinutes: 30,
      stalenessHours: 4,
    });
    expect(read.config?.libraries.receipts).toBe('Receipt images');
  });

  it('strips a trailing slash, because every Graph path is built from this string', () => {
    const read = parseSyncConfig(
      values({ [SYNC_SETTING_KEYS.siteUrl]: 'https://example.invalid/sites/records/' }),
    );
    expect(read.config?.siteUrl).toBe('https://example.invalid/sites/records');
  });

  it('accepts false as an explicitly stored off state', () => {
    // Switching the mirror off writes `false`; it does not delete the row.
    const read = parseSyncConfig(values({ [SYNC_SETTING_KEYS.enabled]: 'false' }));
    expect(read.ok).toBe(true);
    expect(read.config?.enabled).toBe(false);
  });
});

describe('list names', () => {
  it('names a list after its table when there is no prefix', () => {
    expect(listNameFor(defaultSyncConfig(), 'quote_lines')).toBe('quote_lines');
  });

  it('applies the prefix when there is one', () => {
    const config = { ...defaultSyncConfig(), listPrefix: 'Scope' };
    expect(listNameFor(config, 'quote_lines')).toBe('Scope_quote_lines');
  });

  it('expects one list per mirrored table', () => {
    expect(expectedListNames(defaultSyncConfig())).toHaveLength(MIRRORED_TABLES.length);
  });

  it('never expects a list for a table the design excludes', () => {
    const expected = new Set<string>(expectedListNames(defaultSyncConfig()));
    for (const table of NOT_MIRRORED_TABLES) {
      expect(expected.has(table)).toBe(false);
    }
  });
});

describe('nothing secret passes through the settings table', () => {
  /**
   * The structural rule, asserted mechanically.
   *
   * A `settings` row is dumped into every backup, and the mirrored tables reach
   * SharePoint. An earlier draft kept the Graph credentials in a database table
   * alongside the flag that gated them, which would have synced them to the
   * very site they authenticate against. A test is the only thing that stops
   * that being re-added by somebody adding "one more field".
   */
  const FORBIDDEN = /tenant|client|cert|thumbprint|secret|password|credential|token/i;

  it('defines no settings key that names a credential', () => {
    for (const key of allSyncSettingKeys()) {
      expect(key, `${key} looks like a credential`).not.toMatch(FORBIDDEN);
    }
  });

  it('keeps the credential in the environment, where the four names are', () => {
    for (const name of CREDENTIAL_VARIABLES) {
      expect(SYNC_ENVIRONMENT_VARIABLES).toContain(name);
    }
  });

  it('reports the environment as booleans and never returns a value', () => {
    // Sentinels chosen so a leaked value is unmistakable in the serialised
    // result. Presence is all this function is allowed to answer.
    vi.stubEnv('SHAREPOINT_SYNC_ENABLED', '1');
    vi.stubEnv('SHAREPOINT_TENANT_ID', 'leaked-tenant-sentinel');
    vi.stubEnv('SHAREPOINT_CLIENT_ID', 'leaked-client-sentinel');
    vi.stubEnv('SHAREPOINT_CERT_PATH', '/run/secrets/leaked-path-sentinel');
    vi.stubEnv('SHAREPOINT_CERT_THUMBPRINT', 'leaked-thumbprint-sentinel');

    const report = readSyncEnvironment();
    expect(JSON.stringify(report)).not.toMatch(/sentinel/);
    expect(report.credentialComplete).toBe(true);
    expect(report.missing).toEqual([]);
  });
});

describe('readSyncEnvironment', () => {
  it('reads a fresh box as off with nothing supplied', () => {
    const report = readSyncEnvironment();
    expect(report.flagOn).toBe(false);
    expect(report.credentialComplete).toBe(false);
    expect(report.missing).toEqual([...CREDENTIAL_VARIABLES]);
  });

  it('treats zero and false as off, matching the shell rule the backup job uses', () => {
    // A stricter rule here would let this screen report a mirror off that the
    // backup script counts as on.
    vi.stubEnv('SHAREPOINT_SYNC_ENABLED', '0');
    expect(readSyncEnvironment().flagOn).toBe(false);
    vi.stubEnv('SHAREPOINT_SYNC_ENABLED', 'false');
    expect(readSyncEnvironment().flagOn).toBe(false);
    vi.stubEnv('SHAREPOINT_SYNC_ENABLED', 'FALSE');
    expect(readSyncEnvironment().flagOn).toBe(false);
    vi.stubEnv('SHAREPOINT_SYNC_ENABLED', '  ');
    expect(readSyncEnvironment().flagOn).toBe(false);
  });

  it('treats anything else as on', () => {
    vi.stubEnv('SHAREPOINT_SYNC_ENABLED', '1');
    expect(readSyncEnvironment().flagOn).toBe(true);
    vi.stubEnv('SHAREPOINT_SYNC_ENABLED', 'true');
    expect(readSyncEnvironment().flagOn).toBe(true);
  });

  it('names which credential variables are missing, one by one', () => {
    vi.stubEnv('SHAREPOINT_TENANT_ID', 'x');
    vi.stubEnv('SHAREPOINT_CLIENT_ID', 'x');
    const report = readSyncEnvironment();
    expect(report.missing).toEqual(['SHAREPOINT_CERT_PATH', 'SHAREPOINT_CERT_THUMBPRINT']);
    expect(report.present.SHAREPOINT_TENANT_ID).toBe(true);
    expect(report.present.SHAREPOINT_CERT_PATH).toBe(false);
  });
});

describe('syncReadiness: two gates, and the environment wins', () => {
  it('reports the container gate first, even with the mirror switched on here', () => {
    // The restored-dump case. A tenant that used the mirror leaves
    // `sync.enabled = true` in the dump; restoring it onto a box with no
    // credential must not start pushing this company's records anywhere.
    const config = { ...defaultSyncConfig(), enabled: true, siteUrl: 'https://example.invalid/s' };
    const readiness = syncReadiness(config, {
      ...environment(),
      ...NO_ENVIRONMENT,
    });
    expect(readiness).toBe('environment-off');
    expect(mirrorIsOn(config, { ...environment(), ...NO_ENVIRONMENT })).toBe(false);
  });

  it('reports that nobody asked when the container permits it and no row says so', () => {
    expect(syncReadiness(defaultSyncConfig(), environment())).toBe('not-requested');
  });

  it('reports a missing credential before a missing site', () => {
    const config = { ...defaultSyncConfig(), enabled: true };
    expect(
      syncReadiness(config, environment({ credentialComplete: false, missing: ['SHAREPOINT_CERT_PATH'] })),
    ).toBe('credential-missing');
  });

  it('reports a missing site once the credential is complete', () => {
    const config = { ...defaultSyncConfig(), enabled: true };
    expect(syncReadiness(config, environment())).toBe('site-missing');
  });

  it('is ready only when both gates are open and there is somewhere to write', () => {
    const config = {
      ...defaultSyncConfig(),
      enabled: true,
      siteUrl: 'https://example.invalid/sites/records',
    };
    expect(syncReadiness(config, environment())).toBe('ready');
    expect(mirrorIsOn(config, environment())).toBe(true);
  });
});

describe('deriveHealth', () => {
  const now = new Date('2026-09-04T12:00:00.000Z');
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  it('is off when the mirror is off, whatever the row says', () => {
    // A red cross beside a feature the owner deliberately declined teaches him
    // to ignore red, which is the one thing this screen cannot afford.
    expect(
      deriveHealth({
        enabled: false,
        lastRunAt: hoursAgo(500),
        lastSuccessAt: hoursAgo(500),
        consecutiveFailures: 9,
        stalenessHours: 2,
        now,
      }),
    ).toBe('off');
  });

  it('is never-run when the mirror is on and nothing has been attempted', () => {
    expect(
      deriveHealth({
        enabled: true,
        lastRunAt: null,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        stalenessHours: 2,
        now,
      }),
    ).toBe('never-run');
  });

  it('is healthy inside the threshold', () => {
    expect(
      deriveHealth({
        enabled: true,
        lastRunAt: hoursAgo(1),
        lastSuccessAt: hoursAgo(1),
        consecutiveFailures: 0,
        stalenessHours: 2,
        now,
      }),
    ).toBe('healthy');
  });

  it('is still healthy exactly at the threshold, and stale one millisecond past it', () => {
    const base = {
      enabled: true,
      lastRunAt: hoursAgo(2),
      consecutiveFailures: 0,
      stalenessHours: 2,
      now,
    };
    expect(deriveHealth({ ...base, lastSuccessAt: hoursAgo(2) })).toBe('healthy');
    expect(
      deriveHealth({ ...base, lastSuccessAt: new Date(hoursAgo(2).getTime() - 1) }),
    ).toBe('stale');
  });

  it('derives staleness from the configured threshold and not from a stored flag', () => {
    // The same row, two thresholds, two verdicts. Nothing about the row
    // changed, which is what "derived, never stored" means.
    const row = {
      enabled: true,
      lastRunAt: hoursAgo(6),
      lastSuccessAt: hoursAgo(6),
      consecutiveFailures: 0,
      now,
    };
    expect(deriveHealth({ ...row, stalenessHours: 2 })).toBe('stale');
    expect(deriveHealth({ ...row, stalenessHours: 12 })).toBe('healthy');
  });

  it('is failing on a single recorded failure, however recent the last success', () => {
    expect(
      deriveHealth({
        enabled: true,
        lastRunAt: hoursAgo(0.1),
        lastSuccessAt: hoursAgo(0.2),
        consecutiveFailures: 1,
        stalenessHours: 2,
        now,
      }),
    ).toBe('failing');
  });

  it('reports failing rather than stale when it is both', () => {
    // A month of failures is both. Failing is the actionable half: it carries a
    // message. The screen prints the age of the last success beside it, so this
    // cannot read as a hiccup.
    expect(
      deriveHealth({
        enabled: true,
        lastRunAt: hoursAgo(1),
        lastSuccessAt: hoursAgo(720),
        consecutiveFailures: 40,
        stalenessHours: 2,
        now,
      }),
    ).toBe('failing');
  });

  it('reports a run that produced no success as stale rather than healthy', () => {
    expect(
      deriveHealth({
        enabled: true,
        lastRunAt: hoursAgo(1),
        lastSuccessAt: null,
        consecutiveFailures: 0,
        stalenessHours: 2,
        now,
      }),
    ).toBe('stale');
  });

  it('escalates at three consecutive failures', () => {
    expect(ESCALATION_FAILURES).toBe(3);
  });
});

describe('worstHealth', () => {
  it('picks the verdict that needs attention rather than the commonest one', () => {
    expect(worstHealth(['healthy', 'healthy', 'stale'])).toBe('stale');
    expect(worstHealth(['stale', 'failing', 'healthy'])).toBe('failing');
    expect(worstHealth(['off', 'off'])).toBe('off');
    expect(worstHealth(['off', 'never-run'])).toBe('never-run');
  });

  it('words every verdict, so colour is never carrying the meaning alone', () => {
    const verdicts: SyncHealth[] = ['off', 'never-run', 'healthy', 'stale', 'failing'];
    for (const verdict of verdicts) expect(HEALTH_LABEL[verdict]).toBeTruthy();
  });
});

describe('describeAge', () => {
  it('says never when there has never been a success', () => {
    expect(describeAge(null)).toBe('never');
  });

  it('reads as a duration a person can act on', () => {
    expect(describeAge(30_000)).toBe('less than a minute ago');
    expect(describeAge(60_000)).toBe('1 minute ago');
    expect(describeAge(5 * 60_000)).toBe('5 minutes ago');
    expect(describeAge(3_600_000)).toBe('1 hour ago');
    expect(describeAge(5 * 3_600_000)).toBe('5 hours ago');
    expect(describeAge(72 * 3_600_000)).toBe('3 days ago');
  });
});

describe('the mirror seam', () => {
  it('says it is not built, so no screen has to guess', () => {
    expect(MIRROR_IS_BUILT).toBe(false);
  });

  it('throws a named error rather than doing nothing', async () => {
    // A silent stub is the worse failure: sync_state would fill with successes,
    // the screen would show green, and the owner would believe he had an
    // offsite copy of his tax records that had never existed.
    const mirror = resolveMirror();
    await expect(mirror.upsertRows('quotes', [])).rejects.toBeInstanceOf(MirrorNotBuiltError);
    await expect(
      mirror.advanceCursor('quotes', { updatedAt: new Date(), id: 'x' }),
    ).rejects.toBeInstanceOf(MirrorNotBuiltError);
    await expect(mirror.mapItemId('quotes', 'x')).rejects.toBeInstanceOf(MirrorNotBuiltError);
  });

  it('explains itself in the message, because this may reach a screen', async () => {
    await expect(resolveMirror().upsertRows('quotes', [])).rejects.toThrow(/not built yet/);
  });
});

describe('attachment routing', () => {
  it('routes every library kind it names to a library that exists', () => {
    for (const library of Object.values(LIBRARY_FOR_ATTACHMENT)) {
      if (library === null) continue;
      expect(LIBRARY_KINDS).toContain(library);
    }
  });

  it('leaves a kind the design names no library for unrouted rather than guessing', () => {
    // Guessing ProjectFiles would put a company logo in the library an
    // accountant filters by project.
    expect(LIBRARY_FOR_ATTACHMENT.organization).toBeNull();
    expect(LIBRARY_FOR_ATTACHMENT.customer).toBeNull();
  });

  it('files purchase orders with vendor invoices, as section 7.4 does', () => {
    expect(LIBRARY_FOR_ATTACHMENT.purchase_order).toBe('vendor_invoices');
    expect(LIBRARY_FOR_ATTACHMENT.vendor_invoice).toBe('vendor_invoices');
  });
});
