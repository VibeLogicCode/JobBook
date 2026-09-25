import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `revalidatePath` is a request-scoped Next API and there is no request here.
 * Mocked rather than avoided: the actions genuinely must call it -- the root
 * layout reads the organization row for the tab title and the accent colour,
 * so a step that names the company has to invalidate the layout -- and a test
 * that forced it out of the action would be testing a different function.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

import { db } from '@/db/client';
import { costCodes, organization, settings, taxRates, users } from '@/db/schema';
// After the mocks above, deliberately: this pulls in the database client,
// and the module under test must not be loaded before they are installed.
import { readDeployment, seedDeployment } from '../support/organization';
import {
  acknowledgeEnvironmentStep,
  finishSetup,
  saveCompanyStep,
  saveContactStep,
  saveFinancialStep,
  saveFirstUserStep,
  saveLocaleStep,
  saveTradeStep,
  saveTaxRateStep,
} from '@/app/setup/actions';
import { saveAccessStep } from '@/app/setup/access/actions';
import { runEnvironmentChecks } from '@/app/setup/environment';
import { SETUP_STATE_KEY, readSetupGate, stepMarkerKey } from '@/app/setup/state';
import type { ActionResult } from '@/app/settings/result';

/**
 * First-run setup against the real database.
 *
 * What is worth testing here is not the field validation -- that is the
 * settings screens' own builders, already covered -- but the four properties
 * this wizard is the only thing enforcing:
 *
 * 1. It cannot touch a company it did not create. This is the one that matters
 *    most: the failure is silent and total, a live tenant's legal name and tax
 *    registration replaced by whatever somebody typed into a form, on
 *    documents already in a customer's inbox.
 * 2. Each step is durable on its own, so a closed laptop at step 5 costs step
 *    5 and nothing before it.
 * 3. The first account is an owner, whatever the submission says.
 * 4. The environment check reports a missing variable instead of throwing --
 *    a missing variable on a fresh box is the normal case and is exactly what
 *    the installer opened the page to find out.
 */

/**
 * A fictional company, and a different one from the demo seed's on purpose:
 * two fixtures naming the same company would let a test pass because the seed
 * had run rather than because the wizard wrote anything.
 */
const COMPANY = {
  legalName: 'Ravensworth Contracting Limited',
  displayName: 'Ravensworth Contracting',
  operatingName: 'Ravensworth Interiors',
  tagline: 'Fit-outs and refurbishment',
  ownerName: 'Marta Ilves',
  ownerTitle: 'Principal',
};

const CONTACT = {
  addressLine1: '12 Kilnwood Way',
  addressLine2: 'Unit 4',
  city: 'Selkirk',
  province: 'Borders',
  postalCode: 'TD7 4AB',
  country: 'Scotland',
  phone: '+44 1750 000000',
  altPhone: '',
  email: 'quotes@ravensworth.example',
  website: 'https://ravensworth.example',
};

/**
 * The trade step's payload.
 *
 * `both` and `general`, which is the answer that changes least: every form is
 * offered and the pack's types are the nine migration 0018 already created, so
 * this step adds cost codes and rate items and retires nothing. A test that
 * picked `electrical` here would silently retire eight project types under
 * every other assertion in this file.
 */
const TRADE = {
  workPosture: 'both',
  trade: 'general',
  // Required, with no default on the form: there is no sensible guess at how
  // much of the product a stranger wants.
  scope: 'everything',
};

const LOCALE = {
  currency: 'GBP',
  locale: 'en-GB',
  timezone: 'Europe/London',
  areaUnit: 'sqm',
};

const FINANCIAL = {
  taxRegistrationNumber: 'GB000000000',
  taxRegistrationLabel: 'VAT Number',
  businessNumber: 'SC000000',
  fiscalYearEndMonth: '3',
  fiscalYearEndDay: '31',
  taxFilingFrequency: 'quarterly',
  taxDeferredOnHoldback: 'on',
  defaultHoldbackPct: '7.5',
  holdbackLabel: 'Retention',
  holdbackTermsText: 'Retention is released after making good of defects.',
  holdbackReleaseDays: '90',
  paymentTermsDays: '21',
  paymentTermsText: 'Deposit on acceptance, balance on completion.',
  insuranceStatement: 'Public liability cover in place; certificate on request.',
  targetMargin: '22.5',
};

