# Contractor Quote & Project Management System

**Design document**
Date: 2026-08-30
Status: Awaiting review
First deployment: Maple Custom Homes (maplecustomhomes.ca) — general contractor, GTA / Golden Horseshoe, Ontario

The product is white-label (section 2.1). Company identity, branding, tax rules, and document terms are configuration. Maple Custom Homes is the first tenant, not the subject of the code.

---

## 1. Problem

The business runs on manual process. Quotes are assembled ad hoc, so pricing is inconsistent between jobs and margin is invisible until the job is over. Receipts accumulate physically and are reconciled once a year under time pressure. There is no single view of what is owed to vendors or owed by customers, which makes cash-flow planning guesswork. Subcontractor scheduling lives in the owner's head and in text messages.

The system replaces this with one application covering the lifecycle from first customer contact through project completion and year-end accounting handoff.

## 2. Scope and phasing

The full requirement covers roughly seven subsystems. Building them at once produces a spec nobody can implement. They ship in five phases against one shared data model.

| Phase | Contents | Status |
|---|---|---|
| **1** | Rate cards, scope templates, quote engine, customers, projects, branded quote PDF | **This document** |
| 2 | CRM pipeline stages, recurring reminders, callbacks, email/call intake | Later spec |
| 3 | Receipt capture with OCR, vendor records, cost-to-project rollups, accountant export | Later spec — OCR stack already solved, see below |
| 4 | Purchase orders, vendor invoices, customer invoices, AP/AR dashboard, holdback tracking | Later spec |
| 5 | Subcontractor scheduling, planned vs actual dates, WSIB and COI expiry tracking | Later spec |

Phase 1 was chosen because the owner quotes daily. It delivers the fastest visible payback and proves the PDF pipeline end to end, which every later phase depends on.

**Explicitly out of scope, permanently:** general ledger, payroll, tax filing. Those stay in QuickBooks or Xero. This system feeds them. Building bookkeeping is a compliance liability and a maintenance trap.

**Out of scope for now:** subcontractor logins. Only owner, admin, and bookkeeper have accounts.

**Phase 3 note, recorded now because it changes an earlier decision:** Budget Tracker already ships working local receipt capture — `tesseract.js`, `onnxruntime-node`, `jscanify`, and `@techstark/opencv-js`, with vendored model assets and a runtime probe. That removes the Azure Document Intelligence dependency the architecture previously assumed for OCR. Phase 3 reuses that stack: free, local, offline, no per-page cost, no external service. Note the pinning discipline in that project's `package.json` — those four packages are pinned exact for reasons documented inline, and the same pins apply here.

### 2.1 White-label constraint

The system is a product configured for one company, not an application written about one company. **No company-specific value appears anywhere in code, templates, or seed logic.** Name, logo, address, contact details, tax registration, owner name, tax rate, holdback percentage, document prefixes, and terms text are all configuration, editable in the UI by the owner.

Maple Custom Homes is the first deployment, not the subject of the codebase. A build that hardcodes "Maple Custom Homes" or "13%" anywhere outside a seed file has a bug.

**Tenancy: one deployment per company.** Each company gets its own container stack, its own Postgres, its own SharePoint site, and its own domain. Multi-tenancy in a shared database was rejected — it introduces an entire class of cross-tenant data leak that cannot occur when the databases are separate, and deployment is already a twenty-minute Compose operation. The `organization` table nonetheless carries an `id` so a future multi-tenant variant is an addition rather than a rewrite.

A consequence worth stating: **the Ontario rules in section 6.3 become seeded defaults, not logic.** They ship as the default configuration because the first client is in Ontario. They are editable, and nothing in the calculation engine assumes them.

## 3. Architecture

### 3.1 Decision record

The initial recommendation was a Power Apps canvas app over SharePoint lists, using the seeded Microsoft 365 Business Standard license at zero marginal cost. That was rejected after the print requirement surfaced.

The reasoning: Power Apps on a free license cannot generate branded PDFs, cannot do receipt OCR, and cannot aggregate for AP/AR without a Power Automate summary-list workaround to dodge SharePoint delegation limits. Each of those was being solved by putting a worker process on the mini PC the client already owns. That design ends as two systems plus a sync protocol between them, where the auxiliary box does the hard work and Power Apps is a constrained UI over a constrained datastore.

One system is better. The client owns hardware. The application is built as a self-hosted TypeScript web app; SharePoint is demoted from datastore to backup target and accountant handoff, which is what it is genuinely good at.

**Accepted cost of this decision:** uptime and maintenance move from Microsoft to us. Power loss, ISP outage, disk failure, unattended reboots, and dependency CVEs become our responsibility, and the client cannot resolve any of them. Mitigations are containerization (section 3.4) and backup (section 8), but the bus-factor risk is real and is accepted knowingly.

### 3.2 Stack

Versions and library choices track the existing **Budget Tracker** project (`Documents/Budget Tracker`) — same maintainer, same deployment shape, same self-hosted Docker target. Its conventions are adopted rather than re-derived: `src/` layout with `(app)` and `(auth)` route groups, `src/db/{client,schema,seed}.ts`, `src/lib/<domain>/`, hand-rolled `src/components/ui/` primitives, `tests/{unit,integration,db,api,app,components,lib,ops,scripts}`, a maintained `CHANGELOG.md` and `INSTALL.md`, and GitHub Actions for tests and image releases.

