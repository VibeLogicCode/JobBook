'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { companies, organization, taxRates, users } from '@/db/schema';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { loadPack } from '@/db/seed/packs/load';
import { TRADE_LABELS } from '@/db/seed/packs/types';
import { percentField } from '@/app/settings/percent-schema';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import {
  checkbox,
  formValues,
  invalid,
  isoDate,
  optionalInt,
  optionalText,
  requiredInt,
  requiredText,
  whenShown,
} from '@/app/settings/validate';
import { configuredOidcProviders } from '@/app/setup/environment';
import { persistStep } from '@/app/setup/persist';
import {
  type ClosedGate,
  type Executor,
  OWNER_USER_ID_KEY,
  type OpenGate,
  TAX_RATE_ID_KEY,
  markStepComplete,
  putSetting,
  readSetupGate,
  stepIsReachable,
} from '@/app/setup/state';
import { type SetupStepSlug, stepAt } from '@/app/setup/steps';
import { authMode } from '@/lib/auth/mode';
import { forgetSoleOwner } from '@/lib/auth/sole-owner';
import { offersContract, postureOf } from '@/lib/posture/read';

/**
 * First-run setup: one action per step, each persisting as it completes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `src/app/settings/actions.ts` CALLED IN A DIFFERENT ORDER.
 *
 * Every settings action opens with `requireCapability`, which resolves the
 * signed-in identity against the `users` table and refuses an identity with no
 * active row. At first run that table is empty -- the owner's account is step
 * 6 -- so every one of those actions would correctly refuse every step of the
 * wizard whose job is to create the row they check for.
 *
 * The authorization here is different in kind, and it is the gate in
 * `state.ts`: this wizard may write only while no company exists that it did
 * not itself create. That is checked at the top of every action below, inside
 * the transaction that writes, before a single field is read.
 *
 * What IS shared with settings is everything that can be: the zod builders,
 * the percentage parser, the result shape, and every form component. The
 * fields themselves are the same fields, and a second opinion about what a
 * valid postal code looks like is a second answer waiting to disagree.
 * ---------------------------------------------------------------------------
 *
 * Persisting per step is the requirement that shapes the rest. A wizard that
 * held every form in memory and wrote once at the end would lose an hour of
 * an owner's typing to a closed laptop, and the marker rows that make a resume
 * possible are what let it pick up at step 5 instead of step 1.
 */

/**
 * Writes the single organization row.
 *
 * INSERT ... ON CONFLICT DO UPDATE, so the first step creates the row and
 * every later step -- and any step re-submitted to fix a typo -- updates it,
 * through one statement that cannot be a DELETE. `organization` carries a
 * CHECK (id = 1), so there is exactly one row to conflict with.
 */
async function upsertOrganization(
  tx: Executor,
  patch: Record<string, unknown>,
  required: { legalName: string; displayName: string } | null,
  gate: OpenGate,
): Promise<void> {
  const names = required ?? {
    // A later step cannot invent these, and cannot reach here without them:
    // the company step is the first in the order and writes both as NOT NULL.
    legalName: gate.org?.legalName ?? '',
    displayName: gate.org?.displayName ?? '',
  };

  /**
   * Filtered to what `organization` still owns, and guarded when that is
   * nothing.
   *
   * Both halves matter. The company step submits a legal name, an operating
   * name, a tagline and an owner -- every one of which now lives on
   * `companies` -- so its patch for THIS table is empty, and
   * `onConflictDoUpdate` with an empty `set` is not a no-op but invalid SQL
   * (`DO UPDATE SET` followed by nothing). The row still has to be created by
   * such a step, because it is the first step in the order.
   *
   * Derived from the table object rather than a list of names, the same way
   * `upsertFirstCompany` does it below: the split is one rule and having it
   * written twice in two shapes is how the two drift.
   */
  const deploymentOwned = Object.fromEntries(
    Object.entries(patch).filter(([key]) => key in organization),
  );

  const insert = tx.insert(organization).values({
    id: 1,
    // `displayName` is the deployment's label, so it belongs in this insert
    // even though the rest of `names` is the company's.
    displayName: names.displayName,
    ...deploymentOwned,
    // Null on purpose. There is no actor yet -- the owner's account is step
    // 6 -- and inventing one would put a fabricated author on the audit row
    // this insert writes.
    createdBy: null,
  });

  if (Object.keys(deploymentOwned).length === 0) {
    await insert.onConflictDoNothing({ target: organization.id });
  } else {
    await insert.onConflictDoUpdate({ target: organization.id, set: deploymentOwned });
  }

  await upsertFirstCompany(tx, patch, names);
}