const TAX_RATE = {
  label: 'Standard rate',
  shortLabel: 'VAT',
  registrationNumber: 'GB000000000',
  rate: '4.25',
  effectiveFrom: '2024-04-06',
  sortOrder: '1',
};

const OWNER = {
  displayName: 'Marta Ilves',
  email: 'marta.ilves@ravensworth.example',
};

/**
 * The access step, in its office-network posture: the one that needs no
 * credentials and so keeps this suite about the wizard's order rather than
 * about deployment configuration, which `deploy-config.test.ts` covers.
 */
const ACCESS = { posture: 'lan', localUserEmail: OWNER.email };

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}

/** The failure message, or the success message, so an assertion is one `toBe`. */
function messageOf(result: ActionResult): string {
  return result.ok ? result.message : result.error;
}

async function openGate() {
  const gate = await readSetupGate();
  if (!gate.open) throw new Error(`expected an open gate, got ${gate.reason}: ${gate.detail}`);
  return gate;
}

/** Steps 1 to 4, which is as far as anything but the tax rate needs. */
async function runStepsThroughFinancial(): Promise<void> {
  expect(messageOf(await saveCompanyStep(null, form(COMPANY)))).toContain('created');
  expect((await saveContactStep(null, form(CONTACT))).ok).toBe(true);
  expect((await saveTradeStep(null, form(TRADE))).ok).toBe(true);
  expect((await saveLocaleStep(null, form(LOCALE))).ok).toBe(true);
  expect((await saveFinancialStep(null, form(FINANCIAL))).ok).toBe(true);
}

beforeEach(async () => {
  // audit_log first and by name: the triggers on organization, tax_rates and
  // users write a row per insert, and no foreign key means cascade never
  // reaches it. settings holds the completion marker, so a leftover row would
  // close the wizard for every test after the one that finished it.
  await db.execute(sql`
    truncate table audit_log, tax_rates, users, organization, companies, document_sequences, settings
    restart identity cascade
  `);
});

describe('the wizard refuses to run once a company exists', () => {
  it('closes the gate on a company it did not create', async () => {
    // The demo seed, or a restored backup: an organization row with no claim
    // by this wizard.
    await seedDeployment({
      legalName: 'Kestrel Joinery Incorporated',
      displayName: 'Kestrel Joinery',
    });

    const gate = await readSetupGate();
    expect(gate.open).toBe(false);
    if (gate.open) throw new Error('unreachable');
    expect(gate.reason).toBe('live-tenant');
  });

  it('refuses the first step, and leaves the existing company untouched', async () => {
    await seedDeployment({
      legalName: 'Kestrel Joinery Incorporated',
      displayName: 'Kestrel Joinery',
    });

    const result = await saveCompanyStep(null, form(COMPANY));
    expect(result.ok).toBe(false);

    const row = await readDeployment();
    expect(row?.legalName).toBe('Kestrel Joinery Incorporated');
  });

  it('refuses a later step as well, so no step is a way in', async () => {
    await seedDeployment({
      legalName: 'Kestrel Joinery Incorporated',
      displayName: 'Kestrel Joinery',
    });

    // Each action gets its OWN valid payload, so the refusal can only be the
    // gate. Handing every one of them the contact fields would have three of
    // them refuse on validation instead, and prove nothing about the guard.
    const attempts = [
      [saveContactStep, CONTACT],
      [saveTradeStep, TRADE],
      [saveLocaleStep, LOCALE],
      [saveFinancialStep, FINANCIAL],
      [saveTaxRateStep, TAX_RATE],
      [saveFirstUserStep, OWNER],
      [saveAccessStep, ACCESS],
      [acknowledgeEnvironmentStep, {}],
      [finishSetup, {}],
    ] as const;

    for (const [action, payload] of attempts) {
      const result = await action(null, form(payload));
      expect(result.ok).toBe(false);
      expect(messageOf(result)).toContain('already exists');
    }
  });

  it('refuses every step once setup has been finished', async () => {
    await runStepsThroughFinancial();
    expect((await saveTaxRateStep(null, form(TAX_RATE))).ok).toBe(true);
    expect((await saveFirstUserStep(null, form(OWNER))).ok).toBe(true);
    expect((await saveAccessStep(null, form(ACCESS))).ok).toBe(true);
    expect((await acknowledgeEnvironmentStep(null, form({}))).ok).toBe(true);
    expect((await finishSetup(null, form({}))).ok).toBe(true);

    const gate = await readSetupGate();
    expect(gate.open).toBe(false);
    if (gate.open) throw new Error('unreachable');
    expect(gate.reason).toBe('complete');

    // Finishing is not a state anything walks back out of.
    const again = await saveCompanyStep(null, form({ ...COMPANY, legalName: 'Something Else' }));
    expect(again.ok).toBe(false);
    const row = await readDeployment();
    expect(row?.legalName).toBe(COMPANY.legalName);
  });
});

