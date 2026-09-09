import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { AuthModeError, assertModeIsCoherent, authMode } from '@/lib/auth/mode';
import {
  authConfigPath,
  compareToProcessEnv,
  configState,
  readAuthConfig,
} from '@/lib/deploy/auth-config';
import { postureOfEntries, restartPlan } from '@/lib/deploy/posture';

/**
 * The environment check: step 7 of first-run setup.
 *
 * ---------------------------------------------------------------------------
 * IT VALIDATES. IT DOES NOT COLLECT.
 *
 * Every value inspected here is an environment variable or a mounted file, and
 * not one of them is offered as a form field anywhere in this wizard. A form
 * writes to the database; the database is mirrored to SharePoint and dumped
 * into every backup, hourly, to three destinations. A Graph certificate that
 * went in through a text box would be in all of them, encrypted with a key
 * held on the same machine, forever (design sections 7.0, 8.1 and 8.6).
 *
 * So the report says what is set, what is missing, and what to do about it,
 * and the doing happens in a Compose file or a Docker secret.
 * ---------------------------------------------------------------------------
 *
 * Nothing here throws. A missing variable is the normal case on a fresh box
 * and is exactly what the installer opened this page to find out; a check that
 * threw would replace every answer given so far with one stack trace.
 */

export type CheckStatus = 'pass' | 'fail' | 'off';

export interface EnvironmentCheck {
  id: string;
  /** What is being checked, as a person would name it. */
  title: string;
  status: CheckStatus;
  /** What was actually observed. Never a secret, and never a value's contents. */
  detail: string;
  /** What to do about it, or null when there is nothing to do. */
  remedy: string | null;
  /** The variables this check reads, named so the installer knows where to look. */
  variables: readonly string[];
}

/**
 * `off` is a third outcome and not a softened failure.
 *
 * The SharePoint mirror is off on a fresh install by design -- not every
 * company wants its records in a Microsoft tenant, and some have no Microsoft
 * 365 at all. A green tick beside a mirror that is switched off would read as
 * "the mirror works", and a red cross beside a feature the owner deliberately
 * declined teaches him to ignore red. What that decision DOES endanger is the
 * offsite copy, and that is reported as a failure of the backup check, where
 * it belongs.
 */
export function checkSummary(checks: readonly EnvironmentCheck[]): {
  passing: number;
  failing: number;
  off: number;
} {
  return {
    passing: checks.filter((check) => check.status === 'pass').length,
    failing: checks.filter((check) => check.status === 'fail').length,
    off: checks.filter((check) => check.status === 'off').length,
  };
}

/** Present and not blank. An empty string in a Compose file is not a setting. */
function envValue(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : null;
}

/**
 * A shell boolean, as `docker/backup.sh` reads it: anything but unset, empty
 * or `0` is on. Matching that script rather than inventing a second rule, so
 * the wizard cannot report a mirror the backup job disagrees about.
 */