| Layer | Choice | Reason |
|---|---|---|
| Application | Next.js 16 (App Router), React 19, TypeScript 6 | One deployable serving UI and API. PWA gives add-to-home-screen, camera access, offline shell |
| UI | Tailwind 4 + hand-rolled primitives | Matches Budget Tracker; CSS-first theming, print-friendly |
| Database | PostgreSQL 16 | Real transactions and aggregates. No delegation limits, no row thresholds |
| ORM | Drizzle 0.45 | Typed schema, explicit SQL, lightweight migrations |
| Validation | zod | Shared between API boundary and forms |
| Scheduling | node-cron | Sync and backup jobs, in-process |
| Icons / charts | lucide-react, recharts | |
| Tests | Vitest 3 + Testing Library | |
| PDF | Playwright (headless Chromium) | `page.pdf()` is Chrome's print engine. Full CSS control. Same dependency serves E2E tests |
| Auth | Cloudflare Access JWT + Entra ID | Single Microsoft sign-in, no passwords stored |
| Ingress | Cloudflare Tunnel | Outbound-only. No open ports, no VPN client on user devices |
| Deployment | Docker Compose | Portable. Mini PC today, VPS in twenty minutes if needed |
| Host OS | Ubuntu Server LTS | Chromium dependencies are one apt install; systemd restart semantics are reliable |

### 3.3 Access and authentication

Cloudflare Tunnel exposes the app at a subdomain of `maplecustomhomes.ca`. Cloudflare Access sits in front with Entra ID as the identity provider, so users get one Microsoft login with their existing M365 accounts.

The app validates the `Cf-Access-Jwt-Assertion` header in Next.js middleware against Cloudflare's public keys, extracts the verified email, and looks up the role in the `users` table. There is no second login and no separate password store.

**Security requirements, non-negotiable:**

- The app and database containers must not publish ports to the host. All traffic arrives through the tunnel. If the app is reachable directly, the Access JWT can be spoofed by setting the header, and authentication is bypassed entirely.
- The JWT signature, audience, and expiry must all be verified. Reading the email from an unvalidated header is not authentication.
- Postgres is reachable only on the internal Docker network.

Roles: `owner` (full access including rate cards), `admin` (quotes and projects, no rate edit), `bookkeeper` (read quotes, full access to phase 3 expense features). Enforced server-side in route handlers, not by hiding UI.

### 3.4 Hosting portability

Everything runs from one `docker-compose.yml`: app, postgres, cloudflared. The mini PC is the initial target at zero marginal cost. If uptime proves inadequate, the identical compose file runs on a 4-6 EUR/month VPS with a database restore and a DNS change. The hosting decision is therefore reversible and is deliberately deferred.

## 4. Data model

PostgreSQL. All primary keys are UUIDs.

**Money is integer cents**, following Budget Tracker's `src/lib/money.ts` (`formatCents`, `sumCents`, `parseAmountToCents`) and its `Money` component, so both codebases share one representation and one formatter. JavaScript numbers are never used to hold a monetary value mid-calculation.

Rates and quantities are not cents, and this is where the quote engine differs: a rate is `numeric(12,4)` (a sell rate of `4.0000` per square foot) and a quantity is `numeric(12,3)` (`1240.500` square feet). Their product must be exact before it becomes a cent value. The calculation engine therefore holds rates and quantities as scaled integers, multiplies in a wider integer domain, and rounds **once** at the line boundary, half-up, to cents. Tax is computed on the summed taxable base and rounded once, not per line — rounding each line separately drifts by a cent or two across a forty-line quote, and the customer's arithmetic will not match the document.

Every synced table carries these columns, and the sync in section 7 depends on all of them:

- `created_at timestamptz`
- `updated_at timestamptz` — maintained by trigger, drives the sync watermark
- `created_by uuid`
- `record_status ENUM('active','void') DEFAULT 'active'`
- `voided_at timestamptz`, `voided_by uuid`, `void_reason text`

**Nothing is ever deleted. There is no DELETE statement in the application.**

Two reasons, and both are load-bearing:

1. A watermark-based sync (`WHERE updated_at > watermark`) physically cannot observe a row that no longer exists. A hard delete would orphan its SharePoint mirror permanently, leaving a phantom record that outlives the real one.
2. These are financial and tax records. A voided quote that leaves no trace is an audit gap. A voided one with a stated reason is a record.

Voiding sets `record_status = 'void'` with `voided_at`, `voided_by`, and a required `void_reason`. The change syncs like any other field update; the SharePoint row is updated in place, never removed. The UI filters to `record_status = 'active'` by default, with a toggle to show voided records.

`record_status` is named distinctly so it never collides with the business `status` column on `quotes`, which tracks draft/sent/accepted and is a different concept entirely.

Database-level enforcement: the application role is granted `SELECT`, `INSERT`, and `UPDATE` on all tables and is not granted `DELETE`. An accidental delete fails as a permission error rather than destroying a record.