describe('each step persists independently', () => {
  it('creates the single organization row on the first step', async () => {
    const result = await saveCompanyStep(null, form(COMPANY));
    expect(result.ok).toBe(true);

    const row = await readDeployment();
    expect(row?.id).toBe(1);
    expect(row?.legalName).toBe(COMPANY.legalName);
    expect(row?.operatingName).toBe(COMPANY.operatingName);

    const gate = await openGate();
    expect(gate.completed.has('company')).toBe(true);
    expect(gate.resumeAt).toBe('contact');
  });

  it('updates that row on the contact step rather than inserting a second', async () => {
    await saveCompanyStep(null, form(COMPANY));
    expect((await saveContactStep(null, form(CONTACT))).ok).toBe(true);

    // Still exactly one deployment row -- the contact step updates, it does
    // not insert a second.
    expect(await db.select().from(organization)).toHaveLength(1);

    const row = await readDeployment();
    expect(row?.city).toBe(CONTACT.city);
    // The earlier step's values survive: this is an update, not a replacement.
    // Both halves of it -- the company step wrote the legal name to
    // `companies` and the contact step must not have replaced that row either.
    expect(row?.legalName).toBe(COMPANY.legalName);
    // A field left blank is NULL, never the empty string.
    expect(row?.altPhone).toBeNull();
  });

  it('stores the locale, which is what dates the first quote', async () => {
    await saveCompanyStep(null, form(COMPANY));
    await saveContactStep(null, form(CONTACT));
    // The trade step sits between contact and locale, and every step refuses
    // until the one before it is done -- which is the whole point of the
    // wizard being an ORDER rather than a menu.
    await saveTradeStep(null, form(TRADE));
    const result = await saveLocaleStep(null, form(LOCALE));
    expect(messageOf(result)).toContain(LOCALE.timezone);

    const row = await readDeployment();
    expect(row?.timezone).toBe(LOCALE.timezone);
    expect(row?.currency).toBe(LOCALE.currency);
    expect(row?.areaUnit).toBe('sqm');
  });

  it('stores percentages as scaled integers, not floats', async () => {
    await runStepsThroughFinancial();

    const row = await readDeployment();
    // 7.5% is 750 ten-thousandths of a fraction, and a bigint, not 0.075.
    expect(row?.defaultHoldbackPctTenThou).toBe(750n);
    // Basis points are the same scale: 22.5% is 2250 of either.
    expect(row?.targetMarginBp).toBe(2250);
    expect(row?.fiscalYearEndMonth).toBe(3);
    expect(row?.fiscalYearEndDay).toBe(31);
    expect(row?.taxFilingFrequency).toBe('quarterly');
    expect(row?.holdbackReleaseDays).toBe(90);
  });

  it('refuses a percentage finer than the stored scale rather than rounding it', async () => {
    await saveCompanyStep(null, form(COMPANY));
    await saveContactStep(null, form(CONTACT));
    await saveLocaleStep(null, form(LOCALE));

    // A rate quietly altered in the third decimal reprices every future quote.
    const result = await saveFinancialStep(
      null,
      form({ ...FINANCIAL, defaultHoldbackPct: '7.555' }),
    );
    expect(result.ok).toBe(false);

    const gate = await openGate();
    expect(gate.completed.has('financial')).toBe(false);
  });

  it('inserts the first tax rate in ten-thousandths with its effective date', async () => {
    await runStepsThroughFinancial();
    const result = await saveTaxRateStep(null, form(TAX_RATE));
    expect(messageOf(result)).toContain(TAX_RATE.effectiveFrom);

    const rows = await db.select().from(taxRates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rateTenThou).toBe(425n);
    expect(rows[0]?.effectiveFrom).toBe(TAX_RATE.effectiveFrom);
    // Null means in force, which is what a first rate must be.
    expect(rows[0]?.effectiveTo).toBeNull();
  });

  it('corrects the tax rate on a re-submit instead of leaving two in force', async () => {
    await runStepsThroughFinancial();
    await saveTaxRateStep(null, form(TAX_RATE));
    expect((await saveTaxRateStep(null, form({ ...TAX_RATE, rate: '5' }))).ok).toBe(true);

    const rows = await db.select().from(taxRates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rateTenThou).toBe(500n);
  });

  it('refuses a step whose predecessor has not been completed', async () => {
    await saveCompanyStep(null, form(COMPANY));

    // Not a hypothetical: this is a stale tab, or a crafted post.
    const result = await saveFinancialStep(null, form(FINANCIAL));
    expect(result.ok).toBe(false);
    expect(messageOf(result)).toContain('Nothing was saved');

    const row = await readDeployment();
    expect(row?.holdbackLabel).toBeNull();
  });
});

