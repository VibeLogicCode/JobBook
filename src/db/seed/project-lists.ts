/**
 * The fixed ids behind `project_types` and `lead_sources`.
 *
 * Unlike `vendor-lists.ts`'s two lists, these are not a generic starter kit
 * seeded lazily from a screen -- they are the nine and six rows migration 0018
 * promoted the old `project_type` and `lead_source` enums into, written
 * directly by that migration's SQL (which cannot import this file, so the ids
 * and names below are duplicated there, in literal form, and must be kept in
 * sync with it by hand). Every installation gets these rows the moment it
 * runs that migration; there is no fresh-install gap for a runtime "ensure"
 * function to fill, which is why this file exports constants and not a
 * seeding function the way `seed/vendor-lists.ts` does.
 *
 * What this file is actually FOR: giving the demo tenant (`db/seed/demo.ts`)
 * and the automated tests a stable id to point at, instead of a second copy of
 * the enum's old string values. `enumValue -> id` here matches `enumValue ->
 * uuid literal` in the migration exactly.
 */

export const PROJECT_TYPE_IDS = {
  customHome: 'c1a1e000-0000-4a00-9000-000000000001',
  basement: 'c1a1e000-0000-4a00-9000-000000000002',
  renovation: 'c1a1e000-0000-4a00-9000-000000000003',
  kitchen: 'c1a1e000-0000-4a00-9000-000000000004',
  bathroom: 'c1a1e000-0000-4a00-9000-000000000005',
  addition: 'c1a1e000-0000-4a00-9000-000000000006',
  commercialTi: 'c1a1e000-0000-4a00-9000-000000000007',
  waterLeak: 'c1a1e000-0000-4a00-9000-000000000008',
  other: 'c1a1e000-0000-4a00-9000-000000000009',
} as const;

/**
 * The nine rows, in the order migration 0018 inserts them.
 *
 * Display names are written explicitly rather than derived from the old enum
 * member, because a naive title-case does not survive an initialism:
 * `commercial_ti` becomes "Commercial TI", not "Commercial Ti", and
 * `water_leak` becomes "Water leak", not "Water Leak" -- sentence case, matching
 * every other list in this product.
 */
export const DEFAULT_PROJECT_TYPES: readonly { id: string; name: string; sortOrder: number }[] = [
  { id: PROJECT_TYPE_IDS.customHome, name: 'Custom home', sortOrder: 10 },
  { id: PROJECT_TYPE_IDS.basement, name: 'Basement', sortOrder: 20 },
  { id: PROJECT_TYPE_IDS.renovation, name: 'Renovation', sortOrder: 30 },
  { id: PROJECT_TYPE_IDS.kitchen, name: 'Kitchen', sortOrder: 40 },
  { id: PROJECT_TYPE_IDS.bathroom, name: 'Bathroom', sortOrder: 50 },
  { id: PROJECT_TYPE_IDS.addition, name: 'Addition', sortOrder: 60 },
  { id: PROJECT_TYPE_IDS.commercialTi, name: 'Commercial TI', sortOrder: 70 },
  { id: PROJECT_TYPE_IDS.waterLeak, name: 'Water leak', sortOrder: 80 },
  // A real catch-all a project can genuinely be filed under, not a
  // placeholder -- sorted last rather than dropped.
  { id: PROJECT_TYPE_IDS.other, name: 'Other', sortOrder: 900 },
];

export const LEAD_SOURCE_IDS = {
  call: 'c1a2e000-0000-4a00-9000-000000000001',
  email: 'c1a2e000-0000-4a00-9000-000000000002',
  referral: 'c1a2e000-0000-4a00-9000-000000000003',
  website: 'c1a2e000-0000-4a00-9000-000000000004',
  repeat: 'c1a2e000-0000-4a00-9000-000000000005',
  other: 'c1a2e000-0000-4a00-9000-000000000006',
} as const;

export const DEFAULT_LEAD_SOURCES: readonly { id: string; name: string; sortOrder: number }[] = [
  { id: LEAD_SOURCE_IDS.call, name: 'Phone call', sortOrder: 10 },
  { id: LEAD_SOURCE_IDS.email, name: 'Email', sortOrder: 20 },
  { id: LEAD_SOURCE_IDS.referral, name: 'Referral', sortOrder: 30 },
  { id: LEAD_SOURCE_IDS.website, name: 'Website', sortOrder: 40 },
  { id: LEAD_SOURCE_IDS.repeat, name: 'Repeat customer', sortOrder: 50 },
  { id: LEAD_SOURCE_IDS.other, name: 'Other', sortOrder: 900 },
];