/**
 * Writes the FIRST company alongside the deployment row.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WIZARD HAS TO DO THIS, AND WHY IT IS NOT A NEW STEP
 * ---------------------------------------------------------------------------
 *
 * The migration that created `companies` backfills it with an
 * `INSERT ... SELECT ... FROM organization`, which finds nothing on a database
 * where setup has never run. So on a FRESH install `companies` is empty, and
 * every foreign key pointing at it -- `projects.company_id`,
 * `tax_rates.company_id`, `document_sequences.company_id` -- has nothing to
 * point at. The wizard's own tax-rate step would be the first thing to fail.
 *
 * And it must NOT be a new step the installer answers. The owner asked for
 * "which company?" at setup and it is the one question that must not be asked:
 * he does not know his own legal structure yet -- he said so -- and a
 * contractor looking at a NAS at 11pm knows less. Any answer given at first
 * run is wrong often enough to matter, and the wrong answer in the "two"
 * direction burdens every single-company customer forever with a picker they
 * never wanted. A second company is added later, from Settings, by somebody
 * who has since spoken to an accountant.
 *
 * ---------------------------------------------------------------------------
 * THE COLUMN SUBSET IS DERIVED, NOT LISTED
 * ---------------------------------------------------------------------------
 *
 * `patch` is whatever step is submitting, keyed by Drizzle property name, and
 * only some of those keys exist on `companies` -- `timezone` and `currency`
 * are the deployment's and stay behind. Filtering against the table object
 * rather than a hand-written list of 36 names is the difference between one
 * source of truth and two: a column added to `companies` later is picked up
 * here for free, and a column that only ever belonged to the deployment cannot
 * be smuggled across by a typo.
 */
async function upsertFirstCompany(
  tx: Executor,
  patch: Record<string, unknown>,
  names: { legalName: string; displayName: string },
): Promise<void> {
  const owned = Object.fromEntries(
    Object.entries(patch).filter(([key]) => key in companies),
  );

  const insert = tx.insert(companies).values({
    id: FIRST_COMPANY_ID,
    ...names,
    ...owned,
    // Same reasoning as the organization insert above: no actor exists yet.
    createdBy: null,
  });

  /**
   * `DO NOTHING` when this step writes nothing a company owns.
   *
   * The locale step is exactly that case -- currency, locale, timezone and
   * area unit are all the deployment's, so `owned` comes out empty and
   * `onConflictDoUpdate` with an empty `set` is not a no-op but invalid SQL
   * (`DO UPDATE SET` followed by nothing). The row still has to be CREATED by
   * such a step if an earlier one somehow did not, because the foreign keys
   * pointing at it are NOT NULL.
   */
  if (Object.keys(owned).length === 0) {
    await insert.onConflictDoNothing({ target: companies.id });
    return;
  }

  await insert.onConflictDoUpdate({ target: companies.id, set: owned });
}

// ---------------------------------------------------------------------------
// Step 1 — Company
// ---------------------------------------------------------------------------

const companyLabels = {
  legalName: 'Legal name',
  displayName: 'Display name',
  operatingName: 'Operating name',
  tagline: 'Tagline',
  ownerName: 'Owner name',
  ownerTitle: 'Owner title',
};

const companySchema = z.object({
  legalName: requiredText(200),
  displayName: requiredText(200),
  operatingName: optionalText(200),
  tagline: optionalText(200),
  ownerName: optionalText(200),
  ownerTitle: optionalText(100),
});

