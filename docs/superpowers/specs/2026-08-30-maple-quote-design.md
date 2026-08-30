# Maple Custom Homes — Quote & Project Management System

**Design document**
Date: 2026-08-30
Status: Awaiting review
Client: Maple Custom Homes (maplecustomhomes.ca) — general contractor, GTA / Golden Horseshoe, Ontario

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
| 3 | Receipt capture with OCR, vendor records, cost-to-project rollups, accountant export | Later spec |
| 4 | Purchase orders, vendor invoices, customer invoices, AP/AR dashboard, holdback tracking | Later spec |
| 5 | Subcontractor scheduling, planned vs actual dates, WSIB and COI expiry tracking | Later spec |

Phase 1 was chosen because the owner quotes daily. It delivers the fastest visible payback and proves the PDF pipeline end to end, which every later phase depends on.

**Explicitly out of scope, permanently:** general ledger, payroll, tax filing. Those stay in QuickBooks or Xero. This system feeds them. Building bookkeeping is a compliance liability and a maintenance trap.

**Out of scope for now:** subcontractor logins. Only owner, admin, and bookkeeper have accounts.

## 3. Architecture

### 3.1 Decision record

The initial recommendation was a Power Apps canvas app over SharePoint lists, using the seeded Microsoft 365 Business Standard license at zero marginal cost. That was rejected after the print requirement surfaced.

The reasoning: Power Apps on a free license cannot generate branded PDFs, cannot do receipt OCR, and cannot aggregate for AP/AR without a Power Automate summary-list workaround to dodge SharePoint delegation limits. Each of those was being solved by putting a worker process on the mini PC the client already owns. That design ends as two systems plus a sync protocol between them, where the auxiliary box does the hard work and Power Apps is a constrained UI over a constrained datastore.

One system is better. The client owns hardware. The application is built as a self-hosted TypeScript web app; SharePoint is demoted from datastore to backup target and accountant handoff, which is what it is genuinely good at.

**Accepted cost of this decision:** uptime and maintenance move from Microsoft to us. Power loss, ISP outage, disk failure, unattended reboots, and dependency CVEs become our responsibility, and the client cannot resolve any of them. Mitigations are containerization (section 3.4) and backup (section 7), but the bus-factor risk is real and is accepted knowingly.

### 3.2 Stack

| Layer | Choice | Reason |
|---|---|---|
| Application | Next.js 15 (App Router), TypeScript | One deployable serving UI and API. PWA gives add-to-home-screen, camera access, offline shell |
| UI | Tailwind CSS + shadcn/ui | Modern component set, fast to build, print-friendly CSS |
| Database | PostgreSQL 16 | Real transactions and aggregates. No delegation limits, no row thresholds |
| ORM | Drizzle | Typed schema, explicit SQL, lightweight migrations |
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

PostgreSQL. All primary keys are UUIDs. All money columns are `numeric`, never floating point.

Every synced table carries four columns, and the sync in section 7 depends on all of them:

- `created_at timestamptz`
- `updated_at timestamptz` — maintained by trigger, drives the sync watermark
- `created_by uuid`
- `is_deleted boolean DEFAULT false` plus `deleted_at timestamptz`

**Deletes are soft, never hard.** A watermark-based sync cannot detect a row that no longer exists. Hard deleting a record would orphan its SharePoint mirror permanently. All destructive operations set `is_deleted`; the sync propagates the flag and the UI filters on it.

