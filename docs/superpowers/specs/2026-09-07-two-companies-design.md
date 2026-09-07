# Two companies under one owner

**2026-09-07.** Agreed with the owner. **Not scheduled. Nothing here is
built.** Written now because the cheap half of it constrains work that is
already queued, and because three of the changes it needs are far cheaper as
part of the next migration than as a retrofit.

The owner's question: *"what if the same owner has 2 companies that are sister
concerns. 1 does small jobs basement, house hold repairs where its mostly cash
or small jobs, other company is a property home builder. can we setup logic in
this so owner has option of 2 companies to quote from and based on the company
they quote for requirements apply... example smaller company doesnt have AP AR,
would have a lot simpler quote and job process so its less confusing and less
wasted form using this app for small company."*

Reviewed by Fable on 2026-09-07 at the owner's request. Its findings are
folded in throughout.

---

## 1. The one sentence that reorganises the rest

**The owner asked for two companies. What he described wanting is a simpler
form.**

Every symptom he named -- *"a lot simpler quote and job process"*, *"less
confusing"*, *"less wasted form"* -- is about form complexity. None is about
corporate identity. Two companies is the mechanism he reached for; a shorter
quote is the outcome he wants.

Those are separable, and separating them is most of the value in this
document:

- **Simple mode** keyed on the JOB, not the company (§3). Cheap. Delivers what
  he described. Independent of everything else here.
- **Two companies** (§4). Moderate. Buys exactly one thing the first cannot:
  the small company's own legal name and HST registration number on its own
  paper.
- **The per-company visibility wall** (§6). Expensive. Deferred, with a stated
  condition for when it stops being deferrable.

Keying on the job is not merely cheaper, it is more correct. The builder will
do warranty visits and punch lists that deserve the short flow. The repair
company will eventually land a full basement that deserves the long one. A
company-level switch gets both of those wrong, and it cannot be overridden per
job without becoming the per-job setting anyway.

---

## 2. What the owner confirmed

Asked on 2026-09-07, because the answers change the design and three of them
eliminated options outright.

| Question | Answer | What it settles |
|---|---|---|
| Separate legal entities? | **Not decided yet.** *"can we do both where this is asked as part of setup"* | Both shapes must be supportable. Single-company must stay the default and stay invisible. |
| What is shared? | **Customers, rate book and cost codes, subs and suppliers.** All three. | Kills two separate deployments. Two databases cannot share a customer record. |
| Does a job move between them? | **No. A job belongs to one.** | The company is a stamp written once. No re-numbering, no inter-company billing, no split jobs. |
| Do staff see both? | **Some see only one** -- but nobody starts for months. | The company is a permission boundary eventually, and a filter until then. |
| "Mostly cash"? | **Invoiced-and-paid-in-cash, and receipt-only.** Nothing off books. | Adds a receipt document (§3.3). Declines nothing. |
| Small company HST-registered? | **Yes, and charges HST.** | Per-company tax registration is required rather than optional. |

**On "asked as part of setup": no.** §5 explains why that question must not be
asked at all, and what has to be true instead.

---

## 3. Simple mode (Wave A)

Keyed on `project_types`, which is already a maintained database list with a
case-insensitive uniqueness index and a retire-rather-than-delete rule. It
gains flags.

### 3.1 What a simple job hides

Not a shorter form with the same fields. A different set of fields, because a
field that does not apply is worse than a field that is merely long:

| Hidden | Why it does not apply to a repair |
|---|---|
| Holdback percent, label, terms, release days | The Construction Act's holdback regime is not what a homeowner signs for a leaking tap. |
| The `progress` and `holdback_release` invoice kinds | A one-day job is invoiced once. |
| Schedule templates and the forward pass | Three tasks do not want a critical path. |
| Area, washrooms, kitchens, bedrooms scope inputs | Written for a build. |
| Construction Act dates (substantial performance, publication, last supply) | Same regime as holdback. |
| Target margin gauge | Not wrong, just noise at this size. |

`deposit`, `final` and `change_order` stay. So does tax, because the company
is registered.

### 3.2 Where the flags live, and one deliberate override

