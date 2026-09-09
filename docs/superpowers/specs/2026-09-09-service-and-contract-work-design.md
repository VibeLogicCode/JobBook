# Service work and contract work

**2026-09-09.** Agreed with the owner. **Revision 2**, after a review by Fable
at his request found three errors in revision 1 — one of them fatal to the
design's central claim. What that review changed is recorded in §10 rather
than quietly folded in, because two of the mistakes were mine arguing
confidently from a misreading of this codebase.

**Sequenced after backlog §10b.1**, by the owner's decision once the review
found that §10b.1 is a *prerequisite* rather than merely a priority (§8).

The owner's question:

> *"regarding 2 companies its not just tax separation they will have different
> workflows correct? what i mean by that is 1 will be company setup that has to
> act like a builder or a big contractor and second as a small 1 man shop."*

And, on naming:

> *"can this app not be used for other services like electrician plumber? i
> dont want to call it a builder what do you say?"*

And on starter data:

> *"also make sure this can be used by other trades too... based on selection
> in company setup (construction, electrical, plumbing and other generic
> trades) we give them sample code list and other data pre populated."*

This supersedes §3 of `2026-09-07-two-companies-design.md`.

---

## 1. The model, stated honestly

Revision 1 claimed two levels *"different in kind"* — company posture removing
whole MODULES, project type controlling FIELDS. **That does not survive contact
with the code**, and the review was right to call it one idea wearing two hats:

- Nothing in `src/components/ui/destinations.ts` is removable. `/templates` is
  a single destination covering both scope templates and schedule templates.
- Nothing in `src/app/settings/nav.ts` is removable either. `/settings/financial`
  holds the holdback fields *beside* tax registration, fiscal year and margin.
- The only whole routes posture can remove are `/templates/schedule` and
  `/templates/schedule/[id]`. Two.

So the honest model is one level plus a default:

> **Every flag lives on `project_types`.** Posture does exactly three things:
> it decides which types are offered by default, it supplies the default flag
> values for a newly created type, and it filters two routes.

That is still worth having. It also **dissolves two bugs** revision 1 had
created, which is the strongest argument for it (§10.1, §10.2).

The owner's requirement is unchanged and is met: a solo electrician's forms
carry no holdback, no draws, no critical path, because every project type he
is offered has those flags off. What changes is the mechanism, and with it the
claim that a module can be made to not exist.

---

## 2. The vocabulary, and why not "builder"

**Naming the trade would make the product narrower than it is.** An
electrician, a plumber, an HVAC contractor and a home builder all have the
same split *inside their own business*. The axis is the WORK, not the trade.

- **Service work.** Dispatched. One visit or a few days. One invoice. Usually
  no subcontractors, no holdback, no schedule worth drawing.
- **Contract work.** A signed scope. Progress draws. Holdback.
  Subcontractors. A schedule with dependencies. Change orders.

**Not invented vocabulary.** Electrical, plumbing and HVAC companies organise
themselves exactly this way — a service department and a construction
department, different paperwork, often different crews. It is the language the
customer already uses about himself, which is the only test that matters for a
word on a first-run screen.

**The same two words work at both levels**, which is what makes this teachable
rather than a second thing to learn.

---

## 3. What the company is asked

> **What kind of work do you do?**
> — Service work · Contract work · Both

**"Both" is today's behaviour**, so it is the default and this change is
backward-compatible by construction. Changeable in Settings afterwards,
always.

### 3.1 Where the answer lives

`organization`, not `companies` — this is needed before `companies` exists,
and Wave B of the two-companies design is unscheduled. When `companies` is
built the column moves and `organization` keeps a deployment-wide default,
which is why §6.1 insists the reader be a function from the first commit.

### 3.2 The switch back is not free

**Both → service, with contract jobs in flight.** Their project types keep
their flags, so those jobs go on computing holdback and offering draws
correctly. Only what is *offered on new work* changes. Stated because the
alternative — posture re-deriving behaviour for existing jobs — would silently
change the terms of a signed contract.

---

## 4. What the flags are, and the audit

Every flag below is a column on `project_types`. Posture sets their default
for a new type and decides which seeded types are offered.

