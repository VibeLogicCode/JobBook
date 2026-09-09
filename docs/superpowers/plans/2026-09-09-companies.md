# Two companies under one owner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One deployment issues documents as either of two legal companies, each with its own letterhead, HST registration number and invoice series, sharing customers, rates, cost codes and vendors.

**Architecture:** A new `companies` table holds the issuer; `organization` stays the deployment and keeps its single-row CHECK. The company is stamped on `projects` only, and every document reaches it through an existing NOT NULL foreign key to its project. Expand then contract: `companies` is created and backfilled additively, all 28 readers are repointed, and only then are the 36 moved columns dropped from `organization` — so the typechecker, not a reviewer, proves nothing was missed.

**Tech Stack:** Next.js 16 App Router (Turbopack), React 19, TypeScript strict, Drizzle ORM 0.45.2, PostgreSQL 16, Vitest 3 (`environment: 'node'`).

**Spec:** `docs/superpowers/specs/2026-09-07-two-companies-design.md`

**Sibling plan:** `docs/superpowers/plans/2026-09-09-work-posture-and-trade-packs.md` runs AFTER this one and puts `work_posture` on `companies`. Task 1 of this plan creates that column, because it is free in this migration and a second migration for one column is not.

## What building it changed

Recorded here rather than folded silently into the tasks, because five of
these are decisions a reader would otherwise have to reverse-engineer from the
code — and two were mistakes of mine that the toolchain caught.

**Tasks 2 and 4 merged, and they had to.** Rekeying `document_sequences`
breaks `allocateDocumentNumber`'s `ON CONFLICT` in the same statement, so the
schema change and the allocator are one change. The task boundary as drawn
would have left the tree red between two commits.

**Task 5 merged in too, for a better reason.** Every `org.` read in the three
document writers — quote validity, holdback percentage, quote terms, payment
terms, holdback deferral, holdback release days — turned out to be a company
fact without exception. Not one deployment fact among them. So "repoint the
writers" and "fix the letterhead" were the same edit, and splitting them would
have meant touching the same lines twice.

**`companies.document_prefix`, which no task anticipated.** The unique index
on `document_sequences (kind, year, prefix)` that §4.5 requires means two
companies cannot both use `INV` — and nothing gave the second one a distinct
code, so its first invoice would have failed on an index far from the cause.
The owner chose a prefix over my suffix: `RENO_INV-2026-0001` beside
`MAP_INV-2026-0001`, because a document number is read down the phone and a
one-letter difference at the end of a code is one transcription error away
from an hour of reconciling. The kind code is prefixed, never replaced — a
quote and a change order share `quotes.quote_number`.

**`organization` keeps `display_name`; the move was 36 columns, not 37.** The
sign-in screen renders before authentication, so it has no session, no project
and no way to choose between two companies. A screen that cannot know which
company it is must not be asking.

**`React.cache` had to be split from the rule.** `loadCompanies` and
`primaryCompany` are request-scoped in production and process-wide under a
single test fork, so the second test file got the first file's rows. That is
what made `tests/db/companies.test.ts` pass alone and fail in the suite.
`readCompanies` (uncached) and `primaryOf` (pure) are what tests and server
actions use; the cached wrappers are for page rendering, where several
components in one request want the same two rows.

**Two mistakes of mine, and what caught each.**
`companies.payment_terms_days` was `NOT NULL DEFAULT 30` where
`organization`'s is nullable — the typechecker caught it, and it mattered:
`issueInvoice` reads null as "no stated terms", so a default would invent a
due date the customer never agreed to. And `actions.ts` exported a string from
a `'use server'` file, which only `next build` catches — `tests/ops/action-guards.test.ts`
asserts the rule but not that particular shape.

**drizzle-kit could not generate three of the six migrations.** It emitted
`ADD COLUMN ... NOT NULL` with no backfill (fails on any non-empty table) and
put a new primary key before the column it names; and a column RENAME is
precisely the diff it stops to ask a human about, so it hung. Those are
hand-written, snapshots included.

---

## Global Constraints

Copied from the spec and from `AGENTS.md`. Every task's requirements implicitly include this section.