```
users
  id, entra_object_id (unique), email (unique), display_name,
  role ENUM('owner','admin','bookkeeper'), is_active

customers
  id, name, company_name, email, phone,
  address_line1, address_line2, city, province DEFAULT 'ON', postal_code,
  customer_type ENUM('residential','commercial'),
  lead_source ENUM('call','email','referral','website','repeat','other'),
  is_tax_exempt bool DEFAULT false, tax_exempt_number, tax_exempt_reason,
  notes

projects
  id, customer_id FK, project_number (unique, MCH-2026-0001), name,
  site_address_line1, site_city, site_postal_code,
  project_type ENUM('custom_home','basement','renovation','kitchen',
                    'bathroom','addition','commercial_ti','water_leak','other'),
  stage ENUM('lead','site_visit','quoting','quote_sent','won','lost',
             'in_progress','complete','on_hold'),
  scheduled_start, scheduled_end, actual_start, actual_end,   -- DATE
  contract_value numeric(12,2), lost_reason

rate_cards
  id, name, effective_from DATE, is_active

rate_items
  id, rate_card_id FK, code, description, category,
  unit_type ENUM('sqft','each','flat','percent','hour'),
  cost_rate numeric(12,4),      -- what it costs him
  sell_rate numeric(12,4),      -- what the customer pays
  is_taxable bool DEFAULT true, -- false for pass-through disbursements
  default_qty numeric(12,3), sort_order, is_active
  UNIQUE(rate_card_id, code)

scope_templates
  id, name, project_type, description, is_active

scope_template_items
  id, scope_template_id FK, rate_item_id FK,
  qty_source ENUM('area','washrooms','kitchens','bedrooms','fixed','manual'),
  qty_multiplier numeric(10,4) DEFAULT 1,
  is_optional bool, line_group, sort_order

quote_taxes   -- snapshotted tax breakdown per quote
  id, quote_id FK, label, registration_number,
  rate numeric(6,5), taxable_base numeric(12,2),
  tax_amount numeric(12,2), sort_order

quotes
  id, project_id FK, quote_number, version int,
  status ENUM('draft','sent','accepted','declined','expired','superseded'),
  quote_date, valid_until,
  area_sqft numeric, washroom_count int, kitchen_count int, bedroom_count int,
  subtotal numeric(12,2), tax_total numeric(12,2),
  total numeric(12,2), total_cost numeric(12,2), margin_pct numeric(5,2),
  terms, notes, internal_notes,
  sent_at, accepted_at, declined_at, pdf_path
  UNIQUE(project_id, version)

quote_lines
  id, quote_id FK, sort_order, line_group,
  code, description, unit_type,             -- snapshotted from rate_item
  qty numeric(12,3),
  unit_cost numeric(12,4), unit_price numeric(12,4),   -- snapshotted
  line_cost numeric(12,2), line_total numeric(12,2),
  is_taxable bool,                          -- snapshotted from rate_item
  is_optional bool, is_included bool, notes

organization   -- single row per deployment; all branding and locale
  id,
  -- identity
  legal_name, display_name, operating_name, tagline,
  owner_name, owner_title,
  logo_file_id FK files, favicon_file_id FK files, brand_color,
  -- contact
  address_line1, address_line2, city, province, postal_code, country,
  phone, alt_phone, email, website,
  -- financial and legal
  tax_registration_number, tax_registration_label,   -- 'HST Number'
  business_number, currency DEFAULT 'CAD', locale DEFAULT 'en-CA',
  fiscal_year_end_month int, fiscal_year_end_day int,   -- not assumed Dec 31
  tax_filing_frequency ENUM('annual','quarterly','monthly'),
  holdback_pct numeric(5,4), holdback_label, holdback_terms_text,
  payment_terms_days int, payment_terms_text,
  insurance_statement,        -- 'Fully insured and bonded'
  -- documents
  quote_number_prefix, next_quote_seq,
  invoice_number_prefix, next_invoice_seq,
  po_number_prefix, next_po_seq,
  quote_validity_days int, quote_terms_text, document_footer_text
  CHECK (id = 1)              -- exactly one row

feature_flags   -- named toggles, one row per feature
  key (unique), enabled bool, config jsonb, updated_at, updated_by
  -- 'sharepoint_sync', 'receipt_ocr', 'usb_backup'

tax_rates          -- versioned by effective date, never edited in place
  id, label, short_label, registration_number,
  rate numeric(6,5),
  effective_from DATE, effective_to DATE,   -- NULL = currently in force
  is_compound bool DEFAULT false,           -- applies on subtotal + prior taxes
  sort_order, is_active
  -- Ontario seeds one row: 'HST', 0.13, effective_from 2010-07-01

files        -- polymorphic attachment table, one row per stored file
  id, entity_type ENUM('quote','project','customer','receipt',
                       'vendor_invoice','purchase_order'),
  entity_id uuid,                -- the record this file belongs to
  file_name, mime_type, size_bytes bigint,
  storage_path text,             -- local disk, authoritative
  sp_drive_item_id text,         -- Graph driveItem id once mirrored
  sp_web_url text,               -- browser link for the accountant
  sp_synced_at timestamptz,
  uploaded_by, uploaded_at
  INDEX (entity_type, entity_id)

audit_log
  id, table_name, record_id, action, changed_by, changed_at, diff jsonb

sync_state   -- not mirrored to SharePoint; local bookkeeping only
  id, list_name (unique), watermark timestamptz,
  last_run_at, last_success_at, rows_synced int,
  last_error text, consecutive_failures int
```

### 4.1 Rate snapshotting

`quote_lines` stores `unit_cost` and `unit_price` as copies taken at line creation, not as references to `rate_items`. This is the single most important constraint in the schema. If lines read live rates, raising a rate silently rewrites the value of every historical quote, including ones already sent to and accepted by customers. Quote lines are immutable financial records.

### 4.2 Cost and price on every item

Every rate item carries both. The quote builder displays live margin as the owner adjusts quantities, so he can see when a quote is drifting toward a loss before he sends it. Cost figures never appear on customer-facing documents.

### 4.3 Name parity with SharePoint

Every Postgres table has a SharePoint list of the same name, and every column has a field of the same internal name. One Postgres table maps to exactly one SharePoint list; there is no reshaping in the sync layer.

Parity is enforced by generation, not by discipline. The Drizzle schema is the single source of truth, and the SharePoint provisioning template is generated from it (section 7.4). The two cannot drift because nobody writes the SharePoint side by hand.

Four SharePoint constraints force deliberate mapping rules:

