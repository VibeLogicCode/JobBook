'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { companies, organization } from '@/db/schema';
import { requireCapability } from '@/app/settings/actor';
import { percentField } from '@/app/settings/percent-schema';
import { parseRateToTenThou } from '@/lib/money/format';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { resolveSettingsCompany } from '@/lib/company/settings-target';
import { POSTURES, type WorkPosture } from '@/lib/posture/types';
import {
  checkbox,
  formValues,
  invalid,
  optionalInt,
  optionalText,
  requiredInt,
  requiredText,
} from '@/app/settings/validate';

/**
 * The organization record: five forms, one row.
 *
 * The row is split across five sections because it is the whole reason this
 * screen exists. The product is configured for a company, not written about
 * one: the name on the quote, the tax label, the fiscal year end and the
 * footer text are all data, and a build that hardcodes any of them has a bug
 * (design section 2.1). Forty fields on one page nobody scrolls is how they
 * end up hardcoded instead.
 */

/**
 * Applies a patch to the deployment row and to the company it describes.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE FUNCTION WRITES TWO TABLES
 * ---------------------------------------------------------------------------
 *
 * Every settings section funnels through here, and the fields they submit
 * belong to two different things: `timezone` and `currency` are the
 * DEPLOYMENT's, while the legal name, the HST registration number, the
 * holdback terms and the quote footer are the ISSUING COMPANY's. A settings
 * screen should not have to know which, and asking each of the five sections
 * to route its own fields would be five chances to route one wrongly.
 *
 * So the split happens once, here, derived from the `companies` table object
 * rather than a hand-written list of names -- the same mechanism
 * `app/setup/actions.ts` uses, and for the same reason: a column added to
 * `companies` later is carried across for free, and a deployment fact cannot
 * be smuggled into a company row by a typo.
 *
 * WHICH COMPANY comes from the form, not from a guess. The four screens that
 * edit company fields carry a hidden `companyId` naming the company whose
 * values they rendered, and this writes to that one. With a single company the
 * field is still there and still names it -- there is no separate path for the
 * common case, because two paths is how the rare one rots.
 *
 * A form that names NO company falls back to the single active one, and
 * refuses when there is more than one. That is not a nicety: writing a legal
 * name or an HST registration number to whichever company sorted first would
 * put it on the wrong corporation's letterhead, and the person would have no
 * way to tell from this screen that it had happened.
 *
 * The id is re-validated against the live list here rather than trusted from
 * the form. A stale tab holds an id that may since have been retired, and this
 * is a `'use server'` endpoint -- every export is callable, which
 * `tests/ops/action-guards.test.ts` exists to remember.
 */
/**
 * The company a company-scoped form named, as a string or null.
 *
 * Read straight off the FormData rather than through each section's zod
 * schema: it is not one of the fields being edited, it is which record is
 * being edited, and adding it to five schemas would be five chances to leave
 * it out of one. `patchOrganization` re-validates it against the live list.
 */
function namedCompany(formData: FormData): string | null {
  const value = formData.get('companyId');
  return typeof value === 'string' && value !== '' ? value : null;
}

async function patchOrganization(
  patch: Record<string, unknown>,
  message: string,
  submittedCompanyId?: string | null,
): Promise<ActionResult> {
  const companyOwned = Object.fromEntries(
    Object.entries(patch).filter(([key]) => key in companies),
  );

  if (Object.keys(companyOwned).length > 0) {
    const target = await resolveSettingsCompany(submittedCompanyId ?? null);
    if ('problem' in target) return refused(target.problem);
    await db.update(companies).set(companyOwned).where(eq(companies.id, target.company.id));
  }

  /**
   * The deployment's half, and it is often EMPTY now.
   *
   * `organization` gave up thirty-six columns, so identity, contact and
   * documents submit patches with nothing left for this table -- and
   * `.set({})` is not a no-op, it generates `update ... set  where ...`, which
   * Postgres rejects as a syntax error. Every one of those three screens
   * failed to save until this filter existed, which is what
   * `tests/integration/per-company-settings.test.ts` was written and
   * immediately caught.
   *
   * The row still has to be CONFIRMED to exist even when there is nothing to
   * write to it, because "there is no organization record yet" is the honest
   * refusal for a deployment that has not run setup -- and a company-only
   * patch would otherwise report success on a database with no deployment row
   * at all.
   */
  const deploymentOwned = Object.fromEntries(
    Object.entries(patch).filter(([key]) => key in organization),
  );

  const rows = Object.keys(deploymentOwned).length > 0
    ? await db
        .update(organization)
        .set(deploymentOwned)
        .where(eq(organization.id, 1))
        .returning({ id: organization.id })
    : await db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, 1));

  if (rows.length === 0) {
    return refused('There is no organization record yet. Run first-run setup before editing it.');
  }

  // The root layout reads this row for the tab title, the shell heading and the
  // accent colour, so a save has to invalidate the layout and not just the
  // section that produced it.
  revalidatePath('/', 'layout');
  return saved(message);
}