export async function saveCompanyStep(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = companySchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, companyLabels);
  const { legalName, displayName, ...rest } = parsed.data;

  return persistStep('company', async (tx, gate) => {
    await upsertOrganization(
      tx,
      { legalName, displayName, ...rest },
      { legalName, displayName },
      gate,
    );
    return saved(`${displayName} created.`);
  });
}

// ---------------------------------------------------------------------------
// Step 2 — Contact
// ---------------------------------------------------------------------------

const contactLabels = {
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  city: 'City',
  province: 'Province or state',
  postalCode: 'Postal or ZIP code',
  country: 'Country',
  phone: 'Phone',
  altPhone: 'Alternate phone',
  email: 'Email',
  website: 'Website',
};

/**
 * No postal code or phone pattern, deliberately, and for the same reason the
 * settings screen has none: a pattern written for one postal system starts
 * rejecting real addresses the first time this deploys in another country,
 * which is a jurisdiction assumption in the same class as a hardcoded tax rate.
 */
const contactSchema = z.object({
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  province: optionalText(100),
  postalCode: optionalText(20),
  country: optionalText(100),
  phone: optionalText(40),
  altPhone: optionalText(40),
  email: optionalText(200).refine(
    (value) => value === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    'must be an email address',
  ),
  website: optionalText(200).refine(
    (value) => value === null || /^https?:\/\/\S+$/.test(value),
    'must begin with http:// or https://',
  ),
});

export async function saveContactStep(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = contactSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, contactLabels);

  return persistStep('contact', async (tx, gate) => {
    await upsertOrganization(tx, parsed.data, null, gate);
    return saved('Contact details saved.');
  });
}

// ---------------------------------------------------------------------------
// Step 3 — Your work: posture and trade
// ---------------------------------------------------------------------------

const tradeLabels = {
  workPosture: 'Kind of work',
  trade: 'Trade',
  scope: 'What to start with',
};

const tradeSchema = z.object({
  workPosture: z.enum(['both', 'service', 'contract'], 'choose what kind of work you do'),
  trade: z.enum(['general', 'electrical', 'plumbing', 'hvac', 'machining', 'none'], 'choose a trade'),
  /**
   * How much of the product to start with.
   *
   * REQUIRED, with no default on the form, for the same reason the trade field
   * has none: there is no sensible guess at a stranger's business, and a
   * pre-selected answer to "how much of this do you want" is one nobody reads.
   * Contrast `workPosture`, which defaults to `both` because that is the
   * answer that changes least.
   */
  scope: z.enum(['quotes', 'everything'], 'choose what to start with'),
});

/**
 * Writes the company's posture and loads its trade pack.
 *
 * ---------------------------------------------------------------------------
 * ONE TRANSACTION, AND THE ORDER WITHIN IT MATTERS
 * ---------------------------------------------------------------------------
 *
 * The posture goes on the company first, then the pack loads. A half-applied
 * step is the thing to avoid: the pack without the posture would leave a
 * service-only electrician being offered his contract types, and the posture
 * without the pack would leave him with the nine builder types and no rate
 * book -- worse than either end state.
 *
 * `persistStep` already wraps this in the transaction that writes the step
 * marker, so a failure anywhere leaves the step incomplete and re-runnable.
 * `loadPack` is idempotent on fixed ids for exactly that case.
 *
 * ---------------------------------------------------------------------------
 * THE TRADE IS RECORDED AND THEN GATES NOTHING
 * ---------------------------------------------------------------------------
 *
 * The marker `loadPack` writes exists so the lazy vendor and line-group seeds
 * know the lists are already supplied. No screen behaves differently because
 * of the trade, and none should: the same electrician does service calls and
 * full rewires.
 */
