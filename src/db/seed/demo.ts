/**
 * Demo tenant.
 *
 * This is the ONE directory the white-label guard exempts, because seed data
 * is allowed to name a company. Everything here is fictional on purpose: a
 * real client's details in a seed file end up in every deployment, every
 * backup, and every SharePoint mirror.
 */

export const DEMO_ORGANIZATION = {
  id: 1,
  legalName: 'Northgate Building Group Inc.',
  displayName: 'Northgate Building Group',
  operatingName: 'Northgate Builders',
  tagline: 'Renovations and custom builds',
  ownerName: 'Priya Raghavan',
  ownerTitle: 'Owner',
  brandColor: '#4b49d6',
  addressLine1: '84 Foundry Lane',
  city: 'Burlington',
  province: 'ON',
  postalCode: 'L7R 2K9',
  country: 'Canada',
  phone: '905-555-0142',
  email: 'quotes@northgate.example',
  website: 'https://northgate.example',
  taxRegistrationNumber: '80000 1234 RT0001',
  taxRegistrationLabel: 'HST Number',
  businessNumber: '80000 1234',
  currency: 'CAD',
  locale: 'en-CA',
  timezone: 'America/Toronto',
  areaUnit: 'sqft' as const,
  fiscalYearEndMonth: 12,
  fiscalYearEndDay: 31,
  taxFilingFrequency: 'quarterly' as const,
  taxDeferredOnHoldback: true,
  defaultHoldbackPctTenThou: 1000n,
  holdbackLabel: 'Statutory holdback',
  holdbackTermsText:
    'A 10% statutory holdback is retained on each payment and released 60 days after publication of the certificate of substantial performance.',
  holdbackReleaseDays: 60,
  paymentTermsDays: 15,
  paymentTermsText:
    '25% deposit on acceptance, progress draws on completion of each stage, balance on substantial performance. Invoices are due within 15 days.',
  insuranceStatement: 'Fully insured and WSIB registered. Certificates available on request.',
  targetMarginBp: 2500,
  quoteValidityDays: 30,
  quoteTermsText:
    'Prices hold for 30 days from the date above. Work proceeds on written acceptance. Permits, engineering and disposal fees are billed at cost unless listed as an allowance.',
  documentFooterText: 'Northgate Building Group Inc. · 905-555-0142 · quotes@northgate.example',
};

export const DEMO_TAX_RATE = {
  label: 'HST',
  shortLabel: 'HST',
  registrationNumber: '80000 1234 RT0001',
  rateTenThou: 1300n,
  effectiveFrom: '2010-07-01',
  sortOrder: 1,
};

export const DEMO_COST_CODES = [
  { code: '01-00', name: 'General requirements' },
  { code: '02-40', name: 'Demolition' },
  { code: '03-30', name: 'Concrete' },
  { code: '06-10', name: 'Rough carpentry' },
  { code: '09-20', name: 'Drywall and plaster' },
  { code: '09-60', name: 'Flooring' },
  { code: '22-00', name: 'Plumbing' },
  { code: '26-00', name: 'Electrical' },
];

