import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Every enum mirrors to SharePoint as **Text, not Choice**. A Choice column
 * validates against a fixed member list, so adding a value in a migration would
 * make every sync of that row fail with a 400 until somebody edited the list by
 * hand.
 */

/**
 * Deletion replacement. Nothing is ever deleted: a watermark sync cannot
 * observe a row that no longer exists, and these are tax records.
 */
export const recordStatusEnum = pgEnum('record_status', ['active', 'void']);

export const roleEnum = pgEnum('role', ['owner', 'admin', 'bookkeeper']);
export const customerTypeEnum = pgEnum('customer_type', ['residential', 'commercial']);
export const leadSourceEnum = pgEnum('lead_source', [
  'call', 'email', 'referral', 'website', 'repeat', 'other',
]);
export const projectTypeEnum = pgEnum('project_type', [
  'custom_home', 'basement', 'renovation', 'kitchen',
  'bathroom', 'addition', 'commercial_ti', 'water_leak', 'other',
]);
export const projectStageEnum = pgEnum('project_stage', [
  'lead', 'site_visit', 'quoting', 'quote_sent', 'won',
  'lost', 'in_progress', 'complete', 'on_hold',
]);
export const contractTypeEnum = pgEnum('contract_type', [
  'lump_sum', 'unit_price', 'cost_plus', 'time_and_material',
]);

/**
 * How a line calculates -- deliberately separate from what it is labelled.
 *
 * An earlier fused enum ('sqft'|'each'|'flat'|'percent'|'hour') conflated the
 * two: sqft, each and hour all compute identically, and only flat and percent
 * differ at all. Worse, it had no member for linear feet, so baseboard, trim,
 * countertop and fencing -- priced per linear foot by every contractor --
 * could not be entered, and a metric deployment could not say m2.
 */
export const calcModeEnum = pgEnum('calc_mode', ['qty', 'flat', 'percent']);

/** A change order IS a quote with a parent: same lines, engine, PDF, versioning. */
export const quoteKindEnum = pgEnum('quote_kind', ['estimate', 'change_order']);
export const changeReasonEnum = pgEnum('change_reason', [
  'customer_request', 'site_condition', 'design_change',
  'code_requirement', 'error_omission', 'allowance_reconciliation',
]);

/** How much pricing detail the customer document shows. */
export const pricingDisplayEnum = pgEnum('pricing_display', [
  'detailed', 'group_totals', 'lump_sum',
]);
export const clauseKindEnum = pgEnum('clause_kind', ['exclusion', 'assumption']);
export const areaUnitEnum = pgEnum('area_unit', ['sqft', 'sqm']);

/**
 * 'expired' is deliberately absent: expiry derives from valid_until, and a
 * stored value is wrong the moment the clock passes it.
 */
export const quoteStatusEnum = pgEnum('quote_status', [
  'draft', 'sent', 'accepted', 'declined', 'superseded',
]);

export const qtySourceEnum = pgEnum('qty_source', [
  'area', 'washrooms', 'kitchens', 'bedrooms', 'fixed', 'manual',
]);
export const entityTypeEnum = pgEnum('entity_type', [
  'organization', 'quote', 'project', 'customer', 'receipt',
  'vendor_invoice', 'purchase_order',
]);
export const filingFrequencyEnum = pgEnum('filing_frequency', ['annual', 'quarterly', 'monthly']);

/**
 * How a person signs in, chosen per user by an administrator.
 *
 * Only meaningful in `sso` mode. Under Cloudflare Access the Access policy
 * decides, and in local mode the environment does, so the column is ignored in
 * both -- which is why it is nullable rather than defaulted.
 */
export const loginMethodEnum = pgEnum('login_method', ['google', 'microsoft', 'apple']);