- **Next.js 16.** Read `node_modules/next/dist/docs/` before writing App Router code. APIs differ from training data.
- **No DELETE, ever.** `record_status = 'void'` with a reason, or `is_active = false` for a maintained list. `companies` retires via `isActive`; a company is never deleted.
- **Money is integer cents. Quantities are thousandths. Rates are ten-thousandths as `bigint`** — `rate = (name) => bigint(name, { mode: 'bigint' })`. 10% is `100000n`, never `'10.0000'`.
- **`organization`'s single-row CHECK stays** (`src/db/schema/organization.ts:93`, `check('organization_single_row', sql`id = 1`)`). `organization` remains the deployment.
- **The table is named `companies`, never `entities`.** `files.entity_type` / `entity_id` already means "which record does this file attach to". Two meanings for one word in one schema is how a query gets written against the wrong thing and passes review.
- **`companies.id` is a uuid.** `src/db/schema/system.ts:16-27` documents that `files.entity_id` is a uuid and cannot point at `organization`'s integer id. Two companies need two logos.
- **`organization` keeps `displayName`; 36 columns move, not 37.** Settled 2026-09-09 against the code, resolving what the spec left open. `displayName` is read in three places that have no company in hand and cannot get one: the sign-in heading (`src/app/auth/sign-in/page.tsx:40`, which runs BEFORE authentication and so cannot know whose deployment it is), the browser tab title template (`src/app/layout.tsx:23`) and the shell heading (`:51`). It is the DEPLOYMENT's label — the group name when there are two companies — and it must never print on a document. `legalName` and `companies.displayName` are what appear on paper.
- **A job never moves between companies.** Owner's answer, 2026-09-07. Everything in §4.4 of the spec depends on it: no re-numbering, no inter-company billing, no split jobs, no update anomaly to defend against.
- **While there is one company, nothing in the interface mentions companies.** No picker, no column, no filter, no setting. Spec §5.
- **Tests are `environment: 'node'`, `include: ['tests/**/*.test.ts']`, `fileParallelism: false`.** There are no DOM or component tests. A rule that must be asserted has to be expressible as data — the reason `src/components/ui/destinations.ts` exists.
- **A test that reads `organization` must call `ensureOrganization()`** from `tests/support/organization.ts`. A test that reads `companies` must call the new `ensureCompany()` from the same file. §9 of the backlog records what happens otherwise: 98 tests silently never ran.
- **Commit after every task.** Attribution line: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. No local paths, no employer name, no personal name in commits or code.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/db/schema/companies.ts` | The `companies` table. The 36 issuer columns and nothing else. |
| `src/lib/company/load.ts` | `loadCompanies()`, `loadCompany(id)`, `primaryCompany()`, `companyOf(tx, projectId)`. The only readers. |
| `src/lib/company/ids.ts` | `FIRST_COMPANY_ID`, the fixed uuid the migration backfills. |
| `drizzle/0020_companies.sql` | Creates `companies`, backfills one row, adds the three foreign keys, rekeys `document_sequences`. |
| `drizzle/0021_organization_contract.sql` | Drops the 36 moved columns from `organization`. Separate migration, run only after Task 6. |
| `src/app/settings/companies/page.tsx` | The company list, and "Add a company". |
| `src/app/settings/companies/actions.ts` | `addCompany`, `retireCompany`. |
| `src/components/company/CompanyPicker.tsx` | Renders nothing when there is one company. |
| `tests/db/companies.test.ts` | The table, the backfill, the constraints. |
| `tests/unit/company-split.test.ts` | Which columns live where. Assertable as data. |
| `tests/integration/company-documents.test.ts` | Letterhead, numbering and tax, per company. |

**Modified:**

| File | Change |
|---|---|
| `src/db/schema/organization.ts:52-93` | 36 columns leave; `displayName` STAYS as the deployment label; `documentSequences` primary key becomes `(companyId, kind, year)`; `taxRates` gains `companyId NOT NULL`. |
| `src/db/schema/index.ts` | Export `companies`. |
| `src/db/schema/customers.ts:42` | `projects.companyId NOT NULL`. **`projects` lives here, not in `quotes.ts`.** |
| `src/lib/quote/rates.ts:20` | `loadTaxRatesFor(tx, companyId)`. **The worst bug in the spec.** |
| `src/lib/quote/numbering.ts:54` | `allocateDocumentNumber(tx, kind, companyId, year?)`. |
| `src/lib/quote/repository.ts:21,166,192,228,234,253,333` | Company from the project, not `id = 1`. |
| `src/lib/quote/change-order.ts:75,110,137` | Same. |
| `src/lib/invoice/repository.ts:307,352,426` | Same. |
| `src/lib/quote/accept.ts:324` | Same. |
| `src/lib/quote/recalculate.ts:61` | Same. |
| `src/app/print/quote/[id]/page.tsx:51,128` | Letterhead from the quote's project's company. |
| `src/app/api/quotes/[id]/pdf/route.ts:25` | Same. |
| `src/app/settings/tax-rates/actions.ts:59-107` | The overlap guard scopes to one company. **Company two's HST is not a duplicate.** |
| 22 further files | Repointed in Task 6. Listed there in full. |
| `tests/support/organization.ts` | Gains `ensureCompany()`. |

---

## Task 1: The `companies` table, created and backfilled — DONE (`cd0d49b`)

**Files:**
- Create: `src/db/schema/companies.ts`
- Create: `src/lib/company/ids.ts`
- Create: `src/lib/company/load.ts`
- Create: `drizzle/0020_companies.sql`
- Modify: `src/db/schema/index.ts`
- Modify: `tests/support/organization.ts`
- Test: `tests/db/companies.test.ts`

**Interfaces:**
- Produces: `companies` (Drizzle table), `FIRST_COMPANY_ID: string`, `loadCompanies(): Promise<Company[]>`, `loadCompany(id: string): Promise<Company | null>`, `primaryCompany(): Promise<Company | null>`, `type Company = typeof companies.$inferSelect`, `ensureCompany(): Promise<void>`.
- Consumes: nothing.

**Nothing reads this table yet.** That is the point of the task boundary: the migration is additive, the old columns still stand, and a rollback is dropping one table.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/companies.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { companies, organization } from '@/db/schema';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { ensureCompany, ensureOrganization } from '../support/organization';

describe('companies', () => {
  beforeEach(async () => {
    await ensureOrganization();
    await ensureCompany();
  });

  it('carries the issuer columns', async () => {
    const [row] = await db.select().from(companies).where(eq(companies.id, FIRST_COMPANY_ID));
    expect(row).toBeDefined();
    expect(row!.legalName).toBe('Sample Contracting Ltd');
    // Ten-thousandths as bigint. 10% is 100000n, never a decimal string.
    expect(typeof row!.defaultHoldbackPctTenThou === 'bigint' || row!.defaultHoldbackPctTenThou === null).toBe(true);
  });

  it('does not carry the deployment facts', async () => {
    const [row] = await db.select().from(companies).where(eq(companies.id, FIRST_COMPANY_ID));
    // Two companies sharing one office cannot disagree about these without
    // one of them being wrong. They stay on `organization`.
    expect(row as Record<string, unknown>).not.toHaveProperty('timezone');
    expect(row as Record<string, unknown>).not.toHaveProperty('currency');
    expect(row as Record<string, unknown>).not.toHaveProperty('locale');
    expect(row as Record<string, unknown>).not.toHaveProperty('areaUnit');
    expect(row as Record<string, unknown>).not.toHaveProperty('mileageRatePerKmTenThou');
  });

  it('keeps organization single-row', async () => {
    await expect(
      db.insert(organization).values({ id: 2, legalName: 'Second', displayName: 'Second' }),
    ).rejects.toThrow();
  });

  it('retires rather than deletes', async () => {
    const [row] = await db.select().from(companies).where(eq(companies.id, FIRST_COMPANY_ID));
    expect(row!.isActive).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/db/companies.test.ts`
Expected: FAIL — `companies` is not exported from `@/db/schema`.

- [ ] **Step 3: Write the fixed id**

```ts
// src/lib/company/ids.ts
/**
 * The company that existed before companies existed.
 *
 * A FIXED uuid rather than `gen_random_uuid()`, for the reason
 * `db/seed/project-lists.ts` and `db/seed/reminder-rules.ts` give for theirs:
 * migration 0020 has to stamp `projects.company_id` and `tax_rates.company_id`
 * on every existing row, the demo seed has to point at it, and a test has to
 * be able to name it. A random id would make all three read the table back to
 * find out what they had just created.
 *
 * A SECOND company gets a random id. There is only ever one row that predates
 * the concept, and only that row needs a name in code.
 */
export const FIRST_COMPANY_ID = 'c0000001-0000-4a00-9000-000000000001';
```

- [ ] **Step 4: Write the schema**