function envFlagOn(name: string): boolean {
  const value = envValue(name);
  return value !== null && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Runs one check and converts anything it throws into a failure.
 *
 * The wrapper exists because the failure modes here are file systems and
 * network sockets: a certificate path that is a directory, a mount that has
 * gone away mid-read, a database whose DNS name no longer resolves. Every one
 * of those is a finding, not an exception.
 */
async function safely(
  id: string,
  title: string,
  variables: readonly string[],
  run: () => Promise<Omit<EnvironmentCheck, 'id' | 'title' | 'variables'>>,
): Promise<EnvironmentCheck> {
  try {
    return { id, title, variables, ...(await run()) };
  } catch (error) {
    return {
      id,
      title,
      variables,
      status: 'fail',
      detail: `This check could not complete: ${
        error instanceof Error ? error.message : String(error)
      }`,
      remedy: 'Fix the condition named above and reload this page.',
    };
  }
}

// ---------------------------------------------------------------------------
// Authentication mode
// ---------------------------------------------------------------------------

const AUTH_VARIABLES = [
  'AUTH_MODE',
  'LOCAL_USER_EMAIL',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_AUD',
  'GOOGLE_CLIENT_ID',
  'MICROSOFT_CLIENT_ID',
  'APPLE_CLIENT_ID',
  'APP_PUBLIC_URL',
] as const;

/**
 * The provider client ids the RUNNING application reads.
 *
 * Deliberately the unprefixed names, because those are what
 * `src/lib/auth/oidc/providers.ts` and `assertModeIsCoherent` actually
 * require. A check written against a different spelling would report a
 * deployment healthy that cannot sign anybody in.
 */
export function configuredOidcProviders(): string[] {
  return (['GOOGLE', 'MICROSOFT', 'APPLE'] as const)
    .filter((name) => envValue(`${name}_CLIENT_ID`))
    .map((name) => name.toLowerCase());
}

/**
 * The mode the access step wrote to disk, when it differs from the mode this
 * process is running.
 *
 * Null when there is no file, when it names no mode, or when the running
 * process already agrees with it. Anything it returns is a sentence about the
 * gap between the two, which is the distinction this whole report would
 * otherwise be unable to draw: a value in a file is CONFIGURED, and a value in
 * `process.env` is IN EFFECT, and only a restart turns the first into the
 * second.
 */
async function configuredButNotRunning(): Promise<string | null> {
  try {
    const file = await readAuthConfig();
    const configured = file?.entries.get('AUTH_MODE');
    if (!configured || configured === process.env.AUTH_MODE) return null;
    return configured;
  } catch {
    // The dedicated check below reports an unreadable file properly. This
    // helper exists to enrich a message and must not become a second failure.
    return null;
  }
}

async function authModeCheck(): Promise<Omit<EnvironmentCheck, 'id' | 'title' | 'variables'>> {
  let mode;
  try {
    mode = authMode();
  } catch (error) {
    // Before saying "AUTH_MODE is not set", look at what the access step
    // wrote. "You have not configured this" and "you configured this and the
    // container has not been restarted" are different problems with different
    // next actions, and reporting the first when the second is true sends an
    // installer back to redo a step he already finished.
    const configured = await configuredButNotRunning();
    if (configured) {
      return {
        status: 'fail',
        detail:
          `AUTH_MODE is configured as ${configured} in ${authConfigPath()}, and this running ` +
          'process has no value for it — so the file was written after the process started. ' +
          'Configured on disk is not the same thing as in effect.',
        remedy:
          `Restart the application container: ${restartPlan(configured === 'sso' ? 'sso' : 'tunnel').command}. ` +
          'The file is read once, at boot, by the entrypoint. A process’s environment is fixed ' +
          'when it starts, so the application cannot pick this up on its own — and it ' +
          'deliberately has no way to restart itself.',
      };
    }
    return {
      status: 'fail',
      detail:
        error instanceof AuthModeError
          ? error.message
          : 'AUTH_MODE could not be read.',
      remedy:
        'Set AUTH_MODE to access, sso or local. It has no default, because every possible ' +
        'default is wrong for two of the three deployments — and the wrong one either locks ' +
        'the owner out or treats every visitor as him.',
    };
  }

  try {
    // The boot interlock, not a second opinion about it: two modes configured
    // at once fails in the worst direction, a half-configured tunnel quietly
    // treating strangers as the owner.
    assertModeIsCoherent();
  } catch (error) {
    return {
      status: 'fail',
      detail: error instanceof Error ? error.message : 'The authentication configuration is incoherent.',
      remedy:
        'Leave exactly one mode configured. The application refuses to start in this state, ' +
        'so this is a failure the deployment cannot run past.',
    };
  }

  if (mode === 'local') {
    const email = envValue('LOCAL_USER_EMAIL');
    if (!email) {
      // NOT a failure. It is the shipped default, and the whole point of it
      // being optional is that one compose file serves every customer -- see
      // `lib/auth/sole-owner.ts`. What this step does instead is report which
      // of the three unset branches the deployment is actually in, because
      // "it works itself out" is not something an installer should have to
      // take on faith while looking at a blank variable.
      const active = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.isActive, true));

      if (active.length === 0) {
        return {
          // 'off' rather than 'fail': nothing is misconfigured, nothing is
          // yet configured. This step sits AFTER the first-user step in the
          // wizard's order, so a reader seeing it has either not finished
          // that step or has emptied the table since -- and in both cases the
          // remedy is one screen back, not a variable to edit.
          status: 'off',
          detail:
            'LOCAL_USER_EMAIL is not set, which is the shipped default and correct — but no ' +
            'user account exists yet, so no request signs in as anybody and every action is ' +
            'refused for want of an identity.',
          remedy:
            'Finish the first-user step. The account it creates becomes the one this ' +
            'deployment signs in as, with nothing to configure and no variable to set.',
        };
      }

      if (active.length === 1) {
        return {
          status: 'pass',
          detail:
            `Local mode, working itself out. LOCAL_USER_EMAIL is not set, and there is exactly ` +
            `one active account — ${active[0]!.email} — so every request arrives as that ` +
            'person. There is no password, no provider and no session; this mode is for a LAN ' +
            'or a laptop under test.',
          remedy: null,
        };
      }

      return {
        status: 'fail',
        detail:
          `LOCAL_USER_EMAIL is not set and this deployment has ${active.length} active ` +
          'accounts. Local mode signs every request in as one person and there is nothing ' +
          'here to say which, so it refuses to guess — every screen is refused until this ' +
          'is settled.',
        remedy:
          'Set LOCAL_USER_EMAIL to the address that should be signed in, or deactivate the ' +
          'accounts that should not be.',
      };
    }

    // Local mode is not exempt from authorization: the named identity is
    // looked up in `users` exactly as a signed-in one would be. Without a
    // matching active row every screen renders read-only and says so, which
    // reads as a broken install rather than a missing row.
    const [row] = await db
      .select({ isActive: users.isActive, role: users.role })
      .from(users)
      .where(eq(users.email, email.toLowerCase()));

    if (!row) {
      return {
        status: 'fail',
        detail: `AUTH_MODE is local and every request arrives as ${email}, but no user account has that address.`,
        remedy:
          'Either create the first user with this address at the first-user step, or point ' +
          'LOCAL_USER_EMAIL at the address you did use. Authorization is a lookup against ' +
          'the users table on every request, and local mode is not exempt from it.',
      };
    }
    if (!row.isActive) {
      return {
        status: 'fail',
        detail: `The account for ${email} exists but is deactivated.`,
        remedy: 'Reactivate it under Settings, or point LOCAL_USER_EMAIL at an active account.',
      };
    }

    return {
      status: 'pass',
      detail:
        `Local mode. Every request arrives as ${email}, whose account is active and holds ` +
        `the ${row.role} role. There is no password, no provider and no session — this mode ` +
        'is for a LAN or a laptop under test.',
      remedy: null,
    };
  }

  if (mode === 'access') {
    const missing = (['CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD'] as const).filter(
      (name) => !envValue(name),
    );
    if (missing.length > 0) {
      return {
        status: 'fail',
        detail: `AUTH_MODE is access, and ${missing.join(' and ')} ${
          missing.length === 1 ? 'is' : 'are'
        } not set.`,
        remedy:
          'Both are required: the team domain locates the signing keys and the audience tag ' +
          'ties a token to this application. Without them every request is refused, because ' +
          'the unsigned Cf-Access header is never read.',
      };
    }
    return {
      status: 'pass',
      detail: `Cloudflare Access, verified against ${envValue('CF_ACCESS_TEAM_DOMAIN')}. Which sign-in methods are allowed is a rule in the Access policy, not a setting here.`,
      remedy: null,
    };
  }

  const providers = configuredOidcProviders();
  const publicUrl = envValue('APP_PUBLIC_URL');
  if (!publicUrl) {
    return {
      status: 'fail',
      detail: `AUTH_MODE is sso with ${providers.join(', ')} configured, but APP_PUBLIC_URL is not set.`,
      remedy:
        'Set APP_PUBLIC_URL to this deployment’s public origin. Every provider redirect URI ' +
        'is built from it, and the cross-origin refusal compares against it rather than the ' +
        'Host header — which is the classic route to an open redirect.',
    };
  }
  return {
    status: 'pass',
    detail: `This installation signs people in itself, through ${providers.join(', ')}, at ${publicUrl}.`,
    remedy: null,
  };
}