/**
 * The owner's second company shape: *"second as a small 1 man shop"*.
 *
 * The trade step (3) is answered before the financial step (5), so by the time
 * the longest form in the wizard renders, the company has already said whether
 * it withholds holdback on anything. Asking a one-van service outfit for a
 * default percentage, a label, a release period, a tax deferral and a terms
 * paragraph is five questions about something that never happens on its jobs.
 *
 * What these assert is the half a hidden field cannot: that NOT ASKING leaves
 * the columns at their defaults instead of writing blanks and a false over
 * them. An unsent checkbox parses as `false`, so the naive version of this
 * change would have stored `tax_deferred_on_holdback = false` for every
 * service company -- a wrong answer to a question nobody was asked.
 */
describe('a service-only company is asked less', () => {
  const WITHOUT_HOLDBACK = Object.fromEntries(
    Object.entries(FINANCIAL).filter(([key]) => !key.toLowerCase().includes('holdback')),
  ) as Record<string, string>;

  async function stepsThroughLocale(workPosture: string): Promise<void> {
    expect(messageOf(await saveCompanyStep(null, form(COMPANY)))).toContain('created');
    expect((await saveContactStep(null, form(CONTACT))).ok).toBe(true);
    expect((await saveTradeStep(null, form({ ...TRADE, workPosture }))).ok).toBe(true);
    expect((await saveLocaleStep(null, form(LOCALE))).ok).toBe(true);
  }

  it('saves the step with no holdback fields on the form at all', async () => {
    await stepsThroughLocale('service');

    // The five keys are absent, exactly as the rendered form leaves them.
    // `holdbackReleaseDays` used to be `requiredInt`, which made this submit
    // fail with "Holdback release days is required" -- a step refusing itself
    // over a field it never showed.
    const result = await saveFinancialStep(null, form(WITHOUT_HOLDBACK));
    expect(messageOf(result)).toBe('Financial and legal settings saved.');

    const saved = await readDeployment();
    // Column defaults, untouched: NOT NULL DEFAULT 60, and DEFAULT true.
    expect(saved?.holdbackReleaseDays).toBe(60);
    expect(saved?.taxDeferredOnHoldback).toBe(true);
    expect(saved?.defaultHoldbackPctTenThou).toBeNull();
    expect(saved?.holdbackLabel).toBeNull();
    expect(saved?.holdbackTermsText).toBeNull();
    // And the rest of the step still landed. The point is a shorter form, not
    // a step that quietly saves less of what it did ask.
    expect(saved?.paymentTermsDays).toBe(21);
    expect(saved?.taxRegistrationNumber).toBe('GB000000000');
    expect(saved?.targetMarginBp).toBe(2250);
  });

  it('ignores holdback fields submitted by a service-only company anyway', async () => {
    await stepsThroughLocale('service');

    // A stale tab, or a form somebody re-posted by hand. The company says it
    // does not do contract work, so the answer is the same as not asking:
    // defaults kept, nothing written.
    const result = await saveFinancialStep(null, form(FINANCIAL));
    expect(result.ok).toBe(true);

    const saved = await readDeployment();
    expect(saved?.defaultHoldbackPctTenThou).toBeNull();
    expect(saved?.holdbackReleaseDays).toBe(60);
  });

  it('still stores every holdback field for a company that does contract work', async () => {
    await stepsThroughLocale('both');

    expect((await saveFinancialStep(null, form(FINANCIAL))).ok).toBe(true);

    const saved = await readDeployment();
    // 7.5% as ten-thousandths of the FRACTION: 0.075. Not 75000.
    expect(saved?.defaultHoldbackPctTenThou).toBe(750n);
    expect(saved?.holdbackReleaseDays).toBe(90);
    expect(saved?.holdbackLabel).toBe('Retention');
    expect(saved?.taxDeferredOnHoldback).toBe(true);
  });

  it('stores them for a contract-only company too', async () => {
    // `contract` and `both` differ in which TYPES are offered, never in
    // whether holdback is asked about.
    await stepsThroughLocale('contract');
    expect((await saveFinancialStep(null, form(FINANCIAL))).ok).toBe(true);
    expect((await readDeployment())?.defaultHoldbackPctTenThou).toBe(750n);
  });
});

