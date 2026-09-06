# The estimator role

**2026-09-05.** A fourth role: somebody who prices work for customers and is
never shown what that work costs the company.

**Scheduled for Phase 3, after crew and BEFORE AP/AR** — owner's decision,
2026-09-05. The ordering against AP/AR is deliberate rather than incidental:
AP/AR's screens are cost surfaces, and a permission boundary costs one line per
screen when it exists first and an audit of finished screens when it does not.

Agreed with the owner on 2026-09-05. His words: *"an employee who can quote but
should not see profit margins, detail rate level rates, but can quote and see
line totals and quote totals but not the math behind them"*, and *"no ability to
add rates, schedules, templates."*

---

## 1. The trap, stated first

**Hiding a column in the interface does not hide the number.**

`src/components/worksheet/types.ts` carries `unitCostTenThou` and `marginBp` on
`WireLine`. The worksheet is a client component, so those values cross to the
browser inside the RSC payload. A conditional render — `{canSeeCost ? <td>…` —
leaves the figure in the page source, one devtools panel away from the person it
was hidden from. The same is true of the rate list's cost column and the margin
gauge.

So this is **not a render-time check.** The loaders must return a shape that
does not contain the cost, and the types must make it impossible to hand a
cost-bearing line to a component that prints one.

Everything else in this document follows from that sentence.

---

## 2. The role

`role` gains `estimator`, after `bookkeeper`.

**Migration hazard.** `ALTER TYPE role ADD VALUE 'estimator'` cannot be followed
by a use of that value in the same transaction, and drizzle-kit wraps a
migration in one. Add the value in its own migration, and do anything that
writes an estimator row in a later one. A migration that applies on an empty
database and fails on a populated one is the shape to avoid here.

### 2.1 The matrix

| Capability | owner | admin | bookkeeper | **estimator** |
|---|---|---|---|---|
| `quote:write` | ✓ | ✓ | | **✓** |
| `quote:send` | ✓ | ✓ | | **✓** |
| `quote:accept` | ✓ | ✓ | | |
| `worksheet:read` | ✓ | ✓ | ✓ | **✓** |
| `document:generate` | ✓ | ✓ | ✓ | **✓** |
| `cost:read` | ✓ | ✓ | ✓ | |
| `rates:edit` | ✓ | ✓ | | |
| `expense:write` | ✓ | ✓ | ✓ | |
| `record:void` | ✓ | ✓ | | |
| `user:manage` | ✓ | | | |
| `audit:read` | ✓ | ✓ | ✓ | |
| `export:read` | ✓ | ✓ | ✓ | |
| everything else | — | — | — | |

### 2.2 `quote:transition` splits in two

Today one capability covers every status change. The owner's answer — *build
and send, but not accept* — cannot be expressed with one boolean, because
sending is telling a customer a price and accepting is committing the company to
do the work.

`quote:send` covers sent, declined and expired. `quote:accept` covers
acceptance, which is what creates the job. Both call sites in
`src/app/quotes/[id]/actions.ts` (lines 216 and 306) are repointed; every
existing role holds both, so nothing changes for anybody but the estimator.

---

## 3. What `cost:read` gates

Not a list of screens. A list of **facts**, because the same figure reaches the
browser through more than one screen.

| Fact | Where it currently travels |
|---|---|
| Unit cost on a quote line | `WireLine.unitCostTenThou` → the worksheet |
| Margin on a line and on the quote | `WireLine.marginBp`, the totals, the margin gauge |
| Target margin | The gauge's bands, from `organization` |
| Cost on a rate item | The rate list's cost column, the rate picker inside the worksheet, the importer |
| Cost on a template line | `scope_template_items.cost_rate_ten_thou` |
| Everything about an expense | The expenses screens, and job costing |
| What a subcontractor is paid | `assignments.agreed_amount_cents`, on the schedule and the assignment sheet |
| Cost to date on a job | The billing screen |
| Old and new values of any of the above | The audit log |

`audit:read` and `export:read` being false is load-bearing rather than tidy: the
audit log stores before-and-after values, so a role that could read it would
read every cost it was refused on the screen.

**Already clean, verified:** the customer-facing PDF at
`src/app/print/quote/[id]/page.tsx` carries no cost (its only matches for
"margin" are CSS), and the pipeline board and list carry no cost or margin
column. Neither needs changing; both need a test saying so, because the reason
they are clean today is that nobody has added a column yet.

---

## 4. How the loaders change

**Projection, not omission at render.**

`WireLine`'s cost-bearing fields become `string | null` / `number | null`, and
the loader returns null for an estimator. Null rather than absent, because an
optional property is easy to forget to check and a null is not: a component that
prints `line.unitCostTenThou` without handling null is a type error.

The loader takes the capability, not the role — `loadQuote(id, { withCost })` —
so the decision is made once, at the boundary, and no component anywhere asks
what role is looking at it.

The rate list, the rate picker, the template editor and the importer take the
same treatment. Screens that are entirely about cost — expenses, job costing,
the billing screen — are refused wholesale by the existing guard, and their nav
entries are hidden. A hidden nav entry is not a permission; the guard is.

---

## 5. What the estimator can still do

Read and write customers. See the pipeline and open a job. Build a quote, price
it from the rate list's sell prices, generate the PDF, send it. Read their
reminders. See a job's schedule, without the money on it.

They cannot add or edit a rate item, a template of either kind, a cost code, a
tax rate, a vendor, or a user; cannot record an expense; cannot accept a quote;
and cannot void anything.

---

## 6. Testing

The tests that matter are not "the column is hidden".

- **The payload test.** Render a quote page as an estimator, and assert the
  serialized output does not contain the cost figure — searched as the raw
  scaled integer, since that is what would actually be in it. Repeat for the
  rate list and the template editor. This is the test that would have caught the
  naive implementation.
- **The matrix test.** The existing exhaustiveness test extends to the fourth
  role automatically; add the estimator's row and let it fail if a capability is
  forgotten.
- **Every guarded action, refused.** An estimator calling `acceptQuote`,
  `createRateItem`, `createExpense`, `voidTask` gets a refusal sentence, not a
  crash and not a success.
- **The clean screens stay clean.** A test asserting the print route and the
  pipeline carry no cost, so the day somebody adds a margin column to the board
  it fails rather than leaking.

---

## 7. Not in this build

- Restricting an estimator to *their own* quotes. Everyone in this company sees
  every job; a per-record owner is a different feature and this business has
  four to ten live jobs.
- A separate cost visibility for individual rate items.
- Any change to how the three existing roles behave.