// ---------------------------------------------------------------------------
// Render secret
// ---------------------------------------------------------------------------

/** The shape of a value nobody changed. Generic, and not any tenant's. */
const PLACEHOLDER_SECRET = /^(change[-_]?me|changeme|replace[-_]?me|todo|example|secret|dev[-_]only)/i;

const MINIMUM_SECRET_LENGTH = 24;

async function renderSecretCheck(): Promise<Omit<EnvironmentCheck, 'id' | 'title' | 'variables'>> {
  const secret = envValue('INTERNAL_RENDER_SECRET');

  if (!secret) {
    return {
      status: 'fail',
      detail: 'INTERNAL_RENDER_SECRET is not set, so every document render is refused.',
      remedy:
        'Set it to a long random string. Headless Chromium fetches the print page over ' +
        'localhost from inside the container, carrying no Access token and no session cookie, ' +
        'so this secret is the only thing that authenticates it — and with it unset the print ' +
        'route fails closed rather than serving a customer’s contract to anyone.',
    };
  }

  if (PLACEHOLDER_SECRET.test(secret)) {
    return {
      status: 'fail',
      detail: 'INTERNAL_RENDER_SECRET still holds a placeholder value from the example file.',
      remedy: 'Replace it with a long random string before this deployment sees real work.',
    };
  }

  if (secret.length < MINIMUM_SECRET_LENGTH) {
    return {
      status: 'fail',
      detail: `INTERNAL_RENDER_SECRET is ${secret.length} characters long.`,
      remedy: `Use at least ${MINIMUM_SECRET_LENGTH} random characters.`,
    };
  }

  return {
    status: 'pass',
    detail: `Set, ${secret.length} characters. Document rendering can authenticate itself.`,
    remedy: null,
  };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function databaseCheck(): Promise<Omit<EnvironmentCheck, 'id' | 'title' | 'variables'>> {
  try {
    // A round trip, not a connection object. A pool constructs happily against
    // a host that is not listening; only a query proves anything.
    await db.execute(sql`select 1`);
    return {
      status: 'pass',
      detail: 'Reachable, and answering queries.',
      remedy: null,
    };
  } catch (error) {
    return {
      status: 'fail',
      detail: error instanceof Error ? error.message : 'The database did not answer.',
      remedy:
        'Check DATABASE_URL and that the database container is healthy. Nothing this wizard ' +
        'writes can be saved until it answers.',
    };
  }
}

// ---------------------------------------------------------------------------
// SharePoint mirror
// ---------------------------------------------------------------------------

const SHAREPOINT_VARIABLES = [
  'SHAREPOINT_SYNC_ENABLED',
  'SHAREPOINT_TENANT_ID',
  'SHAREPOINT_CLIENT_ID',
  'SHAREPOINT_CERT_PATH',
  'SHAREPOINT_CERT_THUMBPRINT',
] as const;

/** Days of remaining validity below which a certificate is worth naming. */
const CERT_EXPIRY_WARNING_DAYS = 30;

/**
 * Every filesystem read below is marked `turbopackIgnore`.
 *
 * The bundler's static analysis sees a path it cannot resolve and, by default,
 * traces the WHOLE project into the standalone output -- every source file and
 * the public folder along with it -- which is the opposite of what
 * `output: 'standalone'` is set for. The paths genuinely cannot be statically
 * scoped: a Docker secret's mount point and an external drive's mount point
 * are runtime facts, and checking them is this module's entire job.
 */

/**
 * Whether the mounted credential actually loads.
 *
 * "The certificate loads" is the check the design asks for, and it is a
 * genuine one: the credential is a Docker secret, the commonest failure by a
 * wide margin is that the secret was never mounted into the container, and the
 * second commonest is that it expired. Both look identical from outside --
 * the sync simply stops -- and both are visible here in a second.
 *
 * The file is read and parsed. Nothing about its contents is returned: the
 * subject line and the expiry date are, because those are printed on the
 * certificate's public half and are what an operator needs to read.
 */
async function loadCertificate(certPath: string): Promise<{ ok: boolean; detail: string }> {
  const raw = await readFile(/* turbopackIgnore: true */ certPath);
  const text = raw.toString('latin1');

  if (text.includes('-----BEGIN CERTIFICATE-----')) {
    const certificate = new X509Certificate(raw);
    const expires = new Date(certificate.validTo);
    const daysLeft = Math.floor((expires.getTime() - Date.now()) / 86_400_000);
    if (daysLeft < 0) {
      return {
        ok: false,
        detail: `The certificate at ${certPath} expired ${-daysLeft} days ago (subject ${certificate.subject.replace(/\s+/g, ' ')}).`,
      };
    }
    const soon =
      daysLeft <= CERT_EXPIRY_WARNING_DAYS ? ` It expires in ${daysLeft} days — rotate it.` : '';
    return {
      ok: true,
      detail: `Loaded from ${certPath}. Subject ${certificate.subject.replace(/\s+/g, ' ')}, valid until ${certificate.validTo}.${soon}`,
    };
  }

  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text)) {
    // Throws on a malformed or passphrase-protected key, which is the point.
    createPrivateKey(raw);
    return { ok: true, detail: `A private key at ${certPath} parsed successfully.` };
  }

  // A PKCS#12 bundle, which is what the PnP registration cmdlet hands back.
  // Its passphrase is not in this process's environment by design, so
  // readability is as far as this check can honestly go.
  return {
    ok: true,
    detail:
      `A ${raw.length}-byte credential file is present at ${certPath} and readable. It is not ` +
      'a PEM, so it is presumably a PKCS#12 bundle: whether its passphrase is right is proven ' +
      'by the first sync, not here.',
  };
}