export async function saveTradeStep(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = tradeSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, tradeLabels);
  const { workPosture, trade, scope } = parsed.data;

  return persistStep('trade', async (tx) => {
    await tx
      .update(companies)
      .set({ workPosture })
      .where(eq(companies.id, FIRST_COMPANY_ID));

    /**
     * How much of the product this deployment starts with.
     *
     * Written only when the installer asks for less: the columns already
     * default to true, so "everything" is the absence of a decision rather
     * than a second set of writes -- and a deployment migrated forward from
     * before this question existed keeps every screen it had.
     *
     * On `organization` and not on the company: two sister corporations share
     * one rail and one settings menu.
     */
    if (scope === 'quotes') {
      await tx
        .update(organization)
        .set({
          modulePipeline: false,
          moduleCalendar: false,
          moduleExpenses: false,
          moduleVendors: false,
          moduleTemplates: false,
          moduleReminders: false,
        })
        .where(eq(organization.id, 1));
    }

    // The posture just saved above, so a `both`-tagged row arrives with the
    // paperwork this kind of outfit actually needs. Without it, "Service
    // work" changed nothing at all for the general and `none` packs, whose
    // rows are all tagged `both`.
    await loadPack(tx, trade, workPosture);

    return saved(
      trade === 'none'
        ? 'Saved. Your lists are ready to fill in as you go.'
        : `Saved. ${TRADE_LABELS[trade]} job types, cost codes and rate items are loaded — ` +
          `put your own prices on them before you quote.`,
    );
  });
}

// ---------------------------------------------------------------------------
// Step 3 — Locale
// ---------------------------------------------------------------------------

const localeLabels = {
  currency: 'Currency',
  locale: 'Language and region',
  timezone: 'Timezone',
  areaUnit: 'Area unit',
};

/**
 * Each of the three text values is validated by CONSTRUCTING the Intl object
 * that will later use it, exactly as the settings screen does. A hand-written
 * pattern would accept a misspelled zone, which then throws at the moment a
 * quote is being dated -- in a request that has nothing to do with setup.
 */
const localeSchema = z.object({
  currency: requiredText(3)
    .transform((value) => value.toUpperCase())
    .refine((value) => {
      try {
        new Intl.NumberFormat('en', { style: 'currency', currency: value });
        return true;
      } catch {
        return false;
      }
    }, 'must be a three-letter ISO 4217 currency code'),
  locale: requiredText(35).refine((value) => {
    try {
      new Intl.Locale(value);
      return true;
    } catch {
      return false;
    }
  }, 'must be a language tag such as the one your region uses'),
  timezone: requiredText(64).refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'must be an IANA timezone name'),
  areaUnit: z.enum(['sqft', 'sqm']),
});

export async function saveLocaleStep(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = localeSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, localeLabels);

  return persistStep('locale', async (tx, gate) => {
    await upsertOrganization(tx, parsed.data, null, gate);
    return saved(`Locale saved. Dates now compute in ${parsed.data.timezone}.`);
  });
}

// ---------------------------------------------------------------------------
// Step 4 — Financial
// ---------------------------------------------------------------------------

const financialLabels = {
  taxRegistrationNumber: 'Tax registration number',
  taxRegistrationLabel: 'Tax registration label',
  businessNumber: 'Business number',
  fiscalYearEndMonth: 'Fiscal year end month',
  fiscalYearEndDay: 'Fiscal year end day',
  taxFilingFrequency: 'Filing frequency',
  taxDeferredOnHoldback: 'Tax deferred on holdback',
  defaultHoldbackPct: 'Default holdback',
  holdbackLabel: 'Holdback label',
  holdbackTermsText: 'Holdback terms',
  holdbackReleaseDays: 'Holdback release days',
  paymentTermsDays: 'Payment terms days',
  paymentTermsText: 'Payment terms',
  insuranceStatement: 'Insurance statement',
  targetMargin: 'Target margin',
};

