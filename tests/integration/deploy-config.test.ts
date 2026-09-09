import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `revalidatePath` is a request-scoped Next API and there is no request here.
 * Mocked rather than avoided, for the same reason `setup.test.ts` mocks it:
 * the action genuinely must call it, and a test that forced it out would be
 * testing a different function.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

import { db } from '@/db/client';
import { auditLog, organization, settings, users } from '@/db/schema';
// After the mocks above, deliberately: this pulls in the database client,
// and the module under test must not be loaded before they are installed.
import { seedDeployment } from '../support/organization';
import {
  saveCompanyStep,
  saveContactStep,
  saveFinancialStep,
  saveFirstUserStep,
  saveLocaleStep,
  saveTaxRateStep,
  acknowledgeEnvironmentStep,
} from '@/app/setup/actions';
import { saveAccessStep } from '@/app/setup/access/actions';
import { runEnvironmentChecks } from '@/app/setup/environment';
import { readSetupGate, stepMarkerKey } from '@/app/setup/state';
import type { ActionResult } from '@/app/settings/result';
import { readAuthConfig } from '@/lib/deploy/auth-config';

/**
 * The access step, against the real database and a real file on disk.
 *
 * What is worth testing here is not the field validation -- that is covered
 * without a database in `tests/unit/deploy-config.test.ts` -- but the four
 * things this step is the only thing enforcing:
 *
 * 1. NO SECRET REACHES THE DATABASE. The database is mirrored to SharePoint
 *    and dumped hourly to three destinations, so a client secret that landed
 *    in a row would be in every one of those copies, forever. Asserted against
 *    every table the step could plausibly touch, including the audit log,
 *    which is the likeliest accidental route.
 * 2. THE FILE MAY TIGHTEN AND NEVER LOOSEN. The office-network posture writes
 *    the local user's address and refuses to write `AUTH_MODE=local`, because
 *    local mode makes every visitor the owner and a mode selected by a file
 *    the application can write would turn one file write into a promotion to
 *    owner.
 * 3. It carries the wizard's gate exactly as every other step does, so a live
 *    company cannot be reconfigured through it and a step out of order writes
 *    nothing.
 * 4. The environment report can tell CONFIGURED ON DISK from IN EFFECT, which
 *    is the one thing standing between an installer and an hour spent testing
 *    a posture that was never loaded.
 */

/**
 * A fictional company, and a different one from both the demo seed's and
 * `setup.test.ts`'s on purpose: two fixtures naming the same company would let
 * a test pass because another suite had run rather than because this step
 * wrote anything.
 */
const COMPANY = {
  legalName: 'Thornbury Millwork Limited',
  displayName: 'Thornbury Millwork',
  operatingName: '',
  tagline: '',
  ownerName: 'Ines Vaher',
  ownerTitle: 'Director',
};

/**
 * Every key each schema names, blank where the field is optional.
 *
 * Not padding: an HTML form submits a key for every control it renders, and
 * these schemas read a missing key as a missing field rather than as a blank
 * one. A fixture with holes would fail validation for a reason that has
 * nothing to do with the access step.
 */
const CONTACT = {
  addressLine1: '8 Cairnhill Road',
  addressLine2: '',
  city: 'Perth',
  province: 'Perthshire',
  postalCode: 'PH1 0AA',
  country: 'Scotland',
  phone: '+44 1738 000000',
  altPhone: '',
  email: 'quotes@thornbury.example',
  website: 'https://thornbury.example',
};