async function sharePointCheck(): Promise<Omit<EnvironmentCheck, 'id' | 'title' | 'variables'>> {
  if (!envFlagOn('SHAREPOINT_SYNC_ENABLED')) {
    return {
      status: 'off',
      detail:
        'The mirror is off, which is the default on a fresh install and a legitimate choice: ' +
        'not every company wants its records in a Microsoft tenant, and some have no ' +
        'Microsoft 365 at all. Nothing leaves this machine for SharePoint.',
      remedy:
        'Leave it off unless the mirror is wanted. With it off, the USB drive is the only ' +
        'copy that survives loss of the internal disk — see the backup check below.',
    };
  }

  const missing = (['SHAREPOINT_TENANT_ID', 'SHAREPOINT_CLIENT_ID'] as const).filter(
    (name) => !envValue(name),
  );
  if (missing.length > 0) {
    return {
      status: 'fail',
      detail: `Sync is on, but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set.`,
      remedy:
        'Supply the directory and application identifiers from the provisioning script’s ' +
        'output as environment variables. They are identifiers, not secrets, and still do not ' +
        'belong in the database.',
    };
  }

  const certPath = envValue('SHAREPOINT_CERT_PATH');
  if (!certPath) {
    return {
      status: 'fail',
      detail: 'Sync is on, but SHAREPOINT_CERT_PATH is not set, so there is no credential to load.',
      remedy:
        'Mount the certificate as a Docker secret and point SHAREPOINT_CERT_PATH at it. The ' +
        'sync authenticates app-only with a client certificate — it runs unattended every ' +
        'hour, so there is no human present to complete an interactive login.',
    };
  }

  if (!envValue('SHAREPOINT_CERT_THUMBPRINT')) {
    return {
      status: 'fail',
      detail: `A certificate path is set, but SHAREPOINT_CERT_THUMBPRINT is not.`,
      remedy: 'Set the thumbprint the registration reported; the client-certificate credential needs it to name which key it is presenting.',
    };
  }

  try {
    const loaded = await loadCertificate(certPath);
    return {
      status: loaded.ok ? 'pass' : 'fail',
      detail: loaded.detail,
      remedy: loaded.ok ? null : 'Rotate the certificate and remount the secret.',
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: 'fail',
      detail: `The credential at ${certPath} did not load: ${reason}`,
      remedy:
        'Confirm the Docker secret is mounted into this container at that path and is readable ' +
        'by the application user. An unmounted secret is the commonest cause, and from outside ' +
        'it looks exactly like a sync that has quietly stopped.',
    };
  }
}