/**
 * Days in each month, with February at 29: a fiscal year CAN end on 29
 * February, so the question is "is this a day that month ever has", not "is
 * this a day that month has this year". The alternative rejects a legitimate
 * year end in three years out of four.
 */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const financialSchema = z
  .object({
    taxRegistrationNumber: optionalText(50),
    taxRegistrationLabel: optionalText(50),
    businessNumber: optionalText(50),
    fiscalYearEndMonth: optionalInt(1, 12),
    fiscalYearEndDay: optionalInt(1, 31),
    // Optional for the same reason as the sign-in method below: a nullable
    // column whose control might not be on the page must not refuse the whole
    // step because the browser sent no key for it.
    taxFilingFrequency: z
      .enum(['annual', 'quarterly', 'monthly'])
      .or(z.literal(''))
      .optional()
      .transform((value) => (value === '' || value === undefined ? null : value)),
    /**
     * The holdback five, every one of them wrapped.
     *
     * A service-only company is shown none of these (see the step's page), so
     * the form sends no key for any of them. `checkbox` already treats absence
     * as its off state; the other four would refuse the whole step, which is
     * exactly what happened the first time this ran.
     *
     * `holdbackReleaseDays` was `requiredInt` and is now optional: the column
     * is NOT NULL DEFAULT 60, and the action below omits the key rather than
     * writing a null into it.
     */
    taxDeferredOnHoldback: checkbox,
    defaultHoldbackPct: whenShown(percentField({ min: 0, max: 100 })),
    holdbackLabel: whenShown(optionalText(100)),
    holdbackTermsText: whenShown(optionalText(4000)),
    holdbackReleaseDays: whenShown(optionalInt(0, 3650)),
    paymentTermsDays: optionalInt(0, 3650),
    paymentTermsText: optionalText(4000),
    insuranceStatement: optionalText(500),
    targetMargin: percentField({ min: 0, max: 100 }),
  })
  .superRefine((value, ctx) => {
    // Half a date is worse than none: a stored month with no day cannot close
    // a fiscal period, and whatever reads it would quietly assume the 1st.
    if ((value.fiscalYearEndMonth === null) !== (value.fiscalYearEndDay === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['fiscalYearEndDay'],
        message: 'and the month must be set together, or both left blank',
      });
      return;
    }
    if (value.fiscalYearEndMonth !== null && value.fiscalYearEndDay !== null) {
      const max = MONTH_MAX_DAYS[value.fiscalYearEndMonth - 1]!;
      if (value.fiscalYearEndDay > max) {
        ctx.addIssue({
          code: 'custom',
          path: ['fiscalYearEndDay'],
          message: `is past the end of the month you chose, which has ${max} days at most`,
        });
      }
    }
  });

export async function saveFinancialStep(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = financialSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, financialLabels);

  const {
    defaultHoldbackPct, targetMargin,
    taxDeferredOnHoldback, holdbackLabel, holdbackTermsText, holdbackReleaseDays,
    ...rest
  } = parsed.data;

  return persistStep('financial', async (tx, gate) => {
    /**
     * The holdback half, only when the company does contract work.
     *
     * The step does not SHOW these to a service-only company, so the form
     * sends nothing for them -- and an unsent checkbox parses as `false`,
     * which would write `tax_deferred_on_holdback = false` over a default of
     * true and a blank over a release period of 60. Omitting the keys leaves
     * every column at its default, which is what "not asked" has to mean.
     *
     * `postureOf` fails open, so an unreadable company writes the fields as
     * submitted rather than silently dropping a holdback somebody typed.
     */
    const holdback = offersContract(postureOf(gate.org))
      ? {
          taxDeferredOnHoldback,
          holdbackLabel,
          holdbackTermsText,
          // Already in ten-thousandths of a fraction, converted by the shared
          // percentage parser.
          defaultHoldbackPctTenThou: defaultHoldbackPct,
          // NOT NULL in the database, so absence means "leave the default"
          // rather than "store nothing".
          ...(holdbackReleaseDays === null ? {} : { holdbackReleaseDays }),
        }
      : {};

    await upsertOrganization(
      tx,
      {
        ...rest,
        ...holdback,
        // Basis points are the same scale as the percentage parser's output,
        // so a target margin needs no second conversion beyond dropping the
        // bigint.
        targetMarginBp: targetMargin === null ? null : Number(targetMargin),
      },
      null,
      gate,
    );
    return saved('Financial and legal settings saved.');
  });
}

