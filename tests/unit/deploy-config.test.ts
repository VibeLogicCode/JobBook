import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ManagedKey,
  AuthConfigRefused,
  MANAGED_KEYS,
  REFUSED_AUTH_MODE,
  authConfigPath,
  compareToProcessEnv,
  configState,
  emitAuthConfig,
  isSecretKey,
  parseAuthConfig,
  readAuthConfig,
  redactAuthConfig,
  writeAuthConfig,
} from '@/lib/deploy/auth-config';
import {
  POSTURE_KEYS,
  entriesForPosture,
  isMultiTenantEndpoint,
  newCookieSecret,
  postureOfEntries,
  restartPlan,
} from '@/lib/deploy/posture';

/**
 * The deployment configuration file, with no database and no wizard.
 *
 * Everything here is a rule the design states in words that code can get wrong
 * quietly, and three of them are security boundaries rather than conveniences:
 *
 * 1. `AUTH_MODE=local` cannot be written and is not honoured if it appears.
 *    Local mode treats every visitor as one named user, so a mode selected by
 *    a file the application itself can write would turn one file write inside
 *    the app into a promotion from an ordinary user to owner.
 * 2. Only the keys the access step manages are honoured. A line naming
 *    `DATABASE_URL` is dropped, so a write into this file cannot reach the
 *    rest of the deployment.
 * 3. A secret never comes back out. The summariser reports presence and
 *    length, and no path through it returns the value.
 *
 * And one correctness rule that is not a boundary but breaks sign-in when it
 * is wrong: the round trip. A client secret with a space, a quote or a `$` in
 * it has to arrive at the runtime as the provider issued it, so the emitter is
 * tested against an independent reimplementation of what `docker/entrypoint.sh`
 * actually does with these lines — not only against our own parser, which
 * would agree with a shared mistake.
 */

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'deploy-config-'));
  vi.stubEnv('DEPLOY_CONFIG_PATH', path.join(scratch, 'auth.env'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(scratch, { recursive: true, force: true });
});

/**
 * What `docker/entrypoint.sh` does with a line, reimplemented here.
 *
 * An independent oracle on purpose. Round-tripping a value through our own
 * emitter and our own parser proves they agree with each other, which is
 * exactly what two halves of one mistake also do. The shell is the reader that
 * matters, because it is the one that puts these values into the process the
 * application runs in, and its rule is unusual: it splits at the first `=`,
 * strips one leading and one trailing quote as PLAIN TEXT, and never evaluates
 * anything. So no escape sequence may appear in the file — a `\"` would arrive
 * at the runtime as a literal backslash and quote.
 */
function readAsEntrypointDoes(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    // A line with no `=` is degenerate in the shell too and the writer cannot
    // produce one; skipped rather than modelled.
    if (at < 0) continue;
    const key = line.slice(0, at);
    let value = line.slice(at + 1);
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    for (const quote of ['"', "'"]) {
      if (value.startsWith(quote) && value.endsWith(quote)) {
        value = value.slice(1, -1);
        break;
      }
    }
    if (key === 'AUTH_MODE' && value === 'local') continue;
    found.set(key, value);
  }
  return found;
}

/** Awkward values that are all legal in a client secret. */
const AWKWARD: Record<string, string> = {
  space: 'two words here',
  double: 'has a " in it',
  single: "has a ' in it",
  dollar: 'has a $HOME and a $(command) in it',
  backslash: 'ends with a backslash \\',
  brace: 'has ${braces} and `backticks`',
  semicolon: 'a; rm -rf /; b',
  hash: 'a # not a comment',
  equals: 'a=b=c',
  unicode: 'naïve — em dash and ümlaut',
  padded: '  leading and trailing  ',
};