1. **Reserved internal names.** SharePoint reserves `ID`, `Title`, `Created`, `Modified`, `Author`, `Editor`, `GUID`, `Order`, `Version`, `Attachments`, and `ContentType`. Postgres `id` therefore maps to internal name `pg_id`, and `created_at` / `updated_at` map to `pg_created_at` / `pg_updated_at` so they never collide with SharePoint's own audit columns. The generator refuses to emit a reserved name and fails the build.
2. **Internal names must be set explicitly.** Fields created through the SharePoint UI mangle names — a space becomes `_x0020_`. Provisioning sets `InternalName` directly, so `quote_number` stays `quote_number`.
3. **No lookup columns.** Foreign keys are stored as text holding the UUID, exactly as they are in Postgres. SharePoint lookups reference the target's integer `ID`, which is assigned by SharePoint and does not survive a list rebuild or a re-provision. A denormalized display column is added alongside for human readability only; the sync never reads it back.
4. **`Title` is effectively mandatory** on a SharePoint list. Each list sets `Title` to its most useful human identifier — `quote_number` for quotes, `name` for customers, `project_number` for projects — populated by the sync as a convenience for browsing. It is never authoritative.

Type mapping:

| Postgres | SharePoint field | Note |
|---|---|---|
| `uuid` | Text (36) | Indexed where used as a join key |
| `text` short | Text (255) | |
| `text` long | Note (multi-line, plain) | |
| `numeric(12,2)` | Number, 2 decimals | |
| `numeric(5,4)` | Number, 4 decimals | |
| `date` | DateTime, date only | |
| `timestamptz` | DateTime, date and time | Stored UTC, list displays Toronto time |
| `boolean` | Yes/No | |
| `enum` | Choice | Generator emits the exact enum members |
| `jsonb` | Note (multi-line, plain) | Audit log only |

## 5. Quote engine

### 5.1 Line types

| Type | Calculation | Example |
|---|---|---|
| `sqft` | area x rate | Basement finishing at 55/sqft |
| `each` | count x rate | Washroom at 12,000 each |
| `flat` | lump sum | Permit at 3,500 |
| `percent` | percentage of the included non-percent subtotal | Overhead 10%, profit 15%, contingency 5% |
| `hour` | hours x rate | Water leak investigation, time and material |

Percent lines are evaluated after all other included lines, against their sum. This makes overhead and profit visible as line items rather than hidden in unit rates, which is what allows margin to be tracked honestly.

### 5.2 Scope templates

Templates are the standardization requirement. The owner picks "Basement Finish — Standard", enters square footage and washroom count, and the full line set generates. He then adjusts individual lines.

Quantities derive through a small enum rather than a formula parser:

```
qty = qty_source_value x qty_multiplier
```

Where `qty_source` is one of `area`, `washrooms`, `kitchens`, `bedrooms`, `fixed`, or `manual`. Drywall is `area x 1.0`. Pot lights are `area x 0.02`, one per fifty square feet. Washroom rough-in is `washrooms x 1`.

An expression evaluator was considered and rejected. A user-editable formula language in a database column is an injection surface and an unbounded support burden. The enum covers every case described and is trivially extended.

### 5.3 Margin, not markup

A 20% markup is a 16.7% margin. Contractors lose money on this confusion routinely. The system stores and reports margin, and displays the equivalent markup alongside it for reference. Target margin is configurable per rate card.

### 5.4 Versioning

Customers negotiate. Each revision creates a new `quotes` row with an incremented `version`, and the prior version moves to `superseded`. Lines are copied, not shared. The owner can always see exactly what he sent and when.

### 5.5 Optional lines

Lines carry `is_optional` and `is_included`. Optional lines print in a separate "Available upgrades" block with individual pricing and are excluded from the quoted total. This supports upsells without a second quote.

## 6. Documents

### 6.1 Pipeline

A print route renders the document as a normal authenticated page. Playwright navigates headless Chromium to that route on localhost and calls `page.pdf()`. The result is written to disk and the path recorded on the quote. Generation is synchronous and takes roughly two seconds; there is no queue, no polling, and no worker process.

### 6.2 Templates

Documents are React components using Tailwind print CSS. They use `@page` for margins, `break-inside: avoid` so a line item never splits across a page boundary, repeating table headers on multi-page quotes, and Chromium's `displayHeaderFooter` for page numbering.

Quote template content, taken from the live site branding: logo, "General Contracting Done Right", contact details, HST registration number, service area, and the fully insured and bonded footer.

### 6.3 Regional rules — configured, not coded

The capability is built in from Phase 1 because retrofitting it is expensive. The *values* are seeded configuration, because of the white-label constraint in section 2.1.

| Requirement | Mechanism | Ontario seed |
|---|---|---|
| Sales tax | `tax_rates` rows, snapshotted per quote into `quote_taxes` | One row: HST, 13% |
| Tax registration on documents | `organization.tax_registration_number` and `..._label` | Label "HST Number" |
| Statutory holdback | `organization.holdback_pct`, `holdback_label`, `holdback_terms_text` | Construction Act, 10% |
| Payment timeline | `organization.payment_terms_days`, `payment_terms_text` | Prompt Payment, 28 days |
| Insurance statement | `organization.insurance_statement` | "Fully insured and bonded" |

Why `tax_rates` is a table rather than one rate column: Ontario has a single HST line, but British Columbia charges GST plus PST, Alberta charges GST only, and a US deployment may charge state sales tax or none at all on construction labour. A single `hst_rate` column would have to be migrated away from the first time this is deployed outside Ontario. A table with one seeded row costs almost nothing now.

Tax is snapshotted onto each quote as `quote_taxes` rows, following the same rule as line rates in section 4.1. Changing the tax rate must never retroactively alter a quote already sent to a customer.

Phase-4 and Phase-5 items that follow the same pattern: holdback becomes a tracked AR bucket, where failing to separate it overstates available cash by the holdback percentage of every active job. Subcontractor compliance documents — WSIB clearance in Ontario, equivalents elsewhere — become a generic expiring-document type with configurable labels rather than a WSIB-specific field.

Commercial tenant improvement work, which the first client advertises, does not price by square foot. Phase 1 supports it through flat and hourly line types assembled by trade. A dedicated commercial bid mode is deferred until the owner confirms he wants one.