const LOCALE = { currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London', areaUnit: 'sqm' };

const FINANCIAL = {
  taxRegistrationNumber: '',
  taxRegistrationLabel: 'VAT Number',
  businessNumber: '',
  fiscalYearEndMonth: '3',
  fiscalYearEndDay: '31',
  taxFilingFrequency: 'quarterly',
  taxDeferredOnHoldback: 'on',
  defaultHoldbackPct: '5',
  holdbackLabel: 'Retention',
  holdbackTermsText: '',
  holdbackReleaseDays: '60',
  paymentTermsDays: '30',
  paymentTermsText: '',
  insuranceStatement: '',
  targetMargin: '20',
};

const TAX_RATE = {
  label: 'Standard rate',
  shortLabel: 'VAT',
  registrationNumber: '',
  rate: '4.5',
  effectiveFrom: '2024-04-06',
  sortOrder: '1',
};

const OWNER = { displayName: 'Ines Vaher', email: 'ines.vaher@thornbury.example' };

/**
 * Distinctive, so a search of the whole database for it means something.
 *
 * Deliberately containing a space, a quote and a `$`: those are exactly the
 * characters the file format has to carry unchanged, and asserting them here
 * proves the round trip survives the real writer and the real disk rather than
 * only the emitter.
 */
const GOOGLE_SECRET = 'thornbury $ecret with a space and a " quote';
const MICROSOFT_SECRET = "thornbury other-secret with a ' quote";
const TUNNEL_TOKEN = 'thornbury-tunnel-token-value';

const SSO_FORM = {
  posture: 'sso',
  publicUrl: 'https://quotes.thornbury.example',
  googleClientId: 'thornbury-google-client-id',
  googleClientSecret: GOOGLE_SECRET,
  microsoftClientId: 'thornbury-microsoft-client-id',
  microsoftClientSecret: MICROSOFT_SECRET,
  microsoftTenantId: 'a1b2c3d4-0000-4000-8000-000000000001',
};

const TUNNEL_FORM = {
  posture: 'tunnel',
  teamDomain: 'https://thornbury.cloudflareaccess.example',
  accessAud: 'thornbury-audience-tag',
  tunnelToken: TUNNEL_TOKEN,
};

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

function messageOf(result: ActionResult): string {
  return result.ok ? result.message : result.error;
}

async function openGate() {
  const gate = await readSetupGate();
  if (!gate.open) throw new Error(`expected an open gate, got ${gate.reason}: ${gate.detail}`);
  return gate;
}

/** Steps 1 to 6, which is everything the access step builds on. */
async function runStepsThroughFirstUser(): Promise<void> {
  expect((await saveCompanyStep(null, form(COMPANY))).ok).toBe(true);
  expect((await saveContactStep(null, form(CONTACT))).ok).toBe(true);
  expect((await saveLocaleStep(null, form(LOCALE))).ok).toBe(true);
  expect((await saveFinancialStep(null, form(FINANCIAL))).ok).toBe(true);
  expect((await saveTaxRateStep(null, form(TAX_RATE))).ok).toBe(true);
  expect((await saveFirstUserStep(null, form(OWNER))).ok).toBe(true);
}

/**
 * Every row of every table this step could plausibly reach, as one string.
 *
 * A bigint replacer because the organization row carries scaled integers and
 * `JSON.stringify` throws on a BigInt -- which would turn this assertion into
 * an error rather than a finding.
 */
async function everythingInTheDatabase(): Promise<string> {
  const rows = {
    settings: await db.select().from(settings),
    organization: await db.select().from(organization),
    users: await db.select().from(users),
    // The likeliest accidental route: the triggers write a row per insert, and
    // a value that reached a column would reach the audit log with it.
    auditLog: await db.select().from(auditLog),
  };
  return JSON.stringify(rows, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

let scratch: string;
let configPath: string;
const savedConfigPath = process.env.DEPLOY_CONFIG_PATH;

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'deploy-step-'));
  configPath = path.join(scratch, 'config', 'auth.env');
  // Pointed at a scratch directory rather than the repository's `.data`, so
  // this suite cannot leave a config file behind that another suite's
  // environment report would then read.
  process.env.DEPLOY_CONFIG_PATH = configPath;
});

afterAll(async () => {
  if (savedConfigPath === undefined) delete process.env.DEPLOY_CONFIG_PATH;
  else process.env.DEPLOY_CONFIG_PATH = savedConfigPath;
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  // audit_log first and by name, as `setup.test.ts` does: the triggers write a
  // row per insert and no foreign key means cascade never reaches it.
  await db.execute(sql`
    truncate table audit_log, tax_rates, users, organization, companies, document_sequences, settings
    restart identity cascade
  `);
  await rm(path.join(scratch, 'config'), { recursive: true, force: true });
});