/** cost and sell in ten-thousandths: 40000n is $4.0000. */
export const DEMO_RATE_ITEMS = [
  {
    code: 'GEN-01', description: 'Building permit and drawings', costCode: '01-00',
    calcMode: 'flat' as const, unitLabel: '', cost: 180000000n, sell: 195000000n,
    isTaxable: false, isAllowance: true, sortOrder: 1,
  },
  {
    code: 'GEN-02', description: 'Site protection and daily cleanup', costCode: '01-00',
    calcMode: 'qty' as const, unitLabel: 'sqft', cost: 3500n, sell: 6000n, sortOrder: 2,
  },
  {
    code: 'DEM-01', description: 'Strip existing finishes', costCode: '02-40',
    calcMode: 'qty' as const, unitLabel: 'sqft', cost: 18000n, sell: 28000n, sortOrder: 10,
  },
  {
    code: 'DEM-02', description: 'Disposal bins and haulage', costCode: '02-40',
    calcMode: 'qty' as const, unitLabel: 'ea', cost: 5200000n, sell: 7200000n, sortOrder: 11,
  },
  {
    code: 'CON-01', description: 'Underpin and pour bathroom slab', costCode: '03-30',
    calcMode: 'qty' as const, unitLabel: 'ea', cost: 24000000n, sell: 32000000n, sortOrder: 20,
  },
  {
    code: 'CAR-01', description: 'Frame partition walls', costCode: '06-10',
    calcMode: 'qty' as const, unitLabel: 'lnft', cost: 90000n, sell: 145000n, sortOrder: 30,
  },
  {
    code: 'CAR-02', description: 'Interior doors, supply and hang', costCode: '06-10',
    calcMode: 'qty' as const, unitLabel: 'ea', cost: 3800000n, sell: 5600000n, sortOrder: 31,
  },
  {
    code: 'CAR-03', description: 'Baseboard and casing', costCode: '06-10',
    calcMode: 'qty' as const, unitLabel: 'lnft', cost: 42000n, sell: 78000n, sortOrder: 32,
  },
  {
    code: 'DRY-01', description: 'Drywall, tape and prime', costCode: '09-20',
    calcMode: 'qty' as const, unitLabel: 'sqft', cost: 26000n, sell: 41000n, sortOrder: 40,
  },
  {
    code: 'FLR-01', description: 'Luxury vinyl plank flooring', costCode: '09-60',
    calcMode: 'qty' as const, unitLabel: 'sqft', cost: 34000n, sell: 52000n,
    isAllowance: true, sortOrder: 50,
  },
  {
    code: 'PLM-01', description: 'Washroom rough-in and fixtures', costCode: '22-00',
    calcMode: 'qty' as const, unitLabel: 'ea', cost: 42000000n, sell: 58000000n, sortOrder: 60,
  },
  {
    code: 'ELE-01', description: 'Panel circuits and rough-in', costCode: '26-00',
    calcMode: 'qty' as const, unitLabel: 'sqft', cost: 14000n, sell: 24000n, sortOrder: 70,
  },
  {
    code: 'ELE-02', description: 'Pot lights, supply and install', costCode: '26-00',
    calcMode: 'qty' as const, unitLabel: 'ea', cost: 900000n, sell: 1450000n, sortOrder: 71,
  },
  {
    code: 'FIN-09', description: 'Wet bar rough-in and cabinetry', costCode: '06-10',
    calcMode: 'flat' as const, unitLabel: '', cost: 320000000n, sell: 445000000n, sortOrder: 80,
  },
  {
    code: 'FIN-10', description: 'Upgrade to engineered hardwood', costCode: '09-60',
    calcMode: 'qty' as const, unitLabel: 'sqft', cost: 68000n, sell: 98000n, sortOrder: 81,
  },
  {
    code: 'OH-01', description: 'Overhead and site supervision', costCode: '01-00',
    calcMode: 'percent' as const, unitLabel: '%', cost: 0n, sell: 1000n, sortOrder: 90,
  },
  {
    code: 'PRF-01', description: 'Profit', costCode: '01-00',
    calcMode: 'percent' as const, unitLabel: '%', cost: 0n, sell: 1200n, sortOrder: 91,
  },
];

/**
 * Template lines. `multiplier` is in ten-thousandths, so 10000n is one unit per
 * source unit and 200n is one per fifty square feet.
 */
interface DemoTemplateItem {
  code: string;
  source: 'area' | 'washrooms' | 'kitchens' | 'bedrooms' | 'fixed' | 'manual';
  group: string;
  multiplier: bigint;
  fixedQty?: bigint;
  optional?: boolean;
  allowance?: boolean;
}

interface DemoTemplate {
  name: string;
  projectType: 'basement' | 'bathroom' | 'kitchen' | 'renovation' | 'custom_home' | 'addition';
  description: string;
  items: DemoTemplateItem[];
}