```ts
// src/db/schema/companies.ts
import { boolean, date, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, rate } from '@/db/columns';
import { taxFilingFrequencyEnum } from '@/db/schema/organization';

/**
 * The legal person whose name is on the paper.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A SECOND `organization` ROW
 * ---------------------------------------------------------------------------
 *
 * The cheaper-looking variant is to drop `organization`'s single-row CHECK and
 * treat each row as a company. It is wrong twice: it puts `timezone` and
 * `currency` on two rows that must agree -- two companies sharing one office
 * cannot disagree about what today's date is without one of them being wrong
 * -- and it inherits the integer primary key, which `files.entity_id` (a uuid,
 * per `db/schema/system.ts:16-27`) cannot point at. Two companies need two
 * logos.
 *
 * So: `organization` stays the DEPLOYMENT and keeps its check. This table is
 * the ISSUER, and holds exactly what is a fact about a legal person or appears
 * on its letterhead.
 *
 * ---------------------------------------------------------------------------
 * WHY `companies` AND NEVER `entities`
 * ---------------------------------------------------------------------------
 *
 * `files.entity_type` / `entity_id` already exists and already means "which
 * record does this file attach to" -- a quote, a project, an expense. Two
 * meanings for one word in one schema is how a query gets written against the
 * wrong thing and passes review.
 *
 * ---------------------------------------------------------------------------
 * RETIRED, NEVER DELETED
 * ---------------------------------------------------------------------------
 *
 * `isActive` is how two companies merge back into one: mark the second
 * inactive, no new jobs may be filed under it, and every document it already
 * issued keeps the letterhead it was legally issued under. Deleting the row
 * would rewrite history on documents a customer holds and an auditor may ask
 * for.
 */
export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),

  // identity and branding
  legalName: text('legal_name').notNull(),
  displayName: text('display_name').notNull(),
  operatingName: text('operating_name'),
  tagline: text('tagline'),
  ownerName: text('owner_name'),
  ownerTitle: text('owner_title'),
  logoFileId: uuid('logo_file_id'),
  faviconFileId: uuid('favicon_file_id'),
  brandColor: text('brand_color'),

  // contact
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  province: text('province'),
  postalCode: text('postal_code'),
  country: text('country'),
  phone: text('phone'),
  altPhone: text('alt_phone'),
  email: text('email'),
  website: text('website'),

  /**
   * The Input Tax Credit Information Regulations require the SUPPLIER's own
   * registration number on invoices of $30 and up. The wrong number makes the
   * customer's credit defective and reports the supply under the wrong
   * account, so this cannot be a deployment-wide value once two registrants
   * exist. Spec §7.
   */
  taxRegistrationNumber: text('tax_registration_number'),
  taxRegistrationLabel: text('tax_registration_label'),
  businessNumber: text('business_number'),
  fiscalYearEndMonth: integer('fiscal_year_end_month'),
  fiscalYearEndDay: integer('fiscal_year_end_day'),
  taxFilingFrequency: taxFilingFrequencyEnum('tax_filing_frequency'),

  // holdback
  taxDeferredOnHoldback: boolean('tax_deferred_on_holdback').notNull().default(true),
  defaultHoldbackPctTenThou: rate('default_holdback_pct_ten_thou'),
  holdbackLabel: text('holdback_label'),
  holdbackTermsText: text('holdback_terms_text'),
  holdbackReleaseDays: integer('holdback_release_days').notNull().default(60),

  // terms
  paymentTermsDays: integer('payment_terms_days').notNull().default(30),
  paymentTermsText: text('payment_terms_text'),
  insuranceStatement: text('insurance_statement'),
  targetMarginBp: integer('target_margin_bp'),

  // documents
  quoteValidityDays: integer('quote_validity_days').notNull().default(30),
  quoteTermsText: text('quote_terms_text'),
  documentFooterText: text('document_footer_text'),

  /** Where it sits in the picker. Ties fall back to the display name. */
  sortOrder: integer('sort_order').notNull().default(0),
  /**
   * "No new jobs under this company." Retiring, not deletion -- see the
   * header. Every document it issued stays readable and stays attributed.
   */
  isActive: boolean('is_active').notNull().default(true),

  ...auditColumns,
});
```

Then export it: add `export * from '@/db/schema/companies';` to `src/db/schema/index.ts` alongside the other schema exports, and confirm `taxFilingFrequencyEnum` is exported from `organization.ts` (add `export` if it is currently module-private).

- [ ] **Step 5: Write the migration**

```sql
-- drizzle/0020_companies.sql
-- The issuer, split from the deployment. Additive: the 37 columns stay on
-- `organization` until migration 0021, so this migration is reversible by
-- dropping one table and three columns.

CREATE TABLE "companies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "legal_name" text NOT NULL,
  "display_name" text NOT NULL,
  "operating_name" text,
  "tagline" text,
  "owner_name" text,
  "owner_title" text,
  "logo_file_id" uuid,
  "favicon_file_id" uuid,
  "brand_color" text,
  "address_line1" text,
  "address_line2" text,
  "city" text,
  "province" text,
  "postal_code" text,
  "country" text,
  "phone" text,
  "alt_phone" text,
  "email" text,
  "website" text,
  "tax_registration_number" text,
  "tax_registration_label" text,
  "business_number" text,
  "fiscal_year_end_month" integer,
  "fiscal_year_end_day" integer,
  "tax_filing_frequency" "tax_filing_frequency",
  "tax_deferred_on_holdback" boolean DEFAULT true NOT NULL,
  "default_holdback_pct_ten_thou" bigint,
  "holdback_label" text,
  "holdback_terms_text" text,
  "holdback_release_days" integer DEFAULT 60 NOT NULL,
  "payment_terms_days" integer DEFAULT 30 NOT NULL,
  "payment_terms_text" text,
  "insurance_statement" text,
  "target_margin_bp" integer,
  "quote_validity_days" integer DEFAULT 30 NOT NULL,
  "quote_terms_text" text,
  "document_footer_text" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid,
  "record_status" "record_status" DEFAULT 'active' NOT NULL,
  "voided_at" timestamp with time zone,
  "voided_by" uuid,
  "void_reason" text
);

-- The company that existed before companies existed. Copied rather than
-- re-entered, so an installation that has already run setup does not lose its
-- letterhead. The fixed id matches `src/lib/company/ids.ts`.
INSERT INTO "companies" (
  "id", "legal_name", "display_name", "operating_name", "tagline",
  "owner_name", "owner_title", "logo_file_id", "favicon_file_id", "brand_color",
  "address_line1", "address_line2", "city", "province", "postal_code",
  "country", "phone", "alt_phone", "email", "website",
  "tax_registration_number", "tax_registration_label", "business_number",
  "fiscal_year_end_month", "fiscal_year_end_day", "tax_filing_frequency",
  "tax_deferred_on_holdback", "default_holdback_pct_ten_thou", "holdback_label",
  "holdback_terms_text", "holdback_release_days", "payment_terms_days",
  "payment_terms_text", "insurance_statement", "target_margin_bp",
  "quote_validity_days", "quote_terms_text", "document_footer_text"
)
SELECT
  'c0000001-0000-4a00-9000-000000000001'::uuid,
  o."legal_name", o."display_name", o."operating_name", o."tagline",
  o."owner_name", o."owner_title", o."logo_file_id", o."favicon_file_id", o."brand_color",
  o."address_line1", o."address_line2", o."city", o."province", o."postal_code",
  o."country", o."phone", o."alt_phone", o."email", o."website",
  o."tax_registration_number", o."tax_registration_label", o."business_number",
  o."fiscal_year_end_month", o."fiscal_year_end_day", o."tax_filing_frequency",
  o."tax_deferred_on_holdback", o."default_holdback_pct_ten_thou", o."holdback_label",
  o."holdback_terms_text", o."holdback_release_days", o."payment_terms_days",
  o."payment_terms_text", o."insurance_statement", o."target_margin_bp",
  o."quote_validity_days", o."quote_terms_text", o."document_footer_text"
FROM "organization" o
WHERE o."id" = 1;
```