describe('the file format', () => {
  it('round-trips an awkward value through the shell reader that boots the app', () => {
    for (const [name, value] of Object.entries(AWKWARD)) {
      const text = emitAuthConfig({ GOOGLE_CLIENT_SECRET: value });
      expect(readAsEntrypointDoes(text).get('GOOGLE_CLIENT_SECRET'), name).toBe(value);
      // And through our own parser, which has to agree with the shell.
      expect(parseAuthConfig(text).entries.get('GOOGLE_CLIENT_SECRET'), name).toBe(value);
    }
  });

  it('emits one layer of quotes and no escape sequences at all', () => {
    // The escaping a shell would normally need is precisely what would break
    // this file: nothing on the reading side unescapes, so a backslash added
    // here arrives in the running process as a backslash.
    const text = emitAuthConfig({ GOOGLE_CLIENT_SECRET: 'has a " in it' });
    expect(text).toContain('GOOGLE_CLIENT_SECRET="has a " in it"');
    expect(text).not.toContain('\\"');
  });

  it('writes LF only, so a value does not pick up a carriage return', () => {
    // Written from a Windows workstation as often as from the container. A
    // CR left on the end of the line becomes part of the value in the shell,
    // and a client secret with an invisible CR fails at the provider with a
    // message about the secret being wrong.
    const text = emitAuthConfig({ AUTH_MODE: 'sso', APP_PUBLIC_URL: 'https://example.test' });
    expect(text).not.toContain('\r');
    expect(readAsEntrypointDoes(text).get('APP_PUBLIC_URL')).toBe('https://example.test');
  });

  it('refuses a value carrying a line break rather than storing it truncated', () => {
    // A credential cut short at a newline fails at sign-in with nothing to
    // point at, which is worse than a refusal at the moment of pasting.
    expect(() => emitAuthConfig({ TUNNEL_TOKEN: 'first line\nsecond line' })).toThrow(
      AuthConfigRefused,
    );
    expect(() => emitAuthConfig({ TUNNEL_TOKEN: 'carriage\rreturn' })).toThrow(AuthConfigRefused);
    expect(() => emitAuthConfig({ TUNNEL_TOKEN: 'null\0byte' })).toThrow(AuthConfigRefused);
  });

  it('treats a blank value as absent rather than writing an empty assignment', () => {
    const text = emitAuthConfig({ AUTH_MODE: 'sso', GOOGLE_CLIENT_ID: '   ' });
    expect(text).not.toContain('GOOGLE_CLIENT_ID');
    expect([...parseAuthConfig(text).entries.keys()]).toEqual(['AUTH_MODE']);
  });

  it('is byte-stable for the same input, so a diff shows a change and not a reshuffle', () => {
    const when = new Date(0);
    const first = emitAuthConfig({ GOOGLE_CLIENT_ID: 'a', AUTH_MODE: 'sso' }, when);
    const second = emitAuthConfig({ AUTH_MODE: 'sso', GOOGLE_CLIENT_ID: 'a' }, when);
    expect(first).toBe(second);
  });

  it('carries a header saying what wrote it, when, and that it is read at boot', () => {
    const text = emitAuthConfig({ AUTH_MODE: 'sso' }, new Date(86_400_000));
    expect(text).toContain('generated by Scopeline first-run setup');
    expect(text).toContain('READ AT BOOT');
    // The stamp is machine readable, so the report can say when without a
    // second file beside this one holding the metadata.
    expect(parseAuthConfig(text).writtenAt).toBe(new Date(86_400_000).toISOString());
  });

  it('says in the file itself why this is not a settings row', () => {
    // Somebody finds this file on a volume in two years. The two questions
    // then are "may I edit this" and "why is my change doing nothing", and the
    // third is why it is not in the database with everything else.
    const text = emitAuthConfig({ AUTH_MODE: 'sso' });
    expect(text).toContain('mirrored to SharePoint');
    expect(text).toContain('0600');
  });

  it('ignores comments, blank lines and a line that is not an assignment', () => {
    const parsed = parseAuthConfig(
      ['# a comment', '', '   ', 'not an assignment', 'AUTH_MODE="sso"'].join('\n'),
    );
    expect(parsed.entries.get('AUTH_MODE')).toBe('sso');
    expect(parsed.dropped.map((line) => line.reason)).toContain('malformed');
  });

  it('accepts single quotes too, because the boot reader does', () => {
    expect(parseAuthConfig("APP_PUBLIC_URL='https://example.test'").entries.get('APP_PUBLIC_URL'))
      .toBe('https://example.test');
  });

  it('lets the last assignment win, as a shell would', () => {
    const parsed = parseAuthConfig(['MICROSOFT_TENANT_ID="first"', 'MICROSOFT_TENANT_ID="second"'].join('\n'));
    expect(parsed.entries.get('MICROSOFT_TENANT_ID')).toBe('second');
  });
});

