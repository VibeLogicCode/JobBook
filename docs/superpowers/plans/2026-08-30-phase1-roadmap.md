# Phase 1 Roadmap — Five Plans

**Purpose:** the whole shape of Phase 1 in one place, so it can be reviewed as a unit. Plan 1 is written in full TDD detail. Plans 2–5 are specified here — scope, deliverables, interface seams, risks — and each is written at full detail immediately before it is executed.

**Why not write all five in full now.** Plans 2–5 call code Plan 1 has not built. A UI plan written today would specify React against an API whose shape is still theoretical, and a sync plan would assume a schema that testing may still move. That code gets rewritten, which is waste rather than diligence. What genuinely needs deciding up front are the **seams between plans**, and those are fixed here.

**Specs:** `2026-08-30-scopeline-design.md`, `2026-08-30-ui-design.md`

---

## The five plans

| # | Plan | Delivers | Depends on |
|---|---|---|---|
| 1 | Foundation & calculation engine | Migrated schema; pure, tested quote and tax engine; document numbering; create, revise, void | — |
| 2 | Application & worksheet | Auth, API, app shell, screens, the worksheet at all widths, Present mode | 1 |
| 3 | Documents | Playwright PDF pipeline, quote template, print CSS | 1, 2 |
| **4a** | Backup | Hourly encrypted dumps to disk, USB, and SharePoint; dead-man's switch; restore drill | 1 |
| **4b** | SharePoint mirror | Schema generator, provisioning script, sync job, monitoring | 1 |
| 5 | First run & white-label | Setup wizard, seed data, second-tenant proof | 1, 2 |

**Plan 4 is split, and 4a comes early.** Backups must exist before the owner enters a single real quote — the ordering is not negotiable, and it is cheap: 4a needs only the Phase 1 schema.

The accountant export moved out of Phase 1 entirely. Phase 1 has no revenue and no expenses, so its only financial sheet would be "Quotes", which is not a set of books. It ships in Phase 3, the first phase with expenses and recoverable tax. Phase 1 still carries the settings it depends on — fiscal year end and filing frequency — because those are tenant configuration.

Plans 3 and 4b are independent of each other and can be built in either order, or together.

---

## Plan 1 — Foundation & calculation engine

**Status:** written in full. `2026-08-30-phase1-calculation-engine.md`, 17 tasks.

**Produces, and every later plan consumes:**

```ts
// @/lib/quote/types
type CalcMode = 'qty' | 'flat' | 'percent'
interface LineInput {
  code, description, lineGroup, sortOrder,
  calcMode: CalcMode,
  unitLabel: string,            // 'sqft' | 'lnft' | 'ea' | 'hr' | 'm2' -- display only
  qtyMilli: bigint,
  unitCostTenThou: bigint,      // may be negative: discounts, deductive change orders
  unitPriceTenThou: bigint,
  isTaxable, isOptional, isIncluded, isAllowance,
  rateItemId: string | null,    // provenance; never read for pricing
  costCodeId: string | null,    // snapshotted; what Phase 3 costs against
}
interface ComputedLine extends LineInput {
  lineCostCents: number
  lineTotalCents: number
  displayPriceCents: number     // excluded lines: grossed up by included percent lines
}

// @/lib/quote/totals
computeQuote(lines, rates, { onDate, customerExempt }): QuoteTotals

// @/lib/quote/repository
createQuoteFromTemplate(args): Promise<{ quoteId }>
reviseQuote(args): Promise<{ quoteId, version }>   // refuses draft, accepted, superseded, void
voidQuote(args): Promise<void>

// @/lib/quote/numbering
allocateDocumentNumber(tx, kind, businessDate): Promise<string>   // document_sequences

// @/lib/money/format
formatCents, sumCents, parseAmountToCents, parseQtyToMilli,
parseRateToTenThou, formatQty, formatRate, formatBasisPoints
```

`calcMode` is separate from `unitLabel` because `sqft`, `each` and `hour` all compute identically — only `flat` and `percent` differ. The earlier fused enum had no member for linear feet, so baseboard, trim, countertop and fencing were unenterable.

`displayPriceCents` exists because percent lines apply only to *included* lines: a $500 upgrade under 10% overhead and 15% profit raises the total by $625, so printing the raw line total would quote one price and invoice another.

**Scale contract, binding on every plan.** Money is integer cents. Quantities are integer thousandths. Rates and percents are integer ten-thousandths. Margin is basis points. Multiplication happens in `BigInt` because a maximum quantity times a maximum rate exceeds `Number.MAX_SAFE_INTEGER`.

Cent *sums* may be plain `number` — they stay safe integers. The constraint is that no **product** passes through a float.

**Scale is internal.** Anything leaving the system for a human — SharePoint, an export, a PDF — is unscaled. A rate appears as `4.0000`, never `40000`. Plan 4b owns that boundary and must test it in both directions.

---

## Plan 2 — Application & worksheet

The largest plan, and the one carrying the most design risk.

