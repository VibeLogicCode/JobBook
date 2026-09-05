# Phases 2–5 Design — Contractor Quote & Project Management System

**Companion to** `2026-08-30-scopeline-design.md` (Phase 1) and `2026-08-30-ui-design.md`
Date: 2026-08-30
Status: Awaiting review

Phase 1 covers quoting and documents. This document covers the remaining four phases at the same depth, so the shared data model can be reviewed as a whole before any of it is built.

**Why this exists.** The data model spans all five phases. A field missed in Phase 1 and discovered in Phase 4 is not a code change — it is a migration plus backfilling data nobody ever captured. The T5018 business number is the worked example: one line in a spec now, or a year of invoices reviewed by hand at the first year end.

Everything in Phase 1's Global Constraints applies here: nothing is ever deleted, no tenant-specific value outside seed files, money as integer cents, rates snapshotted, `updated_at` by trigger, scale is internal.

---

## Cross-phase additions to Phase 1

Five things belong in the Phase 1 schema even though they are only exercised later. Each is cheap now and expensive to retrofit.

### C1. Contract type on projects

`projects.contract_type ENUM('lump_sum','unit_price','cost_plus','time_and_material')`.

A lump-sum basement finish and a cost-plus commercial fit-out bill differently, hold different risk, and produce different change-order behaviour. Assuming lump sum everywhere is why generic job software stops fitting a GC at about the third job.

### C2. Allowances

`quote_lines.is_allowance boolean`. No separate `allowance_cents` — it would duplicate `line_total_cents`.

An allowance is a placeholder the customer will spend against — "$5,000 tile allowance". It prices into the quote but is not a fixed commitment, and at completion it reconciles against actual cost, producing a credit or an extra. Without the flag, an allowance is indistinguishable from a firm price, and the reconciliation conversation with the customer has no data behind it.

### C3. Exclusions and assumptions

`quotes.exclusions_text`, `quotes.assumptions_text`, and a reusable `quote_clauses` library.

The most common source of a disputed job is a customer assuming something was included. These print on the document as their own block. A clause library means the owner is not retyping "permit fees by others" on every quote.

### C4. Substantial performance date

`projects.substantial_performance_date`.

Under the Ontario Construction Act this date starts the holdback release clock. Phase 4 cannot compute holdback release without it, and it is a property of the project, not of an invoice.

### C5. Vendor identity fields

Recorded in Phase 3's `vendors`, but named here because two are statutory. `cost_codes` itself moved into Phase 1, since quote lines snapshot a cost code and without it no Phase 1 quote can ever be costed.

- `business_number` — required on a T5018 slip.
- `tax_registration_number` — a supplier's GST/HST number is required on a receipt over $30 for the input tax credit to be claimable. Capturing it at receipt time is the difference between claiming an ITC and losing it.

---

## Phase 2 — Pipeline, activity, and reminders

> **Execution plan:** `../plans/2026-09-04-phase2-pipeline-and-reminders.md`.
> Three decisions taken there change what this section describes: the reminder
> engine is built **before** the pipeline board, outbound email in §2.4 is
> **deferred** in favour of a log-an-email action, and idempotency is enforced
> by a unique partial index rather than an application check. Where the two
> documents disagree, the plan is the later thought.


**Purpose.** The owner's process starts with a phone call or an email and ends at a completed job. Today that lives in his head and his text messages. This phase makes the pipeline visible and stops follow-ups being forgotten.

### 2.1 Data model

```
activities
  id, entity_type ENUM('customer','project','quote'), entity_id,
  kind ENUM('call_in','call_out','email_in','email_out','sms',
            'site_visit','meeting','note'),
  occurred_at, subject, body, duration_minutes, user_id
  INDEX (entity_type, entity_id, occurred_at DESC)

stage_history
  id, project_id FK, from_stage, to_stage, changed_at, changed_by, note
  -- time in stage is derived, never stored

reminders
  id, entity_type, entity_id,
  title, detail, due_at, kind ENUM('callback','follow_up','quote_expiring',
                                   'site_visit','compliance','custom'),
  status ENUM('open','done','dismissed'), completed_at, completed_by,
  assigned_to, snoozed_until,
  recurrence ENUM('none','daily','weekly','biweekly','monthly'),
  recurrence_until DATE, generated_by_rule_id

reminder_rules          -- automations, editable in settings
  id, name, trigger ENUM('quote_sent','quote_expiring','stage_entered',
                         'no_activity','site_visit_scheduled','project_won'),
  trigger_stage,        -- for stage_entered
  offset_days int,      -- negative means before
  reminder_kind, title_template, is_active
```