// ---------------------------------------------------------------------------
// USB backup
// ---------------------------------------------------------------------------

const BACKUP_VARIABLES = [
  'BACKUP_USB_DIR',
  'BACKUP_USB_SENTINEL',
  'BACKUP_UPLOAD_DIR',
] as const;

const DEFAULT_SENTINEL = '.backup-volume';

/**
 * Whether a directory is its own mount point.
 *
 * The portable equivalent of `mountpoint -q`, which `docker/backup.sh` runs
 * before every write: a directory and its parent on different devices is a
 * mount. It matters because if the drive unmounts or spins down, writing to
 * the same path succeeds against the INTERNAL disk, and there is no backup at
 * all while everything looks healthy.
 */
async function isMountPoint(dir: string): Promise<boolean> {
  const here = await stat(/* turbopackIgnore: true */ dir);
  const parent = await stat(/* turbopackIgnore: true */ path.dirname(path.resolve(dir)));
  return here.dev !== parent.dev;
}

async function usbBackupCheck(): Promise<Omit<EnvironmentCheck, 'id' | 'title' | 'variables'>> {
  const dir = envValue('BACKUP_USB_DIR');
  const syncOn = envFlagOn('SHAREPOINT_SYNC_ENABLED');
  const uploadDir = envValue('BACKUP_UPLOAD_DIR');

  if (!dir) {
    const onlyCopy = !syncOn || !uploadDir;
    return {
      status: 'fail',
      detail: onlyCopy
        ? 'No USB destination is configured, and no offsite upload destination either. Every ' +
          'copy of this company’s records would sit on the same disk as the database, and ' +
          'survive nothing that disk does not.'
        : 'No USB destination is configured. The offsite upload is the only copy that leaves ' +
          'this disk, so a lost internet connection or a tenant dispute leaves no working restore path.',
      remedy:
        `Set BACKUP_USB_DIR to the mount point of an external drive and place a ${DEFAULT_SENTINEL} ` +
        'sentinel file on the volume itself. This is the owner’s decision to make — it is not ' +
        'one to make silently.',
    };
  }

  try {
    const info = await stat(/* turbopackIgnore: true */ dir);
    if (!info.isDirectory()) {
      return {
        status: 'fail',
        detail: `${dir} exists but is not a directory.`,
        remedy: 'Point BACKUP_USB_DIR at the drive’s mount point.',
      };
    }
  } catch {
    return {
      status: 'fail',
      detail: `${dir} does not exist, so the drive is not mounted there.`,
      remedy: 'Mount the drive, or correct BACKUP_USB_DIR.',
    };
  }

  const sentinel = envValue('BACKUP_USB_SENTINEL') ?? DEFAULT_SENTINEL;
  try {
    await stat(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ dir, sentinel));
  } catch {
    return {
      status: 'fail',
      detail: `The sentinel ${sentinel} is missing from ${dir}. Something is there, but it is not the backup drive.`,
      remedy:
        `Create an empty ${sentinel} file on the drive itself, not on the internal disk under ` +
        'the mount point. The backup job refuses to write without it, for this exact reason.',
    };
  }

  if (!(await isMountPoint(dir))) {
    return {
      status: 'fail',
      detail: `${dir} carries the sentinel but is not a mount point: it is a directory on the internal disk.`,
      remedy:
        'Mount the external drive at that path. A backup written to the internal disk protects ' +
        'against nothing that disk does not survive, while looking entirely healthy.',
    };
  }

  return {
    status: 'pass',
    detail: `The drive at ${dir} is mounted and carries its ${sentinel} sentinel.${
      syncOn && uploadDir ? ' An offsite upload destination is configured as well.' : ''
    }`,
    remedy:
      syncOn && uploadDir
        ? null
        : 'This is the only copy that survives loss of the internal disk. Nothing here is ' +
          'offsite, so a fire or a theft takes both copies.',
  };
}

