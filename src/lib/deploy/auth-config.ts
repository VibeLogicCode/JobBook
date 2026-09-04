import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The deployment configuration file: what the first-run access step writes, and
 * what `docker/entrypoint.sh` reads back at boot.
 *
 * ---------------------------------------------------------------------------
 * A FILE, AND NOT A `settings` ROW, BECAUSE THESE ARE CREDENTIALS.
 *
 * Every other thing first-run setup collects goes into the database. These do
 * not. The `settings` table is mirrored to SharePoint and dumped hourly to
 * three destinations, encrypted with a key held on the same machine as the
 * database it protects (design sections 7.0 and 8.1). A client secret or a
 * tunnel token that went in through a text box would be in every one of those
 * copies, forever, and revoking it would mean revoking it at the provider
 * because there is no way to reach into a backup and take it out again.
 *
 * So they live in one file, on one volume, at mode 0600, and nothing mirrors
 * it. `docker/.dockerignore` and the compose file keep the volume out of the
 * image; the backup sidecar mounts `files` and `backups` and not `config`.
 * ---------------------------------------------------------------------------
 *
 * THE FILE MAY TIGHTEN. IT MAY NEVER LOOSEN. Two rules enforce that, and both
 * are security boundaries rather than tidiness:
 *
 * 1. `AUTH_MODE=local` is never written here and never honoured from here.
 *    Local mode means every visitor is treated as one named user, so a file
 *    the application itself can write must not be able to select it: anyone
 *    achieving a single file write inside the app would otherwise promote
 *    themselves from an ordinary user to owner by downgrading the mode. The
 *    writer refuses it and the reader drops it, so neither a bug here nor a
 *    hand-edited file nor an attacker's write can do it. The entrypoint
 *    refuses it a third time, at boot, for the same reason.
 * 2. Only the keys in `MANAGED_KEYS` are honoured. A line naming
 *    `DATABASE_URL` or `INTERNAL_RENDER_SECRET` is dropped rather than
 *    exported, so the blast radius of a write into this file is the sign-in
 *    posture and nothing else in the deployment.
 *
 * And the process environment wins over the file, every time. A value in a
 * compose file or a `docker run -e` stays the operator's decision, which is
 * what makes rule 1 hold even for `AUTH_MODE`: the app can supply a mode where
 * the operator set none, and can never replace one he did.
 */

/** The mount point the compose file gives the config volume. */
const CONTAINER_CONFIG_PATH = '/data/config/auth.env';

/**
 * Where the file lives.
 *
 * Read per call rather than captured at module load, for the same reason
 * `filesRoot()` is: a test points this at a scratch directory, and a constant
 * frozen at import time would have every suite writing into whichever path
 * happened to be configured first.
 */
export function authConfigPath(): string {
  const configured = process.env.DEPLOY_CONFIG_PATH?.trim();
  if (configured) return path.resolve(configured);
  // In development there is no /data volume, and on Windows that path is not
  // even meaningful. `.data` is gitignored, so a locally written config cannot
  // be committed by accident -- which for a file of credentials is the point.
  if (process.env.NODE_ENV === 'production') return CONTAINER_CONFIG_PATH;
  return path.resolve(process.cwd(), '.data', 'config', 'auth.env');
}

/**
 * Every key this file may carry, in the order it is written.
 *
 * An allowlist, not a filter on a shape. It is what bounds what a write into
 * this file can change, and a fixed order makes the emitted file byte-stable
 * for the same input, so a diff between two runs shows a changed value rather
 * than a reshuffle.
 */
export const MANAGED_KEYS = [
  'AUTH_MODE',
  'LOCAL_USER_EMAIL',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_AUD',
  'TUNNEL_TOKEN',
  'APP_PUBLIC_URL',
  'SSO_COOKIE_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID',
] as const;

export type ManagedKey = (typeof MANAGED_KEYS)[number];

export type AuthConfigEntries = Partial<Record<ManagedKey, string>>;

export function isManagedKey(key: string): key is ManagedKey {
  return (MANAGED_KEYS as readonly string[]).includes(key);
}

/**
 * The one value this file may never carry.
 *
 * Named rather than inlined at the three places that check it, so the writer,
 * the reader and the tests cannot drift apart on what is refused.
 */
export const REFUSED_AUTH_MODE = 'local';

/**
 * Which keys hold a secret.
 *
 * Explicit for the keys we know, and a suffix rule underneath it so an
 * unrecognised key defaults to secret rather than to printable. That direction
 * is deliberate: the cost of over-redacting is a duller screen, and the cost
 * of under-redacting is a client secret in a server-rendered page, a browser
 * cache and somebody's screenshot.
 */