Flags go on `project_types` as columns. `src/db/schema/system.ts` states the
opposite rule in as many words: *"There is deliberately no feature_flags table
-- flags and credentials are environment variables, because a mirrored table
ends up in SharePoint and in every backup, and secrets must never enter the
database."*

**That rule is overridden here, deliberately, and the distinction is what
makes it safe.** The rule protects CREDENTIALS. A product-shape flag is not
one: nothing about "this kind of job has no holdback" is a secret, and
appearing in a backup or a SharePoint mirror costs nothing. What the rule
actually forbids -- a token or a client secret in a mirrored row -- is
untouched.

The other half of that comment still binds: *"Absence is the off state, so no
defaulted column can switch a feature on for someone who never asked."* So
every flag defaults to the CURRENT behaviour. A deployment that never touches
this sees no change.

### 3.3 The receipt

The owner issues receipts rather than numbered invoices on some small jobs.
Legitimate, and it adds a document.

**The money row exists either way.** He collects HST and has to remit it, so
the sale must be in the app regardless of what paper the customer gets. A
receipt is therefore the same `customer_invoices` row with a compact print
template -- same series, same tax lines, less paper. NOT a second document
type that skips the ledger.

There is currently one print route, `/print/quote`, so this is new work rather
than a change. It belongs with AP/AR in Phase 3 rather than in Wave A.

---

## 4. Two companies (Wave B)

### 4.1 The name

**`companies`, never `entities`.** `files.entity_type` / `entity_id` already
exists and means *"which record does this file attach to"* -- a quote, a
project, an expense. Two meanings for one word in one schema is how a query
gets written against the wrong thing and passes review.

### 4.2 The split

`organization` has 41 columns and a single-row CHECK at
`src/db/schema/organization.ts:93`. **The check stays.** `organization`
remains the deployment; a new `companies` table holds the issuer.

**Moves to `companies`** -- everything that is a fact about a legal person or
appears on its paper:

`legalName`, `displayName`, `operatingName`, `tagline`, `ownerName`,
`ownerTitle`, `logoFileId`, `faviconFileId`, `brandColor`, `addressLine1`,
`addressLine2`, `city`, `province`, `postalCode`, `country`, `phone`,
`altPhone`, `email`, `website`, `taxRegistrationNumber`,
`taxRegistrationLabel`, `businessNumber`, `fiscalYearEndMonth`,
`fiscalYearEndDay`, `taxFilingFrequency`, `taxDeferredOnHoldback`,
`defaultHoldbackPctTenThou`, `holdbackLabel`, `holdbackTermsText`,
`holdbackReleaseDays`, `paymentTermsDays`, `paymentTermsText`,
`insuranceStatement`, `targetMarginBp`, `quoteValidityDays`,
`quoteTermsText`, `documentFooterText`.

**Stays on `organization`** -- facts about the deployment, which two companies
sharing one office cannot disagree about without one of them being wrong:

`currency`, `locale`, `timezone`, `areaUnit`, `mileageRatePerKmTenThou`.

`tenantYear` (`src/lib/quote/numbering.ts:30`), `tenantToday`
(`src/lib/quote/dates.ts:17`) and the reminder evaluation
(`src/lib/reminders/repository.ts:85`) all read the timezone and are therefore
unchanged.

**`companies.id` is a uuid.** `src/db/schema/system.ts:16-27` already
documents that `files.entity_id` is a uuid and cannot point at
`organization`'s integer id -- and two companies need two logos.

**The variant to refuse:** dropping the single-row check and treating each
`organization` row as a company. It puts `timezone` and `currency` on two rows
that must agree, and inherits the integer-key problem. Cheaper-looking, wrong.

### 4.3 Three columns that must land in the FIRST migration

This is the part with a deadline. Adding a second company later must need no
data migration, and that is true only if these hold from the moment companies
exist at all:

1. **`projects.company_id NOT NULL`.** Every existing job is already correctly
   stamped when company two arrives, because they were all company one's.
2. **`document_sequences` rekeyed `(company_id, kind, year)`.** Company one
   keeps its history; company two starts at 0001. Nothing is renumbered, ever.
