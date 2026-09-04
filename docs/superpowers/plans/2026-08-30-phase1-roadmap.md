# Phase 1 Roadmap — Five Plans

**Purpose:** the whole shape of Phase 1 in one place, so it can be reviewed as a unit. Plan 1 is written in full TDD detail. Plans 2–5 are specified here — scope, deliverables, interface seams, risks — and each is written at full detail immediately before it is executed.

**Why not write all five in full now.** Plans 2–5 call code Plan 1 has not built. A UI plan written today would specify React against an API whose shape is still theoretical, and a sync plan would assume a schema that testing may still move. That code gets rewritten, which is waste rather than diligence. What genuinely needs deciding up front are the **seams between plans**, and those are fixed here.

**Specs:** `2026-08-30-maple-quote-design.md`, `2026-08-30-ui-design.md`

---

## The five plans

| # | Plan | Delivers | Depends on |
|---|---|---|---|
| 1 | Foundation & calculation engine | Migrated schema; pure, tested quote and tax engine; document numbering; create, revise, void | — |
| 2 | Application & worksheet | Auth, API, app shell, screens, the worksheet at all widths, Present mode | 1 |
| 3 | Documents | Playwright PDF pipeline, quote template, print CSS | 1, 2 |
| 4 | SharePoint & durability | Schema generator, provisioning script, sync, restore, backup tiers, monitoring | 1 |
| 5 | First run & accountant export | Setup wizard, seed data, `.xlsx` export, second-tenant proof | 1, 2, 4 |

Plans 3 and 4 are independent of each other and can be built in either order, or in parallel.

---

## Plan 1 — Foundation & calculation engine

**Status:** written in full. `2026-08-30-phase1-calculation-engine.md`, 17 tasks.

**Produces, and every later plan consumes:**

```ts
// @/lib/quote/types
type UnitType = 'sqft' | 'each' | 'flat' | 'percent' | 'hour'
interface LineInput { code, description, lineGroup, sortOrder, unitType,
  qtyMilli: bigint, unitCostTenThou: bigint, unitPriceTenThou: bigint,
  isTaxable, isOptional, isIncluded }
interface ComputedLine extends LineInput { lineCostCents: number; lineTotalCents: number }

// @/lib/quote/totals
computeQuote(lines, rates, { onDate, customerExempt }): QuoteTotals

// @/lib/quote/repository
createQuoteFromTemplate(args): Promise<{ quoteId }>
reviseQuote(args): Promise<{ quoteId, version }>
voidQuote(args): Promise<void>

// @/lib/money/format
formatCents, sumCents, parseAmountToCents, parseQtyToMilli,
parseRateToTenThou, formatQty, formatRate, formatBasisPoints
```

**Scale contract, binding on all five plans.** Money is integer cents. Quantities are integer thousandths. Rates and percents are integer ten-thousandths. Margin is basis points. Multiplication happens in `BigInt` because a maximum quantity times a maximum rate exceeds `Number.MAX_SAFE_INTEGER`.

---

## Plan 2 — Application & worksheet

The largest plan, and the one carrying the most design risk.

**Scope**
- Cloudflare Access JWT validation in middleware; role resolution from `users`
- API route handlers for customers, projects, quotes, lines, rate cards, templates
- `AppShell` — expanded rail, collapsed rail, bottom tab bar
- Token layer: `globals.css` with the Budget Tracker palette, both themes, tenant accent injected from `organization`
- Primitives ported from Budget Tracker: `Money`, `TableWrap`, `AmountCell`, `ListRow`, `StatTile`, `EmptyState`, `Pill`, `PageHeader`, `RowDialog`, `Notice`, `Button`, `Card`
- New primitives: sum bar, margin gauge, sheet editor, money input, search-first line picker
- Screens: Today, Customers, Projects, Quote worksheet, Quote review, Rate card, Scope templates, Settings
- Present mode

**Tasks:** roughly 22–26.