**Note on the `INSERT ... SELECT`:** it inserts nothing on a database where setup has never run, because `organization` has no row yet. That is correct — the wizard creates the company in Task 8's flow. Task 2's backfill must therefore tolerate an empty `companies`, and it does, because there are no projects either.

- [ ] **Step 6: Add the test helper**

Append to `tests/support/organization.ts`:

```ts
/**
 * The `companies` row a test needs in order to read one.
 *
 * Same reasoning as `ensureOrganization` above, and the same
 * `onConflictDoNothing`. Kept in this file rather than a new one because a
 * test that needs a company almost always needs the deployment row too, and
 * two imports for one precondition is how one of them gets forgotten.
 */
export async function ensureCompany(
  executor: Pick<typeof db, 'insert'> = db,
): Promise<void> {
  await executor
    .insert(companies)
    .values({
      id: FIRST_COMPANY_ID,
      legalName: 'Sample Contracting Ltd',
      displayName: 'Sample Contracting',
    })
    .onConflictDoNothing();
}
```

with `companies` added to the schema import and `import { FIRST_COMPANY_ID } from '@/lib/company/ids';` at the top.

- [ ] **Step 7: Write the readers**

```ts
// src/lib/company/load.ts
import { cache } from 'react';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { companies, projects } from '@/db/schema';

export type Company = typeof companies.$inferSelect;

/**
 * Every company, active first, in picker order.
 *
 * `cache()` for the reason `loadOrganization` gives: the root layout, a page
 * title and a page's own notice all want this in one request, and three reads
 * of a two-row table is three round trips for no reason. Per-request, which is
 * correct -- a company edited in Settings must be visible on the next request,
 * not after a deploy.
 *
 * Swallows errors to an empty list, like `loadOrganization` does to null: a
 * missing database is a setup problem and the caller still has to render the
 * screen that says so.
 */
export const loadCompanies = cache(async (): Promise<Company[]> => {
  try {
    return await db
      .select()
      .from(companies)
      .where(eq(companies.recordStatus, 'active'))
      .orderBy(asc(companies.sortOrder), asc(companies.displayName));
  } catch {
    return [];
  }
});

/**
 * The company to default to when nothing in the request names one.
 *
 * The single ACTIVE company, or null when there are none or more than one.
 * Null on ambiguity rather than "the first" -- guessing which of two
 * registrants issues a document is exactly the mistake this whole change
 * exists to make impossible, and a caller that cannot name a company must ask
 * rather than be handed one.
 */
export const primaryCompany = cache(async (): Promise<Company | null> => {
  const active = (await loadCompanies()).filter((row) => row.isActive);
  return active.length === 1 ? active[0]! : null;
});

export async function loadCompany(id: string): Promise<Company | null> {
  const [row] = await db.select().from(companies).where(eq(companies.id, id));
  return row ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The company a project belongs to.
 *
 * THE function every document loader goes through. `projects.company_id` is
 * NOT NULL and every document -- quote, invoice, expense, holdback ledger row,
 * schedule task -- reaches its project through a NOT NULL foreign key of its
 * own, so this one join answers "whose paper is this" for all of them. Spec
 * §4.4: the company goes on `projects` only, and because a job never moves
 * there is no update anomaly to defend against.
 *
 * Throws rather than returning null. A document whose issuer cannot be
 * resolved must not render with somebody else's letterhead, and there is no
 * sensible fallback: `id = 1` is the bug this replaces.
 */
export async function companyOf(tx: Tx, projectId: string): Promise<Company> {
  const [row] = await tx
    .select({ company: companies })
    .from(projects)
    .innerJoin(companies, eq(companies.id, projects.companyId))
    .where(eq(projects.id, projectId));
  if (!row) throw new Error(`project ${projectId} has no company`);
  return row.company;
}
```

**`companyOf` will not typecheck until Task 2** adds `projects.companyId`. Write it in Task 2 instead if the executor prefers a green tree at every step; the interface is stated here because Tasks 3–6 all consume it.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/db/companies.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema/companies.ts src/db/schema/index.ts src/db/schema/organization.ts \
        src/lib/company/ tests/db/companies.test.ts tests/support/organization.ts \
        drizzle/0020_companies.sql drizzle/meta/