3. **`tax_rates.company_id NOT NULL`.** Company two brings its own
   registration number and its own rates.

Get these wrong and "add a company" becomes a migration on live data at the
worst possible moment -- the day the owner incorporates.

### 4.4 The company goes on `projects` only

Not on quotes, not on invoices, not yet.

Every document already reaches its project through a NOT NULL foreign key:
`quotes.project_id`, `customer_invoices.project_id`, `expenses.project_id`,
`holdback_ledger.project_id`, `schedule_tasks`. Every loader already joins
projects for the customer name, so the join is free.

**Because a job never moves, there is no update anomaly to defend against.**
That is what the owner's answer buys. If a per-company audit view is ever
genuinely wanted, backfilling `company_id` onto the document tables from
`projects` is one mechanical statement with no ambiguity. Spend it then.

### 4.5 Numbering

`document_sequences` primary key becomes `(company_id, kind, year)`, which
makes `prefix` per-company for free. `allocateDocumentNumber` gains a
`companyId`; its four callers (`lib/quote/repository.ts`,
`lib/quote/change-order.ts`, `lib/invoice/repository.ts`, project creation)
all have the project in hand.

The global unique indexes on `invoice_number` and `project_number` stay.
Global uniqueness then has to hold by CONSTRUCTION, so: a unique index on
`document_sequences (kind, year, prefix)`, which stops two companies
registering `INV` for the same kind in the same year.

Each company gets its own sequential series, which is what an auditor asks
for, and the existing principle that a gap is the record of a voided document
stays true per company.

---

## 5. Why the wizard must not ask

The owner asked for the question at setup. **It should not be asked at all.**

He does not know his own legal structure yet -- he said so. A contractor
looking at a NAS at 11pm knows less. Any answer given at first run is wrong
often enough to matter, and the wrong answer in the "two" direction burdens
every single-company customer forever with a picker they never wanted, which
contradicts his own requirement that the simple case stay simple.

Instead:

- The existing wizard's company, contact, financial and tax-rate steps create
  the ONE company. Unchanged from the installer's point of view.
- Settings gains **"Add a company"** under the existing company group
  (`src/app/settings/nav.ts`), reusing those same four steps against a new row.
- **While there is one company, nothing in the interface mentions companies.**
  No picker, no column, no filter, no setting.
- The picker appears on the new-project form the moment a second row exists.

Merging back is free: mark company two inactive, no new jobs under it, and
every old document keeps the letterhead it was legally issued under.

---

## 6. The visibility wall (Wave C -- deferred)

*"Some staff see only one"*, with nobody starting for months.

### 6.1 What it is, stated honestly

**A documents-and-money wall, not an existence wall.**

With customers, subs and rates shared by the owner's own choice, a
repair-company staffer WILL know the builder exists, will see every customer
and vendor, and can see that a shared sub is busy. What they must not see is
the builder's quotes, invoices, expenses, margins and schedule detail.

If the owner ever wants staff not to know that a customer is *also* a builder
client, then shared customers is the contradiction and one of the two has to
go. Worth asking again before this is built.

### 6.2 Why it is not a WHERE clause

`docs/superpowers/specs/2026-09-05-estimator-role-design.md` §1 already
establishes the shape: hiding a column in the interface does not hide the
number, because `src/components/worksheet/types.ts` carries cost and margin
into the browser inside the RSC payload. A conditional render leaves the
figure in the page source.

A company wall has the same property on a second axis. The loaders must return
a shape that does not contain the other company's rows.

### 6.3 The leak paths, worst first

1. **The audit log.** `audit_log` rows are `(table_name, record_id, diff)`
   with full-row `to_jsonb(new)` diffs (trigger at
   `drizzle/0001_touch_and_grants.sql:65`). Anyone with `audit:read` reads
   every builder total, cost and margin. Filtering needs a company on the
   audit row, which the trigger can only stamp if the audited table carries
   one -- and `quote_lines`, `expenses` and `customer_invoices` carry
   `project_id`, not `company_id`. **The answer is not to filter it: a
   company-scoped user does not get `audit:read` or `export:read`.** A scoped
   user is by definition not the whole-deployment bookkeeper. `export:read`
   has zero callers outside `permissions.ts` today, so nothing is lost yet.
