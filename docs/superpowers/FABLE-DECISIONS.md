# Review decisions — 2026-08-30

Fable reviewed all five documents end to end as delegated decision-maker. 43 decisions, 18 must-fix findings, 15 cuts. This is the summary; the full review is in the task transcript.

**Three of its findings were bugs in my plan, not matters of opinion.** Those are listed first.

---

## Bugs it caught in Plan 1

**1. Every test would have wiped the development database.** `.env.example` defined `TEST_DATABASE_URL`, but `client.ts` only ever read `DATABASE_URL`. Ten test files calling `truncate` would have run against dev data. Compounded by Vitest running files in parallel workers, so they would also have interleaved.

**2. `allocateProjectNumber` incremented the wrong counter.** It advanced `nextInvoiceSeq` using `invoiceNumberPrefix` — projects would have silently consumed invoice numbers. Also `new Date().getUTCFullYear()`: a quote created at 8pm Toronto on December 31 gets next year's number.

**3. The no-DELETE test proved nothing.** `SET LOCAL role` outside a transaction is a no-op, so the `DELETE` would have run as superuser — the test either fails for the wrong reason or wipes the table.

All three are fixed before Task 1 runs.

---

## The decisions that change the product

**Optional upgrades were printing the wrong price.** Percent lines (overhead, profit) apply only to *included* lines. So a $500 upgrade shown on the quote actually raises the total by $550 under 10% overhead. Printing one number and invoicing another is a customer-facing correctness bug. Excluded lines are now grossed up, and there's a test pinning it.

**Change orders are just quotes with a parent.** Deletes three tables (`change_orders`, `_lines`, `_taxes`), reuses the same engine, the same PDF, the same versioning — and makes mid-job extras possible in **Phase 1** instead of Phase 4. Deductive change orders are negative rates. Contract value becomes the sum of accepted quotes on a project.

**Linear feet didn't exist.** The `unit_type` enum (`sqft`/`each`/`flat`/`percent`/`hour`) conflated *how a line calculates* with *what it's labelled*. Baseboard, trim, countertop, and fencing are all priced per linear foot and could not be entered at all. Now `calc_mode` (`qty`/`flat`/`percent`) plus a free-text `unit_label`, which also lets a metric deployment say m².

**Quote lines had no provenance, so job costing was impossible.** I over-applied the snapshot rule: it's about *prices*, not *origin*. Without `cost_code_id` on a line, Phase 3 has nothing to group actual costs against. Added, and never read for pricing.

**Ontario holdback tax — I had this wrong.** My spec said tax applies to the full progress amount. Under Excise Tax Act s.168(7), tax on a statutory holdback is deferred until the holdback is paid or becomes payable. Standard practice taxes (progress − holdback) and taxes the holdback on release. Fable cited CRA sources.

**Graph credentials would have leaked into every backup.** The wizard was going to write them into `feature_flags.config` — a table that syncs to SharePoint and lands in every database dump. `feature_flags` is cut entirely; flags and secrets are environment variables.

**The PDF print route had a hole.** Playwright hits `localhost` from inside the container, bypassing Cloudflare Access — so the route was either unauthenticated or unspecified. Now gated by an internal render secret.

**Sync would silently lose rows.** Two mechanisms: `now()` is transaction *start* time, so a row committed after the watermark read but stamped before it never syncs; and bulk inserts share one `updated_at`, so advancing past a 20-row batch skips the rest of a 40-line quote. Fixed with a keyset cursor and a 5-minute safety lag. Also: Graph has no upsert by arbitrary key, so a local id map is required — the spec assumed one existed.

---

## Cuts

Scope removed on the grounds that one part-time maintainer supports three users:

- **Restore-from-SharePoint-lists.** The mirror passes through IEEE doubles, 255-char text limits, and Choice validation; `pg_dump` is byte-exact and has the same 1-hour recovery point. The mirror stays for reading, reporting, and the accountant.
- **`rate_cards`.** Multiple cards meant recreating every template against new rows. Snapshotting already protects history.
- **PWA service worker.** There is no offline quoting against a server-side database; it would have shipped a "you're offline" page.
- **Email alerting from the app** → a dead-man's-switch ping, because the realistic failure is the mini PC being unplugged, and an email job on a dead box sends nothing.
- Separate quote numbering, `feature_flags` UI, per-list SharePoint permission surgery, Phase 2's extra pipeline stages, inbound email, customer portal, Phase 5's Gantt.
- **Phase 1's accountant export moves to Phase 3** — a "Quotes" sheet isn't books.

## The seven open questions, answered

| Question | Decision |
|---|---|
| Percent complete | Owner's judgement, stored per invoice; cost-to-cost shown beside it, never used for billing |
| Sub retainage | Keep the ledger's direction column; build receivable now, payable only if he confirms he withholds |
| Multi-currency | No |
| Inbound email | Cut permanently |
| Time tracking | Not in any phase |
| Customer portal | No — acceptance is a signed PDF the owner uploads |
| Cost codes | Custom short list with hierarchy, seeded from rate categories |

Plus: **the single-DOM-tree editable worksheet is sound**, on three conditions — explicit ARIA roles (display changes drop table semantics in Safari), `position: sticky` on cells rather than rows, and below `sm` the inline inputs are `readOnly` with the row tap opening the sheet as the only editor.

---

## Where I disagree

Passing these through rather than accepting them silently.

**USB backup — I'm keeping it.** Fable cut the tier as duplicating hourly SharePoint dumps at the same recovery point. That's technically true, but you asked for it directly, and it covers a failure SharePoint does not: no internet, a tenant lockout, or an account dispute. I'm keeping it in simplified form — the same encrypted dump copied to the drive, with the mount check, and dropping the grandfather-father-son ladder Fable objected to.

**Quote numbers — worth a second look.** Fable replaced them with project number + revision, on the grounds a customer sees one job. Contractors do reference quote numbers on the phone, and it flagged this as a close call itself. Reversible either way; say if you want them back.

**Inbound email — "cut permanently" is stronger than the evidence.** You said the process starts from a call or email. Cutting the automation is right for now, but I'd call it deferred rather than permanent.

---

## Build order

1. **Tonight, no database:** the pure calculation engine — arithmetic, formatting, lines, percent, tax, totals, template expansion.
2. **Morning, with Postgres:** schema, triggers, numbering, quote repository.
3. **Two one-day spikes in parallel:** the editable worksheet on a real phone, and Playwright PDF inside Docker. These are the two packaging risks.
4. **Backup before any real data.** Non-negotiable ordering — backups precede the first real quote.
5. Then the application, documents, the SharePoint mirror, and first-run setup.

## Close calls it flagged itself

Its own list of what would change its mind: quote numbering if you quote alternates as separate documents; rate cards if you price commercial from a different sheet; restore-from-lists if the SharePoint tenant can't hold encrypted dumps; cost codes if your accountant asks for MasterFormat.