describe('the step writes credentials to a file and never to the database', () => {
  it('writes the sso posture to disk, round-tripping an awkward secret', async () => {
    await runStepsThroughFirstUser();
    const result = await saveAccessStep(null, form(SSO_FORM));
    expect(messageOf(result)).toContain('0600');

    const file = await readAuthConfig();
    expect(file?.path).toBe(configPath);
    expect(file?.entries.get('AUTH_MODE')).toBe('sso');
    expect(file?.entries.get('APP_PUBLIC_URL')).toBe(SSO_FORM.publicUrl);
    // The characters the format exists to carry: a space, a double quote, a
    // single quote and a `$`, through the real writer and the real disk.
    expect(file?.entries.get('GOOGLE_CLIENT_SECRET')).toBe(GOOGLE_SECRET);
    expect(file?.entries.get('MICROSOFT_CLIENT_SECRET')).toBe(MICROSOFT_SECRET);
    expect(file?.entries.get('MICROSOFT_TENANT_ID')).toBe(SSO_FORM.microsoftTenantId);
    // Minted by the application, because no console issues it and the sign-in
    // flow throws without it.
    expect((file?.entries.get('SSO_COOKIE_SECRET') ?? '').length).toBeGreaterThanOrEqual(32);
  });

  it('puts no secret anywhere in the database', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form(SSO_FORM))).ok).toBe(true);

    const everything = await everythingInTheDatabase();
    for (const secret of [GOOGLE_SECRET, MICROSOFT_SECRET]) {
      expect(everything).not.toContain(secret);
    }
    // Not the cookie secret it minted either.
    const minted = (await readAuthConfig())?.entries.get('SSO_COOKIE_SECRET');
    expect(minted).toBeTruthy();
    expect(everything).not.toContain(minted!);
  });

  it('puts no tunnel token in the database either', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form(TUNNEL_FORM))).ok).toBe(true);

    expect((await readAuthConfig())?.entries.get('TUNNEL_TOKEN')).toBe(TUNNEL_TOKEN);
    expect(await everythingInTheDatabase()).not.toContain(TUNNEL_TOKEN);
  });

  it('returns no secret to the caller, because that result is rendered in a browser', async () => {
    await runStepsThroughFirstUser();
    const result = await saveAccessStep(null, form(SSO_FORM));
    const serialised = JSON.stringify(result);
    for (const secret of [GOOGLE_SECRET, MICROSOFT_SECRET, TUNNEL_TOKEN]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('records the step marker, and only the marker', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form(SSO_FORM))).ok).toBe(true);

    const marker = await db
      .select()
      .from(settings)
      .where(eq(settings.key, stepMarkerKey('access')));
    // A timestamp, which is not a credential.
    expect(marker[0]?.value).toBeTruthy();
    expect(Number.isNaN(Date.parse(marker[0]!.value!))) .toBe(false);

    const gate = await openGate();
    expect(gate.completed.has('access')).toBe(true);
    expect(gate.resumeAt).toBe('environment');
  });

  it('replaces the file wholesale when the posture changes', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form(TUNNEL_FORM))).ok).toBe(true);
    expect((await saveAccessStep(null, form(SSO_FORM))).ok).toBe(true);

    // Merged instead of replaced, this deployment would refuse to BOOT:
    // `assertModeIsCoherent` will not run with Access configuration and SSO
    // provider credentials both present.
    const file = await readAuthConfig();
    expect(file?.entries.has('CF_ACCESS_TEAM_DOMAIN')).toBe(false);
    expect(file?.entries.has('TUNNEL_TOKEN')).toBe(false);
    const text = await readFile(configPath, 'utf8');
    expect(text).not.toContain(TUNNEL_TOKEN);
  });

  it('keeps the cookie secret across a correction, so a sign-in in flight survives', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form(SSO_FORM))).ok).toBe(true);
    const first = (await readAuthConfig())?.entries.get('SSO_COOKIE_SECRET');

    expect(
      (await saveAccessStep(null, form({ ...SSO_FORM, googleClientId: 'corrected-client-id' })))
        .ok,
    ).toBe(true);
    expect((await readAuthConfig())?.entries.get('SSO_COOKIE_SECRET')).toBe(first);
  });
});