describe('a partial setup can be resumed', () => {
  it('remembers which steps are done, from the database and not from memory', async () => {
    await saveCompanyStep(null, form(COMPANY));
    await saveContactStep(null, form(CONTACT));

    // A second, independent read is what a request after a browser crash does.
    const gate = await openGate();
    expect([...gate.completed].sort()).toEqual(['company', 'contact']);
    // `trade` now, not `locale`: it is the next incomplete step in the order.
    expect(gate.resumeAt).toBe('trade');
    expect(gate.org?.legalName).toBe(COMPANY.legalName);

    // And the half-built company is not mistaken for a live tenant.
    const marker = await db
      .select()
      .from(settings)
      .where(eq(settings.key, SETUP_STATE_KEY));
    expect(marker[0]?.value).toBe('in_progress');
  });

  it('picks up at the interrupted step and finishes from there', async () => {
    await runStepsThroughFinancial();
    expect((await openGate()).resumeAt).toBe('tax-rate');

    await saveTaxRateStep(null, form(TAX_RATE));
    await saveFirstUserStep(null, form(OWNER));
    await saveAccessStep(null, form(ACCESS));
    await acknowledgeEnvironmentStep(null, form({}));
    expect((await openGate()).resumeAt).toBe('done');

    expect((await finishSetup(null, form({}))).ok).toBe(true);
    const rows = await db.select().from(settings).where(eq(settings.key, SETUP_STATE_KEY));
    expect(rows[0]?.value).toBe('complete');
  });

  it('lets a completed step be corrected before setup is finished', async () => {
    await saveCompanyStep(null, form(COMPANY));
    await saveContactStep(null, form(CONTACT));

    const corrected = await saveCompanyStep(
      null,
      form({ ...COMPANY, displayName: 'Ravensworth Fit-Out' }),
    );
    expect(corrected.ok).toBe(true);

    const row = await readDeployment();
    expect(row?.displayName).toBe('Ravensworth Fit-Out');
    // Going back does not undo what came after it.
    expect((await openGate()).completed.has('contact')).toBe(true);
  });

  it('records a marker for every completed step', async () => {
    await runStepsThroughFinancial();

    for (const slug of ['company', 'contact', 'locale', 'financial'] as const) {
      const rows = await db.select().from(settings).where(eq(settings.key, stepMarkerKey(slug)));
      expect(rows[0]?.value).toBeTruthy();
    }
  });
});