### 2.2 Stage model

Phase 1's nine stages stand unchanged: `lead → site_visit → quoting → quote_sent → won → in_progress → complete`, with `lost` and `on_hold` reachable from any stage.

An earlier draft added `contacted`, `site_visit_scheduled`, `site_visited`, and `negotiating`. They are dropped. Each extra stage is a column on a board, a filter, a reminder rule, and a row in every stage report — and for a contractor running four jobs, the distinction between "contacted" and "lead" is not one he will maintain by hand. Stages people do not update honestly are worse than fewer stages.

Stage changes write `stage_history`. Time in stage is computed from it, never stored — a stored duration is wrong the moment the clock ticks.

Won requires an accepted quote. Lost requires a reason. Both are enforced in the transition, not the UI.

### 2.3 Automations

Run by `node-cron`, evaluated hourly against `reminder_rules`. Seeded defaults, all editable:

| Trigger | Default | Produces |
|---|---|---|
| `quote_sent` | +3 days | "Follow up on quote to {customer}" |
| `quote_expiring` | −5 days | "Quote {number} expires in 5 days" |
| `site_visit_scheduled` | −1 day | "Site visit tomorrow at {address}" |
| `no_activity` | +14 days | "No contact with {customer} in 14 days" |
| `project_won` | +1 day | "Won {project} — confirm start date and deposit" |

Rules generate reminders idempotently: a rule that has already produced an open reminder for an entity does not produce a second. Without that, an hourly job creates twenty-four duplicates a day.

### 2.4 Email

**Outbound:** `nodemailer` over Microsoft 365 SMTP, or Graph `sendMail` when SharePoint sync is already configured. Sending a quote records an `email_out` activity and sets `quotes.sent_at`.

**Inbound is deferred.** Polling a shared mailbox to create leads is genuinely useful and genuinely a project: threading, deduplication, attachment handling, spam. Phase 2 ships a "log an email" action and a paste-in-body form.

The review recommended cutting it permanently. Recorded as deferred rather than cut, because the owner's own description of his process began with a call or an email — that is a stated requirement, and the reviewer was weighing scope rather than overriding him. Revisited after Phase 4, when there is evidence about whether the manual path is actually painful.

### 2.5 Screens

- **Today** gains a reminders panel: due, overdue, snoozed.
- **Pipeline** — board by stage, project cards showing customer, value, days in stage, next reminder. Below `sm`, a stage-filtered list rather than a horizontally scrolling board.
- **Customer detail** gains an activity timeline.
- **Reminders** — list with complete, snooze, reschedule.

---

## Phase 3 — Receipts, vendors, and job costing

**Purpose.** Kill the shoebox. Every dollar spent lands against a project and a cost code on the day it is spent, so year end is an export rather than an archaeology project.

### 3.1 OCR — already solved

Budget Tracker ships a working local receipt pipeline: `jscanify` and `@techstark/opencv-js` for edge detection and deskew, `tesseract.js` and `onnxruntime-node` for recognition, with vendored model assets and a runtime probe. **This phase reuses that stack.** It is free, local, offline, and has no per-page cost, which removes the Azure Document Intelligence dependency the architecture originally assumed.

The file-by-file inventory, what does NOT port, and the image-size question are in `2026-09-04-reuse-from-budget-tracker.md` §2.

Its exact version pins carry over. Those packages are pinned for documented reasons — the ONNX runtime's kernels and the OpenCV 4.7 to jscanify 1.4.3 pairing — and a silent minor bump is a real regression risk.

### 3.2 Data model

```
vendors
  id, name, legal_name, contact_name, email, phone,
  address_line1, city, province, postal_code,
  business_number,            -- T5018 requirement
  tax_registration_number,    -- required on receipts over $30 for an ITC
  is_subcontractor bool, trade, payment_terms_days,
  default_cost_code_id, notes

cost_codes
  id, code, name, parent_id, category, is_active
  -- hierarchy: division then section, e.g. 06 Wood -> 06-10 Framing

expenses
  id, vendor_id, project_id, cost_code_id,
  expense_date, description, reference,
  subtotal_cents, tax_total_cents, total_cents,
  payment_method ENUM('cash','debit','credit','cheque','etransfer','account'),
  receipt_file_id FK files,
  vendor_tax_number_captured,     -- copied from the receipt, not the vendor record
  source ENUM('manual','ocr','import'),
  ocr_confidence numeric, ocr_raw jsonb,
  status ENUM('captured','review','posted'),
  is_billable bool, billed_on_invoice_id

expense_taxes
  id, expense_id, label, rate_ten_thou, tax_amount_cents, is_recoverable
  -- broken out because an input tax credit is claimed per tax, not per receipt
```

