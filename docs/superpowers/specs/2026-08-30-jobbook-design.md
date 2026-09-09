# Contractor Quote & Project Management System

**Design document**
Date: 2026-08-30
Status: Awaiting review
First deployment: Northgate Building Group (northgate.example) — general contractor, GTA / Golden Horseshoe, Ontario

The product is white-label (section 2.1). Company identity, branding, tax rules, and document terms are configuration. Northgate Building Group is the first tenant, not the subject of the code.

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

Northgate Building Group is the first deployment, not the subject of the codebase. A build that hardcodes "Northgate Building Group" or "13%" anywhere outside a seed file has a bug.

**Tenancy: one deployment per company.** Each company gets its own container stack, its own Postgres, its own SharePoint site, and its own domain. Multi-tenancy in a shared database was rejected — it introduces an entire class of cross-tenant data leak that cannot occur when the databases are separate, and deployment is already a twenty-minute Compose operation. The `organization` table nonetheless carries an `id` so a future multi-tenant variant is an addition rather than a rewrite.

A consequence worth stating: **the Ontario rules in section 6.3 become seeded defaults, not logic.** They ship as the default configuration because the first client is in Ontario. They are editable, and nothing in the calculation engine assumes them.

## 3. Architecture

### 3.1 Decision record

The initial recommendation was a Power Apps canvas app over SharePoint lists, using the seeded Microsoft 365 Business Standard license at zero marginal cost. That was rejected after the print requirement surfaced.

The reasoning: Power Apps on a free license cannot generate branded PDFs, cannot do receipt OCR, and cannot aggregate for AP/AR without a Power Automate summary-list workaround to dodge SharePoint delegation limits. Each of those was being solved by putting a worker process on the mini PC the client already owns. That design ends as two systems plus a sync protocol between them, where the auxiliary box does the hard work and Power Apps is a constrained UI over a constrained datastore.

One system is better. The client owns hardware. The application is built as a self-hosted TypeScript web app; SharePoint is demoted from datastore to backup target and accountant handoff, which is what it is genuinely good at.

**Accepted cost of this decision:** uptime and maintenance move from Microsoft to us. Power loss, ISP outage, disk failure, unattended reboots, and dependency CVEs become our responsibility, and the client cannot resolve any of them. Mitigations are containerization (section 3.5) and backup (section 8), but the bus-factor risk is real and is accepted knowingly.

### 3.2 Stack

Versions and library choices track the existing **Budget Tracker** project — same maintainer, same deployment shape, same self-hosted Docker target. Its conventions are adopted rather than re-derived: `src/` layout with `(app)` and `(auth)` route groups, `src/db/{client,schema,seed}.ts`, `src/lib/<domain>/`, hand-rolled `src/components/ui/` primitives, `tests/{unit,integration,db,api,app,components,lib,ops,scripts}`, a maintained `CHANGELOG.md` and `INSTALL.md`, and GitHub Actions for tests and image releases.

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

Cloudflare Tunnel exposes the app at a subdomain of `northgate.example`. Cloudflare Access sits in front with Entra ID as the identity provider, so users get one Microsoft login with their existing M365 accounts.

The app validates the `Cf-Access-Jwt-Assertion` header against Cloudflare's JWKS, extracts the verified email, and resolves the role from the `users` table. There is no second login and no separate password store. In Next.js 16 this file is `proxy.ts`, not `middleware.ts`, and it runs on the Node runtime.

**Security requirements, non-negotiable:**

- **Verify the JWT: signature against the JWKS, plus `iss`, `aud`, and `exp`.** Reading an email from an unvalidated header is not authentication.
- **Never read `Cf-Access-Authenticated-User-Email`.** It is a convenience header with no signature. The JWT is the only credential.
- **Reject service-token JWTs.** They authenticate a machine, carry no `email` claim, and must not resolve to a user.
- **Fail closed.** A missing, malformed, or unverifiable assertion is a rejection, never a fallback.
- The app and database containers publish no ports to the host. All traffic arrives through the tunnel.
- Postgres is reachable only on the internal Docker network.

An earlier draft justified the no-published-ports rule by claiming the Access header could be spoofed if the app were reachable directly. **That reasoning was wrong** — a forged header fails signature verification. The rule stands for replay resistance and defence in depth, and the correction is recorded here because the bad version of it invites someone to skip validation on the grounds that "the tunnel protects us."

Role resolution happens in route handlers against a cached lookup, not as a database query per request inside the proxy.

Roles: `owner` (everything, including rates), `admin` (quotes and projects, no rate edit), `bookkeeper` (read quotes, full access to Phase 3 expenses). Enforced server-side, never by hiding UI. `admin` exists in the enum; nothing is built for it in Phase 1.

Users are keyed on **email**. An Entra object id is not carried in the Access JWT without additional identity-provider claim configuration, and for three users email is sufficient.

### 3.4 Distribution and self-update

Source lives in a private repository; the customer receives a built image from a private registry and never receives source. The application updates itself by asking a public version manifest what the latest release is, then sending one request to a Watchtower companion container — it never touches the Docker socket.

Full design, including what source secrecy is and is not achievable, in `2026-08-30-distribution-and-updates.md`. Two consequences land in this spec:

- **A `settings` key/value table** for machine state (update bookkeeping, sync cursors, toggles), distinct from `organization`'s typed tenant configuration. **Excluded from the SharePoint mirror** — machine state has no business being read by an accountant, and a mirrored table ends up in every backup.
- **Migrations run on boot, after a dump and before serving.** A migration failure must refuse to serve rather than run against a half-migrated schema.

### 3.5 Hosting portability

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

Database-level enforcement: the application role is granted `SELECT`, `INSERT`, and `UPDATE` on all tables and is not granted `DELETE`. An accidental delete fails as a permission error rather than destroying a record. Production runs two roles: `quote_app` with LOGIN for the application, and a separate owner role for migrations, which need DDL the application must never hold.

**Voiding does not cascade.** Voiding a customer with active projects, or a quote with active change orders, is refused until the children are void. A cascade would silently void records the user never named; leaving orphans behind is worse still.

**Users are the exception.** They are deactivated with `is_active`, never voided, because `email` is UNIQUE and a voided row would block re-adding the same person.