| Flag | Off means |
|---|---|
| `holdback` | No holdback percentage on the quote, no ledger, no release |
| `progress_invoicing` | One invoice at the end; no draws |
| `schedule_template` | No template, no forward pass |
| `construction_act_dates` | No substantial performance / publication / last supply |
| `scope_inputs` | No area, washroom, kitchen or bedroom counts |

**Invoice kinds follow `holdback` and `progress_invoicing`, not posture.** That
correction is §10.2 and it is the one that prevented a stranded receivable.

### 4.1 The audit: 37 files mention holdback

Revision 1 said 27. The review said 34. **It is 37** in `src` — and the count
mattering three times over is itself the argument for doing this audit
properly rather than by grep.

Two of those files are **wrong document / wrong number**, not "missing
screen", and both were already broken before this design existed. The review
found them; both are now recorded in the backlog and one is fixed:

1. **`src/app/print/quote/[id]/page.tsx`** printed `org.holdbackTermsText`
   unconditionally and never read the quote's percentage — so a job
   withholding nothing told the customer ten percent was retained. **Fixed
   2026-09-09** (`6891752`), via `src/lib/quote/holdback-notice.ts`. This
   design must not reintroduce it: the notice is a function of the QUOTE.
2. **`src/lib/quote/repository.ts:192,253`** copies
   `org.defaultHoldbackPctTenThou` onto every new quote. **If the project-type
   flag does not intercept here, a service job's accepted quote carries 10% and
   its final invoice withholds it.** Revision 1 never named this call site.
   This is the single most important line in the implementation.

### 4.2 The work revision 1 did not list

**No screen exposes `quotes.holdbackPctTenThou`.** Verified: the only match
under `src/app/quotes` and `src/components/worksheet` is the wire field added
on 2026-09-09. It is written by `repository.ts` from the org default, read by
the invoice engine, and printed — and never editable.

So "a job can turn holdback back on" has **no user interface to turn it on
with**. That UI is real work and it is on the critical path for §4.3, not a
detail. `lib/invoice/repository.ts:149` already refuses to fall back to the
org default with an explicit comment, so the override must SET the column.

### 4.3 Holdback: what is actually true, legally

Revision 1 said hiding holdback per-company *"can produce a legally wrong
document."* **That overstates it**, and the review's correction gives a better
argument for the same conclusion:

- **The holdback obligation is on the PAYER.** For a customer invoice the
  homeowner is the payer, so a contractor's invoice omitting holdback is not
  itself unlawful. The real consequence is a receivable: if the homeowner
  retains 10% anyway, AR shows a short-paid invoice with no holdback row to
  explain it.
- **Since the 2018 amendments, "improvement" includes capital repair and
  excludes maintenance.** A leaking tap is maintenance; a panel swap is an
  improvement. **So the line is not contract size and not the company's
  posture — it is a per-job fact about the work.** Which is a stronger
  argument for putting the flag on the project type than anything revision 1
  offered.
- **The contractor's real exposure is the PAYABLE side.** A service
  electrician who subs out drywall *is* a payer and must retain from the
  drywaller. `holdback_direction = 'payable'` exists in the enum and **nothing
  writes it.** Recorded here as a requirement on unwritten code, the way
  T5018 is. Not built in this design.

Neither the author nor the reviewer is a lawyer. What is defensible is that
the flag sits where the fact sits: on the job.

### 4.4 No invented statutory default

Revision 1 promised *"sane statutory defaults"* when the settings screen is
hidden. **Withdrawn.** `holdbackReleaseDays` (NOT NULL, 60) and
`taxDeferredOnHoldback` (NOT NULL, true) already compute without that screen.
The only value needed is the percentage, and `contractOf` in
`lib/invoice/repository.ts` deliberately refuses an org-default fallback:
*"absent means the contract withholds nothing."*

A 10% fallback would be the jurisdiction assumption wearing a number that
`invoices.ts` and `holdback.ts` both refuse. The override sets the column
explicitly or there is no holdback.

---

## 5. Starter data per trade

An empty rate book is why estimating software gets abandoned in week one. This
is the change most likely to decide whether anybody keeps using the product.

### 5.1 Trade is orthogonal to posture

| | Decides | Gates anything? |
|---|---|---|
| **Posture** | Offered types, new-type defaults, two routes | Two routes |
| **Trade** | Which starter pack is loaded | **No. Nothing.** |

No `trade` column is consulted at runtime and no screen behaves differently
because of it. The same electrician does service calls and full rewires.