describe('the first user', () => {
  it('is created with the owner role', async () => {
    await runStepsThroughFinancial();
    await saveTaxRateStep(null, form(TAX_RATE));

    const result = await saveFirstUserStep(null, form(OWNER));
    expect(result.ok).toBe(true);

    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('owner');
    expect(rows[0]?.email).toBe(OWNER.email);
    expect(rows[0]?.isActive).toBe(true);
  });

  it('is an owner even when the submission asks for something else', async () => {
    await runStepsThroughFinancial();
    await saveTaxRateStep(null, form(TAX_RATE));

    // A role in a form field is a role the browser can edit. The first account
    // has to be able to grant every other role, so this field is not read.
    const result = await saveFirstUserStep(null, form({ ...OWNER, role: 'bookkeeper' }));
    expect(result.ok).toBe(true);

    const rows = await db.select().from(users);
    expect(rows[0]?.role).toBe('owner');
  });

  it('lowercases the address, which is the form every write boundary stores', async () => {
    await runStepsThroughFinancial();
    await saveTaxRateStep(null, form(TAX_RATE));
    await saveFirstUserStep(null, form({ ...OWNER, email: 'Marta.Ilves@Ravensworth.Example' }));

    const rows = await db.select().from(users);
    expect(rows[0]?.email).toBe(OWNER.email);
  });

  it('corrects the same account on a re-submit rather than creating a second owner', async () => {
    await runStepsThroughFinancial();
    await saveTaxRateStep(null, form(TAX_RATE));
    await saveFirstUserStep(null, form(OWNER));

    const result = await saveFirstUserStep(
      null,
      form({ ...OWNER, email: 'm.ilves@ravensworth.example' }),
    );
    expect(result.ok).toBe(true);

    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('m.ilves@ravensworth.example');
    expect(rows[0]?.role).toBe('owner');
  });
});