// ---------------------------------------------------------------------------
// The deployment configuration file
// ---------------------------------------------------------------------------

/**
 * Only the path is named as a variable.
 *
 * The keys inside the file are named in the detail instead, and only the ones
 * that are actually a problem: thirteen variable names in the report's second
 * column is a wall an installer skims past, and the whole value of that column
 * is that it is short enough to read.
 */
const DEPLOY_VARIABLES = ['DEPLOY_CONFIG_PATH'] as const;

/** Anything looser than owner-only on a file of credentials. */
const REQUIRED_CONFIG_MODE = 0o600;

/**
 * What the access step wrote, and whether this process is running it.
 *
 * ---------------------------------------------------------------------------
 * CONFIGURED ON DISK IS NOT IN EFFECT.
 *
 * This check exists because of one honest limitation: the application cannot
 * restart itself. A process's environment is fixed when it starts, the file is
 * read at boot by `docker/entrypoint.sh`, and so every value the access step
 * writes takes effect at the next start of the container and not a moment
 * before. A wizard that said "saved" and stopped there would leave an
 * installer testing a posture that is not loaded, and concluding the product
 * is broken.
 *
 * So the comparison is made explicitly, key by key, between the file and
 * `process.env`, and each key comes out as one of three things: running,
 * waiting on a restart, or overridden by the container environment. The third
 * is not a fault — the environment winning is what keeps a value an operator
 * pinned in a compose file out of reach of anything this application writes.
 * ---------------------------------------------------------------------------
 */