describe('the office-network posture may tighten and never loosen', () => {
  const LAN_FORM = { posture: 'lan', localUserEmail: OWNER.email };

  it('writes the address and refuses to write the mode that would grant it', async () => {
    await runStepsThroughFirstUser();
    const result = await saveAccessStep(null, form(LAN_FORM));
    expect(result.ok).toBe(true);

    const file = await readAuthConfig();
    expect(file?.entries.get('LOCAL_USER_EMAIL')).toBe(OWNER.email);
    // The boundary. Local mode makes every visitor the owner, so a mode
    // selected by a file this application writes would turn one file write
    // inside the app into a promotion from an ordinary user to owner.
    expect(file?.entries.has('AUTH_MODE')).toBe(false);
    expect(await readFile(configPath, 'utf8')).not.toContain('AUTH_MODE="local"');
  });

  it('tells the operator to set the mode himself, and why it cannot', async () => {
    await runStepsThroughFirstUser();
    const message = messageOf(await saveAccessStep(null, form(LAN_FORM)));
    expect(message).toContain('AUTH_MODE=local');
    expect(message).toContain('promotion to owner');
    // And which containers to restart, because the app cannot restart itself.
    expect(message).toContain('docker compose');
    expect(message).toContain('`app`');
  });

  it('refuses an address with no user account behind it', async () => {
    await runStepsThroughFirstUser();
    const result = await saveAccessStep(
      null,
      form({ posture: 'lan', localUserEmail: 'nobody@thornbury.example' }),
    );
    expect(result.ok).toBe(false);
    // In this posture every request arrives as one named user and
    // authorization is still a lookup against `users`, so an address with no
    // row behind it is a deployment where every screen renders read-only --
    // which reads as a broken install rather than a missing row.
    expect(messageOf(result)).toContain('nobody@thornbury.example');
    expect(await readAuthConfig()).toBeNull();
    expect((await openGate()).completed.has('access')).toBe(false);
  });

  it('refuses a deactivated account', async () => {
    await runStepsThroughFirstUser();
    // Another owner, so the last-active-owner rule does not block the update.
    await db.insert(users).values({
      displayName: 'Kalev Sepp',
      email: 'kalev.sepp@thornbury.example',
      role: 'owner',
      createdBy: null,
    });
    await db
      .update(users)
      .set({ isActive: false })
      .where(eq(users.email, 'kalev.sepp@thornbury.example'));

    const result = await saveAccessStep(
      null,
      form({ posture: 'lan', localUserEmail: 'kalev.sepp@thornbury.example' }),
    );
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('deactivated');
  });
});