git commit -m "feat: a companies table, holding the legal person on the paper"
```

---

## Task 2: The three columns that must land in the first migration — DONE (`152cf32`, with Tasks 4 and 5)

**Files:**
- Modify: `drizzle/0020_companies.sql` (same migration — it has not shipped)
- Modify: `src/db/schema/customers.ts` (`projects` is defined at line 42 of this file, not in `quotes.ts` — verified 2026-09-09)
- Modify: `src/db/schema/organization.ts` (`taxRates`, `documentSequences`)
- Create: `src/lib/company/load.ts` — `companyOf` now typechecks
- Test: `tests/db/companies.test.ts` (extend)

**Interfaces:**
- Consumes: `companies`, `FIRST_COMPANY_ID` from Task 1.
- Produces: `projects.companyId` (uuid, NOT NULL, FK), `taxRates.companyId` (uuid, NOT NULL, FK), `documentSequences` primary key `(companyId, kind, year)`, `companyOf(tx, projectId): Promise<Company>`.

**This is the task with a deadline.** Spec §4.3: adding a second company later must need no data migration, and that is true only if these three hold from the moment companies exist at all. Get them wrong and "add a company" becomes a migration on live data on the day the owner incorporates.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/db/companies.test.ts
import { customers, documentSequences, projects, taxRates } from '@/db/schema';
import { PROJECT_TYPE_IDS } from '@/db/seed/project-lists';

describe('the three columns', () => {
  beforeEach(async () => {
    await ensureOrganization();
    await ensureCompany();
  });

  it('refuses a project with no company', async () => {
    const [customer] = await db.insert(customers)
      .values({ displayName: 'Test customer' }).returning({ id: customers.id });
    await expect(
      db.insert(projects).values({
        name: 'No company',
        projectNumber: 'P-2026-9001',
        customerId: customer!.id,
        projectTypeId: PROJECT_TYPE_IDS.basement,
        // companyId deliberately omitted
      } as never),
    ).rejects.toThrow();
  });

  it('refuses a tax rate with no company', async () => {
    await expect(
      db.insert(taxRates).values({
        label: 'HST',
        rateTenThou: 130000n,
        effectiveFrom: '2026-01-01',
      } as never),
    ).rejects.toThrow();
  });

  it('gives each company its own series for the same kind and year', async () => {
    const [second] = await db.insert(companies)
      .values({ legalName: 'Second Co Ltd', displayName: 'Second Co' })
      .returning({ id: companies.id });

    await db.insert(documentSequences).values([
      { companyId: FIRST_COMPANY_ID, kind: 'invoice', year: 2026, nextSeq: 7, prefix: 'INV' },
      { companyId: second!.id, kind: 'invoice', year: 2026, nextSeq: 1, prefix: 'INV' },
    ]);

    const rows = await db.select().from(documentSequences)
      .where(and(eq(documentSequences.kind, 'invoice'), eq(documentSequences.year, 2026)));
    // Two rows, not a primary-key violation: company one keeps its history and
    // company two starts at 0001. Nothing is renumbered, ever.
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/db/companies.test.ts -t 'the three columns'`
Expected: FAIL — `companyId` does not exist on `projects`.

- [ ] **Step 3: Add the columns to the schema**

In `src/db/schema/customers.ts`, on `projects`:

```ts
  /**
   * Which company issued this job, and therefore which company's letterhead,
   * HST number and invoice series every document under it carries.
   *
   * NOT NULL from the first migration, deliberately. Spec §4.3: every existing
   * job is already correctly stamped when company two arrives, because they
   * were all company one's. A nullable column would mean a data migration on
   * the day the owner incorporates -- the worst possible moment.
   *
   * ON `projects` AND NOWHERE ELSE. Quotes, invoices, expenses, holdback
   * ledger rows and schedule tasks all reach here through a NOT NULL foreign
   * key, and every loader already joins projects for the customer name, so the
   * join is free. A job never moves between companies (owner, 2026-09-07), so
   * there is no update anomaly to defend against -- which is exactly what that
   * answer buys.
   */
  companyId: uuid('company_id').notNull().references(() => companies.id),
```

In `src/db/schema/organization.ts`, on `taxRates`:

```ts
  /**
   * Whose registration this rate is charged under.
   *
   * NOT NULL, and the single most important column in this change. Before it,
   * `loadTaxRatesFor` returned every active rate with no filter and
   * `computeTaxes` applied all of them in force -- so the day company two's
   * 13% HST row existed, EVERY quote in the deployment charged 26%. Silently,
   * on a document a customer signs, with the arithmetic entirely innocent.
   * Spec §8 item 2 calls it the worst thing in that document and it was right.
   */
  companyId: uuid('company_id').notNull().references(() => companies.id),
```

and on `documentSequences`, add the same column and change the last line to:

```ts
}, (t) => [primaryKey({ columns: [t.companyId, t.kind, t.year] })]);
```

- [ ] **Step 4: Extend the migration**

Append to `drizzle/0020_companies.sql`:

```sql
-- projects.company_id: added nullable, backfilled, then made NOT NULL. Every
-- existing job was company one's, because company one is the only company
-- that has ever existed.
ALTER TABLE "projects" ADD COLUMN "company_id" uuid;
UPDATE "projects" SET "company_id" = 'c0000001-0000-4a00-9000-000000000001'::uuid;
ALTER TABLE "projects" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id");

ALTER TABLE "tax_rates" ADD COLUMN "company_id" uuid;
UPDATE "tax_rates" SET "company_id" = 'c0000001-0000-4a00-9000-000000000001'::uuid;
ALTER TABLE "tax_rates" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id");

-- document_sequences is rekeyed rather than extended: the primary key IS the
-- series identity, and `allocateDocumentNumber`'s ON CONFLICT targets it.
ALTER TABLE "document_sequences" ADD COLUMN "company_id" uuid;
UPDATE "document_sequences" SET "company_id" = 'c0000001-0000-4a00-9000-000000000001'::uuid;
ALTER TABLE "document_sequences" ALTER COLUMN "company_id" SET NOT NULL;
ALTER TABLE "document_sequences" DROP CONSTRAINT "document_sequences_kind_year_pk";
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_company_id_kind_year_pk"
  PRIMARY KEY ("company_id", "kind", "year");
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id");

-- Global uniqueness of invoice_number and project_number stays (the unique
-- indexes are untouched), so it now has to hold BY CONSTRUCTION: two companies
-- must not both register `INV` for the same kind and year, or their series
-- would collide on formatting. Spec §4.5.
CREATE UNIQUE INDEX "document_sequences_kind_year_prefix_unique"
  ON "document_sequences" ("kind", "year", "prefix");
```

**The empty-database case:** on a fresh install `companies` is empty, so the three `UPDATE`s touch nothing and the three `SET NOT NULL`s succeed on empty tables. Correct.

- [ ] **Step 5: Write `companyOf`**

Add the `companyOf` function from Task 1 Step 7 to `src/lib/company/load.ts` — it typechecks now.

- [ ] **Step 6: Run the tests**

Run: `npm run db:migrate && npx vitest run tests/db/companies.test.ts && npx tsc --noEmit`
Expected: the three new tests PASS. **Every insert of a project or tax rate elsewhere in the suite now fails to typecheck** — that is the expected blast radius and Step 7 is where it is absorbed.