## 7. SharePoint mirror and sync

The client's records are tax records. SharePoint is not a dump target — it holds a structured, queryable replica of the database with matching tables and column names.

### 7.1 What the mirror is for

- **Readable fallback.** If the mini PC dies on a Friday, the owner still opens SharePoint and sees his quotes, customers, and projects in a familiar UI. Not a database file he cannot open.
- **Recovery source.** The mirror is complete enough to rebuild the entire system onto new hardware. See section 8.4.
- **Accountant handoff.** Year-end becomes a shared folder and a list view, not an export request.
- **Reporting.** Power BI Desktop and Excel both connect to SharePoint lists natively, at no additional license cost.
- **Exit path.** Structured data in his own tenant, in his own format. No lock-in to a self-hosted app that one person maintains.

Because the mirror is a recovery source and not merely a convenience, **every column of every table is mirrored.** Partial mirroring would make a rebuild lossy in ways nobody would discover until the day it mattered.

### 7.2 Direction and authority

**One way, Postgres to SharePoint. Always.**

Bidirectional sync is a distributed-systems problem requiring conflict resolution, and there is no requirement here that justifies it. Postgres is authoritative for every field.

This has a hard consequence that must be enforced, not merely documented: **SharePoint lists are read-only to humans.** The provisioning script breaks role inheritance on each synced list and grants Read to the owner, admin, and bookkeeper; only the sync application identity gets Contribute. Without this, someone edits a total in SharePoint, the next sync silently overwrites it, and trust in the system is gone.

Document libraries are the exception — PDFs, receipts, and exports are written once and are not synced back.

### 7.3 Sync job

Runs inside the app container on a schedule, default **every 1 hour**, configurable, plus an on-demand trigger in the admin UI.

The interval is the recovery point objective. Since the mirror is a recovery source (section 8.4), a four-hour interval means losing up to four hours of quoting work when hardware fails. Hourly costs almost nothing — a working day changes tens of rows, far below any throttling concern — so hourly is the default.

Per table:

1. Read the watermark from `sync_state` for that list.
2. `SELECT * FROM <table> WHERE updated_at > watermark ORDER BY updated_at`.
3. Upsert into SharePoint matched on `pg_id`, using the Graph `$batch` endpoint at 20 requests per batch.
4. Rows with `record_status = 'void'` are written with the status, reason, and timestamp set. Nothing is ever removed from SharePoint, matching the no-delete rule in section 4.
5. Advance the watermark to the highest `updated_at` in the committed batch, in the same transaction as the batch result.

Correctness requirements:

- **Honor throttling.** Graph returns HTTP 429 with `Retry-After`. SharePoint write throttling is aggressive and real. Ignoring it gets the app throttled harder, then blocked. Exponential backoff with jitter, capped.
- **Advance the watermark only on confirmed success.** A partial batch must not move it past the failed rows. Re-syncing a row is harmless because the operation is an idempotent upsert; skipping one loses data silently.
- **Log every failure to `sync_state` with the error**, and surface a banner in the admin UI when the last successful sync is older than twice the interval. A sync that has been failing for a month is worse than no sync, because it looks like a backup.

### 7.4 Provisioning script — generated, not hand-written

No manual list or column creation. The chain is:

```
Drizzle schema  ->  npm run generate:sharepoint  ->  PnP template XML
                                                 ->  Provision-MapleQuote.ps1
```

A code generator reads the Drizzle table definitions and emits a PnP provisioning template plus a PowerShell wrapper. Running the wrapper creates or updates every list, field, view, and index, and applies the permission model from section 7.2.

The template is **idempotent** — `Invoke-PnPSiteTemplate` is safe to re-run, so a schema change is: edit Drizzle, regenerate, re-run. Adding a column never means clicking through SharePoint.

The generator also emits indexes on `pg_id` and on every foreign key column. Without them, a list past 5,000 items throws the list view threshold error on ordinary queries.

**Lists created:** one per Postgres table — `users`, `customers`, `projects`, `rate_cards`, `rate_items`, `scope_templates`, `scope_template_items`, `quotes`, `quote_lines`, `organization`, `feature_flags`, `tax_rates`, `quote_taxes`, `audit_log`.

**Document libraries created:**

| Library | Contents |
|---|---|
| `QuoteDocuments` | Generated quote PDFs, foldered by project number |
| `ProjectFiles` | Plans, permits, site photos, signed contracts |
| `Receipts` | Receipt images (Phase 3) |
| `VendorInvoices` | Vendor invoices and purchase orders (Phase 4) |
| `Backups` | Encrypted `pg_dump` archives |
| `Exports` | Accountant-ready `.xlsx` files |

### 7.5 Attachments — libraries, never list attachments

SharePoint lists support per-item attachments. This design does not use them. The decision is forced by a hard technical constraint and confirmed by the storage model.

**Microsoft Graph cannot read or write SharePoint list item attachments.** There is no `attachments` relationship on `listItem` in Graph v1.0. Libraries are fully supported through `driveItem`; list attachments are simply absent from the API.

Using them would require:

- A second API surface — SharePoint REST (`_api/web/lists/.../AttachmentFiles/add`) alongside Graph
- A second token audience — `https://<tenant>.sharepoint.com/.default` rather than Graph
- **Certificate authentication.** Azure AD app-only against SharePoint REST does not accept a client secret; a certificate is mandatory. That means generating, mounting, and rotating a certificate on the mini PC, purely to reach a worse storage model.

The storage model is worse regardless of the API:

| | List attachment | Document library |
|---|---|---|
| Graph support | None | Full |
| Metadata columns | None | Yes — project, vendor, amount, date |
| Versioning | No | Yes |
| Folder structure | No | Yes |
| Accountant workflow | Open each item individually | Filter and bulk download |
| One file referenced by many records | Impossible | Link by id |