// ---------------------------------------------------------------------------
// Identity and branding
// ---------------------------------------------------------------------------

const identityLabels = {
  legalName: 'Legal name',
  displayName: 'Display name',
  operatingName: 'Operating name',
  tagline: 'Tagline',
  ownerName: 'Owner name',
  ownerTitle: 'Owner title',
  brandColor: 'Brand colour',
};

const identitySchema = z.object({
  legalName: requiredText(200),
  displayName: requiredText(200),
  operatingName: optionalText(200),
  tagline: optionalText(200),
  ownerName: optionalText(200),
  ownerTitle: optionalText(100),
  brandColor: optionalText(7).refine(
    (value) => value === null || /^#[0-9a-fA-F]{6}$/.test(value),
    'must be a six-digit hex colour beginning with #',
  ),
});

export async function saveIdentity(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('organization.edit');
  if (!guard.ok) return guard.result;

  const parsed = identitySchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, identityLabels);

  return patchOrganization(parsed.data, 'Identity and branding saved.', namedCompany(formData));
}

// ---------------------------------------------------------------------------
// The kind of work
// ---------------------------------------------------------------------------

const postureLabels = { workPosture: 'Kind of work' };

const postureSchema = z.object({
  workPosture: z.enum(POSTURES as readonly [WorkPosture, ...WorkPosture[]], {
    message: 'must be service work, contract work or both',
  }),
});

/**
 * Changes what kind of work a company does.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * The setup wizard asks the question and then told the installer *"Both of
 * these are changeable afterwards"* -- and nothing could change it. The
 * column was written once, at first run, by a screen that permanently closes
 * itself. The design said the same thing in as many words: *"Changeable in
 * Settings afterwards, always."* This is that screen's half of it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES AND DOES NOT TOUCH
 * ---------------------------------------------------------------------------
 *
 * ONE column. It does not re-derive a single project type's flags, and it must
 * not: a type is where the paperwork rules live, and rewriting them from a
 * posture change would silently alter the terms of contracts already signed
 * under those types. Posture decides what is OFFERED on new work -- the jobs
 * in flight go on computing exactly what they computed yesterday.
 *
 * So switching to service-only stops offering contract types and stops asking
 * for measurements on new service jobs. It does not remove a holdback from a
 * job that agreed to one.
 */
export async function saveWorkPosture(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('organization.edit');
  if (!guard.ok) return guard.result;

  const parsed = postureSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, postureLabels);

  return patchOrganization(parsed.data, 'The kind of work saved.', namedCompany(formData));
}

// ---------------------------------------------------------------------------
// Contact
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
 * Address and phone shapes are NOT validated beyond a length.
 *
 * A postal code regex is a jurisdiction assumption in the same class as a
 * hardcoded tax rate: the moment this deploys outside the first country, a
 * pattern written for one postal system starts rejecting real addresses. These
 * fields print on a document, and a human reads them.
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
    // Deliberately loose. Something before and after an @, with a dot after,
    // is as much as a printed contact block needs; every stricter pattern
    // rejects an address somebody actually uses.
    (value) => value === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    'must be an email address',
  ),
  website: optionalText(200).refine(
    (value) => value === null || /^https?:\/\/\S+$/.test(value),
    'must begin with http:// or https://',
  ),
});

export async function saveContact(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('organization.edit');
  if (!guard.ok) return guard.result;

  const parsed = contactSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, contactLabels);

  return patchOrganization(parsed.data, 'Contact details saved.', namedCompany(formData));
}

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

const localeLabels = {
  currency: 'Currency',
  locale: 'Language and region',
  timezone: 'Timezone',
  areaUnit: 'Area unit',
};