describe('the file may tighten and never loosen', () => {
  it('refuses to WRITE AUTH_MODE=local, naming the escalation it prevents', () => {
    let thrown: unknown;
    try {
      emitAuthConfig({ AUTH_MODE: REFUSED_AUTH_MODE });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AuthConfigRefused);
    // The message is the point as much as the refusal: the next person to hit
    // it has to understand that it is a boundary and not a bug.
    expect((thrown as Error).message).toContain('promotion to owner');
  });

  it('leaves no file at all when the write is refused', async () => {
    await expect(writeAuthConfig({ AUTH_MODE: REFUSED_AUTH_MODE })).rejects.toBeInstanceOf(
      AuthConfigRefused,
    );
    // Not a partial file and not a temporary one: the emitter runs before
    // anything touches the disk.
    expect(await readdir(scratch)).toEqual([]);
    expect(await readAuthConfig()).toBeNull();
  });

  it('DROPS AUTH_MODE=local if it somehow appears in the file', () => {
    // The second of three refusals. A hand edit, a restored file from another
    // deployment, or a write that should not have happened: whatever put it
    // there, it is not honoured.
    const parsed = parseAuthConfig(
      ['AUTH_MODE="local"', 'LOCAL_USER_EMAIL="somebody@example.test"'].join('\n'),
    );
    expect(parsed.entries.has('AUTH_MODE')).toBe(false);
    expect(parsed.dropped.map((line) => line.key)).toContain('AUTH_MODE');
    expect(parsed.dropped[0]?.reason).toBe('refused-value');
    // The address on its own grants nothing, so it is kept. That is the whole
    // arrangement: the wizard writes this half, the operator writes the other.
    expect(parsed.entries.get('LOCAL_USER_EMAIL')).toBe('somebody@example.test');
  });

  it('drops it from a file that is read back off the disk, not only from a string', async () => {
    await writeFile(
      path.join(scratch, 'auth.env'),
      ['AUTH_MODE="local"', 'APP_PUBLIC_URL="https://example.test"'].join('\n'),
    );
    const file = await readAuthConfig();
    expect(file?.entries.has('AUTH_MODE')).toBe(false);
    expect(file?.entries.get('APP_PUBLIC_URL')).toBe('https://example.test');
  });

  it('still honours the two modes that cannot loosen anything', () => {
    expect(parseAuthConfig('AUTH_MODE="access"').entries.get('AUTH_MODE')).toBe('access');
    expect(parseAuthConfig('AUTH_MODE="sso"').entries.get('AUTH_MODE')).toBe('sso');
  });

  it('drops a key this file does not manage, so a write here reaches nothing else', () => {
    const parsed = parseAuthConfig(
      [
        'DATABASE_URL="postgres://elsewhere/quote"',
        'INTERNAL_RENDER_SECRET="a-long-enough-random-string"',
        'PATH="/tmp"',
        'AUTH_MODE="sso"',
      ].join('\n'),
    );
    expect([...parsed.entries.keys()]).toEqual(['AUTH_MODE']);
    expect(parsed.dropped.filter((line) => line.reason === 'not-managed').map((line) => line.key))
      .toEqual(['DATABASE_URL', 'INTERNAL_RENDER_SECRET', 'PATH']);
  });

  it('cannot emit a key outside the allowlist even if one is handed to it', () => {
    // TypeScript forbids this at the call site; the runtime has to as well,
    // because a plain object arriving from anywhere is not type-checked.
    const smuggled = { AUTH_MODE: 'sso', DATABASE_URL: 'postgres://elsewhere/quote' };
    const text = emitAuthConfig(smuggled as Parameters<typeof emitAuthConfig>[0]);
    expect(text).not.toContain('DATABASE_URL');
  });
});

