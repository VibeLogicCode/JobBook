# Phases 2–5 Design — Contractor Quote & Project Management System

**Companion to** `2026-08-30-maple-quote-design.md` (Phase 1) and `2026-08-30-ui-design.md`
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

`quote_lines.is_allowance boolean` plus `allowance_cents`.

An allowance is a placeholder the customer will spend against — "$5,000 tile allowance". It prices into the quote but is not a fixed commitment, and at completion it reconciles against actual cost, producing a credit or an extra. Without the flag, an allowance is indistinguishable from a firm price, and the reconciliation conversation with the customer has no data behind it.

### C3. Exclusions and assumptions

`quotes.exclusions_text`, `quotes.assumptions_text`, and a reusable `quote_clauses` library.

The most common source of a disputed job is a customer assuming something was included. These print on the document as their own block. A clause library means the owner is not retyping "permit fees by others" on every quote.

### C4. Substantial performance date

`projects.substantial_performance_date`.

Under the Ontario Construction Act this date starts the holdback release clock. Phase 4 cannot compute holdback release without it, and it is a property of the project, not of an invoice.

### C5. Vendor identity fields

Recorded in Phase 3's `vendors`, but named here because two are statutory:

- `business_number` — required on a T5018 slip.
- `tax_registration_number` — a supplier's GST/HST number is required on a receipt over $30 for the input tax credit to be claimable. Capturing it at receipt time is the difference between claiming an ITC and losing it.

---

## Phase 2 — Pipeline, activity, and reminders

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

`lead → contacted → site_visit_scheduled → site_visited → quoting → quote_sent → negotiating → won → in_progress → complete`, with `lost` and `on_hold` reachable from any stage.

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

**Inbound is deferred and explicitly so.** Polling a shared mailbox to create leads is genuinely useful and genuinely a project — threading, deduplication, attachment handling, spam. Phase 2 ships a "log an email" action and a paste-in-body form. Inbound automation is revisited after Phase 4, when there is evidence about whether it matters.

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

### 3.5 Screens

Receipt capture (camera-first, mobile), review queue, bulk expense grid, vendors, project cost view.

---

## Phase 4 — Change orders, purchase orders, invoicing, AP/AR

The largest phase and the one that decides whether the owner can plan cash.

### 4.1 Change orders — first class, never an edited quote

An accepted quote is what the customer signed. It must continue to say that. Scope changes after acceptance create a change order, which is separately priced, separately approved, and adjusts the contract value.

```
change_orders
  id, project_id, number, title, description,
  reason ENUM('customer_request','site_condition','design_change',
              'code_requirement','error_omission'),
  status ENUM('draft','sent','approved','rejected','void'),
  requested_at, sent_at, approved_at, approved_by_name, signature_file_id,
  subtotal_cents, tax_total_cents, total_cents, total_cost_cents, margin_bp,
  schedule_impact_days int

change_order_lines   -- identical shape to quote_lines, same snapshot rule
change_order_taxes   -- identical shape to quote_taxes
```

**Contract value is derived, never stored as a single editable number:**

```
contract_value = accepted_quote.total + sum(approved change_orders.total)
```

`schedule_impact_days` exists because unpriced time is how a contractor loses a job while appearing to break even on it. A change order that adds four days to a fixed-date job has a cost even when its line items are billed at full margin.

### 4.2 Purchase orders

```
purchase_orders
  id, vendor_id, project_id, number, status ENUM('draft','issued','partial',
    'received','closed','void'),
  issue_date, expected_date, subtotal_cents, tax_total_cents, total_cents, notes
purchase_order_lines
  id, purchase_order_id, cost_code_id, description, qty_milli, unit_type,
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
  id, invoice_id, cost_code_id, description, qty_milli, unit_type,
  unit_price_ten_thou, line_total_cents, is_taxable,
  source_quote_line_id, source_change_order_line_id
customer_invoice_taxes     -- snapshot, same rule as quotes
```

**Deposit accounting.** A deposit taken before work is unearned revenue, not income. It sits as a liability and draws down against progress invoices via `deposit_applied_cents`. Treating a deposit as revenue on receipt overstates income and understates it later, and the accountant will have to unwind it.

**Progress billing.** Amount = contract value × percent complete − previously invoiced. Holdback is withheld from the result, then tax applies. Order matters: tax is charged on the full progress amount, not on the post-holdback figure. Holdback is withheld from payment, not from the sale.

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
payments
  id, direction ENUM('in','out'),
  entity_type ENUM('customer_invoice','vendor_invoice','deposit','holdback'),
  entity_id, paid_at, amount_cents,
  method ENUM('cash','cheque','etransfer','eft','credit','other'),
  reference, notes
```

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

### 5.3 Compliance gate

Paying a subcontractor whose WSIB clearance has lapsed transfers liability for their premiums to the general contractor. That is a real financial exposure, not paperwork.

So: approving a vendor invoice or issuing a PO to a subcontractor with an expired clearance raises a **blocking warning with an explicit override**, and the override is recorded with the user and a reason. Hard-blocking would be wrong — sometimes the certificate is in an email and the work is done — but silence would be worse.

Expiry reminders at 30 and 7 days, through Phase 2's reminder engine.

### 5.4 Screens

Schedule (calendar and a simple Gantt), subcontractor directory, assignment board, compliance dashboard.

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

## Decisions this document defers to review

Recorded explicitly so they are answered rather than assumed.

1. **Percent complete** — owner's judgement, cost-to-cost ratio, or schedule-weighted? Cost-to-cost is defensible to an accountant; judgement is what contractors actually use. Proposal: store the owner's figure, display the cost-to-cost ratio beside it.
2. **Retainage on subcontractors** — does he actually withhold from subs, or only have it withheld from him? Changes whether `holdback_ledger` payable is built in Phase 4 or dropped.
3. **Multi-currency** — assumed no. Any US work would change `organization.currency` from a display setting into a transaction-level field.
4. **Inbound email** — deferred past Phase 4 above. Confirm or override.
5. **Time tracking** — his own hours and any employees'. Not in any phase. Absent from the requirements, but it is the usual next request after job costing, and adding it later means `expenses` needs a labour source.
6. **Customer portal** — quote acceptance by link, invoice viewing. Would remove the "did you get my quote" phone call, and needs anonymous tokenised access, which is a security surface. Not in any phase.
7. **Cost code standard** — a custom short list, or CSI MasterFormat divisions? MasterFormat is what an estimator expects and what a bookkeeper will recognise; a custom list is faster to use. Proposal: seed a short custom list, allow hierarchy so MasterFormat can be adopted later.