2. **The calendar.** The genuine contradiction. Subs are shared and the
   calendar exists to answer *"is anybody promised to two places at once"*.
   Filter builder tasks out and the scoped staffer double-books the plumber;
   leave them in and they read builder job names. **Only correct answer is
   redaction:** the sub shows as busy with no job, customer or address. A
   loader returning a different shape, not a filter.
3. **Activities on a shared parent.** `activities` is polymorphic over
   customer, project and quote. An activity logged against a CUSTOMER has no
   project and therefore no company. The owner will type *"Smith wants to add
   a garage to the build"* on a customer and a scoped staffer will read it.
   The schema cannot close this. Either `activities.company_id` nullable (null
   means shared, set when logged from a project or quote) or accept it as
   behavioural. Same for `customers.notes` and `vendors.notes`.
4. **Files.** `/api/files/[id]` serves by UUID with authentication but no
   parent check. A builder's acceptance PDF or receipt is reachable by anyone
   authenticated who has the link, and links get pasted into notes on shared
   customers. Needs an authorization check through
   `files.entity_type`/`entity_id` to the owning project.
5. **Customer and vendor detail pages.** They list the record's projects,
   expenses and assignments. Filter the project-derived lists; the customer's
   existence is shared by the owner's decision.
6. **Today, the lists, search, reminders.** Straightforward filters through
   project. Reminders on a shared customer (`no_activity`) have no company and
   will fire for both -- confusing rather than leaking.

### 6.4 Mechanism, and when

Extend `Actor` from `requireCapability` with a company scope resolved once
from a `user_companies` join table, where **no rows means all companies**.
Project-rooted loaders take `{ scope }` alongside the estimator design's
`{ withCost }`. The two compose: an estimator scoped to the repair company
sees its quotes without cost.

**Scope lives on the user, not the role.** The role matrix is exhaustively
tested per role and scope is orthogonal to it; folding scope into the role
would double the matrix and mean nothing.

**Built with the estimator role, not before it.** Same machinery, and there is
nobody to wall off until then. The condition that ends the deferral: the first
user who is neither the owner nor a whole-deployment admin.

---

## 7. The accounting constraints, which determine the technical shape

Two Ontario corporations under common control each have their own business
number and HST account, file their own return, and are separately liable. This
app is not the general ledger, but it IS the sales and purchases subledger --
it issues the invoices, records the expenses with recoverable-tax lines, and
keeps the holdback ledger. A subledger has to reconcile per registrant.

What an auditor would object to, and what the design prevents structurally:

- **One HST number on both companies' documents.** The Input Tax Credit
  Information Regulations require the supplier's own registration number on
  invoices of $30 and up. The wrong number makes the customer's credit
  defective and reports the supply under the wrong account. Today
  `tax_rates.registrationNumber` is snapshotted onto `quote_taxes` and
  `customer_invoice_taxes`, and `organization.taxRegistrationNumber` prints in
  the quote header (`src/app/print/quote/[id]/page.tsx:128`). Per-company tax
  rates fix both.
- **One invoice series across two registrants.** Fixed by §4.5.
- **A tax credit claimed by the wrong corporation.** `expenses.project_id NOT
  NULL` chains to the company, so this is clean by construction. Shared
  vendors are fine -- a supplier is a supplier to both.
- **T5018 is filed per payer.** A sub paid by both gets two slips. The report
  groups by company. Unbuilt, so this is a requirement on unwritten code.

**One thing the owner should raise with his accountant.** The small-supplier
threshold AGGREGATES associated corporations (Excise Tax Act s.148). If the
builder is over $30k, the repair company cannot skip registration by being
small. He has confirmed it will be registered and will charge HST, which is
consistent -- but the app must model "no tax" ONLY as *"this company has no
registration and no rate rows"*, never as a per-quote toggle.