```
users
  id, entra_object_id (unique), email (unique), display_name,
  role ENUM('owner','admin','bookkeeper'), is_active

customers
  id, name, company_name, email, phone,
  address_line1, address_line2, city, province DEFAULT 'ON', postal_code,
  customer_type ENUM('residential','commercial'),
  lead_source ENUM('call','email','referral','website','repeat','other'),
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
  default_qty numeric(12,3), sort_order, is_active
  UNIQUE(rate_card_id, code)

scope_templates
  id, name, project_type, description, is_active

scope_template_items
  id, scope_template_id FK, rate_item_id FK,
  qty_source ENUM('area','washrooms','kitchens','bedrooms','fixed','manual'),
  qty_multiplier numeric(10,4) DEFAULT 1,
  is_optional bool, line_group, sort_order

quotes
  id, project_id FK, quote_number, version int,
  status ENUM('draft','sent','accepted','declined','expired','superseded'),
  quote_date, valid_until,
  area_sqft numeric, washroom_count int, kitchen_count int, bedroom_count int,
  subtotal numeric(12,2), hst_rate numeric(5,4), hst_amount numeric(12,2),
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
  is_optional bool, is_included bool, notes

app_settings   -- single row
  company_name, legal_name, hst_number, address, phone, email, website,
  logo_path, hst_rate numeric(5,4) DEFAULT 0.13,
  quote_validity_days int DEFAULT 30,
  default_holdback_pct numeric(5,4) DEFAULT 0.10,
  quote_number_prefix, next_quote_seq

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

### 6.3 Ontario requirements

These are built in from Phase 1 because retrofitting them is expensive.

- **HST at 13%**, shown as a separate line, with the HST registration number on every document. The rate is snapshotted onto each quote so historical documents stay correct if the rate ever changes.
- **Construction Act holdback of 10%** stated in the quote terms. Holdback becomes a tracked AR bucket in Phase 4; if it is not separated there, the cash-flow view will overstate available cash by ten percent of every active job.
- **Prompt Payment** timelines — 28 days to pay a proper invoice, 7 days onward to subcontractors — drive the Phase 4 reminder schedule. Noted here so the invoice schema anticipates it.
- **WSIB clearance and subcontractor certificates of insurance** with expiry tracking arrive in Phase 5. Paying a subcontractor with lapsed clearance transfers liability to the general contractor.

Commercial tenant improvement work, which the site advertises, does not price by square foot. Phase 1 supports it through flat and hourly line types assembled by trade. A dedicated commercial bid mode is deferred until the owner confirms he wants one.

## 7. SharePoint mirror, sync, and recovery

The client's records are tax records. SharePoint is not a dump target — it holds a structured, queryable replica of the database with matching tables and column names.

### 7.1 What the mirror is for

- **Readable fallback.** If the mini PC dies on a Friday, the owner still opens SharePoint and sees his quotes, customers, and projects in a familiar UI. Not a database file he cannot open.
- **Accountant handoff.** Year-end becomes a shared folder and a list view, not an export request.
- **Reporting.** Power BI Desktop and Excel both connect to SharePoint lists natively, at no additional license cost.
- **Exit path.** Structured data in his own tenant, in his own format. No lock-in to a self-hosted app that one person maintains.

### 7.2 Direction and authority

**One way, Postgres to SharePoint. Always.**

Bidirectional sync is a distributed-systems problem requiring conflict resolution, and there is no requirement here that justifies it. Postgres is authoritative for every field.

This has a hard consequence that must be enforced, not merely documented: **SharePoint lists are read-only to humans.** The provisioning script breaks role inheritance on each synced list and grants Read to the owner, admin, and bookkeeper; only the sync application identity gets Contribute. Without this, someone edits a total in SharePoint, the next sync silently overwrites it, and trust in the system is gone.

Document libraries are the exception — PDFs, receipts, and exports are written once and are not synced back.

### 7.3 Sync job

Runs inside the app container on a schedule, default **every 4 hours**, configurable, plus an on-demand trigger in the admin UI.

Per table:

1. Read the watermark from `sync_state` for that list.
2. `SELECT * FROM <table> WHERE updated_at > watermark ORDER BY updated_at`.
3. Upsert into SharePoint matched on `pg_id`, using the Graph `$batch` endpoint at 20 requests per batch.
4. Rows with `is_deleted = true` are written with the flag set. They are not removed from SharePoint — the list keeps the tombstone so the accountant can see that a record existed and was voided.
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

**Lists created:** one per Postgres table — `users`, `customers`, `projects`, `rate_cards`, `rate_items`, `scope_templates`, `scope_template_items`, `quotes`, `quote_lines`, `app_settings`, `audit_log`.

**Document libraries created:**

| Library | Contents |
|---|---|
| `QuoteDocuments` | Generated quote PDFs, foldered by project number |
| `Receipts` | Receipt images (Phase 3) |
| `Backups` | Encrypted `pg_dump` archives |
| `Exports` | Accountant-ready `.xlsx` files |

### 7.5 Authentication

Two identities, two purposes:

- **Provisioning** — interactive delegated auth, run once by an administrator, needs site collection administrator rights. Runs from a workstation, not from the server.
- **Sync job** — app-only, unattended, Entra app registration with Graph `Sites.Selected` and a site-scoped `write` grant. `Sites.Selected` is specifically chosen over `Sites.ReadWrite.All` so a leaked credential reaches exactly one site and nothing else in the tenant.

The client secret lives in a Docker secret, never in the image or in git, and is rotated annually. Certificate authentication is the hardening upgrade if the client wants it later.

**This requires a new Entra app registration in the client's own tenant.** The existing MapleQuote PnP registration belongs to a different tenant and cannot be reused. The `Sites.Selected` site grant needs a one-time administrator consent.

### 7.6 Backup, distinct from sync

The mirror is a replica, not a backup — it holds current state, so a bad write propagates to it. Point-in-time recovery is separate.

| Cadence | Action | Retention |
|---|---|---|
| Hourly | `pg_dump` to a local volume | 48 hours |
| Nightly | Encrypted dump to the `Backups` library via Graph | 30 days, rotating |
| Every 4 hours | Structured sync to SharePoint lists (section 7.3) | Current state |
| Monthly | Accountant `.xlsx` to the `Exports` library | Indefinite |

**A backup that has never been restored is not a backup.** A scripted restore drill against a clean container is part of the Phase 1 definition of done, not a follow-up task.

Power Automate was considered for the push and rejected: it adds a connector dependency, cannot be tested in CI, and fails silently. Direct Graph calls from Node are testable and log properly.

## 8. Testing

- **Unit** — quote calculation engine. Line type math, percent-line ordering, margin against markup, HST rounding, template quantity derivation. This is where money bugs live, so coverage here is high.
- **Integration** — Drizzle queries against a real Postgres in a test container. Rate snapshot immutability is explicitly asserted: change a rate item, confirm existing quote lines do not move.
- **Schema parity** — a test asserts that every Drizzle table and column has a matching entry in the generated SharePoint template, with no reserved-name collisions. This fails the build on drift rather than discovering it during a sync at 2am.
- **Sync** — against a real SharePoint dev site. Covers upsert idempotency (running the same batch twice produces no duplicates), soft-delete propagation, watermark non-advancement on partial failure, and 429 backoff behaviour.
- **E2E (Playwright)** — build a quote from a template, adjust lines, generate the PDF, assert it renders with the correct total.
- **Restore drill** — scripted, run against a clean container, verified in CI.

## 9. Definition of done, Phase 1

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
12. A record is soft-deleted in the app; the next sync sets `is_deleted` on its SharePoint row rather than removing it.
13. The bookkeeper cannot edit a synced SharePoint list directly, verified in SharePoint itself, not just in the app.

## 10. Open items

- **Real rate figures.** The seed rate card ships with clearly marked placeholder GTA numbers so the app is usable on first run. The owner overwrites them in the UI. No code change required.
- **Commercial bid mode.** Deferred pending confirmation that square-foot pricing is genuinely inadequate for his tenant improvement work.
- **Scope template set.** Which templates ship seeded — basement finish, kitchen, bathroom, full renovation, custom home — to be confirmed with the owner.