// ---------------------------------------------------------------------------
// Step 5 — First tax rate
// ---------------------------------------------------------------------------

const taxRateLabels = {
  label: 'Label',
  shortLabel: 'Short label',
  registrationNumber: 'Registration number',
  rate: 'Rate',
  effectiveFrom: 'Effective from',
  sortOrder: 'Order',
  isCompound: 'Compound',
};

const taxRateSchema = z.object({
  label: requiredText(50),
  shortLabel: optionalText(20),
  registrationNumber: optionalText(50),
  rate: percentField({ min: 0, max: 100, allowBlank: false }),
  effectiveFrom: isoDate,
  sortOrder: requiredInt(0, 999),
  isCompound: checkbox,
});

/**
 * The first rate.
 *
 * Under Settings a rate is never edited: a change closes the current row and
 * inserts its successor, so the rate that applied on any past date stays
 * answerable years later. That rule protects issued documents -- and during
 * first-run setup there are none. So re-submitting this step CORRECTS the row
 * it created, tracked by id in `settings`, rather than superseding it. The
 * alternative leaves a deployment that has never sent a quote with two rates
 * in force on the same day because the installer mistyped a digit.
 */
export async function saveTaxRateStep(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = taxRateSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, taxRateLabels);
  const { rate, ...rest } = parsed.data;
  // Unreachable: allowBlank is false, so the parser rejects an empty field
  // before this. Checked because the field's type admits null and a silent 0%
  // rate would be a tax line a customer never questions.
  if (rate === null) return refused('A rate is required.');

  return persistStep('tax-rate', async (tx, gate) => {
    const existingId = gate.values.get(TAX_RATE_ID_KEY);

    if (existingId) {
      const rows = await tx
        .update(taxRates)
        .set({ ...rest, rateTenThou: rate })
        .where(eq(taxRates.id, existingId))
        .returning({ id: taxRates.id });
      if (rows.length > 0) {
        return saved(`${rest.label} corrected, in force from ${rest.effectiveFrom}.`);
      }
      // The recorded row is gone, which should not happen -- nothing deletes.
      // Falling through to an insert is the honest recovery.
    }

    const [row] = await tx
      .insert(taxRates)
      .values({
        // The company this wizard created in step 1. A rate belongs to a
        // registrant, not to a deployment -- the Input Tax Credit Information
        // Regulations put the supplier's own number on the invoice.
        companyId: FIRST_COMPANY_ID,
        ...rest,
        rateTenThou: rate,
        createdBy: null,
      })
      .returning({ id: taxRates.id });
    await putSetting(tx, TAX_RATE_ID_KEY, row!.id);

    return saved(`${rest.label} added, in force from ${rest.effectiveFrom}.`);
  });
}

// ---------------------------------------------------------------------------
// Step 6 — First user
// ---------------------------------------------------------------------------

const firstUserLabels = {
  displayName: 'Name',
  email: 'Email',
  loginMethod: 'Sign-in method',
};

const firstUserSchema = z.object({
  displayName: requiredText(200),
  email: requiredText(200)
    .transform((value) => value.toLowerCase())
    .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'must be an email address'),
  /**
   * Absent, blank and chosen are three states, and only the third is a value.
   *
   * `.optional()` is load-bearing rather than defensive: the field is only
   * RENDERED where this application does its own signing in. Behind Cloudflare
   * Access the policy decides and on a LAN nobody does, so in two of the three
   * modes the browser submits no such key at all -- and a schema that demanded
   * one refused the whole step with "some of these values need another look"
   * against a field the person was never shown.
   */
  loginMethod: z
    .enum(['google', 'microsoft', 'apple'])
    .or(z.literal(''))
    .optional()
    .transform((value) => (value === '' || value === undefined ? null : value)),
});