const KNOWN_SECRETS: readonly ManagedKey[] = [
  'TUNNEL_TOKEN',
  'SSO_COOKIE_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_SECRET',
];

/**
 * Identifiers, not credentials. A team domain, an Access audience tag, a
 * client id and a directory GUID are all published or discoverable, and the
 * SSO spec calls them identifiers in as many words -- showing them back is how
 * an installer confirms he pasted the right one of the four values a console
 * hands him.
 */
const KNOWN_IDENTIFIERS: readonly ManagedKey[] = [
  'AUTH_MODE',
  'LOCAL_USER_EMAIL',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_AUD',
  'APP_PUBLIC_URL',
  'GOOGLE_CLIENT_ID',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_TENANT_ID',
];

export function isSecretKey(key: string): boolean {
  if ((KNOWN_SECRETS as readonly string[]).includes(key)) return true;
  if ((KNOWN_IDENTIFIERS as readonly string[]).includes(key)) return false;
  // Fail closed. A key nobody has classified is treated as a secret, so
  // adding one to `MANAGED_KEYS` and forgetting to classify it makes a screen
  // duller rather than putting a credential in a server-rendered page. An
  // earlier version guessed from the key's suffix instead, which gets the
  // answer exactly backwards for a name that does not end in `_SECRET`.
  return true;
}

/** Thrown by the writer, and only for something it must not do. */
export class AuthConfigRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigRefused';
  }
}

// ---------------------------------------------------------------------------
// The format
// ---------------------------------------------------------------------------

/**
 * The line the reader recognises as the generation stamp.
 *
 * A comment, so `entrypoint.sh` skips it like any other, and machine readable,
 * so the environment report can say when the file was written without a second
 * file beside it holding the metadata.
 */
const STAMP_PREFIX = '# scopeline-written:';

/**
 * `KEY="value"`, with ONE layer of double quotes and no escaping at all.
 *
 * This is not the usual shell quoting, and the difference matters. The reader
 * in `docker/entrypoint.sh` deliberately does not evaluate these lines -- an
 * earlier version built `export K='v'` as a string and ran it through `eval`,
 * which broke the moment a client secret contained a single quote and left the
 * variable silently empty. It instead splits at the first `=` and strips one
 * leading and one trailing quote as plain text.
 *
 * So the round trip is exact for anything that is not a newline: a space, a
 * single or double quote, a backslash and a `$` all survive, because nothing
 * on either side interprets them. Adding an escape sequence here would BREAK
 * that -- a `\"` would arrive at the runtime as a literal backslash and quote.
 *
 * A newline cannot survive a line-based format, so it is refused rather than
 * mangled: a credential with a newline in it is a paste that took a line too
 * many, and a value silently truncated at the newline is a sign-in that fails
 * for a reason nothing reports.
 */
function emitLine(key: ManagedKey, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new AuthConfigRefused(
      `${key} contains a line break, which a line-based file cannot carry. ` +
        'It is refused rather than truncated, because a credential cut short at ' +
        'the newline fails at sign-in with nothing to point at.',
    );
  }
  if (value.includes('\0')) {
    throw new AuthConfigRefused(`${key} contains a null byte`);
  }
  return `${key}="${value}"`;
}

/**
 * The whole file, header and all.
 *
 * The header is there because somebody will find this file on a volume in two
 * years with no memory of what wrote it, and the two questions then are "may I
 * edit this" and "why is my change not doing anything". It answers both, and
 * names the boundary that is not obvious from the contents.
 */