describe('writing', () => {
  it('creates the directory and the file, and leaves no temporary behind', async () => {
    vi.stubEnv('DEPLOY_CONFIG_PATH', path.join(scratch, 'nested', 'deeper', 'auth.env'));
    const written = await writeAuthConfig({ AUTH_MODE: 'sso', APP_PUBLIC_URL: 'https://example.test' });

    expect(written.keys).toEqual(['AUTH_MODE', 'APP_PUBLIC_URL']);
    // The write goes to a temporary file and is renamed, so a crash mid-write
    // cannot leave a half-parsed config. What must not survive is the
    // temporary file itself.
    expect(await readdir(path.join(scratch, 'nested', 'deeper'))).toEqual(['auth.env']);
  });

  it('reports mode 0600 where the platform reports permissions at all', async () => {
    const written = await writeAuthConfig({ AUTH_MODE: 'sso' });

    if (process.platform === 'win32') {
      // Windows reports 0666 or 0444 for every file regardless of any ACL, so
      // asserting 0600 there would be asserting a fiction. Null says the
      // platform cannot answer rather than inventing a number.
      expect(written.mode).toBeNull();
      return;
    }
    expect(written.mode).toBe(0o600);
    // Read back off the disk as well: the mode passed to writeFile is masked
    // by the process umask, which is why the writer chmods explicitly.
    const info = await stat(written.path);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('replaces the file wholesale rather than merging postures', async () => {
    // Merging would leave Access configuration and SSO credentials both
    // present, and `assertModeIsCoherent` refuses to BOOT in that state — a
    // deployment that will not start, after a step that said it had saved.
    await writeAuthConfig(entriesForPosture({
      posture: 'tunnel',
      teamDomain: 'https://team.example.test',
      accessAud: 'an-audience-tag',
      tunnelToken: 'a-tunnel-token',
    }));
    await writeAuthConfig(entriesForPosture({
      posture: 'sso',
      publicUrl: 'https://example.test',
      google: { clientId: 'an-id', clientSecret: 'a secret with a space' },
      microsoft: null,
    }));

    const file = await readAuthConfig();
    expect(file?.entries.has('CF_ACCESS_TEAM_DOMAIN')).toBe(false);
    expect(file?.entries.has('TUNNEL_TOKEN')).toBe(false);
    expect(file?.entries.get('AUTH_MODE')).toBe('sso');
    expect(file?.entries.get('GOOGLE_CLIENT_SECRET')).toBe('a secret with a space');
  });

  it('reads back as null when there is no file, which is an ordinary answer', async () => {
    expect(await readAuthConfig()).toBeNull();
  });

  it('defaults to a path under the repository outside the container', () => {
    vi.stubEnv('DEPLOY_CONFIG_PATH', '');
    vi.stubEnv('NODE_ENV', 'development');
    // `.data` is gitignored, so a locally written config cannot be committed
    // by accident — which for a file of credentials is the point.
    expect(authConfigPath()).toBe(path.resolve(process.cwd(), '.data', 'config', 'auth.env'));
  });

  it('defaults to the container volume in production', () => {
    vi.stubEnv('DEPLOY_CONFIG_PATH', '');
    vi.stubEnv('NODE_ENV', 'production');
    // Literal, and deliberately not run through path.resolve: this is the
    // mount point inside a Linux container, and resolving it on a Windows
    // workstation would turn it into C:\data\config\auth.env — a path that
    // exists nowhere and would send a developer hunting for a volume.
    expect(authConfigPath()).toBe('/data/config/auth.env');
  });
});

describe('redaction', () => {
  const entries = new Map<ManagedKey, string>([
    ['AUTH_MODE', 'sso'],
    ['APP_PUBLIC_URL', 'https://example.test'],
    ['GOOGLE_CLIENT_ID', 'an-identifier'],
    ['GOOGLE_CLIENT_SECRET', 'a-secret-nobody-may-see'],
    ['SSO_COOKIE_SECRET', 'another-secret-nobody-may-see'],
  ]);

  it('never returns a secret, by any key', () => {
    const rows = redactAuthConfig(entries);
    for (const row of rows) {
      if (row.secret) expect(row.value).toBeNull();
    }
    // Belt and braces: the serialised form of the whole summary must not
    // contain the secret anywhere, whatever field it might have leaked into.
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('a-secret-nobody-may-see');
    expect(serialised).not.toContain('another-secret-nobody-may-see');
  });

  it('reports presence and length, which is what an installer needs', () => {
    const row = redactAuthConfig(entries).find((entry) => entry.key === 'GOOGLE_CLIENT_SECRET');
    expect(row?.present).toBe(true);
    // Length distinguishes the two failures that actually happen: a value that
    // never arrived, and one the console's copy button truncated.
    expect(row?.length).toBe('a-secret-nobody-may-see'.length);
  });

  it('shows an identifier, because that is how a paste is confirmed', () => {
    const rows = redactAuthConfig(entries);
    expect(rows.find((entry) => entry.key === 'GOOGLE_CLIENT_ID')?.value).toBe('an-identifier');
    expect(rows.find((entry) => entry.key === 'APP_PUBLIC_URL')?.value).toBe('https://example.test');
  });

  it('reports an absent key as absent rather than omitting the row', () => {
    const rows = redactAuthConfig(entries, ['MICROSOFT_CLIENT_SECRET']);
    expect(rows[0]?.present).toBe(false);
    expect(rows[0]?.length).toBe(0);
    expect(rows[0]?.value).toBeNull();
  });

  /**
   * Every managed key, classified by hand.
   *
   * A table rather than a loop, and asserted to cover `MANAGED_KEYS` exactly,
   * so adding a key to the file's allowlist without deciding whether it is a
   * credential fails here. That is the failure worth engineering for: the
   * decision is easy and forgetting to make it is what puts a secret on a
   * screen.
   */
  const CLASSIFICATION: Record<ManagedKey, boolean> = {
    AUTH_MODE: false,
    LOCAL_USER_EMAIL: false,
    // A RECIPIENT. The machine holds a key it cannot decrypt with, which is
    // the entire design, so showing it back is how an operator confirms the
    // deployment encrypts to the key he kept. The private half never reaches
    // this file -- `lib/backup/age-key.ts` says why.
    BACKUP_AGE_PUBLIC_KEY: false,
    CF_ACCESS_TEAM_DOMAIN: false,
    CF_ACCESS_AUD: false,
    TUNNEL_TOKEN: true,
    APP_PUBLIC_URL: false,
    SSO_COOKIE_SECRET: true,
    GOOGLE_CLIENT_ID: false,
    GOOGLE_CLIENT_SECRET: true,
    MICROSOFT_CLIENT_ID: false,
    MICROSOFT_CLIENT_SECRET: true,
    MICROSOFT_TENANT_ID: false,
  };

  it('classifies every managed key deliberately', () => {
    expect(Object.keys(CLASSIFICATION).sort()).toEqual([...MANAGED_KEYS].sort());
    for (const [key, secret] of Object.entries(CLASSIFICATION)) {
      expect(isSecretKey(key), key).toBe(secret);
    }
  });

  it('treats a key nobody has classified as a secret', () => {
    // Fail closed on disclosure: over-redacting costs a duller screen, and
    // under-redacting puts a client secret in a server-rendered page, a
    // browser cache and somebody's screenshot.
    expect(isSecretKey('SOMETHING_NOBODY_HAS_CLASSIFIED')).toBe(true);
    expect(isSecretKey('')).toBe(true);
  });
});

describe('configured on disk versus in effect', () => {
  const entries = new Map<ManagedKey, string>([
    ['AUTH_MODE', 'sso'],
    ['APP_PUBLIC_URL', 'https://example.test'],
  ]);

  it('calls a key in effect when this process is running that exact value', () => {
    const effects = compareToProcessEnv(entries, {
      AUTH_MODE: 'sso',
      APP_PUBLIC_URL: 'https://example.test',
    });
    expect(effects.map((entry) => entry.effect)).toEqual(['in-effect', 'in-effect']);
    expect(configState(effects)).toBe('in-effect');
  });

  it('calls it awaiting a restart when the process has no value for it', () => {
    // The whole reason this comparison exists: a process's environment is
    // fixed when it starts, the file is read at boot, so a file written now
    // does nothing until the container comes back.
    const effects = compareToProcessEnv(entries, { AUTH_MODE: 'sso' });
    expect(effects.find((entry) => entry.key === 'APP_PUBLIC_URL')?.effect).toBe('awaiting-restart');
    expect(configState(effects)).toBe('awaiting-restart');
  });

  it('treats an empty environment value as no value, as the boot reader does', () => {
    const effects = compareToProcessEnv(entries, { AUTH_MODE: 'sso', APP_PUBLIC_URL: '  ' });
    expect(effects.find((entry) => entry.key === 'APP_PUBLIC_URL')?.effect).toBe('awaiting-restart');
  });

  it('calls it overridden when the environment names something else', () => {
    const effects = compareToProcessEnv(entries, {
      AUTH_MODE: 'access',
      APP_PUBLIC_URL: 'https://example.test',
    });
    expect(effects.find((entry) => entry.key === 'AUTH_MODE')?.effect).toBe('overridden');
    expect(configState(effects)).toBe('overridden');
  });

  it('ranks awaiting-restart above overridden, because only one is an action', () => {
    const effects = compareToProcessEnv(entries, { AUTH_MODE: 'access' });
    expect(configState(effects)).toBe('awaiting-restart');
  });

  it('reports an empty file as empty rather than as in effect', () => {
    expect(configState(compareToProcessEnv(new Map(), {}))).toBe('empty');
  });
});

describe('the three postures', () => {
  it('writes the local address for the office-network posture and NOT the mode', () => {
    const entries = entriesForPosture({ posture: 'lan', localUserEmail: 'owner@example.test' });
    // The interlock, stated as an assertion. Local mode makes every visitor
    // the owner, so the application may write the address — which grants
    // nothing on its own — and the operator sets the mode in the container
    // environment, where the application cannot reach it.
    expect(entries.AUTH_MODE).toBeUndefined();
    expect(entries.LOCAL_USER_EMAIL).toBe('owner@example.test');
    expect(POSTURE_KEYS.lan).toEqual(['LOCAL_USER_EMAIL']);
  });

  it('writes access mode with the team domain, audience and tunnel token', () => {
    const entries = entriesForPosture({
      posture: 'tunnel',
      teamDomain: 'https://team.example.test',
      accessAud: 'an-audience-tag',
      tunnelToken: 'a-tunnel-token',
    });
    expect(entries).toEqual({
      AUTH_MODE: 'access',
      CF_ACCESS_TEAM_DOMAIN: 'https://team.example.test',
      CF_ACCESS_AUD: 'an-audience-tag',
      TUNNEL_TOKEN: 'a-tunnel-token',
    });
  });

  it('writes sso mode with the public url and only the providers supplied', () => {
    const entries = entriesForPosture({
      posture: 'sso',
      publicUrl: 'https://example.test',
      google: null,
      microsoft: { clientId: 'an-id', clientSecret: 'a-secret', tenantId: 'a-directory-guid' },
    });
    expect(entries.AUTH_MODE).toBe('sso');
    expect(entries.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(entries.MICROSOFT_TENANT_ID).toBe('a-directory-guid');
    // Minted rather than collected: no console issues this one, and without it
    // the sign-in flow throws on the first attempt.
    expect((entries.SSO_COOKIE_SECRET ?? '').length).toBeGreaterThanOrEqual(32);
  });

  it('keeps an existing cookie secret so a correction does not bounce a sign-in', () => {
    const existing = newCookieSecret();
    const entries = entriesForPosture({
      posture: 'sso',
      publicUrl: 'https://example.test',
      google: { clientId: 'an-id', clientSecret: 'a-secret' },
      microsoft: null,
      cookieSecret: existing,
    });
    expect(entries.SSO_COOKIE_SECRET).toBe(existing);
  });

  it('derives the posture from the file rather than from a remembered marker', () => {
    // One source of truth. A settings row saying `sso` beside a file carrying
    // Access keys is a screen that lies about a deployment, and the file is
    // what the boot actually reads.
    expect(postureOfEntries(new Map([['AUTH_MODE', 'access']]))).toBe('tunnel');
    expect(postureOfEntries(new Map([['AUTH_MODE', 'sso']]))).toBe('sso');
    expect(postureOfEntries(new Map([['LOCAL_USER_EMAIL', 'owner@example.test']]))).toBe('lan');
    expect(postureOfEntries(new Map())).toBeNull();
  });

  it('refuses the two Microsoft endpoints any directory in the world can mint for', () => {
    expect(isMultiTenantEndpoint('common')).toBe(true);
    expect(isMultiTenantEndpoint('ORGANIZATIONS')).toBe(true);
    expect(isMultiTenantEndpoint(' common ')).toBe(true);
    expect(isMultiTenantEndpoint('consumers')).toBe(false);
    expect(isMultiTenantEndpoint('a-directory-guid')).toBe(false);
  });

  it('names the containers to restart, and the operator work no container can do', () => {
    // The tunnel posture is the one with two containers: cloudflared takes its
    // environment from compose and does not mount the config volume, so it
    // cannot read the file this step writes.
    expect(restartPlan('tunnel').services).toEqual(['app', 'tunnel']);
    expect(restartPlan('sso').services).toEqual(['app']);
    expect(restartPlan('lan').operatorMustFirst.join(' ')).toContain('AUTH_MODE=local');
    expect(restartPlan('tunnel').operatorMustFirst.join(' ')).toContain('TUNNEL_TOKEN');
    for (const posture of ['lan', 'tunnel', 'sso'] as const) {
      expect(restartPlan(posture).command).toContain('docker compose');
    }
  });
});