/**
 * Each of the three text values is validated by CONSTRUCTING the Intl object
 * that will later use it. A currency code, a language tag and an IANA zone are
 * all things the platform can answer definitively, and a hand-written pattern
 * would accept a misspelled zone -- which then throws at the moment a quote is
 * being dated, in a request that has nothing to do with settings.
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

export async function saveLocale(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('organization.edit');
  if (!guard.ok) return guard.result;

  const parsed = localeSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, localeLabels);

  // No company: currency, locale, timezone and area unit are the
  // DEPLOYMENT's, and two companies sharing one office cannot disagree about
  // what day it is. This screen has no company selector for the same reason.
  return patchOrganization(parsed.data, 'Locale saved.');
}

// ---------------------------------------------------------------------------
// Financial and legal
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
  mileageRatePerKm: 'Mileage rate',
  targetMargin: 'Target margin',
};

/**
 * Days in each month, with February at 29.
 *
 * A fiscal year can end on 29 February -- a leap year exists -- so the check
 * is "is this a day that month ever has", not "is this a day that month has
 * this year". The alternative rejects a legitimate year end in three years out
 * of every four.
 */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const financialSchema = z
  .object({
    taxRegistrationNumber: optionalText(50),
    taxRegistrationLabel: optionalText(50),
    businessNumber: optionalText(50),
    fiscalYearEndMonth: optionalInt(1, 12),
    fiscalYearEndDay: optionalInt(1, 31),
    taxFilingFrequency: z
      .enum(['annual', 'quarterly', 'monthly'])
      .or(z.literal(''))
      .transform((value) => (value === '' ? null : value)),
    taxDeferredOnHoldback: checkbox,
    defaultHoldbackPct: percentField({ min: 0, max: 100 }),
    holdbackLabel: optionalText(100),
    holdbackTermsText: optionalText(4000),
    holdbackReleaseDays: requiredInt(0, 3650),
    paymentTermsDays: optionalInt(0, 3650),
    paymentTermsText: optionalText(4000),
    insuranceStatement: optionalText(500),
    /**
     * What a kilometre driven on a job costs, in ten-thousandths of a
     * currency unit: $0.7200 is 7200.
     *
     * Parsed by the rate parser rather than the percent one, because this is
     * an amount per unit and not a share of anything -- `parseRateToTenThou`
     * takes the four decimal places the scale actually holds, where
     * `percentField` would divide by a hundred and turn 0.72 into 72
     * ten-thousandths of a cent.
     *
     * Required, and floored at zero: the column is NOT NULL, and a blank here
     * would be a rate of nothing costing every future trip at zero. Capped at
     * ten currency units a kilometre, which is a decimal point in the wrong
     * place rather than a policy about how much driving may cost.
     */
    mileageRatePerKm: z
      .string()
      .transform((value) => value.trim())
      .refine((value) => value !== '', 'is required')
      .transform((raw) => parseRateToTenThou(raw))
      .refine(
        (value) => value !== null,
        'must be an amount per kilometre, with at most four decimal places',
      )
      .refine(
        (value) => value === null || (value >= 0n && value <= 100_000n),
        'must be between 0 and 10.0000 per kilometre',
      )
      .transform((value) => value!),
    // Basis points and rate ten-thousandths are the same scale -- 25% is 2500
    // of either -- so the percentage parser converts a target margin exactly.
    targetMargin: percentField({ min: 0, max: 100 }),
  })
  .superRefine((value, ctx) => {
    // Half a date is worse than none: a stored month with no day cannot close a
    // fiscal period, and whatever reads it later would quietly assume the 1st.
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

export async function saveFinancial(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('organization.edit');
  if (!guard.ok) return guard.result;

  const parsed = financialSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, financialLabels);

  const { defaultHoldbackPct, mileageRatePerKm, targetMargin, ...rest } = parsed.data;

  return patchOrganization(
    {
      ...rest,
      defaultHoldbackPctTenThou: defaultHoldbackPct,
      // What the NEXT trip will cost. Every trip already logged snapshotted
      // the rate it was driven at onto its own row, so this write cannot
      // restate one -- which is the whole reason that column exists.
      mileageRatePerKmTenThou: mileageRatePerKm,
      // Stored as a plain integer count of basis points rather than a scaled
      // bigint, so the conversion happens here and not at the margin gauge.
      targetMarginBp: targetMargin === null ? null : Number(targetMargin),
    },
    'Financial and legal settings saved.',
    /**
     * This screen writes to BOTH tables: the holdback fields, the tax
     * registration and the target margin are the company's, and the mileage
     * rate is the deployment's. `patchOrganization` splits the patch by which
     * table owns each key, so one call handles both -- and the company id only
     * decides where the company half lands.
     */
    namedCompany(formData),
  );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const documentLabels = {
  quoteValidityDays: 'Quote validity',
  quoteTermsText: 'Quote terms',
  documentFooterText: 'Document footer',
};

const documentSchema = z.object({
  quoteValidityDays: requiredInt(1, 3650),
  quoteTermsText: optionalText(8000),
  documentFooterText: optionalText(1000),
});

export async function saveDocuments(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireCapability('organization.edit');
  if (!guard.ok) return guard.result;

  const parsed = documentSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, documentLabels);

  return patchOrganization(parsed.data, 'Document settings saved.', namedCompany(formData));
}
