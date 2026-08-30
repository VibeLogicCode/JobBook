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
- **Recovery source.** The mirror is complete enough to rebuild the entire system onto new hardware. See section 7.7.
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

The interval is the recovery point objective. Since the mirror is a recovery source (section 7.7), a four-hour interval means losing up to four hours of quoting work when hardware fails. Hourly costs almost nothing — a working day changes tens of rows, far below any throttling concern — so hourly is the default.

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

**Lists created:** one per Postgres table — `users`, `customers`, `projects`, `rate_cards`, `rate_items`, `scope_templates`, `scope_template_items`, `quotes`, `quote_lines`, `app_settings`, `audit_log`.

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

### 7.7 Recovery — rebuilding from SharePoint

The mirror must be able to rebuild the system onto new hardware. This is a Phase 1 deliverable.

Two recovery paths, with different characteristics:

| Path | Source | Recovery point | Fidelity |
|---|---|---|---|
| **Primary** | `pg_dump` from the `Backups` library | Up to 24 hours old | Byte-exact, includes audit log and sync state |
| **Secondary** | Rebuild from SharePoint lists | Up to 1 hour old | Complete business data; audit log and sync state regenerate |

The secondary path has the better recovery point. If the mini PC fails at 4pm, the nightly dump is from 2am, but the list mirror is from 3pm. Rebuilding from lists therefore is not a last resort — it is often the right choice, and both paths are first-class and both are tested.

`npm run restore:sharepoint` performs the rebuild:

1. Authenticate app-only, same credentials as the sync.
2. Read every list, paging through Graph.
3. Insert in foreign-key dependency order: `users`, `app_settings`, `customers`, `projects`, `rate_cards`, `rate_items`, `scope_templates`, `scope_template_items`, `quotes`, `quote_lines`, `files`, `audit_log`.
4. Download every library file to local disk and reconcile `files.storage_path` against `sp_drive_item_id`.
5. Rebuild `sync_state` watermarks from the maximum `pg_updated_at` per table, so the first sync after recovery does not resend the entire database.
6. Verify: compare row counts per table against the source lists, and report any mismatch as a failure rather than a warning.

Restoring UUIDs rather than generating new ones is what makes this work — every foreign key is a UUID stored as text on both sides, so relationships survive the round trip intact. This is the payoff for the no-lookup-columns rule in section 4.3.

**What SharePoint does not hold, and what must therefore be stored elsewhere:** the Cloudflare Tunnel token, the Postgres password, the Graph client secret, and the Cloudflare Access configuration. None of these belong in the client's SharePoint. They go in a password manager, and the recovery runbook names them explicitly. A perfect data restore is useless if nobody can bring the tunnel back up.

### 7.8 Backup, distinct from sync

The mirror is a replica, not a backup — it holds current state, so a bad write propagates to it. Point-in-time recovery is separate.

| Cadence | Action | Retention |
|---|---|---|
| Hourly | `pg_dump` to a local volume | 48 hours |
| Nightly | Encrypted dump to the `Backups` library via Graph | 30 days, rotating |
| Hourly | Structured sync to SharePoint lists (section 7.3) | Current state |
| Monthly | Accountant `.xlsx` to the `Exports` library | Indefinite |

**A backup that has never been restored is not a backup.** A scripted restore drill against a clean container is part of the Phase 1 definition of done, not a follow-up task.

Power Automate was considered for the push and rejected: it adds a connector dependency, cannot be tested in CI, and fails silently. Direct Graph calls from Node are testable and log properly.

## 8. Testing

- **Unit** — quote calculation engine. Line type math, percent-line ordering, margin against markup, HST rounding, template quantity derivation. This is where money bugs live, so coverage here is high.
- **Integration** — Drizzle queries against a real Postgres in a test container. Rate snapshot immutability is explicitly asserted: change a rate item, confirm existing quote lines do not move.
- **Schema parity** — a test asserts that every Drizzle table and column has a matching entry in the generated SharePoint template, with no reserved-name collisions. This fails the build on drift rather than discovering it during a sync at 2am.
- **Sync** — against a real SharePoint dev site. Covers upsert idempotency (running the same batch twice produces no duplicates), void propagation, watermark non-advancement on partial failure, chunked upload of a file over 4MB, and 429 backoff behaviour.
- **Round trip** — the decisive test. Seed a database, sync it, drop it entirely, restore from SharePoint, and assert the result is equivalent row for row and file for file. This is the test that proves the recovery story is real rather than aspirational.
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
12. A record is voided in the app with a reason; the next sync sets `record_status`, `voided_at`, and `void_reason` on its SharePoint row rather than removing it.
13. The bookkeeper cannot edit a synced SharePoint list directly, verified in SharePoint itself, not just in the app.
14. A quote PDF and an uploaded file over 4MB both land in their libraries with correct metadata columns.
15. The database is dropped and rebuilt from SharePoint alone via `npm run restore:sharepoint`, and every quote, line, file, and total matches. Performed on a second machine, not the original.
16. The recovery runbook exists and names every secret that SharePoint does not hold.

## 10. Open items

- **Real rate figures.** The seed rate card ships with clearly marked placeholder GTA numbers so the app is usable on first run. The owner overwrites them in the UI. No code change required.
- **Commercial bid mode.** Deferred pending confirmation that square-foot pricing is genuinely inadequate for his tenant improvement work.
- **Scope template set.** Which templates ship seeded — basement finish, kitchen, bathroom, full renovation, custom home — to be confirmed with the owner.