- [ ] **Step 7: Fix every project and tax-rate insert in the suite and the seeds**

Find them: `grep -rln "insert(projects)\|insert(taxRates)" src tests scripts`

Each gains `companyId: FIRST_COMPANY_ID` (tests, `src/db/seed/demo.ts`) or the company from the request (application code — but application inserts are Task 5's and Task 8's, so for now pass `(await primaryCompany())!.id` and leave a `// Task 8: from the picker` marker only where the picker genuinely lands).

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. Record the test count in the commit message — §9 of the backlog exists because a silently shrinking suite went unnoticed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: projects, tax rates and numbering all belong to a company"
```

---

## Task 3: Tax rates scoped to one company — DONE (`152cf32`)

**Files:**
- Modify: `src/lib/quote/rates.ts:20`
- Modify: `src/lib/quote/repository.ts:166,228,333`
- Modify: `src/lib/quote/accept.ts:324`
- Modify: `src/lib/quote/change-order.ts:110`
- Modify: `src/lib/quote/recalculate.ts:61`
- Modify: `src/lib/invoice/repository.ts:352`
- Modify: `src/app/expenses/actions.ts:248-271`
- Modify: `src/lib/quote/tax-overlap.ts`
- Modify: `src/app/settings/tax-rates/actions.ts:59-107`
- Test: `tests/integration/company-documents.test.ts` (create)
- Test: `tests/unit/tax-overlap.test.ts` (extend)

**Interfaces:**
- Consumes: `companyOf`, `taxRates.companyId`.
- Produces: `loadTaxRatesFor(tx, companyId): Promise<TaxRateInput[]>`, `overlapProblem(existing, candidate)` unchanged in signature — the CALLER now passes only one company's rows.

**The worst bug in the spec, and it does not exist yet.** Do this before any screen can create a second company.

**And the guard I shipped yesterday now cuts the wrong way.** `addTaxRate` matches on the label alone, so once company two registers for HST, `overlapProblem` would refuse it as a duplicate of company one's — a correct guard giving a wrong refusal, telling the owner to supersede a row belonging to a different corporation. The fix is at the query, not in the comparison: pass one company's rows.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/company-documents.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { companies, taxRates } from '@/db/schema';
import { loadTaxRatesFor } from '@/lib/quote/rates';
import { FIRST_COMPANY_ID } from '@/lib/company/ids';
import { ensureCompany, ensureOrganization } from '../support/organization';

describe('two registrants, two rate sets', () => {
  let secondId: string;

  beforeEach(async () => {
    await ensureOrganization();
    await ensureCompany();
    const [second] = await db.insert(companies)
      .values({ legalName: 'Second Co Ltd', displayName: 'Second Co' })
      .returning({ id: companies.id });
    secondId = second!.id;

    await db.insert(taxRates).values([
      { companyId: FIRST_COMPANY_ID, label: 'HST', rateTenThou: 130000n,
        effectiveFrom: '2020-01-01', registrationNumber: '111111111RT0001' },
      { companyId: secondId, label: 'HST', rateTenThou: 130000n,
        effectiveFrom: '2020-01-01', registrationNumber: '222222222RT0001' },
    ]);
  });

  it('returns one company its own single rate, not both', async () => {
    // Before this change `loadTaxRatesFor` returned every active rate and
    // `computeTaxes` applied all in force -- so this returned two 13% rows and
    // every quote in the deployment charged 26%.
    const rates = await db.transaction((tx) => loadTaxRatesFor(tx, FIRST_COMPANY_ID));
    expect(rates).toHaveLength(1);
    expect(rates[0]!.registrationNumber).toBe('111111111RT0001');
  });

  it('gives the second company its own registration number', async () => {
    const rates = await db.transaction((tx) => loadTaxRatesFor(tx, secondId));
    expect(rates).toHaveLength(1);
    expect(rates[0]!.registrationNumber).toBe('222222222RT0001');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/integration/company-documents.test.ts`
Expected: FAIL — `loadTaxRatesFor` takes one argument, and returns 2 rows.

- [ ] **Step 3: Scope the loader**

```ts
// src/lib/quote/rates.ts
/**
 * The active tax rates for ONE company, in application order.
 *
 * Effective dating is still NOT filtered here -- the engine picks what was in
 * force on the quote's own date, which is a different question from what is
 * configured today. The COMPANY filter is different in kind and belongs here:
 * a rate belonging to another registrant is not a rate that was ever in force
 * on this document, at any date.
 *
 * Two rates in force together is legitimate and is why `isCompound` exists --
 * GST beside PST, Quebec stacking one on the other. That is exactly why this
 * filter has to be in the QUERY: nothing downstream can tell a second
 * province's tax from a second corporation's copy of the same one, and nothing
 * downstream should try.
 */
export async function loadTaxRatesFor(tx: Tx, companyId: string): Promise<TaxRateInput[]> {
  const rows = await tx
    .select()
    .from(taxRates)
    .where(and(
      eq(taxRates.companyId, companyId),
      eq(taxRates.isActive, true),
      eq(taxRates.recordStatus, 'active'),
    ))
    .orderBy(asc(taxRates.sortOrder));
  // ...mapping unchanged
}
```

- [ ] **Step 4: Repoint all nine call sites**

Each has a project or a quote in hand. The pattern:

```ts
const company = await companyOf(tx, projectId);
const totals = computeQuote(lines, await loadTaxRatesFor(tx, company.id), { onDate: quoteDate, customerExempt });
```

`src/app/expenses/actions.ts:248-271` computes recoverable tax on an expense; `expenses.project_id` is NOT NULL, so it chains to the company cleanly — which is what makes "a tax credit claimed by the wrong corporation" clean by construction (spec §7).

- [ ] **Step 5: Scope the overlap guard**

In `src/app/settings/tax-rates/actions.ts`, add `eq(taxRates.companyId, companyId)` to the guard's own SELECT, and add to `src/lib/quote/tax-overlap.ts`'s header:

```
 * ---------------------------------------------------------------------------
 * ONE COMPANY'S ROWS, AND WHY THAT IS THE CALLER'S JOB
 * ---------------------------------------------------------------------------
 *
 * This function compares on the LABEL, which was the only candidate for "the
 * same tax" while there was one registrant. With two, `HST` under company one
 * and `HST` under company two are two different taxes owed by two different
 * corporations to the same government, and refusing the second as a duplicate
 * would tell the owner to supersede a row belonging to a company that is not
 * the one he is editing -- a correct guard producing a wrong refusal.
 *
 * The fix is in the QUERY and not in this comparison, deliberately. A
 * `companyId` field here would be a second place to get the scoping right, and
 * the caller already has to scope its write.
```