export function emitAuthConfig(entries: AuthConfigEntries, writtenAt: Date = new Date()): string {
  const mode = entries.AUTH_MODE;
  if (mode === REFUSED_AUTH_MODE) {
    throw new AuthConfigRefused(
      `AUTH_MODE=${REFUSED_AUTH_MODE} is never written to this file. Local mode treats every ` +
        'visitor as one named user, so a file the application can write must not be able to ' +
        'select it: a single file write inside the app would otherwise be a promotion to owner. ' +
        'It has to be set in the container environment, where it is the operator’s decision.',
    );
  }

  const lines: string[] = [
    '# Deployment sign-in configuration, generated by Scopeline first-run setup.',
    `${STAMP_PREFIX} ${writtenAt.toISOString()}`,
    '#',
    '# READ AT BOOT, BY docker/entrypoint.sh. Not per request, and not re-read:',
    '# a process’s environment is fixed when it starts, so a change here does',
    '# nothing at all until the containers are restarted. The access step names',
    '# which ones.',
    '#',
    '# Values already present in the environment WIN over this file, so a',
    '# compose file or a `docker run -e` stays the operator’s authority.',
    '#',
    '# Each value carries one layer of double quotes, stripped as plain text and',
    '# never evaluated, so a space, a quote, a backslash or a $ inside a secret',
    '# survives unchanged. Hand-editing is fine; keep the quotes, one line each.',
    '#',
    `# AUTH_MODE=${REFUSED_AUTH_MODE} is never written here and never honoured from`,
    '# here. Local mode means every visitor is the owner, so if this file could',
    '# set it, one file write inside the application would be a promotion from an',
    '# ordinary user to owner. Set it in the container environment instead.',
    '#',
    '# These are credentials, which is why they are in a file at mode 0600 and',
    '# not in the settings table: a settings row is mirrored to SharePoint and',
    '# lands in every hourly backup, to three destinations.',
    '',
  ];

  for (const key of MANAGED_KEYS) {
    const value = entries[key];
    // Blank is absent, not a value. An empty assignment in this file would be
    // exported as an empty variable, and `envValue()` throughout the app reads
    // an empty variable as unset anyway -- so writing one adds a line that
    // means nothing and reads as though it means something.
    if (value === undefined || value.trim() === '') continue;
    lines.push(emitLine(key, value));
  }

  return `${lines.join('\n')}\n`;
}

export type DropReason = 'malformed' | 'not-managed' | 'refused-value';

export interface DroppedLine {
  /** The key as written, when one could be read at all. */
  key: string;
  reason: DropReason;
  /** Why it was dropped, in a sentence the environment report can show. */
  detail: string;
}

export interface ParsedAuthConfig {
  entries: Map<ManagedKey, string>;
  /** Lines that were read and then refused. Never a value, only a key. */
  dropped: DroppedLine[];
  /** From the generation stamp, when the file carries one. */
  writtenAt: string | null;
}

/**
 * Strips one layer of quotes, exactly as `entrypoint.sh` does.
 *
 * Faithful to the shell rather than merely similar, including the degenerate
 * one-character case: two readers of one file that disagree about quoting is a
 * sign-in that works at boot and not in the wizard's report, or the reverse.
 */
function stripOneLayer(raw: string): string {
  for (const quote of ['"', "'"]) {
    if (raw.length >= 1 && raw.startsWith(quote) && raw.endsWith(quote)) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/**
 * Parses the file back.
 *
 * Deliberately the mirror image of the emitter and of the entrypoint, and
 * deliberately forgiving of everything except the two things it must refuse.
 * A file somebody hand-edited is the normal case for a runbook step, and a
 * parser that threw on a stray line would take the environment report down
 * with it -- when reporting that stray line is the whole job.
 */
export function parseAuthConfig(text: string): ParsedAuthConfig {
  const entries = new Map<ManagedKey, string>();
  const dropped: DroppedLine[] = [];
  let writtenAt: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line.startsWith('#')) {
      if (line.startsWith(STAMP_PREFIX)) {
        writtenAt = line.slice(STAMP_PREFIX.length).trim() || null;
      }
      continue;
    }

    const split = line.indexOf('=');
    if (split <= 0) {
      dropped.push({
        key: line.slice(0, 40),
        reason: 'malformed',
        detail: 'This line carries no KEY=value assignment.',
      });
      continue;
    }

    const key = line.slice(0, split);
    const value = stripOneLayer(line.slice(split + 1));

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      dropped.push({
        key: key.slice(0, 40),
        reason: 'malformed',
        detail: 'This is not a usable environment variable name.',
      });
      continue;
    }

    if (!isManagedKey(key)) {
      // The allowlist doing its job. A line naming DATABASE_URL or
      // INTERNAL_RENDER_SECRET is not a typo to be forgiven: it is either a
      // hand edit in the wrong file or a write that should not have happened,
      // and either way it is reported rather than exported.
      dropped.push({
        key,
        reason: 'not-managed',
        detail:
          'This file may only carry the sign-in keys the access step writes. ' +
          'Anything else is ignored, so a write into this file cannot reach the ' +
          'rest of the deployment’s configuration.',
      });
      continue;
    }

    if (key === 'AUTH_MODE' && value === REFUSED_AUTH_MODE) {
      dropped.push({
        key,
        reason: 'refused-value',
        detail:
          `AUTH_MODE=${REFUSED_AUTH_MODE} is never honoured from this file. Local mode treats ` +
          'every visitor as one named user, so a mode selected by a file the application can ' +
          'write would turn one file write into a promotion to owner. It has to come from the ' +
          'container environment.',
      });
      continue;
    }

    // Last line wins, which is what the shell does with a repeated assignment.
    entries.set(key, value);
  }

  return { entries, dropped, writtenAt };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface WrittenAuthConfig {
  path: string;
  keys: ManagedKey[];
  writtenAt: string;
  /** Null where the platform does not report POSIX permission bits. */
  mode: number | null;
}