describe('the environment check', () => {
  const WATCHED = [
    'AUTH_MODE',
    'LOCAL_USER_EMAIL',
    'INTERNAL_RENDER_SECRET',
    'SHAREPOINT_SYNC_ENABLED',
    'SHAREPOINT_CERT_PATH',
    'SHAREPOINT_CERT_THUMBPRINT',
    'SHAREPOINT_TENANT_ID',
    'SHAREPOINT_CLIENT_ID',
    'BACKUP_USB_DIR',
    'BACKUP_UPLOAD_DIR',
    // The mode interlock reads all six of these, and the sign-in suites in
    // this same run set some of them. A leaked provider id would make local
    // mode report an incoherent configuration for a reason that has nothing
    // to do with the assertion being made.
    'CF_ACCESS_TEAM_DOMAIN',
    'CF_ACCESS_AUD',
    'GOOGLE_CLIENT_ID',
    'MICROSOFT_CLIENT_ID',
    'APPLE_CLIENT_ID',
    'APP_PUBLIC_URL',
  ] as const;

  /** Everything the mode interlock forbids alongside local mode. */
  function clearSignInConfiguration(): void {
    for (const name of [
      'CF_ACCESS_TEAM_DOMAIN',
      'CF_ACCESS_AUD',
      'GOOGLE_CLIENT_ID',
      'MICROSOFT_CLIENT_ID',
      'APPLE_CLIENT_ID',
    ]) {
      delete process.env[name];
    }
  }

  // Saved and restored by hand rather than through a whole-object swap:
  // reassigning process.env leaves the database URL behind in some Node
  // builds, and every other suite in this run needs it.
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of WATCHED) saved.set(name, process.env[name]);
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

  it('reports a failure rather than throwing when a variable is missing', async () => {
    delete process.env.AUTH_MODE;
    delete process.env.INTERNAL_RENDER_SECRET;
    delete process.env.SHAREPOINT_SYNC_ENABLED;
    delete process.env.BACKUP_USB_DIR;

    const checks = await runEnvironmentChecks();

    expect(byId(checks, 'auth-mode').status).toBe('fail');
    expect(byId(checks, 'render-secret').status).toBe('fail');
    expect(byId(checks, 'usb-backup').status).toBe('fail');
    // Every failure names the next action, because a check that reports one
    // without a remedy is a check that gets ignored.
    for (const check of checks) {
      if (check.status === 'fail') expect(check.remedy).toBeTruthy();
    }
  });

  it('names the variable an installer has to set', async () => {
    delete process.env.INTERNAL_RENDER_SECRET;
    const checks = await runEnvironmentChecks();
    expect(byId(checks, 'render-secret').detail).toContain('INTERNAL_RENDER_SECRET');
    expect(byId(checks, 'render-secret').variables).toContain('INTERNAL_RENDER_SECRET');
  });

  it('rejects a placeholder secret, which is the likeliest first-run mistake', async () => {
    process.env.INTERNAL_RENDER_SECRET = 'change-me-to-a-long-random-string';
    expect(byId(await runEnvironmentChecks(), 'render-secret').status).toBe('fail');
  });

  it('accepts a real secret of a usable length', async () => {
    process.env.INTERNAL_RENDER_SECRET = 'K7pQ2vY9wR4tL8nX6mB3zC5jH1sD0fGa';
    expect(byId(await runEnvironmentChecks(), 'render-secret').status).toBe('pass');
  });

  it('reads the database as reachable, because it is answering this test', async () => {
    expect(byId(await runEnvironmentChecks(), 'database').status).toBe('pass');
  });

  it('reports the mirror as off rather than failing, since off is the default', async () => {
    delete process.env.SHAREPOINT_SYNC_ENABLED;
    const check = byId(await runEnvironmentChecks(), 'sharepoint');
    // Not a failure: not every company wants its records in a Microsoft
    // tenant. What it endangers is the offsite copy, reported by the backup
    // check instead.
    expect(check.status).toBe('off');
  });

  it('fails the mirror when it is switched on with no credential to load', async () => {
    process.env.SHAREPOINT_SYNC_ENABLED = '1';
    process.env.SHAREPOINT_TENANT_ID = '00000000-0000-0000-0000-000000000000';
    process.env.SHAREPOINT_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
    delete process.env.SHAREPOINT_CERT_PATH;

    const check = byId(await runEnvironmentChecks(), 'sharepoint');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('SHAREPOINT_CERT_PATH');
  });

  it('fails a certificate path that does not resolve, without throwing', async () => {
    process.env.SHAREPOINT_SYNC_ENABLED = '1';
    process.env.SHAREPOINT_TENANT_ID = '00000000-0000-0000-0000-000000000000';
    process.env.SHAREPOINT_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
    process.env.SHAREPOINT_CERT_PATH = path.join(
      import.meta.dirname,
      'no-such-secret-is-mounted.pem',
    );
    process.env.SHAREPOINT_CERT_THUMBPRINT = 'AA'.repeat(20);

    expect(byId(await runEnvironmentChecks(), 'sharepoint').status).toBe('fail');
  });

  it('fails the backup check when a configured path is not mounted', async () => {
    process.env.BACKUP_USB_DIR = path.join(import.meta.dirname, 'no-such-mount-point');
    const check = byId(await runEnvironmentChecks(), 'usb-backup');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('not mounted');
  });

  it('says so when neither a USB nor an offsite destination is configured', async () => {
    delete process.env.BACKUP_USB_DIR;
    delete process.env.BACKUP_UPLOAD_DIR;
    delete process.env.SHAREPOINT_SYNC_ENABLED;

    const check = byId(await runEnvironmentChecks(), 'usb-backup');
    expect(check.status).toBe('fail');
    // The interlock: with both off, the only copy of the company's records
    // sits on the same disk as the database it protects.
    expect(check.detail).toContain('same disk');
  });

  it('fails local mode when the named identity has no account', async () => {
    process.env.AUTH_MODE = 'local';
    process.env.LOCAL_USER_EMAIL = 'nobody@ravensworth.example';
    clearSignInConfiguration();

    const check = byId(await runEnvironmentChecks(), 'auth-mode');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('nobody@ravensworth.example');
  });

  it('passes local mode once the owner account exists', async () => {
    await runStepsThroughFinancial();
    await saveTaxRateStep(null, form(TAX_RATE));
    await saveFirstUserStep(null, form(OWNER));

    process.env.AUTH_MODE = 'local';
    process.env.LOCAL_USER_EMAIL = OWNER.email;
    clearSignInConfiguration();

    const check = byId(await runEnvironmentChecks(), 'auth-mode');
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('owner');
  });
});