`vendor_tax_number_captured` is deliberately a copy taken from the receipt rather than a join to `vendors`. A vendor's registration can change, and the claim is evidenced by what the receipt said on the day.

### 3.3 Capture workflow

1. Photograph or upload. Image stored through `files`, local disk authoritative.
2. Deskew and recognise locally. Candidates extracted: vendor, date, subtotal, tax, total, tax number.
3. Row lands in a **review queue** at `status = 'review'` with candidates pre-filled and confidence shown.
4. Owner confirms or corrects, assigns project and cost code, posts.

OCR proposes; a person posts. Nothing reaches the books on machine confidence alone. Budget Tracker's review-queue pattern is the model.

Bulk entry matters as much as OCR: an owner catching up on forty receipts at a kitchen table needs a fast keyboard-driven grid, not forty photographs.

### 3.4 Job costing

Per project, per cost code:

| Column | Source |
|---|---|
| Quoted | Accepted quote lines, grouped by cost code |
| Committed | Open purchase orders (Phase 4) |
| Actual | Posted expenses and vendor invoices |
| Remaining | Quoted − Actual |
| Variance | Quoted − (Actual + Committed) |

Mapping quote lines to cost codes requires `rate_items.cost_code_id`. **That field must exist in Phase 1's `rate_items`**, or the first job-costing view has nothing to group by.

### 3.5 Payments arrive here, not in Phase 4

`payments` (section 4.5) is built in Phase 3 rather than Phase 4.

Deposits and progress payments are received long before the invoicing subsystem exists, and cash payments to subcontractors with no invoice behind them are routine on a residential job. Without a payments table in Phase 3, those either go unrecorded or get recorded as expenses, and the T5018 total — which is cash-basis on payments to subcontractors — cannot be reconstructed later.

### 3.6 The accountant export ships here

Moved forward from Phase 1. Phase 3 is the first phase with expenses and recoverable tax, which is the first point an export is a set of books rather than a list of quotes. Period logic derives from the Phase 1 settings (`fiscal_year_end_month`, `fiscal_year_end_day`, `tax_filing_frequency`).

### 3.7 Screens

Receipt capture (camera-first, mobile), review queue, bulk expense grid, vendors, project cost view.

---

## Phase 4 — Change orders, purchase orders, invoicing, AP/AR

The largest phase and the one that decides whether the owner can plan cash.

### 4.1 Change orders — already built, in Phase 1

An earlier draft specified `change_orders`, `change_order_lines`, and `change_order_taxes` as three new tables here. **All three are deleted.**

A change order is a quote with a parent: the same lines, the same tax snapshot, the same calculation engine, the same versioning and acceptance flow, and the same PDF with a different heading. Duplicating that produced three tables, a second engine to keep in step, and a second PDF template — and, worse, it put mid-job extras in Phase 4 when they are the single most common thing a contractor needs after a quote is accepted.

So `quotes` carries `kind`, `parent_quote_id`, `sequence`, `reason`, and `schedule_impact_days`, and change orders work from **Phase 1**. See sections 4 and 5.6 of the Phase 1 spec. Deductive change orders are negative rates.

Contract value is derived as the sum of accepted, active quotes on the project. There is no stored contract value column.

### 4.2 Purchase orders

```
purchase_orders
  id, vendor_id, project_id, number, status ENUM('draft','issued','partial',
    'received','closed','void'),
  issue_date, expected_date, subtotal_cents, tax_total_cents, total_cents, notes
purchase_order_lines
  id, purchase_order_id, cost_code_id, description, qty_milli,
  calc_mode, unit_label,
  unit_price_ten_thou, line_total_cents, received_qty_milli
```

A PO is the "committed" column in job costing. Its value is that the owner sees money spent before the invoice arrives.

### 4.3 Customer invoicing

```
billing_schedule            -- how a project bills
  id, project_id, sort_order, name,
  basis ENUM('deposit','percent_complete','milestone','fixed_amount','final'),
  percent_ten_thou, amount_cents, planned_date, invoice_id, status

customer_invoices
  id, project_id, number,
  kind ENUM('deposit','progress','final','holdback_release','change_order'),
  issue_date, due_date, period_from, period_to,
  subtotal_cents, tax_total_cents,
  holdback_cents,           -- withheld from this invoice
  deposit_applied_cents,    -- drawn down from customer advances
  total_cents, amount_due_cents,
  status ENUM('draft','sent','partial','paid','overdue','void'),
  sent_at, paid_at
customer_invoice_lines
  id, invoice_id, cost_code_id, description, qty_milli,
  calc_mode, unit_label,
  unit_price_ten_thou, line_total_cents, is_taxable,
  source_quote_line_id, source_change_order_line_id
customer_invoice_taxes     -- snapshot, same rule as quotes
```