describe('what the step refuses', () => {
  it('requires a posture to be chosen, with nothing defaulted', async () => {
    await runStepsThroughFirstUser();
    // No default. This is the one decision on the whole wizard where guessing
    // on the operator's behalf is not acceptable: the wrong answer publishes
    // the company's quoting system with no sign-in.
    const result = await saveAccessStep(null, form({ localUserEmail: OWNER.email }));
    expect(result.ok).toBe(false);
    expect(await readAuthConfig()).toBeNull();
  });

  it('refuses the two Microsoft endpoints any directory in the world can mint for', async () => {
    await runStepsThroughFirstUser();
    for (const tenant of ['common', 'organizations']) {
      const result = await saveAccessStep(
        null,
        form({ ...SSO_FORM, microsoftTenantId: tenant }),
      );
      expect(result.ok, tenant).toBe(false);
      if (result.ok) throw new Error('unreachable');
      const field = result.fieldErrors?.find((entry) => entry.field === 'microsoftTenantId');
      expect(field?.message, tenant).toContain('attacker-controlled');
      expect(await readAuthConfig()).toBeNull();
    }
  });

  it('refuses a provider with a client id and no secret, which would not boot', async () => {
    await runStepsThroughFirstUser();
    const result = await saveAccessStep(
      null,
      form({ ...SSO_FORM, googleClientSecret: '', microsoftClientId: '', microsoftClientSecret: '', microsoftTenantId: '' }),
    );
    expect(result.ok).toBe(false);
    expect(await readAuthConfig()).toBeNull();
  });

  it('refuses sso mode with no provider at all', async () => {
    await runStepsThroughFirstUser();
    const result = await saveAccessStep(
      null,
      form({
        posture: 'sso',
        publicUrl: 'https://quotes.thornbury.example',
        googleClientId: '',
        googleClientSecret: '',
        microsoftClientId: '',
        microsoftClientSecret: '',
        microsoftTenantId: '',
      }),
    );
    expect(result.ok).toBe(false);
    expect(await readAuthConfig()).toBeNull();
  });

  it('refuses a plain http public url outside localhost', async () => {
    await runStepsThroughFirstUser();
    // Every provider refuses a plain http redirect URI outside localhost, and
    // this is also the origin the cross-origin refusal compares against.
    const result = await saveAccessStep(
      null,
      form({ ...SSO_FORM, publicUrl: 'http://quotes.thornbury.example' }),
    );
    expect(result.ok).toBe(false);
    expect(await readAuthConfig()).toBeNull();
  });

  it('refuses a step whose predecessor has not been completed', async () => {
    expect((await saveCompanyStep(null, form(COMPANY))).ok).toBe(true);

    // A stale tab, or a crafted post. The gate is re-read inside the writing
    // transaction, so the refusal cannot be raced.
    const result = await saveAccessStep(null, form(SSO_FORM));
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('Nothing was saved');
    expect(await readAuthConfig()).toBeNull();
  });

  it('refuses to reconfigure a company this wizard did not create', async () => {
    await seedDeployment({
      legalName: 'Kestrel Joinery Incorporated',
      displayName: 'Kestrel Joinery',
    });

    const result = await saveAccessStep(null, form(SSO_FORM));
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('already exists');
    // Not a file either. A live deployment's sign-in posture is not something
    // this wizard may rewrite.
    expect(await readAuthConfig()).toBeNull();
  });
});