**Scope**
- Cloudflare Access JWT validation in `proxy.ts` (Next.js 16's name for middleware, on the Node runtime); role resolution from `users`
- API route handlers for customers, projects, quotes, change orders, lines, rate items, cost codes, templates
- `AppShell` — expanded rail, collapsed rail, bottom tab bar
- Token layer: `globals.css` with the Budget Tracker palette, both themes, tenant accent injected from `organization`
- Primitives ported from Budget Tracker: `Money`, `TableWrap`, `AmountCell`, `ListRow`, `StatTile`, `EmptyState`, `Pill`, `PageHeader`, `RowDialog`, `Notice`, `Button`, `Card`
- New primitives: sum bar, margin gauge, sheet editor, money input, search-first line picker
- Screens: Today, Customers, Projects, Quote worksheet, Quote review, Rate card, Scope templates, Settings
- Present mode

**Tasks:** roughly 22–26.

**Risk, and where it actually is.** Not the CRUD screens. It is the worksheet: one DOM tree that is a table at `sm` and above and a stacked card list below, whose cells hold live inputs at every width. Budget Tracker's `data-table--stack` handles read-only tables; an editing surface is the untested extension. **This is the first thing to build and the first thing to look at on a real phone** — if the single-tree approach fails for editable rows, that is a Plan 2 architecture change, and it is far cheaper to discover in week one than week four.

**Security, non-negotiable and verified by test.** Verify the signature against Cloudflare's JWKS plus `iss`, `aud` and `exp`. Reject service-token JWTs, which carry no `email`. Never read `Cf-Access-Authenticated-User-Email`. Fail closed. The app and database containers publish no ports.

An earlier draft justified the no-ports rule by claiming a directly reachable app would let the header be forged. **That reasoning was wrong** — a forged header fails signature verification. The rule stands for replay resistance and defence in depth, and the correction matters because the bad version invites skipping validation on the grounds that the tunnel protects us.

---

## Plan 3 — Documents

**Scope**
- Playwright and Chromium in the Docker image
- `/print/quote/[id]` — server-rendered, print-only, authenticated by an `INTERNAL_RENDER_SECRET` header accepted for that path prefix alone. Chromium reaches it over localhost from inside the container, so it never passes through Cloudflare and carries no Access JWT; calling it "a normal authenticated page" left it either unauthenticated or unspecified
- PDF service: launch, navigate to localhost, `page.pdf()`, write to disk, record on the quote
- Quote template: Plex Serif headings, letterhead from `organization`, logo inlined as a data URI, grouped lines, optional-upgrades block, tax breakdown by line with registration numbers, holdback and payment terms, exclusions, signature block
- Print CSS: `@page`, `break-inside: avoid`, repeating headers, `displayHeaderFooter` page numbering

**Tasks:** roughly 8–10.

**Risks.** Chromium adds ~300MB to the image and needs its font and system dependencies installed explicitly. PDF output must be deterministic enough to assert on — snapshot the extracted text and the page count, never the rendered bytes. Every string comes from `organization` or the quote; the white-label guard from Plan 1 Task 17 covers the templates too.

The template also honours `quotes.pricing_display`, defaulting to `group_totals` — most residential contractors will not send a homeowner a document showing quantity times unit rate — and prints available upgrades at their grossed-up price.

---

## Plan 4a — Backup

Built early, immediately after the two spikes, and **before the owner enters a single real quote.** It depends only on the Phase 1 schema.

**Scope**
- Hourly `pg_dump -Fc`, encrypted with `age` to a public key whose private half lives off the machine
- One artifact, three destinations: internal volume, USB drive, and the SharePoint `Backups` library
- USB mount verification — `mountpoint -q` plus a sentinel file, aborting loudly on failure
- Retention: hourly kept 48 hours, last-of-day kept 30 days
- Files and generated PDFs backed up, not just the database
- Verification on the **plaintext** stream before encryption, since the decryption key is deliberately off-box; weekly scratch-database restore with row counts
- Dead-man's-switch ping to an external monitor on every success
- Migrate-on-boot: dump, then migrate, then serve — failing closed
- Scripted restore drill

**Tasks:** roughly 10–12.

**Why the USB tier survived review.** The reviewer argued it duplicates the hourly SharePoint dump at the same recovery point, which is true on paper. It is kept because it covers failures SharePoint does not: no internet, a tenant lockout, an account dispute, or a deployment with sync switched off. The monthly retention tier was dropped as the reviewer suggested — every tier is pruning code that can fail silently.

---

## Plan 4b — SharePoint mirror

**Scope**
- Generator: Drizzle schema → PnP provisioning template XML → PowerShell wrapper
- Reserved-name mapping (`id` → `pg_id`, `created_at` → `pg_created_at`, `updated_at` → `pg_updated_at`), failing the build on a collision
- Provisioning: lists, fields, views, indexes, six libraries, site-level Read for humans, and bootstrapping the app-only certificate registration
- Sync job: hourly, keyset cursor `(updated_at, id)` with a five-minute safety lag, `sp_item_map` for item ids, Graph `$batch` with per-sub-request status parsing, 4xx skipped and surfaced, 429/5xx retried without advancing, void propagation, chunked upload above 4MB
- Staleness monitoring

**Tasks:** roughly 14–16.

**The seam that must not be missed.** Plan 1 stores scaled integers. **SharePoint receives unscaled values** — a rate appears as `4.0000`, not `40000`; a total as `4962.00`, not `496200`. The mirror is read by an accountant and by Power BI, so it carries human values. A scale-symmetry test is mandatory: getting this wrong is silent until someone reads a report.

**Three sync bugs to test explicitly**, each a silent data loss in an earlier draft: a cohort of rows sharing one `updated_at` must sync completely (a 40-line quote loses lines 21–40 under a bare watermark); a row committed during a run must not be skipped (`now()` is transaction start time); and one 400 must not stall a table's cursor forever.

**Not in scope: restore-from-lists.** The mirror is for reading. Values round-trip through IEEE doubles, 255-character Text caps, and Choice validation, while the dump in the same tenant is byte-exact with the same recovery point. Recovery is Plan 4a's job.

Enums mirror as **Text, not Choice** — a Choice column rejects any value not in its member list, so adding an enum value in a migration would fail every sync of that row until someone edited the list by hand.

**Authentication.** PnP's registration cmdlet produces a **certificate**, not a client secret; the sync authenticates from Node with MSAL client-certificate credentials. `Connect-PnPOnline -Interactive` has needed an explicit `-ClientId` since the shared PnP app was removed in September 2024.

---

## Plan 5 — First run & white-label

**Scope**
- Setup wizard: organization, branding upload, financial (tax rates with effective dates, fiscal year end, filing frequency, holdback), documents, environment validation, first user, rate items
- Environment validation rather than credential collection: the wizard confirms `SHAREPOINT_SYNC_ENABLED` and that the Graph certificate loads, and that the USB path is mounted. Credentials never pass through a form, because a form writes to the database and the database is mirrored and dumped
- Seed data: placeholder rate items, cost codes, and scope templates, clearly marked, in `src/db/seed/` — the only directory the white-label guard exempts
- Second-tenant proof: stand up a different fictional company and assert its PDF carries none of the first one's details

**Tasks:** roughly 8–10.

**The accountant export is not here.** It moved to Phase 3, the first phase with expenses and recoverable tax. A Phase 1 workbook whose only financial sheet is "Quotes" is not a set of books, and handing an accountant one invites the assumption that it is.

---

## Cross-plan invariants

Every plan is held to these; each states them in its own Global Constraints.

1. **Nothing is ever deleted.** No `DELETE` in application code; the database role does not hold the privilege.
2. **No tenant-specific value outside `src/db/seed/`.** Enforced by the grep test from Plan 1 Task 17, extended as each plan adds files.
3. **Money never passes through a JavaScript `number` mid-calculation.**
4. **Rates on a quote line are snapshots.** No plan may introduce a read of `rate_items` to price an existing quote.
5. **`updated_at` is maintained by trigger.** No plan may set it in application code, and no mirrored table may exist without it.
6. **Scale is internal.** Anything leaving the system for a human — SharePoint, an export, a PDF — is unscaled.

## Sequencing

1. **Plan 1** — the calculation engine and schema.
2. **Two spikes, in parallel, one day each.** The editable worksheet on a real phone, and Playwright `page.pdf()` inside the Docker image against a static page. These are the two packaging risks in Phase 1, and both are far cheaper to be wrong about in week one than week four.
3. **Plan 4a — backup.** Before the owner enters a single real quote.
4. **Plan 2** — the application, informed by whatever the worksheet spike found.
5. **Plan 3** — documents.
6. **Plan 4b** — the SharePoint mirror.
7. **Plan 5** — first run, seed data, second-tenant proof.

The worksheet spike is the highest-risk assumption in Phase 1: one DOM tree that is a table at `sm` and above and stacked cards below, with live inputs at every width. The read-only stacking pattern it builds on is proven; an editing surface on top of it is not. If it fails, that is a Plan 2 architecture change.

**Changes to Plan 1 before Task 1 begins**, all from the review:

- `client.ts` selects `TEST_DATABASE_URL` under Vitest — as written, every database test truncates whatever `DATABASE_URL` points at.
- `fileParallelism: false` for the database suites, so ten files truncating one database do not interleave.
- `drizzle-kit generate` plus `migrate`, not `push`. `push` gives production no reproducible migration path.
- Task 9's no-DELETE test must run inside a transaction; `SET LOCAL role` outside one is a no-op, so the `DELETE` ran as superuser and the test proved nothing.
- Task 15 rewritten against `document_sequences`: as written, `allocateProjectNumber` incremented the invoice counter, and the year came from `getUTCFullYear()` rather than the tenant's business date.
- Task 8's assertion that `rateItemId` is absent from a quote line is **inverted** — it is present as provenance; what must be asserted is that changing the rate item does not move an existing line's price.
- The type contract gains `calcMode`, `unitLabel`, `rateItemId`, `costCodeId`, `isAllowance`, and `displayPriceCents`.
- Schema tasks gain every cross-phase field: contract type, substantial performance and certificate dates, exclusions, assumptions, `quote_clauses`, cost codes, change-order columns on `quotes`, per-quote holdback, `pricing_display`, timezone, area unit.