### 5.2 It is a copy, never a link

Seeded rows become the owner's rows. **No mechanism ever updates one**, and
there must not be — "update your rate book from the latest pack" would
overwrite a contractor's own prices, the most destructive thing this product
could do. A pack improved later reaches only new installations. Correct; the
alternative is worse.

### 5.3 THE PACKS CARRY NO PRICES — and zero is not safe either

Ship codes, descriptions, units and cost-code structure. **Never a dollar
figure.** A rate book of invented numbers looks authoritative, and a
contractor quoting at prices this software guessed loses the job or loses
money, with nothing tracing back to a seed file.

**Revision 1 then claimed seeding at zero was safe. It is not, and the reason
I gave was a misreading of my own codebase.** I quoted *"Blank records as
zero, and the margin will read 100%"* — that hint is on the **cost** field
(`RateItemFields.tsx:113` is `costRateTenThou`). Zero **sell** behaves
differently and worse:

- `marginBasisPoints` returns **0** on zero revenue, so the rate list reads
  0.00% and the gauge sits red at zero cells — indistinguishable from a real
  item priced badly.
- A zero-sell line contributes $0 to the subtotal.
- `pricingDisplay` defaults to `group_totals`, under which the line is
  **invisible on the printed quote**. A customer receives a document silently
  missing the price of real work.
- The rate picker offers every active item, zero included, with no flag.

So a zero-priced seeded item is worse than an empty rate book **for exactly
the reason stated against invented prices: it looks like a price.**

**Therefore a structural guard, not hint text.** Adding a line whose
`sellRateTenThou` is `0n` is refused — or requires an explicit confirmation —
unless the item is a percent-mode line or an allowance, both of which are
legitimately zero. The rate list flags unpriced rows. "The screen must say
plainly" was a hope; a guard is a mechanism.

### 5.4 No MasterFormat, no NAHB chart

**MasterFormat** is the standard North American construction cost-code
numbering, published by the Construction Specifications Institute and, in
Canada, Construction Specifications Canada — the `03 Concrete` /
`22 Plumbing` / `26 Electrical` system. **NAHB's Chart of Accounts** is the
residential equivalent. Spelled out because revision 1 assumed the reader knew
the term and the reader did not.

Both are published and sold, with copyright asserted on the compilation — the
selection, numbering and arrangement. Individual words are not protectable;
nobody owns "Concrete".

**Owner's decision, 2026-09-09:** *"no i dont want to buy it."* Settled.

So: **plain-language divisions we write ourselves**, with our own numbering.

**And the tension with the codes design, owned rather than hidden.**
`2026-09-07-generated-codes-design.md` §2 says the app must NOT invent cost
codes, because a chart of accounts has to agree with the accountant's. This
seeds six to ten per trade, and `quote_lines.cost_code_id` is a live foreign
key. The reconciliation: a seeded code is a **starting suggestion the owner
renames or retires**, not an assertion. It is defensible because the
alternative is an empty list — but it is a tension, not a thing the other spec
supports.

### 5.5 One pack per trade, rows tagged by posture

Not a trade × posture matrix. Each pack is one list; each row carries the
posture it belongs to. An electrical pack holds `Service call` (service),
`Rewire` (contract), `Panel upgrade` (both). Adding a posture later does not
multiply content.

### 5.6 Four packs, and the GC pack is not free

1. **General contracting / renovation**
2. **Electrical**
3. **Plumbing**
4. **HVAC**
5. **Other / none** — project types and line groups only. Must be no worse
   than today's empty start, only plainer.

**Revision 1 called the GC pack "today's list, unchanged and therefore
free". Wrong.** No cost codes or rate items ship to a real install today —
`src/db/seed/schedule-templates.ts` says so in as many words. The only GC list
is the demo tenant's (`src/db/seed/demo.ts`), which carries **prices and
MasterFormat division numbers** (`01-00`, `03-30`, `22-00`, `26-00`) and
therefore violates both hard rules above. The GC pack must be authored like
the other three.

**The demo tenant needs a decision of its own.** It is what anybody evaluating
the product sees, and it uses MasterFormat numbering. Eight division numbers
is plausibly de minimis, but the spec should not leave its own rule
contradicted by its own demo: either exempt the demo explicitly with that
reasoning, or renumber it. **Recommend renumbering** — it costs nothing and
removes the question.