```
users
  id, email (unique), display_name,
  role ENUM('owner','admin','bookkeeper'), is_active
  -- Keyed on email. The Access JWT does not carry an Entra object id without
  -- extra IdP claim configuration, and email suffices for three users.
  -- Deactivated via is_active, never voided: email is UNIQUE, so a voided row
  -- would block re-adding the same person.

customers
  id, name, company_name, email, phone,
  address_line1, address_line2, city, province, postal_code,
  alt_contact_name, alt_contact_email, alt_contact_phone,  -- spouse, property manager
  customer_type ENUM('residential','commercial'),
  lead_source ENUM('call','email','referral','website','repeat','other'),
  is_tax_exempt bool DEFAULT false, tax_exempt_number, tax_exempt_reason,
  notes
  -- province carries NO default. Defaulting it to 'ON' in the schema would
  -- violate section 2.1; the UI defaults it from organization.province.

projects
  id, customer_id FK, project_number (unique), name,
  site_address_line1, site_city, site_province, site_postal_code,
  project_type ENUM('custom_home','basement','renovation','kitchen',
                    'bathroom','addition','commercial_ti','water_leak','other'),
  contract_type ENUM('lump_sum','unit_price','cost_plus','time_and_material'),
  stage ENUM('lead','site_visit','quoting','quote_sent','won','lost',
             'in_progress','complete','on_hold'),
  scheduled_start, scheduled_end, actual_start, actual_end,   -- DATE
  substantial_performance_date DATE,   -- starts the holdback release clock
  certificate_published_date DATE,     -- the statutory clock runs from publication
  lost_reason, notes
  -- No contract_value column. Contract value is DERIVED as the sum of accepted
  -- quotes on the project (section 5.6). Storing it too would give two sources
  -- of truth from day one.

cost_codes
  id, code, name, parent_id FK self, category, is_active
  -- Hierarchy: division then section. Replaces rate_items.category. Exists in
  -- Phase 1 because quote lines snapshot a cost code, and without it Phase 3
  -- job costing has nothing to group actual spend against.

rate_items
  id, code (unique), description, cost_code_id FK,
  calc_mode ENUM('qty','flat','percent'),
  unit_label text,              -- 'sqft', 'lnft', 'ea', 'hr', 'm2'
  cost_rate numeric(12,4),      -- what it costs him
  sell_rate numeric(12,4),      -- what the customer pays; may be negative
  is_taxable bool DEFAULT true, -- false for pass-through disbursements
  default_qty numeric(12,3), sort_order, is_active
  -- ONE list per deployment; there is no rate_cards table. Multiple cards
  -- would mean recreating every template against new item rows, and
  -- snapshotting already protects historical quotes.
  -- calc_mode is separate from unit_label because sqft, each and hour all
  -- compute identically; only flat and percent differ. The old fused enum had
  -- no way to express linear feet, so baseboard, trim, countertop and fencing
  -- were unenterable, and a metric deployment could not say m2.

scope_templates
  id, name, project_type, description, is_active

scope_template_items
  id, scope_template_id FK, rate_item_id FK,
  qty_source ENUM('area','washrooms','kitchens','bedrooms','fixed','manual'),
  qty_multiplier numeric(10,4) DEFAULT 1, fixed_qty numeric(12,3),
  is_optional bool, line_group, sort_order

quotes
  id, project_id FK,
  kind ENUM('estimate','change_order'),
  parent_quote_id FK quotes,    -- the estimate a change order amends
  sequence int,                 -- change order number within the project
  reason ENUM('customer_request','site_condition','design_change',
              'code_requirement','error_omission','allowance_reconciliation'),
  schedule_impact_days int,     -- unpriced time is still a cost
  version int,
  status ENUM('draft','sent','accepted','declined','superseded'),
  quote_date, valid_until,
  scope_template_id FK,         -- so "regenerate" knows what to regenerate from
  area_sqft numeric, washroom_count int, kitchen_count int, bedroom_count int,
  subtotal numeric(12,2), tax_total numeric(12,2),
  total numeric(12,2), total_cost numeric(12,2), margin_pct numeric(5,2),
  holdback_pct numeric(5,4),    -- per quote, nullable; defaulted by customer_type
  pricing_display ENUM('detailed','group_totals','lump_sum'),
  exclusions_text, assumptions_text, terms, notes, internal_notes,
  payment_terms_text,           -- deposit and draw terms differ per job
  accepted_by_name, acceptance_file_id FK files,
  sent_at, accepted_at, declined_at, pdf_path
  UNIQUE(project_id, kind, sequence, version)
  PARTIAL UNIQUE(project_id, kind, sequence)
    WHERE status='accepted' AND record_status='active'
  -- A change order IS a quote with a parent: same lines, same taxes, same
  -- engine, same PDF with a different heading, same versioning and acceptance.
  -- Three parallel change_order tables would duplicate all of it and delay
  -- mid-job extras to Phase 4. Deductive change orders use negative rates.
  -- 'expired' is NOT a stored status. It derives from valid_until, because a
  -- stored value is wrong the moment the clock passes it.

quote_lines
  id, quote_id FK, sort_order, line_group,
  code, description,                        -- snapshotted
  calc_mode, unit_label,                    -- snapshotted
  rate_item_id FK,   -- provenance ONLY, never read for pricing; nullable
  cost_code_id FK,   -- snapshotted; what Phase 3 groups actual cost against
  qty numeric(12,3),
  unit_cost numeric(12,4), unit_price numeric(12,4),   -- snapshotted
  line_cost numeric(12,2), line_total numeric(12,2),
  is_taxable bool, is_allowance bool,       -- snapshotted
  is_optional bool, is_included bool, notes -- notes is customer-facing sub-text
  CHECK (is_optional OR is_included)
  -- The snapshot rule is about PRICES, not origin. An earlier draft asserted
  -- no rate_item_id existed at all, which made every quote uncostable in
  -- Phase 3 and re-pricing at current rates impossible.
  -- The CHECK exists because a non-optional excluded line would otherwise
  -- print as an available upgrade.

quote_taxes   -- snapshotted tax breakdown per quote
  id, quote_id FK, label, registration_number,
  rate numeric(6,5), taxable_base numeric(12,2),
  tax_amount numeric(12,2), sort_order

quote_clauses -- reusable exclusion and assumption library
  id, kind ENUM('exclusion','assumption'), text, sort_order, is_active

organization   -- single row per deployment; all branding and locale
  id,
  -- identity
  legal_name, display_name, operating_name, tagline,
  owner_name, owner_title,
  logo_file_id FK files, favicon_file_id FK files, brand_color,
  -- contact
  address_line1, address_line2, city, province, postal_code, country,
  phone, alt_phone, email, website,
  -- locale
  currency DEFAULT 'CAD', locale DEFAULT 'en-CA',
  timezone DEFAULT 'America/Toronto',   -- IANA; see note below
  area_unit ENUM('sqft','sqm') DEFAULT 'sqft',
  -- financial and legal
  tax_registration_number, tax_registration_label,   -- 'HST Number'
  business_number,
  fiscal_year_end_month int, fiscal_year_end_day int,   -- not assumed Dec 31
  tax_filing_frequency ENUM('annual','quarterly','monthly'),
  tax_deferred_on_holdback bool DEFAULT true,  -- Ontario; see section 6.3
  default_holdback_pct numeric(5,4), holdback_label, holdback_terms_text,
  holdback_release_days int DEFAULT 60,
  payment_terms_days int, payment_terms_text,
  insurance_statement,        -- 'Fully insured and bonded'
  target_margin_bp int,       -- drives the worksheet margin gauge bands
  -- documents
  quote_validity_days int, quote_terms_text, document_footer_text
  CHECK (id = 1)              -- exactly one row
  -- No sequence columns. See document_sequences.
  -- timezone is not optional: quote_date defaults, valid_until, fiscal period
  -- boundaries, cron schedules and days-in-stage all need the tenant's local
  -- day, and new Date() in a UTC container gives the wrong date after 7pm
  -- Toronto.

document_sequences
  kind text, year int, next_seq int
  PRIMARY KEY (kind, year)
  -- Allocated with INSERT ... ON CONFLICT DO UPDATE ... RETURNING. Replaces
  -- six per-document sequence columns on organization, which did not scale to
  -- change orders and purchase orders, and where an earlier draft had project
  -- numbers incrementing the invoice counter.

tax_rates          -- versioned by effective date, never edited in place
  id, label, short_label, registration_number,
  rate numeric(6,5),
  effective_from DATE, effective_to DATE,   -- NULL = currently in force
  is_compound bool DEFAULT false,           -- applies on subtotal + prior taxes
  sort_order, is_active
  -- Ontario seeds one row: 'HST', 0.13, effective_from 2010-07-01

files        -- polymorphic attachment table, one row per stored file
  id, entity_type ENUM('organization','quote','project','customer','receipt',
                       'vendor_invoice','purchase_order'),
  entity_id uuid,                -- the record this file belongs to
  file_name, mime_type, size_bytes bigint,
  storage_path text,             -- local disk, authoritative
  uploaded_by, uploaded_at
  INDEX (entity_type, entity_id)
  -- Served by id from a UUID filename, never by storage_path.
  -- Logo uploads restricted to PNG and JPEG: an SVG served from the app origin
  -- is a cross-site scripting vector.
  -- SharePoint identifiers live in sp_item_map, not here.

stage_history      -- trigger-populated; time in stage is derived, never stored
  id, project_id FK, from_stage, to_stage, changed_at, changed_by, note

audit_log          -- trigger-populated; NOT mirrored to SharePoint
  id, table_name, record_id, action, changed_by, changed_at, diff jsonb
  -- Excluded from the mirror: no updated_at, will be the largest table, and is
  -- already in every dump.

sp_item_map  -- local only; Graph has no upsert by arbitrary key
  table_name, pg_id, sp_item_id
  PRIMARY KEY (table_name, pg_id)

settings     -- key/value machine state; NOT mirrored to SharePoint
  key (primary key), value, updated_at
  -- update.* bookkeeping, sync cursors, feature toggles. Distinct from
  -- `organization`, which holds typed tenant configuration. Absence is the off
  -- state: no defaulted column can switch a feature on for someone who never
  -- asked. There is no feature_flags table -- flags and credentials are
  -- environment variables, because a mirrored table ends up in SharePoint and
  -- in every backup, and secrets must never enter the database.

sync_state   -- local only
  id, list_name (unique),
  cursor_updated_at, cursor_id,   -- keyset cursor, not a bare watermark
  last_run_at, last_success_at, rows_synced,
  last_error, consecutive_failures
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
| `enum` | **Text** | Not Choice. A Choice column validates against a fixed member list, so adding an enum value in a migration makes every sync of that row fail with a 400 until the list is edited by hand |
| `jsonb` | Note (multi-line, plain) | Not mirrored; audit log stays local |

Two SharePoint limits the generator must respect: a Note field caps at roughly 64k characters, and a Text field at 255. The generator learns each column's scale from the `_cents` / `_milli` / `_ten_thou` naming convention and unscales on the way out — a rate appears in SharePoint as `4.0000`, never as `40000`.

## 5. Quote engine

### 5.1 Calculation modes

Three modes, and a separate free-text `unit_label` that never affects arithmetic.

| `calc_mode` | Calculation | Typical labels |
|---|---|---|
| `qty` | quantity x rate | `sqft`, `lnft`, `ea`, `hr`, `m2` |
| `flat` | the rate, once, regardless of quantity | permit, dumpster, engineering |
| `percent` | percentage of the included non-percent subtotal | overhead, profit, contingency |

An earlier draft used a single fused enum (`sqft`/`each`/`flat`/`percent`/`hour`). It conflated *how a line calculates* with *what it is called*: `sqft`, `each` and `hour` all compute identically, and only `flat` and `percent` differ at all. Worse, it had no member for linear feet, so baseboard, trim, countertop and fencing — all priced per linear foot by every GC — could not be entered, and a metric deployment could not say m2.

`flat` charges its rate exactly once, so a stray quantity cannot silently multiply a permit fee.

Percent lines are evaluated after all other included lines, against their sum, and never compound onto each other: a 10% overhead and a 15% profit both apply to the same base. Compounding would make the total depend on line order. This keeps overhead and profit visible as line items rather than buried in unit rates, which is what makes margin honest.

**Rates may be negative.** A discount and a deductive change order are both a negative rate, and a negative line reduces the subtotal, the percent base, and the taxable base alike.

### 5.1.1 What an optional upgrade actually costs

Percent lines apply only to *included* lines, so the raw total of an excluded line is not what accepting it adds to the quote. A $500 upgrade under 10% overhead and 15% profit raises the total by $625.

Every excluded line therefore carries a **grossed-up display price**: its own total plus each included percent rate applied to it. That is the figure printed under available upgrades, and it is the figure the customer is charged if they accept. Printing one number and invoicing another is a defect the customer discovers, on paper, after signing.

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

Customers negotiate. Each revision creates a new `quotes` row with an incremented `version`, and the prior version moves to `superseded`. Lines are copied, not shared. The owner can always see exactly what he sent and when. The revision copies only `record_status = 'active'` lines, sets `quote_date` to today, recomputes `valid_until`, and recomputes tax for the new date.

**Mutability is defined by status, enforced by trigger:**

| Status | Lines | Header |
|---|---|---|
| `draft` | Freely editable in place | Freely editable |
| `sent`, `declined`, `superseded`, `accepted` | Immutable | Whitelist only: status, the sent/accepted/declined timestamps, `pdf_path`, `internal_notes`, and the void columns |

A trigger rejects insert or update of priced columns on any line whose quote is not `draft`. Without this rule the void model becomes absurd — removing a line from a draft would demand a human-supplied `void_reason` for a quote nobody has seen. Draft line removal voids with a system-supplied reason.

**Revision is allowed only from `sent` or `declined`.** A `draft` edits in place; an `accepted` quote is never revised, because the customer signed it — the change goes on a change order instead.

### 5.5 Optional lines

Lines carry `is_optional` and `is_included`. Optional lines print in a separate "Available upgrades" block with individual pricing and are excluded from the quoted total. This supports upsells without a second quote.

### 5.6 Change orders and contract value

A change order is a quote with `kind = 'change_order'` and a `parent_quote_id`. It reuses the same lines, taxes, engine, versioning, acceptance flow, and PDF — with a different heading and its own `sequence` within the project. Deductive change orders are negative rates.

**Contract value is derived, never stored:**

```
contract_value = sum(total) over accepted, active quotes on the project
```

An earlier draft had both a `projects.contract_value_cents` column and a Phase 4 statement that the value was derived. Two sources of truth from day one is a reconciliation bug waiting for a witness.

`schedule_impact_days` is priced separately from the line items, because a change order that adds four days to a fixed-date job has a real cost even when every line on it carries full margin. Unpriced time is the most common way a contractor loses money while appearing to break even.

## 6. Documents

### 6.1 Pipeline

A print route renders the document as a server-rendered page. Playwright navigates headless Chromium to that route on localhost and calls `page.pdf()`. The result is written to disk and the path recorded on the quote. Generation is synchronous and takes roughly two seconds; there is no queue, no polling, and no worker process.

**The print route needs its own credential.** Chromium reaches it from inside the container, over localhost, so it never passes through Cloudflare and carries no Access JWT. An earlier draft called this "a normal authenticated page", which it cannot be: the route was therefore either unauthenticated — a hole exposing any customer's quote to anyone who could reach the app — or unspecified.

`/print/*` authenticates on an `INTERNAL_RENDER_SECRET` header, checked in `proxy.ts` and accepted for that path prefix only. Every other route requires the Access JWT. The secret is a container environment variable, never a database row.

### 6.2 Templates

Documents are React components using Tailwind print CSS. They use `@page` for margins, `break-inside: avoid` so a line item never splits across a page boundary, repeating table headers on multi-page quotes, and Chromium's `displayHeaderFooter` for page numbering.

Every string on the document comes from `organization` or the quote itself: logo, tagline, contact block, tax registration number and its label, insurance statement, footer text, exclusions, assumptions, and payment terms. Nothing about any particular company appears in a template — an earlier draft of this section quoted the first client's tagline directly, which is exactly the defect section 2.1 exists to prevent.

**`quotes.pricing_display` controls how much arithmetic the customer sees:**

| Value | Prints |
|---|---|
| `group_totals` *(default)* | A total per trade group. No quantities, no unit rates |
| `detailed` | Every line with quantity and unit rate, plus overhead and profit as their own lines |
| `lump_sum` | One figure for the whole scope |

Defaulting to `detailed` would have been wrong. Most residential contractors will not send a homeowner a document showing `1,240.5 sqft x $4.00` — it invites line-by-line negotiation of a price that was quoted as a whole. `detailed` remains available for the commercial and unit-price work where a client expects exactly that breakdown.

Available upgrades print with their **grossed-up** price from section 5.1.1, never the raw line total.

### 6.3 Regional rules — configured, not coded

The capability is built in from Phase 1 because retrofitting it is expensive. The *values* are seeded configuration, because of the white-label constraint in section 2.1.

| Requirement | Mechanism | Ontario seed |
|---|---|---|
| Sales tax | `tax_rates` rows, snapshotted per quote into `quote_taxes` | One row: HST, 13% |
| Tax registration on documents | `organization.tax_registration_number` and `..._label` | Label "HST Number" |
| Statutory holdback | `quotes.holdback_pct` per quote, defaulted from `organization.default_holdback_pct` by customer type | Construction Act, 10% |
| Holdback release clock | `organization.holdback_release_days` from `projects.certificate_published_date` | 60 days |
| Tax on holdback | `organization.tax_deferred_on_holdback` | Deferred to release |
| Payment timeline | `organization.payment_terms_days`, `payment_terms_text` | Prompt Payment, 28 days |
| Insurance statement | `organization.insurance_statement` | "Fully insured and bonded" |
| Area unit | `organization.area_unit` | Square feet |

**Holdback is per quote, not a global default.** A single organization-wide percentage would print a 10% withholding invitation on every residential quote, where most homeowners neither expect nor ask for one. It is nullable; the PDF prints the holdback block only when it is set. Phase 4 reads the accepted quote's rate rather than the organization default, which may have changed since.

#### Why `tax_rates` is a table

Ontario bills a single HST line — its PST was harmonized into HST in July 2010 and no longer exists separately. Other jurisdictions do not look like that:

| Jurisdiction | Lines |
|---|---|
| Ontario | HST 13% |
| Nova Scotia | HST 14% (reduced from 15% on 2025-04-01) |
| New Brunswick, Newfoundland, PEI | HST 15% |
| British Columbia | GST 5% + PST 7% |
| Saskatchewan | GST 5% + PST 6% |
| Manitoba | GST 5% + RST 7% |
| Quebec | GST 5% + QST 9.975% |
| Alberta, territories | GST 5% |

A single `hst_rate` column would need migrating away the first time this deployed outside Ontario. A table with one seeded row costs almost nothing now.

#### Rates are versioned, not edited

Rates change — Nova Scotia's HST went from 15% to 14% on 2025-04-01, and Ontario's HST exists only because of a 2010 change. Editing a rate in place would destroy the record of what was correct before.

So `tax_rates` rows carry `effective_from` and `effective_to`, and editing a rate **closes the current row and inserts a new one** rather than mutating. The owner sees a simple form — change the rate, set the date it takes effect — and the versioning happens underneath.

This works with, not instead of, the per-quote snapshot in `quote_taxes`. The two solve different problems:

- **The snapshot** protects quotes already issued. A quote sent last March keeps last March's tax line forever, exactly as the customer received it.
- **Effective dating** determines which rate a *new* quote picks up, including one back-dated during a rate transition, and answers "what was the rate on this date" for an audit.

Neither alone suffices. A snapshot without effective dating cannot price correctly in the weeks around a rate change; effective dating without a snapshot lets a later edit rewrite history.

#### Compound tax

`tax_rates.is_compound` allows a tax to apply to the subtotal plus previously applied taxes. No current Canadian jurisdiction compounds — Quebec stopped in 2013 — but PEI historically did, and one boolean now costs less than a migration and a recalculation later. Compound taxes evaluate in `sort_order`, after all non-compound ones.

#### Exemptions

Tax is not uniform across lines or customers, and both cases are real for a general contractor:

- **Line level.** `rate_items.is_taxable`, snapshotted onto `quote_lines`. Permit fees and similar pass-through disbursements are commonly billed at cost and handled differently from labour and materials.
- **Customer level.** `customers.is_tax_exempt` with `tax_exempt_number` and `tax_exempt_reason`. The exemption number belongs on the document, so it is stored rather than merely flagged.

A caution for seed data and test fixtures: public bodies — municipalities, universities, school boards, hospitals — **are not exempt.** They pay tax and claim rebates. An earlier draft used a regional health authority as its exempt example, which would have taught the owner not to charge a hospital.

The taxable base is the sum of included, taxable lines. It is stored on each `quote_taxes` row as `taxable_base` so a document reconciles years later without re-deriving which lines were taxable at the time.

#### Tax on statutory holdback is deferred

An earlier draft of this document stated that tax is charged on the full progress amount rather than the post-holdback figure. **That was wrong for Canada.**

Under Excise Tax Act s.168(7), where a holdback is retained under provincial legislation or a written construction contract, tax on the held-back amount is not payable until the holdback is paid out or is required to be paid out. Standard Ontario practice therefore taxes (progress − holdback) on each progress invoice, and taxes the holdback on the release invoice.

The schema shape survives the correction; the rule does not. `organization.tax_deferred_on_holdback` exists so a jurisdiction without deferral still works, seeded true for Ontario.

#### Later phases, same pattern

Holdback becomes a tracked AR bucket in Phase 4 — failing to separate it overstates available cash by the holdback percentage of every active job. Subcontractor compliance documents (WSIB clearance in Ontario, equivalents elsewhere) become a generic expiring-document type with configurable labels rather than a WSIB-specific field.

Commercial tenant improvement work, which the first client advertises, does not price by square foot. Phase 1 supports it through `flat` and `qty` lines assembled by trade, with `pricing_display: 'detailed'`. A dedicated commercial bid mode is deferred until the owner confirms he wants one.

## 7. SharePoint mirror and sync

SharePoint holds a structured, queryable replica of the database with matching tables and column names.

### 7.0 Optional, and off by default

The mirror is gated by the `SHAREPOINT_SYNC_ENABLED` environment variable, **off on a fresh install**. Not every company wants its data in a Microsoft tenant, and some will not have Microsoft 365 at all.

It is an environment variable rather than a database row on purpose. An earlier draft put it in a `feature_flags` table alongside the Graph credentials the setup wizard collected — and that table is mirrored, so the credentials would have synced to SharePoint and landed in every database dump. **Secrets never enter the database.** Flags that gate credentials live beside them, in the container environment.

Requirements this imposes:

- **The app boots and runs fully with sync disabled and no Graph credentials present.** Missing SharePoint configuration is a normal state, not a startup error. Everything touching Graph sits behind the gate.
- With it off, the scheduler does not run, sync status is hidden, and provisioning is skipped.
- **Enabling it triggers a full backfill.** The keyset cursor resets and every row is pushed. Safe to repeat, because every write is an idempotent upsert keyed through `sp_item_map`.
- Disabling it leaves existing SharePoint data in place. It stops updating; it is not torn down.

**The interlock matters more than the toggle.** With sync off, SharePoint leaves the backup picture. If sync is disabled *and* no USB backup path is configured, the company's tax records exist on exactly one disk. The dashboard says so, plainly and persistently. It is the owner's decision; it is not one to make silently.

### 7.1 What the mirror is for

- **Readable fallback.** If the mini PC dies on a Friday, the owner still opens SharePoint and sees his quotes, customers, and projects in a familiar UI. Not a database file he cannot open.
- **Accountant handoff.** Year-end becomes a shared folder and a list view, not an export request.
- **Reporting.** Power BI Desktop and Excel both connect to SharePoint lists natively, at no additional licence cost.
- **Exit path.** Structured data in his own tenant, in his own format. No lock-in to a self-hosted app that one person maintains.

**The mirror is for reading, not for recovery.** An earlier draft made it the primary rebuild source. It is the wrong artifact for that job: values round-trip through IEEE doubles, Text caps at 255 characters, Note at roughly 64k, and a Choice column rejects any value not in its member list. The `pg_dump` in the `Backups` library is byte-exact and has the same recovery point. Recovery is from dumps — section 8.

Every column is still mirrored, because the generator emits them anyway and a half-populated list is confusing to read.

### 7.2 Direction and authority

**One way, Postgres to SharePoint. Always.**

Bidirectional sync is a distributed-systems problem requiring conflict resolution, and there is no requirement here that justifies it. Postgres is authoritative for every field.

This has a hard consequence: **SharePoint lists are read-only to humans.** Provisioning grants people Read at the **site** level and Contribute to the sync application identity alone. Site-level permissions achieve this without breaking role inheritance on every list, which an earlier draft called for and which is fragile surgery to re-apply after each schema change.

The reason is worse than the earlier draft claimed. It said an edit made in SharePoint would be overwritten by the next sync. In fact **an unchanged Postgres row is never resent**, so a human edit is not overwritten — it *persists and diverges silently*, and the mirror quietly stops matching the database. A wrong figure that survives is worse than one that gets corrected, which makes read-only more important, not less.

Document libraries are the exception — PDFs, receipts, and exports are written once and are not synced back.

### 7.3 Sync job

Runs inside the app container on a schedule, default **every 1 hour**, configurable, plus an on-demand trigger in the admin UI.

The interval is the recovery point objective. Since the mirror is a recovery source (section 8.4), a four-hour interval means losing up to four hours of quoting work when hardware fails. Hourly costs almost nothing — a working day changes tens of rows, far below any throttling concern — so hourly is the default.

Per table:

1. Read the keyset cursor `(cursor_updated_at, cursor_id)` from `sync_state`.
2. `SELECT * FROM <table> WHERE (updated_at, id) > (cursor_updated_at, cursor_id) AND updated_at <= now() - interval '5 minutes' ORDER BY updated_at, id`.
3. For each row, look up `sp_item_map` for an existing SharePoint item id: create if absent, patch if present, recording the new id. Batched through Graph `$batch`, 20 sub-requests at a time.
4. Rows with `record_status = 'void'` are written with the status, reason, and timestamp set. Nothing is ever removed from SharePoint, matching the no-delete rule in section 4.
5. Advance the cursor to the last successfully written row's `(updated_at, id)`.

Four correctness requirements, each covering a way an earlier draft lost data silently:

- **A keyset cursor, not a bare watermark.** A bulk insert stamps many rows with the same `updated_at`. Advancing to "the highest value in this 20-row batch" and then querying `> watermark` skips the remainder of that cohort — a 40-line quote loses lines 21 through 40. Ordering and paging on `(updated_at, id)` cannot skip a row.
- **A five-minute safety lag.** `now()` in PostgreSQL is transaction *start* time. A row whose transaction began before the sync read its cursor but committed after it carries a timestamp below the new cursor and would never be sent again. The lag costs five minutes of recency and closes the hole.
- **Distinguish 4xx from 429 and 5xx.** A 400 on one row — an unmapped value, an over-length string — must be logged, skipped, and surfaced, not retried forever. Under a naive "advance only on success" rule, one bad row blocks that table's cursor permanently and every later row stops syncing. A 429 or 5xx retries *without* advancing, honouring `Retry-After` with capped exponential backoff and jitter; SharePoint write throttling is aggressive and real.
- **`$batch` is not atomic.** It returns per-sub-request statuses and some can fail while others succeed. Parse every sub-response; treating the batch as pass-or-fail either loses writes or repeats them.

**Log every failure to `sync_state`** and surface a banner when the last success is older than twice the interval. A sync that has been failing for a month is worse than no sync, because it looks like a backup.

There is no upsert-by-arbitrary-key in Graph, which is why `sp_item_map` exists. An earlier draft specified "upsert matched on `pg_id`" — an operation the API does not offer. Writing a list item requires knowing its SharePoint item id, so the mapping is ours to keep.

### 7.4 Provisioning script — generated, not hand-written

No manual list or column creation. The chain is:

```
Drizzle schema  ->  npm run generate:sharepoint  ->  PnP template XML
                                                 ->  Provision-JobBook.ps1
```

A code generator reads the Drizzle table definitions and emits a PnP provisioning template plus a PowerShell wrapper. Running the wrapper creates or updates every list, field, view, and index, and applies the permission model from section 7.2.

The template is **idempotent** — `Invoke-PnPSiteTemplate` is safe to re-run, so a schema change is: edit Drizzle, regenerate, re-run. Adding a column never means clicking through SharePoint.

The generator also emits indexes on `pg_id` and on every foreign key column. Without them, a list past 5,000 items throws the list view threshold error on ordinary queries.

**Lists created:** one per mirrored table — `organization`, `users`, `customers`, `projects`, `cost_codes`, `rate_items`, `scope_templates`, `scope_template_items`, `quotes`, `quote_lines`, `quote_taxes`, `quote_clauses`, `tax_rates`, `document_sequences`, `files`, `stage_history`.

**Not mirrored:** `settings`, `sync_state`, `sp_item_map`, and `audit_log`. The first three are machine state; `audit_log` has no `updated_at` to sync on, will be the largest table in the database, and is already captured in every dump.

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

**Design:** the polymorphic `files` table routes each file to a library by `entity_type`. Local disk is authoritative and is what the application serves — no Graph round-trip to display a receipt, and files are served by id from a UUID filename rather than by `storage_path`. SharePoint holds the mirror, with `pg_id`, `entity_type`, `entity_id`, and human-readable metadata as library columns so the accountant can filter by project. The SharePoint drive item id lives in `sp_item_map` like every other mirrored row's, not as columns on `files`.

Logo and favicon uploads are restricted to PNG and JPEG. An SVG served from the application's own origin is a cross-site scripting vector.

Two implementation constraints:

- **Graph simple upload caps at 4MB.** Phone receipt photos routinely exceed this, so a chunked upload session is required, not optional.
- File metadata is set with a second call — `PATCH /sites/{id}/lists/{listId}/items/{itemId}/fields` — after the upload completes. Upload and metadata are not atomic; a file with unset metadata must be retried on the next sync rather than treated as done.

### 7.6 Authentication

Two identities, two purposes. Neither requires touching the Azure portal.

**Provisioning — interactive.** Run manually against the client's tenant using his credentials, from a workstation, not the server. Needs site collection administrator rights. Run once, and again after any schema change.

`Connect-PnPOnline -Interactive` has required an explicit `-ClientId` since the shared PnP application registration was removed in September 2024. This tenant already needs a custom registration for that reason.

**Sync job — app-only.** This cannot be interactive. The sync runs unattended in a container every hour, indefinitely; there is no human present to complete a login, and delegated refresh tokens expire and are invalidated by a password change or an MFA policy change. A background daemon requires app-only credentials. There is no alternative that is not fragile.

The manual work is removed rather than the registration: the provisioning script bootstraps the app registration through PnP, requests Graph `Sites.Selected`, and applies the site-scoped `write` grant. One script run against his tenant, no portal navigation, no manual consent beyond the administrator approval prompt PnP raises.

**It produces a certificate, not a client secret.** An earlier draft of this section promised a printed client secret; the PnP registration cmdlet generates a certificate and returns its thumbprint and private key. The sync authenticates from Node with MSAL client-certificate credentials. The certificate is mounted as a Docker secret, never in the image and never in git, and is rotated on the same schedule a secret would have been.

`Sites.Selected` is chosen over `Sites.ReadWrite.All` deliberately: a leaked credential reaches exactly one site, not the whole tenant.

> The exact PnP cmdlet names differ across PnP.PowerShell major versions. They are verified against the installed module at implementation time rather than asserted here.

## 8. Backup and recovery

### 8.1 Three copies, two media, one offsite

| Copy | Medium | Location | Survives |
|---|---|---|---|
| Live Postgres | Internal SSD | Mini PC | Nothing; it is the thing being protected |
| Hourly dump | Internal SSD | Mini PC | Bad data, dropped table, botched migration |
| Hourly dump | **USB HDD** | Mini PC, external | Internal disk failure, filesystem corruption |
| Hourly dump | SharePoint `Backups` | Microsoft | Fire, theft, flood, the whole site going away |
| Hourly list sync | SharePoint lists | Microsoft | Nothing. It is for reading, not recovery (section 7.1) |

Both SharePoint rows are conditional on `SHAREPOINT_SYNC_ENABLED` (section 7.0). With it off, the USB drive is the only copy that survives loss of the internal disk — which is why the interlock in section 7.0 refuses to let both be off quietly.

One artifact, three destinations. The same encrypted `pg_dump` file is written to the internal volume, copied to the USB drive, and uploaded to the `Backups` library. Not three separate backup implementations.

### 8.2 Local and USB backup

**Hourly, not nightly.** A `pg_dump` of this database is a few megabytes and stays that way for years. Writing it hourly to the USB drive costs nothing and takes the USB recovery point from 24 hours down to 1, matching the SharePoint mirror. There is no reason to accept a worse recovery point to save a few megabytes.

Retention is deliberately flat rather than a grandfather-father-son ladder: hourly dumps kept 48 hours, plus the last dump of each day kept 30 days. A twelve-month monthly tier was considered and dropped — the SharePoint copy already holds long-term history, and every retention tier is pruning code that can fail silently.

**Receipts, quote PDFs, and uploaded files are backed up too**, not just the database. A restored database whose `files` rows point at missing images is only half a recovery.

**Keeping the USB tier was a deliberate override of the review**, which argued it duplicates the hourly SharePoint dump at the same recovery point. That is true on paper. It is kept because it covers failures SharePoint does not: no internet, a tenant lockout, an account dispute, or a deployment that has sync switched off entirely.

Five requirements, each of which is a way this silently fails in practice:

1. **Verify the mount before writing.** If the USB drive unmounts or spins down, writing to `/mnt/backup` succeeds against the internal disk at that same path, and there is no backup at all while everything looks healthy. The script checks `mountpoint -q` and confirms a sentinel file on the volume, and aborts loudly if either fails.
2. **ext4, not NTFS or exFAT.** Permissions and reliability under Linux.
3. **Encrypt the dump, not the disk.** Dump files are encrypted with `age` to a public key; the private key lives in the password manager alongside the other secrets. This is the same artifact and the same key as the SharePoint copy — one mechanism. Full-disk LUKS was considered and rejected: unattended boot needs a keyfile on the internal disk, so stealing the whole machine defeats it, and the realistic threat is the external drive alone walking out of an office.
4. **Prune on a schedule.** A full disk stops backups silently. Retention is enforced every run, not hoped for.
5. **Verify the artifact, before encryption.** Every run checks the dump with `pg_restore --list`; weekly, a scheduled job restores it into a scratch database and counts rows.

   Two details an earlier draft got wrong. `pg_restore --list` only reads archive formats, so the dump must be taken with `-Fc` — it cannot be plain SQL. And verification has to happen on the **plaintext stream, before encryption**, because the `age` private key deliberately lives off the machine; a box that could decrypt its own backups would defeat the reason for encrypting them. That the encrypted artifact is decryptable is proven separately, by a periodic drill from the maintainer's workstation.

### 8.3 Restore paths, in order

Pick by failure mode, not by habit:

| Failure | Use | Recovery point |
|---|---|---|
| Bad data, dropped table, bad migration — hardware fine | Hourly dump, internal volume | 1 hour |
| Internal disk failed, machine and USB intact | Hourly dump, USB drive | 1 hour |
| Machine dead, USB intact | USB drive on new hardware | 1 hour |
| Machine and USB both gone — fire, theft, flood | Hourly dump from SharePoint `Backups` | 1 hour |
| A bad migration during an update | The pre-migration dump taken at boot | Minutes |

The SharePoint row requires sync to be enabled. A deployment with it off has no disaster path beyond the USB drive, and the operator needs to know that before the disaster rather than during it.

The USB drive is the working restore path and handles almost every realistic failure; SharePoint is the disaster path. Every path restores a `pg_dump`, so all of them are byte-exact.

**Rebuilding from the SharePoint lists is not a restore path.** An earlier draft made it one, and made it primary. See section 7.1 — the mirror round-trips through IEEE doubles, 255-character text caps, and Choice validation, while a dump in the same tenant is byte-exact with the same recovery point. The mirror is for reading.

### 8.4 What backups do not hold

A perfect data restore is useless if nobody can bring the service back up. None of the following belong in the client's SharePoint or in a database dump, and all of them are needed to stand the system up on new hardware:

- The Cloudflare Tunnel token and the Access application configuration
- The PostgreSQL password
- The Graph certificate and its private key
- The `age` private key that decrypts every dump
- The registry `read:packages` token that pulls the image
- `INTERNAL_RENDER_SECRET`

They live in the maintainer's password manager, and the recovery runbook names each one explicitly with where it is used.

**Restoring UUIDs rather than generating new ones** is what makes any restore path work: every foreign key is a UUID, so relationships survive intact. This is also the payoff for the no-lookup-columns rule in section 4.3 — SharePoint lookups reference an integer item id that SharePoint assigns, which would not survive a rebuild.

### 8.5 Monitoring

Silent backup failure is the normal way backups fail. Every mechanism reports staleness:

- **A dead-man's switch.** The backup job pings an external monitor (healthchecks.io or equivalent) on every success. Miss the window and the monitor alerts. This is the primary mechanism, and it replaces the e-mail an earlier draft specified: the realistic failure is the mini PC being dead or unplugged, and a mail job on a dead machine sends nothing. One `curl` line, no SMTP, no `Mail.Send` permission.
- **An in-app banner** when the last USB backup is older than 2 hours, the last sync older than 2 hours, or the last upload older than 26 hours.
- `sync_state` records `consecutive_failures`; three in a row escalates.
- The weekly restore verification writes its result where a failure is visible, not only to a log nobody opens.

**A backup that has never been restored is not a backup.** A scripted restore drill against a clean container is part of the Phase 1 definition of done, not a follow-up task.

### 8.6 First-run setup

White-labelling is only real if standing up a new company does not require SQL. A fresh deployment with an empty database redirects to a setup wizard, completable by the owner:

1. **Organization** — legal and display name, operating name, tagline, owner name, address, phone, email, website.
2. **Branding** — logo and favicon upload, brand colour. Logo is stored through the `files` table and inlined as a data URI when rendering PDFs, so document generation never depends on an authenticated fetch.
3. **Financial** — currency, locale, tax registration number and its label, one or more tax rates with their effective dates, holdback percentage and terms, payment terms.
4. **Documents** — number prefixes and starting sequences in `document_sequences`, quote validity days, default pricing display, terms, exclusions, assumptions, and footer text.
5. **Environment check** — the wizard *validates* rather than collects: it confirms whether `SHAREPOINT_SYNC_ENABLED` is set and its Graph certificate loads, and confirms the USB backup path is mounted. Credentials are environment variables and never pass through a form, because a form writes to the database and the database is mirrored and dumped.
6. **First user** — the signed-in identity becomes `owner`.
7. **Rate card** — start from a seeded placeholder card or an empty one.

The wizard writes the `organization` row, `tax_rates`, `cost_codes`, `document_sequences`, and the first `users` row — that first signed-in identity becomes `owner`. It runs once; afterwards every field remains editable under Settings, owner role only.

## 9. Accountant export

Year-end is the pain the owner named first. The export is a first-class feature, not a report.

**The export ships in Phase 3, not Phase 1.** Phase 1 holds customers, projects, and quotes — no revenue, no expenses. A workbook whose only financial sheet is "Quotes" is not a set of books, and handing an accountant one invites the assumption that it is. Phase 3 is the first phase with expenses and input tax credits, which is the first point the export earns its place. The period logic and sheet framework are built then, and Phase 4 adds the rest.

What Phase 1 does carry is the *configuration* the export depends on — `fiscal_year_end_month`, `fiscal_year_end_day`, and `tax_filing_frequency` — because those are tenant settings and retrofitting them means re-asking the owner.

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

- **Unit** — quote calculation engine. Calculation-mode math, percent-line ordering, margin against markup, tax rounding, template quantity derivation, negative rates as discounts and deductive change orders, and exactness past `Number.MAX_SAFE_INTEGER`. This is where money bugs live, so coverage here is high.
- **Optional-line gross-up** — an excluded line's printed price equals the increase in the total when it is included. The specific case: a $1,000 included line, 10% overhead, a $500 excluded line displaying $550; include it and the subtotal becomes $1,650.
- **Tax** — its own suite, because it is the most jurisdiction-sensitive logic in the system. Single-rate (Ontario HST), dual-rate (BC GST + PST), compound ordering, non-taxable lines, exempt customers, and a rate change mid-stream where a quote dated before the change gets the old rate and one dated after gets the new one.
- **Integration** — Drizzle queries against a real Postgres in a test container. Rate snapshot immutability is explicitly asserted: change a rate item, confirm existing quote lines do not move.
- **Schema parity** — a test asserts that every Drizzle table and column has a matching entry in the generated SharePoint template, with no reserved-name collisions. This fails the build on drift rather than discovering it during a sync at 2am.
- **Sync** — against a real SharePoint dev site. Idempotency (the same batch twice produces no duplicates), void propagation, chunked upload above 4MB, and 429 backoff. Three cases exist because each was a silent data-loss bug in an earlier draft: a cohort of rows sharing one `updated_at` must all sync; a row committed during a sync run must not be skipped; and a single 400 on one row must not stall that table's cursor forever.
- **Scale symmetry** — a rate stored as `40000` appears in SharePoint as `4.0000`, and a value read back re-scales to `40000`. Getting this wrong is silent until somebody reads a report.
- **Mutability triggers** — a priced column on a `sent` quote's line cannot be updated; a header column outside the whitelist cannot be changed after `sent`; `reviseQuote` refuses a `draft`, `accepted`, `superseded`, or `void` source.
- **Void cascade** — voiding a customer with active projects is refused rather than orphaning them.
- **E2E (Playwright)** — build a quote from a template, adjust lines, generate the PDF, assert it renders with the correct total.
- **White-label** — a test greps the built application, seed-file directory excluded, for the first client's name, domain, phone number, and the literal `0.13`. Any hit fails the build. This is the only reliable way to keep hardcoded values out over time.
- **Feature gate** — a unit test asserts that with `SHAREPOINT_SYNC_ENABLED` unset the scheduler does not register and no Graph client is constructed. Running the entire suite twice under both settings was considered and dropped: it doubles CI time to re-prove assertions that have nothing to do with the flag.
- **Auth** — a forged `Cf-Access-Jwt-Assertion` is rejected; a valid signature with the wrong `aud` or `iss` is rejected; an expired assertion is rejected; a service-token JWT carrying no `email` is rejected; `Cf-Access-Authenticated-User-Email` alone never authenticates; `/print/*` accepts the render secret and no other path does.
- **Backup** — mount-detection is tested by unmounting the target and asserting the job aborts loudly rather than writing to the underlying path. Retention pruning, dump verification, and `age` round-trip encryption are each covered.
- **Restore drill** — scripted, run against a clean container, verified in CI. Also covers the boot sequence: a deliberately failing migration must leave the app refusing to serve rather than serving against a half-migrated schema.
- **Test isolation** — the database suites run against `TEST_DATABASE_URL` and with file parallelism disabled. Both are guarded by a test, because an earlier draft of the plan had every suite truncating whatever `DATABASE_URL` pointed at, in parallel workers.

## 12. Definition of done, Phase 1

**Quoting**

1. Owner signs in with his Microsoft account through Cloudflare Access and reaches the app on both phone and desktop.
2. He creates a customer and a project.
3. He selects a scope template, enters square footage and room counts, and a complete quote generates.
4. He adjusts lines, marks some optional, and watches margin update live.
5. An optional line's printed price equals what the total rises by when it is included.
6. He adds a linear-foot line and a negative discount line; both price correctly.
7. He generates a branded PDF with correct tax, holdback terms, exclusions, and assumptions, in `group_totals` display.
8. He revises the quote; version 1 is preserved unchanged and cannot be edited.
9. Rate item edits do not alter any existing quote.
10. He raises a change order against the accepted quote; the project's contract value becomes quote plus change order.
11. Present mode hides cost, margin, and rate codes in one tap.

**Correctness and access**

12. A tax rate is changed with a future effective date. Quotes dated before it keep the old rate, quotes dated after get the new one, and every already-issued quote is untouched.
13. A second tax line is added and both appear on the PDF with their own labels and registration numbers.
14. A non-taxable line is excluded from the taxable base; a tax-exempt customer produces a quote with no tax lines and the exemption number shown.
15. Two quotes created concurrently receive different document numbers.
16. A record is voided with a reason; voiding a customer with active projects is refused.
17. The bookkeeper signs in and can read quotes but cannot edit rates, verified server-side.
18. A forged Access assertion is rejected. `/print/*` is reachable only with the render secret.

**Durability**

19. An hourly encrypted dump lands on the internal volume and the USB drive, and a restore from the USB copy succeeds.
20. The USB drive is unmounted mid-schedule; the job aborts with a visible error rather than writing to the internal disk.
21. Uploaded files and generated PDFs are on the USB drive, not only the database dump.
22. An hourly dump reaches the SharePoint `Backups` library, and a restore from it succeeds on a second machine.
23. The dead-man's switch fires: stop the backup job, confirm the external monitor alerts.
24. A deliberately failing migration leaves the app refusing to serve, with the pre-migration dump present.
25. The recovery runbook exists and names every secret backups do not hold.

**Mirror**

26. The provisioning script runs against an empty SharePoint site and creates every list, column, view, index, and library with no manual steps. Running it a second time changes nothing.
27. The sync runs and the quote from step 3 appears in the `quotes` list with matching column names, unscaled values, and enum values as text.
28. A 40-line quote syncs completely — no rows lost to a shared `updated_at`.
29. The bookkeeper cannot edit a synced list, verified in SharePoint itself.
30. Enabling sync on a populated database backfills every row; enabling it again creates no duplicates.
31. The app boots and quotes correctly with sync disabled and no Graph credentials present, and says so when no USB path is configured either.

**White-label**

32. A fresh deployment completes the setup wizard end to end and produces a fully branded quote PDF with no SQL and no file editing.
33. A second deployment under a different fictional company name, address, tax label, tax rate, and logo produces a PDF showing none of the first company's details.

## 13. Open items

- **Real rate figures.** The seed rate list ships with clearly marked placeholder GTA numbers so the app is usable on first run. The owner overwrites them in the UI. No code change required.
- **Commercial bid mode.** Deferred pending confirmation that square-foot pricing is genuinely inadequate for his tenant improvement work.
- **Scope template set.** Which templates ship seeded — basement finish, kitchen, bathroom, full renovation, custom home — to be confirmed with the owner.
- **Quote numbering.** The review replaced a separate quote number with project number plus revision, on the grounds that a customer sees one job. Contractors do quote numbers on the phone. Flagged as a close call by the reviewer and reversible either way; the owner has not yet been asked.
- **Cost code standard.** A short custom list is seeded with hierarchy support, so CSI MasterFormat can be adopted later if the accountant asks for it.