/**
 * The first account, and it is an `owner`.
 *
 * The role is not a field on this form and is not read from the submission.
 * Step 6 exists to produce the identity that can then grant every other role,
 * and a role picker here would let the first account be created as a
 * bookkeeper -- a deployment with no owner, where nobody can grant the role
 * back through the interface and recovery is a script run on the box.
 */
export async function saveFirstUserStep(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = firstUserSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, firstUserLabels);
  const { displayName, email, loginMethod } = parsed.data;

  // A sign-in method is only meaningful where the application itself does the
  // signing in. Behind Access the policy decides, and on a LAN nobody does.
  let method = loginMethod;
  let mode: string;
  try {
    mode = authMode();
  } catch {
    mode = 'unset';
  }
  if (method !== null) {
    if (mode !== 'sso') {
      method = null;
    } else if (!configuredOidcProviders().includes(method)) {
      return refused(
        `${method} has no credentials in this deployment's environment, so it cannot sign anybody in.`,
      );
    }
  }

  return persistStep('first-user', async (tx, gate) => {
    const existingId = gate.values.get(OWNER_USER_ID_KEY);

    // Deactivated rather than replaced, if the installer corrects the address:
    // `email` is UNIQUE and a user row is never voided, so the row this wizard
    // created is updated in place and there is only ever one owner.
    if (existingId) {
      const rows = await tx
        .update(users)
        .set({ displayName, email, role: 'owner', loginMethod: method, isActive: true })
        .where(eq(users.id, existingId))
        .returning({ id: users.id });
      // The address may have just changed, and it is the cached answer.
      forgetSoleOwner();
      if (rows.length > 0) {
        return saved(`${displayName} corrected. The account remains the owner.`);
      }
    }

    try {
      const [row] = await tx
        .insert(users)
        .values({ displayName, email, role: 'owner', loginMethod: method, createdBy: null })
        .returning({ id: users.id });
      await putSetting(tx, OWNER_USER_ID_KEY, row!.id);
      // The installer must be signed in as this account on his very next
      // request, not after a cache expires. On a deployment with no
      // LOCAL_USER_EMAIL this row is what ends the "nobody has claimed this
      // deployment" state -- see `lib/auth/sole-owner.ts`.
      forgetSoleOwner();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('users_email_unique') || message.includes('duplicate key')) {
        return refused(
          `An account already exists for ${email}. Use a different address, or continue — ` +
            'that account is what will sign in.',
        );
      }
      throw error;
    }

    return saved(`${displayName} created as owner.`);
  });
}

// ---------------------------------------------------------------------------
// Step 7 — Environment check
// ---------------------------------------------------------------------------

/**
 * Records that the report has been read, and nothing else.
 *
 * There is no form on that step and no field in this action: the check
 * validates the environment rather than collecting it, and a credential that
 * arrived through a text box would be written to a database that is mirrored
 * to SharePoint and dumped hourly to three destinations.
 *
 * A failing check does not block the step. Half of what it reports -- the
 * mirror, the USB drive -- is a decision the owner is entitled to make
 * differently, and a wizard that refused to finish would be routed around
 * with SQL, which is the thing first-run setup exists to remove.
 */
export async function acknowledgeEnvironmentStep(
  _previous: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  return persistStep('environment', async () =>
    saved('Noted. It stays on the dashboard while failing.'),
  );
}

// ---------------------------------------------------------------------------
// Step 8 — Done
// ---------------------------------------------------------------------------

/**
 * Closes the wizard, permanently.
 *
 * After this the gate refuses every path into `/setup`, in this deployment,
 * for good: there is deliberately no route by which this screen can replace an
 * existing tenant's details. Every field remains editable under Settings,
 * where a change is one field rather than a replacement, and where an owner
 * role is required to make it.
 */
export async function finishSetup(
  _previous: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  // The completion flag is written by `persistStep` through the same upsert
  // that records the step, in one transaction. Setting it here as well would
  // be two writes racing on one key, and the loser would leave a finished
  // deployment reporting itself as still in progress.
  return persistStep('done', async () => saved('Setup complete.'), true);
}