- [ ] **Step 6: Extend the overlap test**

```ts
it('does not treat another company HST as a duplicate', async () => {
  // The caller scopes the query, so the guard never sees the other company's
  // row. Asserted at the action rather than the pure function, because the
  // scoping is the action's job and a unit test of `overlapProblem` cannot
  // catch it being skipped.
  const result = await addTaxRate(null, formDataFor({
    label: 'HST', rate: '13', effectiveFrom: '2020-01-01', sortOrder: '10',
  }, { companyId: secondId }));
  expect(result.kind).toBe('saved');
});
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "fix: two companies charge their own tax, not each other's as well"
```

---

## Task 4: Numbering per company — DONE (`152cf32`, `cee9405`)

**Files:**
- Modify: `src/lib/quote/numbering.ts:54`
- Modify: `src/app/projects/actions.ts:148`
- Modify: `src/app/quotes/new/actions.ts:215`
- Modify: `src/lib/invoice/repository.ts:426`
- Modify: `src/lib/quote/change-order.ts:137`
- Modify: `src/lib/quote/repository.ts:168,234`
- Test: `tests/db/numbering.test.ts` (extend)

**Interfaces:**
- Produces: `allocateDocumentNumber(tx, kind, companyId, year?): Promise<string>`.
- `tenantYear(tx)` is UNCHANGED — it reads `organization.timezone`, which stays a deployment fact. Two companies in one office cannot disagree about what year it is.

- [ ] **Step 1: Write the failing test**

```ts
it('starts the second company at 0001 and leaves the first alone', async () => {
  await db.transaction(async (tx) => {
    expect(await allocateDocumentNumber(tx, 'invoice', FIRST_COMPANY_ID, 2026)).toBe('INV-2026-0001');
    expect(await allocateDocumentNumber(tx, 'invoice', FIRST_COMPANY_ID, 2026)).toBe('INV-2026-0002');
    // A different registrant's series. Nothing is renumbered, ever, and the
    // existing principle that a gap is the record of a voided document stays
    // true per company.
    expect(await allocateDocumentNumber(tx, 'invoice', secondId, 2026)).toBe('INV-2026-0001');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/db/numbering.test.ts`
Expected: FAIL — arity.

- [ ] **Step 3: Add the parameter**

```ts
export async function allocateDocumentNumber(
  tx: Tx,
  kind: DocumentKind,
  companyId: string,
  year?: number,
): Promise<string> {
  const seriesYear = year ?? (await tenantYear(tx));
  const fallback = DEFAULT_PREFIX[kind];

  const rows = await tx.execute(sql`
    insert into document_sequences (company_id, kind, year, next_seq, prefix, updated_at)
    values (${companyId}, ${kind}, ${seriesYear}, 2, ${fallback}, now())
    on conflict (company_id, kind, year) do update
      set next_seq = document_sequences.next_seq + 1, updated_at = now()
    returning next_seq, prefix
  `);
  // ...unchanged
}
```

**`companyId` before the optional `year`**, so no call site can pass a year into the company slot. The two are both scalars and a positional mix-up would allocate against a company id used as a year.

- [ ] **Step 4: Repoint the six call sites**