Landscaping, roofing, painting and drywall are the obvious next four and are
deliberately excluded. Each pack wants somebody who does that trade to read
it.

### 5.7 What a pack contains

Project types (posture-tagged), cost codes (shallow — a deep hierarchy nobody
asked for is the first thing a new user deletes), rate items (unpriced), line
groups, and trades (subcontractor kinds hired).

**Nothing else.** Not vendors, not customers, not tax rates. Vendors and
customers are the owner's real relationships and inventing them would put
fictional companies in a real business's records — which the demo tenant does
deliberately and a production install must never do.

### 5.8 The seeding mechanism does not exist, and the existing seeds fight it

**Revision 1 said "the mechanism exists". It does not.**
`src/db/seed/project-lists.ts` is a set of constants mirroring migration
`0018`'s SQL; it seeds nothing at runtime. Three consequences, all of which
break the feature as revision 1 described it:

1. **The nine builder project types are in every database before the wizard
   runs**, via migration 0018. An electrician's first screen would read
   "Custom home, Basement, Renovation…" *plus* his pack. **So a pack must
   RETIRE the types it does not want**, using the existing
   retire-not-delete rule. §5.1 of revision 1 promised an electrician's list
   and §5.2 did not deliver it.
2. **`ensureVendorLists` and `ensureLineGroups` seed lazily on first visit**
   to `/vendors`, `/settings/trades`, `/settings/vendor-types` and
   `/settings/line-groups`, appending the full GC set. So an electrician's
   short trade list acquires twelve general-contracting trades the first time
   he opens Vendors, and his line groups acquire "Framing, Drywall,
   Concrete…". **Those lazy seeds must become pack-aware, or reuse the pack's
   fixed ids.** Not optional — it silently undoes the pack.
3. **Fixed ids per pack row**, as the existing seed already does. Not for
   wizard re-runs — `readSetupGate` refuses those on a live tenant — but for
   re-submitting a step within one setup, and for a later "load a pack"
   entry point in Settings.

**Existing `project_types` rows need a stated backfill**: every one of the
nine keeps today's behaviour, `Water leak` and `Other` included. "Current
behaviour" is the migration's job to make explicit, not the reader's to infer.

**This is a content problem wearing a code problem's clothes.**

---

## 6. Implementation

### 6.1 One reader, derived — not a second cache

`workPosture()` derives from `loadOrganization`, which the root layout already
calls and which is already `cache()`-wrapped. **Do not add a second cached
reader.** `React.cache` is per-request, which is correct here; `proxy.ts`
never sees it and should not — posture is not authentication.

**It fails OPEN.** `loadOrganization` swallows errors to `null`, so a database
blip resolves posture to `'both'` and the fuller forms appear. Acceptable for
a product-shape flag and stated here because revision 1's "the guard refuses"
language reads as a permission. **It is not a permission.** Nothing here
protects anything; it shortens forms.

Derived predicates — `hasContractWork()`, `hasServiceWork()` — so a call site
reads as a question about the business and a fourth posture would not touch
them.

`AppShell` is `'use client'`, so posture reaches it as a prop.
`destinationsFor(posture)` replaces the three exported constants in
`destinations.ts`, keeping the one-list invariant that
`tests/unit/navigation.test.ts` asserts.

### 6.2 Two routes, not a nav rebuild

`/templates/schedule` and `/templates/schedule/[id]` refuse under service-only.
That is the whole of §6.2. Revision 1 described filtering `DESTINATIONS` and
`SETTINGS_GROUPS`; §1 explains why that does nothing.

The guard is on the route, not the link — a hidden nav entry is not a
mechanism, which this codebase has already written about the estimator role.

### 6.3 Absence is the off state

The rule is at **`src/db/schema/organization.ts:171`** — revision 1 cited
`system.ts`, and `2026-09-07-two-companies-design.md` repeats that
misattribution and should be corrected too.

The posture column defaults to `'both'`, the value that changes nothing. Every
project-type flag defaults to today's behaviour.

The *"deliberately no feature_flags table"* rule from the same file is
overridden for these flags, deliberately: it protects CREDENTIALS, and nothing
about "this kind of job has no holdback" is a secret or costs anything in a
backup.

---