/**
 * Writes the file: whole, atomically, at mode 0600.
 *
 * WHOLE, not merged. Each posture's keys are mutually exclusive at the
 * runtime -- `assertModeIsCoherent` refuses to boot with Access configuration
 * and SSO provider credentials both present -- so merging a new posture over
 * an old one would leave a deployment that does not start, after a step that
 * said it had saved.
 *
 * ATOMICALLY, through a temporary file and a rename, because the failure this
 * guards against is not hypothetical: a mini PC losing power mid-write leaves
 * a truncated file, the boot reader parses what is there, and the deployment
 * comes up with half a posture -- a team domain and no audience, which fails
 * closed but reads as a broken install. A rename within one directory either
 * happened or did not.
 *
 * AT 0600, because the file holds a client secret and a tunnel token, and the
 * app runs as a non-root user beside a backup sidecar in the same image.
 */
export async function writeAuthConfig(
  entries: AuthConfigEntries,
): Promise<WrittenAuthConfig> {
  const writtenAt = new Date();
  // Emitted BEFORE anything touches the disk, so a refused AUTH_MODE or an
  // unquotable value leaves no file and no temporary file behind.
  const body = emitAuthConfig(entries, writtenAt);

  const target = authConfigPath();
  const directory = path.dirname(target);
  await mkdir(/* turbopackIgnore: true */ directory, { recursive: true, mode: 0o700 });
  // Best effort, and not fatal: `/data/config` is a volume that may already
  // exist owned by another uid, and the file's own 0600 is what actually
  // protects the contents. Failing the step over the directory's bits would
  // refuse to configure a deployment that is fine.
  await chmod(/* turbopackIgnore: true */ directory, 0o700).catch(() => undefined);

  const temporary = path.join(directory, `.auth.env.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    // 'wx' fails rather than overwrites: a collision on a UUID is not a real
    // expectation, but truncating somebody else's in-flight write to save a
    // flag is not a risk worth taking.
    await writeFile(/* turbopackIgnore: true */ temporary, body, { mode: 0o600, flag: 'wx' });
    // The mode passed to writeFile is masked by the process umask, so on a
    // container with a permissive umask the file would land at 0644 and the
    // secrets in it would be world readable. Set it explicitly.
    await chmod(/* turbopackIgnore: true */ temporary, 0o600);
    await rename(/* turbopackIgnore: true */ temporary, target);
    renamed = true;
  } finally {
    if (!renamed) {
      await unlink(/* turbopackIgnore: true */ temporary).catch(() => undefined);
    }
  }

  return {
    path: target,
    keys: MANAGED_KEYS.filter((key) => {
      const value = entries[key];
      return value !== undefined && value.trim() !== '';
    }),
    writtenAt: writtenAt.toISOString(),
    mode: await modeOf(target),
  };
}

/**
 * The permission bits, or null where the platform does not report them.
 *
 * Windows reports 0666 or 0444 for every file regardless of any ACL, so a
 * caller asserting 0600 there would be asserting a fiction. Null says "this
 * platform cannot answer" rather than inventing a number.
 */
export async function modeOf(file: string): Promise<number | null> {
  if (process.platform === 'win32') return null;
  try {
    const info = await stat(/* turbopackIgnore: true */ file);
    return info.mode & 0o777;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface AuthConfigFile extends ParsedAuthConfig {
  path: string;
  /** When the bytes last changed, which the header cannot be trusted for. */
  modifiedAt: Date | null;
  mode: number | null;
}

/**
 * The file, parsed, or null when there is none.
 *
 * Null is an ordinary answer and not a failure: an operator who configures
 * everything in his compose file never runs this step, and his deployment is
 * correctly configured with no file at all.
 *
 * Anything other than "not there" is thrown, because a config file that exists
 * and cannot be read is a real finding -- the commonest cause is a volume
 * mounted with the wrong owner, and reporting it as "no configuration" would
 * send the installer looking for a step he already completed.
 */
export async function readAuthConfig(): Promise<AuthConfigFile | null> {
  const file = authConfigPath();
  let text: string;
  try {
    text = await readFile(/* turbopackIgnore: true */ file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let modifiedAt: Date | null = null;
  try {
    modifiedAt = (await stat(/* turbopackIgnore: true */ file)).mtime;
  } catch {
    // The file was read a moment ago, so this is a race with something else
    // rewriting it. The parsed contents still stand.
  }

  return { path: file, ...parseAuthConfig(text), modifiedAt, mode: await modeOf(file) };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export interface RedactedEntry {
  key: ManagedKey;
  secret: boolean;
  present: boolean;
  /** Characters. Zero when absent. */
  length: number;
  /**
   * The value, for an identifier. ALWAYS null for a secret -- this is the
   * property the step's page depends on, because a server component that
   * returned a client secret would put it in the HTML, the browser's cache and
   * whatever screenshot the installer sends to support.
   */
  value: string | null;
}

/**
 * What may be shown about the file.
 *
 * A secret is reduced to "present, and this many characters". That is not
 * decoration: length is the one fact that distinguishes the two failures an
 * installer actually hits -- a value that never arrived, and a value that
 * arrived truncated because the console's copy button took half of it -- and
 * neither is visible from a row of asterisks.
 */
export function redactAuthConfig(
  entries: ReadonlyMap<ManagedKey, string>,
  keys: readonly ManagedKey[] = [...entries.keys()],
): RedactedEntry[] {
  return keys.map((key) => {
    const value = entries.get(key);
    const secret = isSecretKey(key);
    return {
      key,
      secret,
      present: value !== undefined && value !== '',
      length: value?.length ?? 0,
      value: secret ? null : (value ?? null),
    };
  });
}

// ---------------------------------------------------------------------------
// Configured on disk versus in effect for this process
// ---------------------------------------------------------------------------

/**
 * `in-effect` -- this process is running with the value the file names.
 * `awaiting-restart` -- the file names it and this process has no value for
 * it, so the file was written after the process started.
 * `overridden` -- the environment names something else, and keeps winning.
 */
export type KeyEffect = 'in-effect' | 'awaiting-restart' | 'overridden';

export interface EffectiveKey {
  key: ManagedKey;
  effect: KeyEffect;
  secret: boolean;
}

/**
 * The environment, as this module needs to read it.
 *
 * Deliberately looser than `NodeJS.ProcessEnv`, which this project augments to
 * require `NODE_ENV`: nothing here reads that, and demanding it would mean a
 * caller comparing against a two-key snapshot -- which is exactly what a test
 * of this function is -- had to invent a value for it.
 */
export type EnvSnapshot = Record<string, string | undefined>;

/**
 * Present and not blank, matching `envValue()` in the environment report and
 * the `[ -z ]` test in the entrypoint. A variable set to the empty string is
 * treated as unset by all three, so a fourth opinion here would report a key
 * as overridden by a value that nothing uses.
 */
function envValue(name: string, env: EnvSnapshot): string | null {
  const value = env[name];
  return value && value.trim() !== '' ? value.trim() : null;
}

/**
 * The gap between what is on disk and what this process is actually running.
 *
 * This exists because the application cannot restart itself, and a wizard that
 * said "saved" and left it there would have an installer testing a sign-in
 * posture that is not loaded. A process's environment is fixed when it starts:
 * the file is read by the entrypoint, so the value takes effect at the next
 * boot of the container and not a moment sooner.
 */
export function compareToProcessEnv(
  entries: ReadonlyMap<ManagedKey, string>,
  env: EnvSnapshot = process.env,
): EffectiveKey[] {
  const effects: EffectiveKey[] = [];
  for (const key of MANAGED_KEYS) {
    const configured = entries.get(key);
    if (configured === undefined || configured === '') continue;
    const live = envValue(key, env);
    effects.push({
      key,
      secret: isSecretKey(key),
      effect:
        live === null
          ? 'awaiting-restart'
          : live === configured.trim()
            ? 'in-effect'
            : 'overridden',
    });
  }
  return effects;
}

export type ConfigState = 'empty' | 'in-effect' | 'awaiting-restart' | 'overridden';

/**
 * The verdict for the file as a whole.
 *
 * `awaiting-restart` outranks `overridden` on purpose. Both are worth saying,
 * but only one of them is an action the installer has to take before the
 * posture he just chose is the posture the deployment is running.
 */
export function configState(effects: readonly EffectiveKey[]): ConfigState {
  if (effects.length === 0) return 'empty';
  if (effects.some((entry) => entry.effect === 'awaiting-restart')) return 'awaiting-restart';
  if (effects.some((entry) => entry.effect === 'overridden')) return 'overridden';
  return 'in-effect';
}