**Design:** the polymorphic `files` table routes each file to a library by `entity_type`. Local disk is authoritative and is what the application serves — no Graph round-trip to display a receipt. SharePoint holds the mirror, with `pg_id`, `entity_type`, `entity_id`, and human-readable metadata as library columns so the accountant can filter by project.

Two implementation constraints:

- **Graph simple upload caps at 4MB.** Phone receipt photos routinely exceed this, so a chunked upload session is required, not optional.
- File metadata is set with a second call — `PATCH /sites/{id}/lists/{listId}/items/{itemId}/fields` — after the upload completes. Upload and metadata are not atomic; a file with unset metadata must be retried on the next sync rather than treated as done.

### 7.6 Authentication

Two identities, two purposes. Neither requires touching the Azure portal.

**Provisioning — interactive.** Run manually against the client's tenant using his credentials, from a workstation, not the server. `Connect-PnPOnline -Interactive`. Needs site collection administrator rights. Run once, and again after any schema change.

**Sync job — app-only.** This cannot be interactive. The sync runs unattended in a container every hour, indefinitely; there is no human present to complete a login, and delegated refresh tokens expire and are invalidated by a password change or an MFA policy change. A background daemon requires app-only credentials. There is no alternative that is not fragile.

The manual work is removed rather than the registration: `Provision-MapleQuote.ps1` bootstraps the app registration itself through PnP, requests Graph `Sites.Selected`, applies the site-scoped `write` grant, and prints the resulting client id and secret for the operator to store. One script run against his tenant, no portal navigation, no manual consent screens beyond the administrator approval prompt PnP raises.

`Sites.Selected` is chosen over `Sites.ReadWrite.All` deliberately: a leaked secret reaches exactly one site, not the whole tenant.

The client secret lives in a Docker secret, never in the image and never in git, and is rotated annually. Certificate authentication remains available as a hardening step but is not required, because this design never calls SharePoint REST.

> The exact PnP cmdlet names for app registration differ across PnP.PowerShell major versions. They are verified against the installed module at implementation time rather than assumed.

## 8. Backup and recovery

### 8.1 Three copies, two media, one offsite

| Copy | Medium | Location | Survives |
|---|---|---|---|
| Live Postgres | Internal SSD | Mini PC | Nothing; it is the thing being protected |
| Hourly dump | Internal SSD | Mini PC | Bad data, dropped table, botched migration |
| Hourly dump | **USB HDD** | Mini PC, external | Internal disk failure, filesystem corruption |
| Hourly list sync | SharePoint | Microsoft | Fire, theft, flood, the whole site going away |
| Nightly dump | SharePoint | Microsoft | Same, byte-exact |

Both SharePoint rows are conditional on `feature_flags.sharepoint_sync` (section 7.0). With it off, the last two rows disappear and the USB drive is the only copy that survives loss of the internal disk — which is why the interlock in section 7.0 refuses to let both be off quietly.

One artifact, three destinations. The same encrypted `pg_dump` file is written to the internal volume, copied to the USB drive, and uploaded to the `Backups` library. Not three separate backup implementations.

### 8.2 Local and USB backup

**Hourly, not nightly.** A `pg_dump` of this database is a few megabytes and stays that way for years. Writing it hourly to the USB drive costs nothing and takes the USB recovery point from 24 hours down to 1, matching the SharePoint mirror. There is no reason to accept a worse recovery point to save a few megabytes.

Retention on the USB drive is grandfather-father-son:

| Kept | Retention |
|---|---|
| Hourly dumps | 48 hours |
| Nightly snapshot (last dump of the day) | 30 days |
| Monthly snapshot (last dump of the month) | 12 months |

**Receipts, quote PDFs, and uploaded files are backed up too**, not just the database. A restored database whose `files` rows point at missing images is only half a recovery.

Five requirements, each of which is a way this silently fails in practice:

1. **Verify the mount before writing.** If the USB drive unmounts or spins down, writing to `/mnt/backup` succeeds against the internal disk at that same path, and there is no backup at all while everything looks healthy. The script checks `mountpoint -q` and confirms a sentinel file on the volume, and aborts loudly if either fails.
2. **ext4, not NTFS or exFAT.** Permissions and reliability under Linux.
3. **Encrypt the dump, not the disk.** Dump files are encrypted with `age` to a public key; the private key lives in the password manager alongside the other secrets. This is the same artifact and the same key as the SharePoint copy — one mechanism. Full-disk LUKS was considered and rejected: unattended boot needs a keyfile on the internal disk, so stealing the whole machine defeats it, and the realistic threat is the external drive alone walking out of an office.
4. **Prune on a schedule.** A full disk stops backups silently. Retention is enforced every run, not hoped for.
5. **Verify the artifact.** Every run checks the dump parses with `pg_restore --list`. Weekly, a scheduled job actually restores it into a scratch database and counts rows. A dump that has never been read is a file, not a backup.

### 8.3 Restore paths, in order

Pick by failure mode, not by habit:

| Failure | Use | Recovery point |
|---|---|---|
| Bad data, dropped table, bad migration — hardware fine | Hourly dump, internal volume | 1 hour |
| Internal disk failed, machine and USB intact | Hourly dump, USB drive | 1 hour |
| Machine dead, USB intact | USB drive on new hardware | 1 hour |
| Machine and USB both gone — fire, theft, flood | Nightly dump from SharePoint | 24 hours |
| Dumps missing, corrupt, or stale | **Rebuild from SharePoint lists** | 1 hour |

The last two rows require SharePoint sync to be enabled. A deployment with it off has no disaster path beyond the USB drive, and the operator needs to know that before the disaster, not during it.