**The defensible line.** Every money row resolves through a NOT NULL chain to
exactly one company; each company has its own series and its own registration
number on its own paper; the export yields one company's complete sales and
purchases. **Shared master data is a CRM, not a ledger, and an accountant will
accept a shared CRM with two ledgers.** Sharing a software system is not
commingling; sharing a bank account is. Worth asking whether they do.

---

## 8. What breaks first, in order

Named so the migration is written in this sequence rather than discovered in
it. Items 2 through 5 are all SILENT, which is what makes them expensive.

1. **The single-row CHECK** (`src/db/schema/organization.ts:93`). Loud,
   immediate, correct.
2. **Double tax.** `loadTaxRatesFor` (`src/lib/quote/rates.ts:20`) returns
   every active rate with no company filter, and `computeTaxes` applies all in
   force. **The day company two's 13% row exists, every quote in the
   deployment charges 26%.** Also `src/lib/quote/recalculate.ts` and
   `src/app/expenses/actions.ts:248-271`. This is the single worst thing in
   this document.
3. **Wrong letterhead on a legal document.**
   `src/app/print/quote/[id]/page.tsx:51,128` and
   `src/app/api/quotes/[id]/pdf/route.ts:25` read `id = 1`. Company one's
   name, HST number and logo on company two's quote.
4. **Wrong defaults on new documents.** `src/lib/quote/repository.ts:21` and
   `181-194`, `src/lib/quote/change-order.ts:75`,
   `src/lib/invoice/repository.ts:307`: holdback percent, terms, payment terms
   and holdback tax deferral all taken from company one.
5. **Shared numbering.** `src/lib/quote/numbering.ts:65`. Silent until the
   accountant asks.
6. **`files.entity_id` is a uuid** and `organization.id` is an integer
   (`src/db/schema/system.ts:16-27`). Two logos require the uuid-keyed table.
7. **Reminder rules are global.** The holdback-release rule would fire on
   repair jobs. Nullable `company_id`. Minor.
8. **Lists, Today, search, activities, calendar, files.** Noise without the
   wall; leaks with it (§6.3).
9. **Backup and restore are whole-database** (`docker/backup.sh:171`,
   `docker/restore.sh:250`). Not a break -- a disclosure. Both corporations
   live in one artifact under one key and are restored together. Fine for one
   owner; a problem the day one corporation is sold or wound up. **Tell him
   before he incorporates, not after.**
10. **The SharePoint mirror**, unbuilt (`NotImplementedMirror` today). The
    design says one site per company, which cannot split with shared customers
    and vendors without mirroring the shared tables to both. Either one site
    for the group, or scope only the document tables per site. Decide when it
    is built; it is the one place this narrow model wants to widen.

**23 files read the organization row directly** rather than through
`loadOrganization`. Repointing them is mechanical -- almost all have a project
or quote in hand -- but it is 23 files, and the count is the honest measure of
this wave's size.

---

## 9. Sequencing

| Wave | Scope | Cost | Depends on |
|---|---|---|---|
| **A** | Simple mode on `project_types` | 1-3 days | Nothing |
| **B** | `companies`, the `organization` split, three foreign keys, numbering, 23 readers, "Add a company" | A few focused days | Nothing. The split is the risk. |
| **C** | The visibility wall | Estimator-sized | The estimator role, and a second user existing |
| -- | The receipt template | With AP/AR | Phase 3 |

**A and B are independent, and A is the one that solves the stated problem.**
If B never happened, keying simplicity on the job would still give the shorter
flow on both sides -- and would give the builder a short path for warranty
visits that a company switch never could.

B buys exactly one thing: the small company's own name and HST number on its
own paper. Real, but only once that company issues its own documents.

---

## 10. Not in this design

- **Inter-company billing.** One company subcontracting to the other. Ruled
  out by the owner: a job belongs to one company and never moves.
- **Moving a job between companies.** Same answer. §4.4 depends on it.
- **Per-company users as a role.** Scope is on the user, orthogonal to role.
- **Two deployments.** Shared customers, rates and vendors rule it out. Two
  databases cannot share a customer record, and syncing them would be
  inventing a distributed-systems problem to avoid a schema change.
- **A per-quote "no tax" switch.** §7. Absence of registration is the only way
  a company charges no tax.