**Risk, and where it actually is.** Not the CRUD screens. It is the worksheet: one DOM tree that is a table at `sm` and above and a stacked card list below, whose cells hold live inputs at every width. Budget Tracker's `data-table--stack` handles read-only tables; an editing surface is the untested extension. **This is the first thing to build and the first thing to look at on a real phone** — if the single-tree approach fails for editable rows, that is a Plan 2 architecture change, and it is far cheaper to discover in week one than week four.

**Security, non-negotiable and verified by test.** The app and database containers publish no ports. Access JWT signature, audience, and expiry are all verified. If the app is reachable directly, the header can be forged and authentication is bypassed entirely.

---

## Plan 3 — Documents

**Scope**
- Playwright and Chromium in the Docker image
- `/print/quote/[id]` — server-rendered, authenticated, print-only
- PDF service: launch, navigate to localhost, `page.pdf()`, write to disk, record on the quote
- Quote template: Plex Serif headings, letterhead from `organization`, logo inlined as a data URI, grouped lines, optional-upgrades block, tax breakdown by line with registration numbers, holdback and payment terms, exclusions, signature block
- Print CSS: `@page`, `break-inside: avoid`, repeating headers, `displayHeaderFooter` page numbering

**Tasks:** roughly 8–10.

**Risks.** Chromium adds ~300MB to the image and needs its font and system dependencies installed explicitly. PDF output must be deterministic enough to assert on — snapshot the extracted text and the page count, never the rendered bytes. Every string comes from `organization`; the white-label guard from Plan 1 Task 17 covers the templates too.

---

## Plan 4 — SharePoint & durability

**Scope**
- Generator: Drizzle schema → PnP provisioning template XML → `Provision-MapleQuote.ps1`
- Reserved-name mapping (`id` → `pg_id`, `created_at` → `pg_created_at`, `updated_at` → `pg_updated_at`), with the generator failing the build on a collision
- Provisioning script: lists, fields, views, indexes, six libraries, read-only permissions on synced lists, and bootstrapping the app-only registration
- Sync job: hourly, watermark per list, Graph `$batch`, 429 backoff, void propagation, chunked upload above 4MB
- `npm run restore:sharepoint` — rebuild in FK dependency order, download library files, rebuild watermarks, verify row counts
- Backup: hourly encrypted `pg_dump` to internal volume and USB with mount verification, nightly to SharePoint, retention ladder, weekly restore verification
- Staleness monitoring and alerting

**Tasks:** roughly 18–22.

**The seam that must not be missed.** Plan 1 stores scaled integers. **SharePoint must receive unscaled values** — a rate appears there as `4.0000`, not `40000`; a total as `4962.00`, not `496200`. The mirror is read by an accountant and by Power BI, so it carries human values. The restore path re-scales on the way back in. A round-trip test that asserts scale symmetry is mandatory, because getting this wrong is silent and only surfaces when someone reads a report.

**Everything here is behind `feature_flags.sharepoint_sync`,** off by default, and the full suite runs a second time with it disabled and no Graph credentials present.

---

## Plan 5 — First run & accountant export

**Scope**
- Setup wizard: organization, branding upload, financial including tax rates and fiscal year end, documents, features, first user, rate card
- Seed data: a placeholder rate card and scope templates, clearly marked, in `src/db/seed/` — the only directory the white-label guard exempts
- Accountant export: `exceljs` workbook plus CSV per sheet; Phase 1 sheets are cover and manifest, customers, projects, quotes with tax breakdown, pipeline summary
- Period calculation from fiscal year end and filing frequency
- Monthly write to the SharePoint `Exports` library, and on demand from Settings
- Second-tenant proof: stand up a different fictional company and assert its PDF and export carry none of the first one's details

**Tasks:** roughly 12–14.

**The cover sheet must state what is not included.** A Phase 1 export has no revenue and no expenses. An accountant handed a workbook with a "Quotes" sheet and no disclaimer may reasonably assume it is a complete set of books.

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

Plan 1, then Plan 2. Plans 3 and 4 in either order or together. Plan 5 last, since it depends on the export sheets existing and on the wizard having screens to render.

**Recommended checkpoint:** build the worksheet at the start of Plan 2, on a real phone, before the rest of Plan 2 is written. It is the highest-risk assumption in Phase 1 and the cheapest thing to be wrong about early.