The USB drive is the working restore path and handles almost every realistic failure. SharePoint is the disaster path. Note the last row: if the dumps themselves are bad, the list rebuild still has a 1-hour recovery point and is the better option than an old dump.

### 8.4 Rebuilding from SharePoint
The last resort, and the only path that survives loss of the site itself. This is a Phase 1 deliverable.

`npm run restore:sharepoint` performs the rebuild:

1. Authenticate app-only, same credentials as the sync.
2. Read every list, paging through Graph.
3. Insert in foreign-key dependency order: `users`, `organization`, `feature_flags`, `tax_rates`, `customers`, `projects`, `rate_cards`, `rate_items`, `scope_templates`, `scope_template_items`, `quotes`, `quote_lines`, `quote_taxes`, `files`, `audit_log`.
4. Download every library file to local disk and reconcile `files.storage_path` against `sp_drive_item_id`.
5. Rebuild `sync_state` watermarks from the maximum `pg_updated_at` per table, so the first sync after recovery does not resend the entire database.
6. Verify: compare row counts per table against the source lists, and report any mismatch as a failure rather than a warning.

Restoring UUIDs rather than generating new ones is what makes this work — every foreign key is a UUID stored as text on both sides, so relationships survive the round trip intact. This is the payoff for the no-lookup-columns rule in section 4.3.

**What SharePoint does not hold, and what must therefore be stored elsewhere:** the Cloudflare Tunnel token, the Postgres password, the Graph client secret, and the Cloudflare Access configuration. None of these belong in the client's SharePoint. They go in a password manager, and the recovery runbook names them explicitly. A perfect data restore is useless if nobody can bring the tunnel back up.


### 8.5 Monitoring

Silent backup failure is the normal way backups fail. Every mechanism reports staleness:

- Last USB backup older than 2 hours, last SharePoint sync older than 2 hours, or last nightly upload older than 26 hours raises a banner in the admin UI and sends an email.
- `sync_state` records `consecutive_failures`; three in a row escalates.
- The weekly restore verification writes its result where a failure is visible, not only to a log file nobody opens.

**A backup that has never been restored is not a backup.** A scripted restore drill against a clean container is part of the Phase 1 definition of done, not a follow-up task.

### 8.6 First-run setup

White-labelling is only real if standing up a new company does not require SQL. A fresh deployment with an empty database redirects to a setup wizard, completable by the owner:

1. **Organization** — legal and display name, operating name, tagline, owner name, address, phone, email, website.
2. **Branding** — logo and favicon upload, brand colour. Logo is stored through the `files` table and inlined as a data URI when rendering PDFs, so document generation never depends on an authenticated fetch.
3. **Financial** — currency, locale, tax registration number and its label, one or more tax rates with their effective dates, holdback percentage and terms, payment terms.
4. **Documents** — number prefixes and starting sequences, quote validity days, terms and footer text.
5. **Features** — SharePoint sync on or off; if on, collect Graph credentials and validate them before completing. USB backup path, validated as mounted.
6. **First user** — the signed-in identity becomes `owner`.
7. **Rate card** — start from a seeded placeholder card or an empty one.

The wizard writes the `organization` row, `tax_rates`, `feature_flags`, and the first `users` row. It runs once; afterwards every field remains editable under Settings, owner role only.

## 9. Accountant export

Year-end is the pain the owner named first. The export is a first-class feature, not a report.

**Scope honesty:** most of a tax filing is Phase 3-4 data. Phase 1 holds customers, projects, and quotes — no revenue, no expenses. The framework is built in Phase 1 and each later phase adds its sheets, so the accountant story grows rather than arriving late.

### 9.1 Periods

Driven by `organization.fiscal_year_end_month` / `_day` and `tax_filing_frequency`. A December 31 year end and quarterly HST is the seeded default, not an assumption in code — many corporations have off-calendar year ends, and the export must respect the one it is given.

### 9.2 Sheets, by the phase that fills them

| Phase | Sheets |
|---|---|
| 1 | Cover and manifest, Customers, Projects, Quotes with tax breakdown, Pipeline summary |
| 3 | Expenses by category, HST paid (input tax credits), Vendors |
| 4 | Sales invoices with HST collected, AR aging, AP aging, Holdback receivable and payable, Customer deposits (unearned revenue), WIP schedule, T5018 subcontractor payments |

Two of these are statutory and are the reason the vendor and invoice schemas must anticipate them rather than be retrofitted:

- **T5018, Statement of Contract Payments.** CRA requires construction contractors to file a slip annually for every subcontractor paid more than $500 in the reporting period, carrying legal name, address, and business number or SIN. `vendors` therefore needs `business_number` and `is_subcontractor` from the moment it exists. Reconstructing this from invoice history at the first year end is exactly the manual scramble this system is meant to remove.
- **Work in progress.** Jobs open at year end drive percentage-of-completion revenue recognition. The accountant will ask for it, and it needs contract value, costs to date, and billings to date per open project.

### 9.3 Output rules

- One `.xlsx` workbook per period, one sheet per subject, plus a CSV per sheet — accountants frequently prefer CSV.
- `exceljs` for generation. SheetJS's free build left npm following CVEs and is not used.
- Every row carries its source record id so any figure traces back to a record in the app.
- Amounts are written as real numbers with two decimals, never as strings. Accountants sort and sum these columns.
- The cover sheet states company, tax registration number, period covered, generation timestamp, and **what is not included** — so nobody mistakes a Phase 1 export for a complete set of books.
- Written to the SharePoint `Exports` library monthly, and on demand from Settings.

The permanent boundary from section 2 still holds: this system feeds an accountant and feeds QuickBooks or Xero. It is not a general ledger.

## 10. Interface

The visual system, responsive strategy, screen inventory, worksheet design, and document design live in a companion document: `2026-08-30-ui-design.md`.