All six have the project in hand. `src/app/projects/actions.ts:148` and `src/app/quotes/new/actions.ts:215` allocate a PROJECT number and therefore take the company from the form (Task 8's picker) or `primaryCompany()`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: each company gets its own document series"
```

---

## Task 5: The right letterhead and the right defaults — DONE (`152cf32`)

**Files:**
- Modify: `src/app/print/quote/[id]/page.tsx:51,128`
- Modify: `src/app/api/quotes/[id]/pdf/route.ts:25`
- Modify: `src/lib/quote/repository.ts:21,192,253`
- Modify: `src/lib/quote/change-order.ts:75`
- Modify: `src/lib/invoice/repository.ts:307`
- Test: `tests/integration/company-documents.test.ts` (extend)

**Interfaces:** consumes `companyOf`. Produces nothing new.

Spec §8 items 3 and 4 — the two SILENT breaks. Item 3 puts company one's name, HST number and logo on company two's quote. Item 4 takes holdback percent, holdback terms, payment terms and holdback tax deferral from company one for a job belonging to company two.

**`repository.ts:192` and `:253` are the same two lines the sibling plan calls "the single most important line in the implementation."** Here they change from `org` to `company`; there they gain a project-type check. Do them in that order and the second change is one line.

- [ ] **Step 1: Write the failing test**

```ts
it('prints the issuing company letterhead and holdback default', async () => {
  const quote = await createQuoteFor(secondCompanyProjectId);
  const wire = await loadQuote(quote.id);
  expect(wire.company.legalName).toBe('Second Co Ltd');
  expect(wire.company.taxRegistrationNumber).toBe('222222222RT0001');
  // Not company one's 10%. Spec §8 item 4: silent, and on a signed document.
  expect(wire.holdbackPctTenThou).toBe('50000');
});
```

- [ ] **Step 2: Run it to make sure it fails** — `wire.company` does not exist.

- [ ] **Step 3: Replace `organization.id = 1` reads with `companyOf`**

In `src/lib/quote/repository.ts`, the header read at line 21 becomes a per-project read:

```ts
// Was: const [org] = await tx.select().from(organization).where(eq(organization.id, 1));
// The issuer of THIS job's documents, which is a fact about the project and
// not about the deployment. `id = 1` was correct for exactly as long as there
// was one company.
const company = await companyOf(tx, projectId);
```

and lines 192 and 253 become `holdbackPctTenThou: company.defaultHoldbackPctTenThou,`.

The print route reads the quote's project's company for the header block at line 128 and the name at line 51.

- [ ] **Step 4: Run the tests** — `npx vitest run && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: a document carries the letterhead of the company that issued it"
```

---

## Task 6: Repoint the remaining readers — DONE

**Files:** the 22 not covered by Tasks 3–5. Verify the list before starting — it was 23 in the spec and is 28 today:

`grep -rln "from(organization)\|insert(organization)\|update(organization)" src`

- `src/app/auth/sign-in/page.tsx:32,40` — reads `displayName`, which STAYS on `organization`. The only change is to stop selecting the whole row: select `displayName` alone, so the day the other columns are dropped in Task 7 this file does not have to change again.
- `src/app/calendar/page.tsx`, `src/app/expenses/page.tsx`, `src/app/vendors/page.tsx`, `src/app/customers/*` — read `timezone`, `currency`, `locale`, `areaUnit`, `mileageRatePerKmTenThou`. **These stay on `organization` and these files need no change.** Confirm each one individually rather than assuming.
- `src/app/settings/*`, `src/app/setup/*` — the editing screens. These become company-scoped in Task 8.
- `src/lib/reminders/repository.ts:85` — reads `timezone`. No change.
- `src/app/projects/[id]/*`, `src/app/templates/*`, `src/app/quotes/new/page.tsx` — read holdback and margin defaults. Repoint to the project's company.

- [ ] **Step 1: Enumerate and classify.** For each of the 28 files, record in the commit message which of the three it is: *deployment fact, no change* / *repointed to the project's company* / *company editing screen, Task 8*. A file that is none of the three is a finding, not a chore.
- [ ] **Step 2: Repoint the middle group.**
- [ ] **Step 3: Run the full suite and typecheck.** `npx vitest run && npx tsc --noEmit && npm run build`
- [ ] **Step 4: Commit.**

```bash
git add -A
git commit -m "refactor: every reader of the old organization columns names a company"
```

---

## Task 7: Drop the moved columns — DONE (migration 0025, 36 columns)

**Files:**
- Create: `drizzle/0021_organization_contract.sql`
- Modify: `src/db/schema/organization.ts`

**The contract half of expand/contract, and the only step that cannot be done early.** The typechecker is the test: if a column is gone from the Drizzle table and `npx tsc --noEmit` is clean, nothing reads it. That is a stronger proof than a reviewer reading 28 files.

- [ ] **Step 1: Remove the columns from the Drizzle table** and run `npx tsc --noEmit`. Every remaining reader is now a compile error. Fix each — a reader surfacing here is one Task 6 missed, and worth noting in the commit.
- [ ] **Step 2: Write the migration** — `ALTER TABLE "organization" DROP COLUMN` per moved column. **36 columns, and `display_name` is NOT one of them** — it stays as the deployment label (see Global Constraints). `legal_name` DOES go, so `ensureOrganization()` in `tests/support/organization.ts` stops setting it; `companies` carries both, which is why the move is 36 rather than 37: `display_name` is duplicated, not moved.
- [ ] **Step 3: Run** `npm run db:migrate && npx vitest run && npx tsc --noEmit && npm run build`
- [ ] **Step 4: Commit.**

```bash
git add -A
git commit -m "refactor: organization keeps only what the deployment owns"
```

---

## Task 8: Add a company — DONE

**Files:**
- Create: `src/app/settings/companies/page.tsx`, `actions.ts`
- Create: `src/components/company/CompanyPicker.tsx`
- Modify: `src/app/settings/nav.ts`
- Modify: `src/app/projects/new/page.tsx`, `src/app/projects/actions.ts`
- Modify: `src/app/quotes/new/page.tsx`, `src/app/quotes/new/actions.ts`
- Test: `tests/integration/add-company.test.ts`

**The wizard is not touched.** Spec §5: the owner asked for the question at setup and it must not be asked at all — he does not know his own legal structure yet, and a contractor looking at a NAS at 11pm knows less. The wizard's company, contact, financial and tax-rate steps create the ONE company, unchanged from the installer's point of view.

- [ ] **Step 1: Write the failing test**

```ts
it('renders no picker while there is one company', async () => {
  expect(await companyPickerOptions()).toBeNull();
});

it('renders a picker the moment a second exists', async () => {
  await addCompany(null, formDataFor({ legalName: 'Second Co Ltd', displayName: 'Second Co' }));
  const options = await companyPickerOptions();
  expect(options).toHaveLength(2);
});

it('refuses a new job under a retired company', async () => {
  const result = await createProject(null, formDataFor({ companyId: retiredId, /* ... */ }));
  expect(result.kind).toBe('refused');
});
```

- [ ] **Step 2: Run it to make sure it fails.**
- [ ] **Step 3: Build the settings screen and actions**, guarded by the same capability the other company settings screens use. `retireCompany` sets `isActive = false` and never deletes — the merge-back path.
- [ ] **Step 4: Build the picker**, returning `null` when `loadCompanies()` has one active row. Not hidden with CSS: *absent*. A hidden control is still in the DOM and still in the accessibility tree, and the requirement is that a single-company install has no such concept.
- [ ] **Step 5: Wire it into the two creation forms.** The company is written once, at creation, and never editable afterwards — a job never moves.
- [ ] **Step 6: Run the full suite, typecheck, build.**
- [ ] **Step 7: Commit.**

```bash
git add -A
git commit -m "feat: add a second company from settings, and pick one when creating a job"
```

---

## Self-review

**Spec coverage.** §4.1 naming → Global Constraints. §4.2 the split → Tasks 1, 7. §4.3 three columns → Task 2. §4.4 company on projects only → Task 2. §4.5 numbering → Task 4. §5 no wizard question, "Add a company", picker on second row → Task 8. §7 per-registrant tax → Task 3. §8 items 1–5 → Tasks 2, 3, 4, 5. §8 item 6 uuid → Task 1. §8 item 7 reminder rules → **not planned.** §8 items 8–10 (wall, backup disclosure, SharePoint) → out of scope, deferred by the spec itself.

**Gap 1 — §8 item 7, reminder rules are global.** The spec calls it minor and proposes a nullable `company_id`. Not planned, deliberately: today the only rule it would misfire on is a holdback-release rule that does not exist, because no action creates a `holdback_release` invoice (backlog §12). Recorded in the backlog rather than built against a feature with no caller.

**Gap 2 — RESOLVED before this plan was committed.** The draft left the sign-in screen's label open. Settled against the code: `displayName` stays on `organization`, 36 columns move. The deciding fact is that `src/app/auth/sign-in/page.tsx:40` renders before authentication, so it has no project, no session and no way to choose between two companies — a screen that cannot know which company it is must not be asking. See Global Constraints. Task 1's schema and Task 6's Step 1 both reflect this; the earlier "resolve at Task 1" instruction is gone because it is resolved.

**Placeholders:** none. Task 6's per-file classification is a step with a stated output, not a TODO.

**Type consistency:** `companyOf(tx, projectId): Promise<Company>` is used in Tasks 3, 5, 6 with that signature. `allocateDocumentNumber(tx, kind, companyId, year?)` is consistent across Task 4's six call sites. `loadTaxRatesFor(tx, companyId)` consistent across nine. `FIRST_COMPANY_ID` is a `string` everywhere.