**Deposit accounting.** A deposit taken before work is unearned revenue, not income. It sits as a liability and draws down against progress invoices via `deposit_applied_cents`. Treating a deposit as revenue on receipt overstates income and understates it later, and the accountant will have to unwind it.

**Progress billing.** Amount = contract value × percent complete − previously invoiced. Holdback is withheld from that result.

**Tax ordering — corrected.** An earlier draft asserted that tax is charged on the full progress amount rather than the post-holdback figure, on the reasoning that holdback is withheld from payment rather than from the sale. **That is wrong for Canada.**

Under Excise Tax Act s.168(7), where a holdback is retained under provincial legislation or a written construction contract, tax on the held-back amount is not payable until the holdback is paid out or is required to be paid out. Standard Ontario practice therefore taxes **(progress − holdback)** on each progress invoice, and taxes the holdback on the release invoice.

`organization.tax_deferred_on_holdback` gates this, seeded true for Ontario, so a jurisdiction without the deferral still bills correctly.

**Deposit tax.** A deposit invoice charges tax at the time it is issued. When the deposit is drawn down against a progress invoice, the drawdown reduces that invoice's **taxable base** before tax is computed — otherwise the same dollar is taxed twice.

**Percent complete** is the owner's judgement, stored per invoice, with the cost-to-cost ratio displayed beside it for reference and never used for billing. Cost-to-cost is what an accountant will defend; judgement is what contractors actually use, and storing the figure that was billed is what makes the invoice reproducible.

### 4.4 Holdback

```
holdback_ledger
  id, project_id, direction ENUM('receivable','payable'),
  counterparty_type ENUM('customer','vendor'), counterparty_id,
  accrued_cents, released_cents, invoice_id,
  release_eligible_date,   -- substantial performance + statutory period
  released_at, notes
```

Holdback receivable is money earned and not yet collectable. It must be a separate AR bucket. Folded into ordinary AR, the cash view overstates available cash by the holdback percentage of every active job — for a GC running four jobs, that is a materially wrong number to plan against.

Holdback payable is the mirror: amounts withheld from subcontractors, owed on the same clock.

`release_eligible_date` derives from `projects.substantial_performance_date` plus the statutory period from `organization.holdback_release_days` (Ontario: 60). Configurable, because the period differs by province.

### 4.5 Payments and aging

```
payments                  -- built in Phase 3; see section 3.5
  id, direction ENUM('in','out'),
  entity_type ENUM('customer_invoice','vendor_invoice','deposit','holdback'),
  entity_id,              -- nullable: a cash payment may have no invoice
  counterparty_type ENUM('customer','vendor'), counterparty_id,
  paid_at, amount_cents,
  method ENUM('cash','cheque','etransfer','eft','credit','other'),
  reference, notes
```

`counterparty_type` and `counterparty_id` are not redundant with `entity_id`. T5018 reporting is cash-basis on payments to subcontractors, and a cash payment with no invoice behind it still has to appear on the slip — so the payee must be recorded on the payment itself, not inferred through an invoice that may not exist.

`customer_invoices` additionally snapshots `contract_value_at_invoice_cents`, `percent_complete_ten_thou`, and `previously_billed_cents`. Without them a progress invoice cannot be reproduced once a later change order moves the contract value.

`expenses` gains `allowance_quote_line_id`, so an allowance reconciles against the actual cost that was spent under it.

Partial payments are the norm, so an invoice's status derives from the sum of its payments rather than being set by hand.

Aging buckets on both sides: current, 1–30, 31–60, 61–90, 90+. Holdback is reported separately from every bucket.

**Prompt Payment.** Ontario gives 28 days to pay a proper invoice and 7 days onward to subcontractors. `customer_invoices.due_date` derives from `organization.payment_terms_days`; vendor due dates derive from `vendors.payment_terms_days`. Reminder rules key off both.

### 4.6 Cash flow view

The screen the owner asked for without naming it: by week, expected AR receipts against scheduled AP payments, with holdback shown separately and open POs as a forward commitment. A twelve-week horizon, not a forecast model.

### 4.7 Screens

Change orders, purchase orders, customer invoices, vendor invoices, payments, AP aging, AR aging, cash flow, holdback ledger.

---