## 7. Testing

`environment: 'node'`, no component tests — so the rules must be assertable as
data. Same reasoning that produced `destinations.ts`.

- **Posture resolution**: three values, the default when never set, and the
  fail-open path when `loadOrganization` returns null.
- **`repository.ts:192,253`**: a service-type job's new quote carries **no**
  holdback percentage. §4.1 item 2 — the wrong-number test.
- **The print notice**: already covered by `tests/unit/print-holdback.test.ts`.
- **Zero-sell guard** (§5.3): a zero-priced item is refused as a quote line;
  a percent-mode line and an allowance still pass.
- **Pack seeding**: loading a pack retires the migration-0018 types it does
  not want, and a later visit to `/vendors` does **not** re-append the GC
  trades. The §5.8 item 2 test.
- **Route refusal**: `/templates/schedule` refused under service-only, called
  directly rather than through a link.
- **Backward compatibility**: a deployment with no posture set behaves
  identically to today. Assert on the demo tenant, which is what an evaluator
  sees.
- **Wizard**: `tests/integration/setup.test.ts` asserts `resumeAt` by slug
  (`'tax-rate'`, `'done'`) and walks steps by name, so a new step is real
  churn revision 1 did not list. **Posture must be known before the pack**,
  since §5.5 filters rows by it — so trade and posture share one step, or
  posture comes first. The `done` summary should name both.

---

## 8. Cost and sequence

**§10b.1 first.** The review found it is a prerequisite, not a priority: the
trade pack lives in the wizard, and `src/lib/auth/access.ts:48-50` still
throws without `LOCAL_USER_EMAIL`, so **no customer can reach the wizard, and
therefore no customer can reach the packs.** ~1.5 hours. The owner agreed once
this was pointed out.

§10b.2a (the backup key) is independent and is the liability. Before or
interleaved.

Then: **posture 2–4 days**, most of it the 37-file audit. **Packs: a day of
code, and the packs are content** — including the GC pack, which §5.6 corrects
from "free" to "authored".

Splittable: posture first, packs second.

---

## 9. Not in this design

- **Letting the trade gate a feature.** §5.1.
- **A pack containing prices, or zero prices without a guard.** §5.3.
- **MasterFormat or the NAHB chart.** §5.4. Declined by the owner.
- **Any mechanism updating a seeded row.** §5.2.
- **More than four packs.** §5.6.
- **Payable-side holdback.** §4.3. Real exposure, unwritten code, recorded.
- **An invented statutory holdback default.** §4.4.
- **A third posture between service and contract.** Offered and declined. A
  $15,000 bathroom is contract work with no schedule template, which §4
  already allows.
- **Per-user posture.** A property of the business, not of who is looking.
- **The holdback release form.** Needed for §4.2's override to be useful end
  to end, but it is AP/AR work — see the backlog entry of 2026-09-09.

---

## 10. What the review changed

Kept because the mistakes are instructive and two of them were confident.

### 10.1 The fatal contradiction

§4.1 of revision 1 said a contract-flagged job turns holdback back on. §5 said
*"under service only, contract types are not offered."* **So the override could
never fire, and holdback was exactly the hard removal §4.1 said must never
exist.** The load-bearing caveat was dead code. Fixed by §1: every flag on the
project type, posture only choosing what is offered.

### 10.2 The stranded receivable

Revision 1 removed the `progress` and `holdback_release` invoice kinds at the
posture level. Holdback accrues only on draws and is paid out only by a
release — so a contract job under a service-only company would have withheld
10% and had **no invoice kind able to bill it back.** Money owed, and
un-invoiceable. Fixed by tying invoice kinds to the project-type flags.

### 10.3 Zero prices

§5.3. I asserted a safety property and cited a hint that is on a different
field. This is the second time in three days I have argued from a misreading
of this codebase, and both times the error survived because the sentence
sounded like it had been checked.

### 10.4 Three counts, three wrong

Revision 1: 27 files mention holdback. The review: 34. Actual: **37**. Small
in itself, and a reason not to size an audit by a grep somebody remembered.

### 10.5 Things the review confirmed

The service/contract vocabulary, the `'both'` default, never updating a seeded
row, the copyright reasoning in §5.4, excluding vendors and customers from
packs, and that `React.cache` is the right mechanism for §6.1. Unchanged.