describe('the environment report tells configured from in effect', () => {
  const WATCHED = [
    'AUTH_MODE',
    'LOCAL_USER_EMAIL',
    'APP_PUBLIC_URL',
    'CF_ACCESS_TEAM_DOMAIN',
    'CF_ACCESS_AUD',
    'GOOGLE_CLIENT_ID',
    'MICROSOFT_CLIENT_ID',
    'APPLE_CLIENT_ID',
    'SSO_COOKIE_SECRET',
    'GOOGLE_CLIENT_SECRET',
    'MICROSOFT_CLIENT_SECRET',
    'MICROSOFT_TENANT_ID',
    'TUNNEL_TOKEN',
  ] as const;

  // Saved and restored by hand rather than through a whole-object swap, for
  // the reason `setup.test.ts` gives: reassigning process.env leaves the
  // database URL behind in some Node builds.
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of WATCHED) saved.set(name, process.env[name]);
    for (const name of WATCHED) delete process.env[name];
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function byId(checks: Awaited<ReturnType<typeof runEnvironmentChecks>>, id: string) {
    const check = checks.find((candidate) => candidate.id === id);
    if (!check) throw new Error(`no check with id ${id}`);
    return check;
  }

  it('reports a written file that this process never loaded as awaiting a restart', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form(SSO_FORM))).ok).toBe(true);

    // Nothing was put into process.env, which is exactly the real situation:
    // the file is read at boot by the entrypoint, so a file written now does
    // nothing at all until the container comes back.
    const check = byId(await runEnvironmentChecks(), 'deploy-config');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('NOT in effect');
    expect(check.detail).toContain('AUTH_MODE');
    expect(check.remedy).toContain('docker compose');
    // And it never prints what it found.
    expect(`${check.detail} ${check.remedy}`).not.toContain(GOOGLE_SECRET);
  });

  it('says the same thing on the sign-in row, instead of "AUTH_MODE is not set"', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form(SSO_FORM))).ok).toBe(true);

    // "You have not configured this" and "you configured this and the
    // container has not been restarted" are different problems. Reporting the
    // first when the second is true sends an installer back to redo a step he
    // already finished.
    const check = byId(await runEnvironmentChecks(), 'auth-mode');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('configured as sso');
    expect(check.detail).toContain('not the same thing as in effect');
  });

  it('reports the posture as in effect once the process is running those values', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form(SSO_FORM))).ok).toBe(true);

    // What the entrypoint does at boot, done by hand: every key the file names
    // exported into the environment.
    const file = await readAuthConfig();
    for (const [key, value] of file!.entries) process.env[key] = value;

    const check = byId(await runEnvironmentChecks(), 'deploy-config');
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('in effect');
    expect(check.detail).toContain('sso');
  });

  it('reports the environment as winning when it names a different value', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form(TUNNEL_FORM))).ok).toBe(true);

    const file = await readAuthConfig();
    for (const [key, value] of file!.entries) process.env[key] = value;
    // An operator who pinned the mode in his compose file. The environment
    // winning is what keeps that value out of reach of anything this
    // application writes, so it is reported rather than treated as a fault.
    process.env.AUTH_MODE = 'sso';

    const check = byId(await runEnvironmentChecks(), 'deploy-config');
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('overriding AUTH_MODE');
    expect(check.remedy).toBeTruthy();
  });

  it('reports no file as off rather than as a failure', async () => {
    // A legitimate arrangement: an operator who sets every value in his
    // compose file never writes this file at all.
    const check = byId(await runEnvironmentChecks(), 'deploy-config');
    expect(check.status).toBe('off');
    expect(check.detail).toContain('no configuration file');
  });

  it('shouts about AUTH_MODE=local appearing in the file, and does not honour it', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form({ posture: 'lan', localUserEmail: OWNER.email }))).ok)
      .toBe(true);

    // Whatever put it there -- a hand edit, a restored file, or a write that
    // should not have happened -- it is the shape of a privilege escalation
    // and it is never silent.
    const existing = await readFile(configPath, 'utf8');
    await writeFile(configPath, `${existing}AUTH_MODE="local"\n`);

    const check = byId(await runEnvironmentChecks(), 'deploy-config');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('refused and was not loaded');
    expect((await readAuthConfig())?.entries.has('AUTH_MODE')).toBe(false);
  });

  it('names a line whose key this file does not manage', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form(SSO_FORM))).ok).toBe(true);

    const existing = await readFile(configPath, 'utf8');
    await writeFile(configPath, `${existing}DATABASE_URL="postgres://elsewhere/quote"\n`);

    // The allowlist is what keeps a write into this file from reaching the rest
    // of the deployment, and silence about a dropped line is how a hand-edit
    // in the wrong file stays a mystery for a week.
    const check = byId(await runEnvironmentChecks(), 'deploy-config');
    expect(check.detail).toContain('DATABASE_URL');
    expect(check.detail).toContain('does not manage');
    expect((await readAuthConfig())?.entries.has('AUTH_MODE')).toBe(true);
  });

  it('every failing check still names a next action', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form(SSO_FORM))).ok).toBe(true);

    // A check that reports a failure without a remedy is a check that gets
    // ignored, and this step's report is read at eleven at night.
    for (const check of await runEnvironmentChecks()) {
      if (check.status === 'fail') expect(check.remedy, check.id).toBeTruthy();
    }
  });

  it('lets setup finish with the posture still awaiting a restart', async () => {
    await runStepsThroughFirstUser();
    expect((await saveAccessStep(null, form(SSO_FORM))).ok).toBe(true);
    // The wizard does not block on it. Half of what the report names is a
    // decision the owner is entitled to make differently, and a wizard that
    // refused would be routed around with SQL.
    expect((await acknowledgeEnvironmentStep(null, form({}))).ok).toBe(true);
    expect((await openGate()).resumeAt).toBe('done');
  });
});