async function deployConfigCheck(): Promise<Omit<EnvironmentCheck, 'id' | 'title' | 'variables'>> {
  const file = await readAuthConfig();

  if (!file) {
    return {
      status: 'off',
      detail:
        `There is no configuration file at ${authConfigPath()}, so the container environment ` +
        'alone decides how this deployment signs people in.',
      remedy:
        'That is a legitimate arrangement: an operator who sets every value in his compose ' +
        'file never needs this file. Use the access step if you would rather the wizard held ' +
        'the credentials in one place at mode 0600 instead.',
    };
  }

  // The loudest finding, and it comes first. A refused line means something
  // wrote AUTH_MODE=local into a file the application can write, and that is
  // the exact shape of a privilege escalation: local mode treats every visitor
  // as one named user, so a mode chosen by this file would turn one file write
  // inside the app into a promotion to owner. It is dropped rather than
  // honoured, three times over — here, by the parser, and by the entrypoint —
  // but it is never silent.
  const refusedLines = file.dropped.filter((line) => line.reason === 'refused-value');
  if (refusedLines.length > 0) {
    return {
      status: 'fail',
      detail:
        `${file.path} contains AUTH_MODE=local, which is refused and was not loaded. Nothing ` +
        'is running as a result of it. Local mode makes every visitor the owner, so it may ' +
        'only be set in the container environment, where the application cannot reach it.',
      remedy:
        'Remove that line. If this deployment is genuinely meant to run on an office network ' +
        'with no sign-in, set AUTH_MODE=local in the compose file or the .env beside it — that ' +
        'is a decision for whoever runs the machine, and deliberately not one this application ' +
        'can make for itself. If nobody put it there on purpose, treat it as evidence that ' +
        'something wrote into this file and look at how.',
    };
  }

  if (file.mode !== null && (file.mode & 0o077) !== 0) {
    return {
      status: 'fail',
      detail:
        `${file.path} is at permissions ${file.mode.toString(8).padStart(3, '0')}, so a client ` +
        'secret and a tunnel token in it are readable by more than the account that owns them.',
      remedy: `chmod ${REQUIRED_CONFIG_MODE.toString(8)} ${file.path}. The writer sets this on every write, so a looser mode means something else changed it.`,
    };
  }

  const effects = compareToProcessEnv(file.entries);
  const state = configState(effects);
  const posture = postureOfEntries(file.entries);

  // Lines naming a key this file does not manage. Reported wherever they are,
  // because the allowlist silently ignoring them is what keeps a write into
  // this file from reaching DATABASE_URL — and silence about it is how a
  // hand-edit in the wrong file stays a mystery for a week.
  const foreign = file.dropped.filter((line) => line.reason === 'not-managed');
  const foreignNote =
    foreign.length > 0
      ? ` ${foreign.length} other line${foreign.length === 1 ? '' : 's'} (${foreign
          .map((line) => line.key)
          .join(', ')}) name keys this file does not manage and were ignored.`
      : '';

  if (state === 'empty') {
    return {
      status: 'fail',
      detail: `${file.path} exists and carries no key this deployment reads.${foreignNote}`,
      remedy: 'Run the access step again, or delete the file and configure the environment directly.',
    };
  }

  const waiting = effects.filter((entry) => entry.effect === 'awaiting-restart');
  if (state === 'awaiting-restart') {
    return {
      status: 'fail',
      detail:
        `Configured on disk and NOT in effect. ${file.path} sets ${waiting
          .map((entry) => entry.key)
          .join(', ')}, and this running process has no value for ${
          waiting.length === 1 ? 'it' : 'them'
        } — so the file was written after the process started.${foreignNote}`,
      remedy:
        `${posture ? `${restartPlan(posture).command}. ` : 'Restart the application container. '}` +
        'The file is read once, at boot. The application cannot pick it up on its own and ' +
        'deliberately cannot restart itself: doing that would mean mounting the Docker socket ' +
        'into this container, which is root on the host.',
    };
  }

  const overridden = effects.filter((entry) => entry.effect === 'overridden');
  if (state === 'overridden') {
    return {
      status: 'pass',
      detail:
        `The file is loaded, and the container environment is overriding ${overridden
          .map((entry) => entry.key)
          .join(', ')}. The environment wins by design, so what is running is the ` +
        `environment's value and not the file's.${foreignNote}`,
      remedy:
        'Nothing, if that is intended — a value pinned in a compose file staying out of reach ' +
        'of anything the application writes is the point. If the file is meant to be the ' +
        'authority for one of these keys, remove that key from the compose file and restart.',
    };
  }

  return {
    status: 'pass',
    detail:
      `${posture ? `The ${posture} posture is` : 'This file is'} configured at ${file.path} and ` +
      `in effect: all ${effects.length} values match what this process is running with. Mode ` +
      `0600, and mirrored nowhere — these are credentials, so they are in a file rather than ` +
      `in the settings table, which is mirrored to SharePoint and lands in every backup.${foreignNote}`,
    remedy:
      posture === 'lan'
        ? 'This posture also needs AUTH_MODE=local in the container environment, which this ' +
          'application cannot write and the sign-in check above reports on.'
        : null,
  };
}

// ---------------------------------------------------------------------------

/**
 * The whole report, in the order an installer can act on it: sign-in first,
 * because a deployment nobody can sign into is not a deployment; then the two
 * things the application itself needs to function; then the two that decide
 * whether the records survive the machine.
 */
export async function runEnvironmentChecks(): Promise<EnvironmentCheck[]> {
  return Promise.all([
    safely('auth-mode', 'Sign-in mode', AUTH_VARIABLES, authModeCheck),
    // Immediately after the mode, because it is the same subject read from the
    // other side: the mode above is what this process is RUNNING, and this is
    // what the access step CONFIGURED. When the two disagree, the pair of rows
    // read together says so.
    safely('deploy-config', 'Deployment configuration file', DEPLOY_VARIABLES, deployConfigCheck),
    safely('render-secret', 'Document render secret', ['INTERNAL_RENDER_SECRET'], renderSecretCheck),
    safely('database', 'Database', ['DATABASE_URL'], databaseCheck),
    safely('sharepoint', 'SharePoint mirror', SHAREPOINT_VARIABLES, sharePointCheck),
    safely('usb-backup', 'USB backup drive', BACKUP_VARIABLES, usbBackupCheck),
  ]);
}