describe('nothing in this area deletes', () => {
  it('contains no delete call anywhere under the setup routes or components', async () => {
    // Nothing is ever deleted (spec section 4): a watermark sync cannot
    // observe a row that no longer exists, and these are tax records. The
    // database role does not hold the privilege either, so a DELETE here would
    // fail at runtime -- but it would fail in front of an owner mid-setup.
    const roots = [
      path.resolve(import.meta.dirname, '../../src/app/setup'),
      path.resolve(import.meta.dirname, '../../src/components/setup'),
    ];

    const offences: string[] = [];
    for (const root of roots) {
      for await (const file of walk(root)) {
        const source = await readFile(file, 'utf8');
        if (/\.delete\s*\(/.test(source) || /\bdrop\s+table\b/i.test(source)) {
          offences.push(path.basename(file));
        }
      }
    }
    expect(offences).toEqual([]);
  });
});

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry.name)) yield full;
  }
}

/**
 * How much of the product a deployment starts with.
 *
 * The owner's question was whether this could be a quote-and-invoice tool for
 * somebody not ready for the rest, switched on when they are. The answer is a
 * set of switches rather than a mode -- see `db/schema/organization.ts` -- and
 * the wizard is where the first value is written.
 */
describe('what the deployment starts with', () => {
  it('leaves every part on when the installer asks for everything', async () => {
    expect(messageOf(await saveCompanyStep(null, form(COMPANY)))).toContain('created');
    expect((await saveContactStep(null, form(CONTACT))).ok).toBe(true);
    expect((await saveTradeStep(null, form({ ...TRADE, scope: 'everything' }))).ok).toBe(true);

    const [row] = await db.select().from(organization).where(eq(organization.id, 1));
    expect(row!.modulePipeline).toBe(true);
    expect(row!.moduleCalendar).toBe(true);
    expect(row!.moduleExpenses).toBe(true);
    expect(row!.moduleVendors).toBe(true);
    expect(row!.moduleTemplates).toBe(true);
    expect(row!.moduleReminders).toBe(true);
  });

  it('puts the optional parts away for a quotes-and-invoices start', async () => {
    expect(messageOf(await saveCompanyStep(null, form(COMPANY)))).toContain('created');
    expect((await saveContactStep(null, form(CONTACT))).ok).toBe(true);
    expect((await saveTradeStep(null, form({ ...TRADE, scope: 'quotes' }))).ok).toBe(true);

    const [row] = await db.select().from(organization).where(eq(organization.id, 1));
    expect(row!.modulePipeline).toBe(false);
    expect(row!.moduleCalendar).toBe(false);
    expect(row!.moduleExpenses).toBe(false);
    expect(row!.moduleVendors).toBe(false);
    expect(row!.moduleTemplates).toBe(false);
    expect(row!.moduleReminders).toBe(false);
  });

  it('refuses the step when the question is left unanswered', async () => {
    // No default on the form, so an unanswered select sends nothing -- and the
    // step must refuse rather than pick for him.
    expect(messageOf(await saveCompanyStep(null, form(COMPANY)))).toContain('created');
    const { scope: _scope, ...withoutScope } = TRADE;
    expect((await saveTradeStep(null, form(withoutScope))).ok).toBe(false);
  });

  it('loads the trade pack either way', async () => {
    // The parts that are put away are the MENU. A quotes-only start still gets
    // its job types, cost codes and rate book -- it is quoting that needs them.
    expect(messageOf(await saveCompanyStep(null, form(COMPANY)))).toContain('created');
    expect((await saveContactStep(null, form(CONTACT))).ok).toBe(true);
    expect((await saveTradeStep(null, form({ ...TRADE, trade: 'electrical', scope: 'quotes' }))).ok)
      .toBe(true);

    const codes = (await db.select().from(costCodes)).map((row) => row.code);
    expect(codes).toContain('E-10');
  });
});