export const DEMO_TEMPLATES: DemoTemplate[] = [
  {
    name: 'Basement Finish — Standard',
    projectType: 'basement' as const,
    description: 'Full basement finish: framing through flooring, one washroom.',
    items: [
      { code: 'GEN-01', source: 'fixed' as const, group: 'General', multiplier: 10000n, fixedQty: 1000n },
      { code: 'GEN-02', source: 'area' as const, group: 'General', multiplier: 10000n },
      { code: 'DEM-01', source: 'area' as const, group: 'Demolition', multiplier: 10000n },
      { code: 'DEM-02', source: 'area' as const, group: 'Demolition', multiplier: 20n },
      { code: 'CAR-01', source: 'area' as const, group: 'Framing', multiplier: 1200n },
      { code: 'CAR-02', source: 'bedrooms' as const, group: 'Framing', multiplier: 10000n },
      { code: 'CAR-03', source: 'area' as const, group: 'Finishing', multiplier: 1100n },
      { code: 'DRY-01', source: 'area' as const, group: 'Drywall', multiplier: 27000n },
      { code: 'ELE-01', source: 'area' as const, group: 'Electrical', multiplier: 10000n },
      { code: 'ELE-02', source: 'area' as const, group: 'Electrical', multiplier: 200n },
      { code: 'PLM-01', source: 'washrooms' as const, group: 'Plumbing', multiplier: 10000n },
      { code: 'CON-01', source: 'washrooms' as const, group: 'Concrete', multiplier: 10000n },
      { code: 'FLR-01', source: 'area' as const, group: 'Flooring', multiplier: 10000n, allowance: true },
      { code: 'FIN-09', source: 'fixed' as const, group: 'Available upgrades', multiplier: 10000n, fixedQty: 1000n, optional: true },
      { code: 'FIN-10', source: 'area' as const, group: 'Available upgrades', multiplier: 10000n, optional: true },
      { code: 'OH-01', source: 'fixed' as const, group: 'Overhead', multiplier: 10000n },
      { code: 'PRF-01', source: 'fixed' as const, group: 'Overhead', multiplier: 10000n },
    ],
  },
  {
    name: 'Bathroom Renovation',
    projectType: 'bathroom' as const,
    description: 'Single washroom gut and rebuild.',
    items: [
      { code: 'DEM-01', source: 'area' as const, group: 'Demolition', multiplier: 10000n },
      { code: 'DEM-02', source: 'fixed' as const, group: 'Demolition', multiplier: 10000n, fixedQty: 1000n },
      { code: 'PLM-01', source: 'washrooms' as const, group: 'Plumbing', multiplier: 10000n },
      { code: 'ELE-01', source: 'area' as const, group: 'Electrical', multiplier: 10000n },
      { code: 'DRY-01', source: 'area' as const, group: 'Drywall', multiplier: 32000n },
      { code: 'FLR-01', source: 'area' as const, group: 'Flooring', multiplier: 10000n, allowance: true },
      { code: 'OH-01', source: 'fixed' as const, group: 'Overhead', multiplier: 10000n },
      { code: 'PRF-01', source: 'fixed' as const, group: 'Overhead', multiplier: 10000n },
    ],
  },
];

export const DEMO_CUSTOMERS = [
  {
    name: 'Eleanor Vance',
    customerType: 'residential' as const,
    leadSource: 'referral' as const,
    email: 'eleanor.vance@example.com',
    phone: '416-555-0188',
    addressLine1: '41 Kensington Avenue',
    city: 'Oakville',
    province: 'ON',
    postalCode: 'L6H 3T2',
    altContactName: 'Marcus Vance',
    altContactPhone: '416-555-0189',
    projects: [
      {
        name: 'Kensington basement finish',
        projectType: 'basement' as const,
        contractType: 'lump_sum' as const,
        stage: 'quoting' as const,
        siteAddressLine1: '41 Kensington Avenue',
        siteCity: 'Oakville',
        siteProvince: 'ON',
        sitePostalCode: 'L6H 3T2',
        scheduledStart: null,
        template: 'Basement Finish — Standard',
        scope: { areaSqftMilli: 1240500n, washroomCount: 1, kitchenCount: 0, bedroomCount: 2 },
      },
    ],
  },
  {
    name: 'Dara Okonkwo',
    customerType: 'residential' as const,
    leadSource: 'website' as const,
    phone: '905-555-0117',
    addressLine1: '12 Rowanwood Court',
    city: 'Milton',
    province: 'ON',
    postalCode: 'L9T 8S4',
    projects: [
      {
        name: 'Main bathroom renovation',
        projectType: 'bathroom' as const,
        contractType: 'lump_sum' as const,
        stage: 'quote_sent' as const,
        siteAddressLine1: '12 Rowanwood Court',
        siteCity: 'Milton',
        siteProvince: 'ON',
        sitePostalCode: 'L9T 8S4',
        scheduledStart: null,
        template: 'Bathroom Renovation',
        scope: { areaSqftMilli: 82000n, washroomCount: 1, kitchenCount: 0, bedroomCount: 0 },
      },
    ],
  },
  {
    name: 'Halton Community Housing',
    companyName: 'Halton Community Housing Corp.',
    customerType: 'commercial' as const,
    leadSource: 'repeat' as const,
    email: 'facilities@halton-housing.example',
    phone: '905-555-0160',
    city: 'Burlington',
    province: 'ON',
    isTaxExempt: false,
    projects: [
      {
        name: 'Unit 214 bathroom refit',
        projectType: 'bathroom' as const,
        contractType: 'unit_price' as const,
        stage: 'won' as const,
        siteAddressLine1: '900 Lakeshore Road, Unit 214',
        siteCity: 'Burlington',
        siteProvince: 'ON',
        scheduledStart: '2026-10-05',
        template: 'Bathroom Renovation',
        scope: { areaSqftMilli: 64000n, washroomCount: 1, kitchenCount: 0, bedroomCount: 0 },
      },
    ],
  },
];

export const DEMO_USERS = [
  { email: 'owner@northgate.example', displayName: 'Priya Raghavan', role: 'owner' as const },
  { email: 'office@northgate.example', displayName: 'Sam Whitfield', role: 'admin' as const },
];