Two decisions from it that affect this spec:

- **Full responsive parity**, including the quote worksheet on a phone. Accepted with its cost — roughly a third more interface work in Phase 1 — because the owner needs to build a quote in the field.
- **Present mode**, a view toggle that hides cost, margin, internal notes, and rate codes. He shows quotes to customers on his own screen; without it, turning the laptop around exposes his margin. A view state only, no data or permission implications.

## 11. Testing

- **Unit** — quote calculation engine. Line type math, percent-line ordering, margin against markup, tax rounding, template quantity derivation. This is where money bugs live, so coverage here is high.
- **Tax** — its own suite, because it is the most jurisdiction-sensitive logic in the system. Single-rate (Ontario HST), dual-rate (BC GST + PST), compound ordering, non-taxable lines, exempt customers, and a rate change mid-stream where a quote dated before the change gets the old rate and one dated after gets the new one.
- **Integration** — Drizzle queries against a real Postgres in a test container. Rate snapshot immutability is explicitly asserted: change a rate item, confirm existing quote lines do not move.
- **Schema parity** — a test asserts that every Drizzle table and column has a matching entry in the generated SharePoint template, with no reserved-name collisions. This fails the build on drift rather than discovering it during a sync at 2am.
- **Sync** — against a real SharePoint dev site. Covers upsert idempotency (running the same batch twice produces no duplicates), void propagation, watermark non-advancement on partial failure, chunked upload of a file over 4MB, and 429 backoff behaviour.
- **Round trip** — the decisive test. Seed a database, sync it, drop it entirely, restore from SharePoint, and assert the result is equivalent row for row and file for file. This is the test that proves the recovery story is real rather than aspirational.
- **E2E (Playwright)** — build a quote from a template, adjust lines, generate the PDF, assert it renders with the correct total.
- **White-label** — a test greps the built application, seed-file directory excluded, for the first client's name, domain, phone number, and the literal `0.13`. Any hit fails the build. This is the only reliable way to keep hardcoded values out over time.
- **Feature flag** — the full suite runs a second time with `sharepoint_sync` disabled and no Graph credentials configured, asserting the app boots, quoting works end to end, and nothing reaches for Graph.
- **Backup** — mount-detection is tested by unmounting the target and asserting the job aborts loudly rather than writing to the underlying path. Retention pruning, dump verification, and `age` round-trip encryption are each covered.
- **Restore drill** — scripted, run against a clean container, verified in CI. Covers both the dump path and the SharePoint rebuild path.

## 12. Definition of done, Phase 1

1. Owner signs in with his Microsoft account through Cloudflare Access and reaches the app on both phone and desktop.
2. He creates a customer and a project.
3. He selects a scope template, enters square footage and room counts, and a complete quote generates.
4. He adjusts lines, marks some optional, and watches margin update live.
5. He generates a branded PDF with correct HST and holdback terms.
6. He revises the quote; version 1 is preserved unchanged.
7. Rate card edits do not alter any existing quote.
8. A nightly backup lands in SharePoint and a restore has been performed successfully from it.
9. The bookkeeper signs in and can read quotes but cannot edit rates, verified server-side.
10. `Provision-MapleQuote.ps1` runs against an empty SharePoint site and creates every list, column, view, index, and library with no manual steps. Running it a second time changes nothing.
11. The sync job runs, and the quote created in step 3 appears in the SharePoint `quotes` list with matching column names and values.
12. A record is voided in the app with a reason; the next sync sets `record_status`, `voided_at`, and `void_reason` on its SharePoint row rather than removing it.
13. The bookkeeper cannot edit a synced SharePoint list directly, verified in SharePoint itself, not just in the app.
14. A quote PDF and an uploaded file over 4MB both land in their libraries with correct metadata columns.
15. The database is dropped and rebuilt from SharePoint alone via `npm run restore:sharepoint`, and every quote, line, file, and total matches. Performed on a second machine, not the original.
16. The recovery runbook exists and names every secret that SharePoint does not hold.
17. An hourly encrypted dump lands on the USB drive with the retention ladder applied, and a restore from it succeeds.
18. The USB drive is unmounted mid-schedule; the backup job aborts with a visible error rather than silently writing to the internal disk.
19. Uploaded files and generated PDFs are present on the USB drive, not only the database dump.
20. Staleness alerting fires: stop the sync, confirm the admin banner and the email arrive.
21. A fresh deployment against an empty database completes the setup wizard end to end and produces a working, fully branded quote PDF with no SQL and no file editing.
22. A second deployment is stood up under a different fictional company name, address, tax label, tax rate, and logo. Its quote PDF shows none of the first company's details.
23. The app boots and quotes correctly with `sharepoint_sync` disabled and no Graph credentials present.
24. Enabling `sharepoint_sync` on a populated database backfills every row, and enabling it a second time creates no duplicates.
25. Disabling `sharepoint_sync` while no USB backup path is configured surfaces the single-copy warning.
26. A tax rate is changed with a future effective date. Quotes dated before it keep the old rate, quotes dated after get the new one, and every already-issued quote is untouched.
27. A second tax line is added and both appear correctly on the PDF with their own labels and registration numbers.
28. A line marked non-taxable is excluded from the taxable base; a tax-exempt customer produces a quote with no tax lines and the exemption number shown.

## 13. Open items

- **Real rate figures.** The seed rate card ships with clearly marked placeholder GTA numbers so the app is usable on first run. The owner overwrites them in the UI. No code change required.
- **Commercial bid mode.** Deferred pending confirmation that square-foot pricing is genuinely inadequate for his tenant improvement work.
- **Scope template set.** Which templates ship seeded — basement finish, kitchen, bathroom, full renovation, custom home — to be confirmed with the owner.