## Phase 5 — Scheduling and compliance

### 5.1 Data model

```
schedule_tasks
  id, project_id, name, cost_code_id, trade,
  planned_start, planned_end, actual_start, actual_end,
  percent_complete_ten_thou, is_milestone,
  predecessor_task_id, lag_days, sort_order,
  status ENUM('not_started','in_progress','blocked','complete')

assignments
  id, schedule_task_id, vendor_id,
  confirmed_at, declined_at, agreed_amount_cents, purchase_order_id, notes

compliance_documents
  id, vendor_id,
  kind ENUM('wsib_clearance','liability_insurance','license',
            'safety_certificate','other'),
  document_number, issuer, issued_at, expires_at,
  file_id FK files, status ENUM('valid','expiring','expired','missing')
```

### 5.2 Planned versus actual

Both pairs of dates are stored so slippage is measurable. Overwriting a planned date with an actual one destroys the only evidence of how estimates perform, which is the data that makes the next quote better.

Dependencies are single-predecessor with a lag. Full critical-path scheduling is deliberately excluded: a GC running four residential jobs does not need CPM, and it would be the most complex code in the product serving the least-used screen.

The "simple Gantt" an earlier draft promised is also cut. A list ordered by planned date, plus a calendar view, answers every question the owner actually asked — who is on site this week, what is late — without a custom timeline renderer to maintain across three breakpoints.

### 5.3 Compliance gate

Paying a subcontractor whose WSIB clearance has lapsed transfers liability for their premiums to the general contractor. That is a real financial exposure, not paperwork.

So: approving a vendor invoice or issuing a PO to a subcontractor with an expired clearance raises a **blocking warning with an explicit override**, and the override is recorded with the user and a reason. Hard-blocking would be wrong — sometimes the certificate is in an email and the work is done — but silence would be worse.

Expiry reminders at 30 and 7 days, through Phase 2's reminder engine.

### 5.4 Screens

Schedule (a date-ordered list and a calendar), subcontractor directory, assignment board, compliance dashboard.

---

## Accountant export — full sheet list

Extends section 9 of the Phase 1 spec.

| Sheet | Phase | Contents |
|---|---|---|
| Cover and manifest | 1 | Company, tax number, period, generated at, **what is not included** |
| Customers | 1 | Including exemption numbers |
| Projects | 1 | Contract type, contract value, stage, dates |
| Quotes | 1 | With tax breakdown |
| Pipeline summary | 1 | By stage, value, count |
| Vendors | 3 | Including business number and tax registration |
| Expenses | 3 | By category and cost code, with vendor tax number |
| Input tax credits | 3 | Recoverable tax by period — the ITC claim |
| Sales invoices | 4 | With tax collected |
| Tax summary | 4 | Collected minus recoverable, by filing period |
| AR aging | 4 | Buckets, holdback separate |
| AP aging | 4 | Buckets, holdback separate |
| Holdback | 4 | Receivable and payable, with release dates |
| Customer deposits | 4 | Unearned revenue at period end |
| Change orders | 4 | Approved, by project |
| Work in progress | 4 | Open projects: contract value, cost to date, billed to date |
| **T5018** | 4 | Subcontractors paid over $500: name, address, business number, total |
| Subcontractor compliance | 5 | Clearance status at period end |

---

## Decisions, resolved

These were deferred to review and have been decided. Recorded with the reasoning so they are not silently revisited.

| Question | Decision |
|---|---|
| Percent complete | Owner's judgement, stored per progress invoice. Cost-to-cost ratio shown beside it, never used for billing |
| Subcontractor retainage | `holdback_ledger.direction` stays. Receivable is built in Phase 4; the payable UI waits until the owner confirms he withholds from subs |
| Multi-currency | No. One currency per deployment, display-only |
| Inbound email | Deferred past Phase 4, not cut — it is a stated requirement (section 2.4) |
| Time tracking | Not in any phase. `expenses.source` is an extensible enum, so no schema accommodation is needed now |
| Customer portal | No. Acceptance is recorded by the owner against an uploaded signed PDF. A portal needs anonymous routes through Cloudflare Access, which would undo the security posture |
| Cost code standard | A short custom list with `parent_id`, seeded from the rate categories. MasterFormat can be adopted later if the accountant asks |

Two further calls affecting these phases:

- **`admin` stays in the role enum, and nothing is built for it.** Owner and bookkeeper are the two real roles for now; removing the value later is a migration, keeping it costs nothing.
- **The `payments` table moves to Phase 3**, so deposits and cash payments to subs are recordable before the invoicing subsystem exists.
