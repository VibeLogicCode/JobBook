'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { organization } from '@/db/schema';
import { requireCapability } from '@/app/settings/actor';
import { percentField } from '@/app/settings/percent-schema';
import { type ActionResult, refused, saved } from '@/app/settings/result';
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

/** Applies a patch to the single organization row. */
async function patchOrganization(
  patch: Record<string, unknown>,
  message: string,
): Promise<ActionResult> {
  const rows = await db
    .update(organization)
    .set(patch)
    .where(eq(organization.id, 1))
    .returning({ id: organization.id });

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

  return patchOrganization(parsed.data, 'Identity and branding saved.');
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

  return patchOrganization(parsed.data, 'Contact details saved.');
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

  const { defaultHoldbackPct, targetMargin, ...rest } = parsed.data;

  return patchOrganization(
    {
      ...rest,
      defaultHoldbackPctTenThou: defaultHoldbackPct,
      // Stored as a plain integer count of basis points rather than a scaled
      // bigint, so the conversion happens here and not at the margin gauge.
      targetMarginBp: targetMargin === null ? null : Number(targetMargin),
    },
    'Financial and legal settings saved.',
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

  return patchOrganization(parsed.data, 'Document settings saved.');
}
