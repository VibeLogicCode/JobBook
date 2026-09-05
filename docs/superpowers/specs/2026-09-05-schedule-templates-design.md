# Schedule templates

**2026-09-05.** A saved shape of work — the tasks, how long each takes, and what
waits on what — applied to a job with one date, so a schedule is imported rather
than rebuilt from memory.

Agreed with the owner on 2026-09-05, then reviewed before any code was written.
**Revised after that review**; §12 records what changed and why, because two of
the corrections were to decisions this document had already argued for.

Forward pass only. The backward pass is named in §10 and deliberately not built.

---

## 1. Why

A quote can be rebuilt from the rate list in twenty minutes. A schedule is
rebuilt from memory, and the thing memory drops is the two-week lead time the
cabinet supplier needs. The cost of that is a subcontractor standing on a site
with nothing to do.

The product already holds every piece this needs: `schedule_tasks` with
`predecessor_task_id` and `lag_days`, a tested push engine in
`src/lib/schedule/push.ts`, and a quote that records the measurements a job was
priced from. What is missing is the saved shape.

---

## 2. The one strong decision: a template holds no dates

Not a start date, not an end date, not a calendar of any kind. It holds

- an ordered list of tasks,
- each task's **duration**,
- each task's **predecessor and lag**.

A template with dates in it is stale the moment a job slips, and it would force
"basement build starting in March" to be maintained separately from the same
build starting in September. The shape of the chain is the part that is
identical between two basements; the calendar is the part that never is.

Applying a template takes **one** date and computes the rest through the
existing `startAfter`.

---

## 3. Step zero: `schedule_tasks.trade` becomes a foreign key

`schedule_tasks.trade` is `text`, free-form. `vendors.trade_id` and
`crew.trade_id` are foreign keys into `trades` (migration 0014). A template
that carried `trade_id` would have nowhere to put it, and denormalising the
name at import would drift from the list the first time a trade is renamed.

Since the only reason a template carries a trade is so the assignment picker can
offer the right subcontractors, the text column has to go first.

**Migration: promote `schedule_tasks.trade` to `trade_id`**, exactly as 0014 did
for `vendors.trade` — distinct non-null values become `trades` rows (matching
existing rows case-insensitively rather than creating duplicates), repoint, drop
the column. `TaskEditor`'s `TextField` for trade becomes a `SelectField`.

This is a prerequisite, not part of the feature. It ships and is verified on its
own before anything below is written.

---

## 4. Two template tables, not one with a `kind`

An earlier draft renamed `scope_templates` to `templates` with a
`kind` of `'quote' | 'schedule'`, sharing the parent row. **That is wrong**, for
two reasons found in review:

**A trigger breaks at run time, not at migration time.**
`drizzle/0004_quote_mutability.sql` defines `guard_quote_mutability()`, which
reads `new.scope_template_id` and `old.scope_template_id` by name. PL/pgSQL
resolves record fields when the trigger fires, so renaming the column leaves a
migration that applies cleanly and a product that raises
`record "new" has no field "scope_template_id"` on the next accept, decline or
mark-sent. Verified at `drizzle/0004_quote_mutability.sql:67` and `:74`.

**A shared parent cannot enforce its own kind.** With one table,
`schedule_template_tasks.template_id -> templates.id` may point at a
`kind = 'quote'` row and no foreign key refuses it. Enforcing it needs a
composite key on `(id, kind)`, a trigger, or trust in application code. Two
tables have the constraint for free.

Against that: five duplicated columns, and `drizzle-kit generate` cannot express
a rename non-interactively anyway.

```
scope_templates            (unchanged)
└── scope_template_items    rate item, source, multiplier

schedule_templates          name, project_type, description, is_active, audit
└── schedule_template_tasks duration, predecessor, lag, conditions
```

**Screens.** One list at `/templates` reading both tables, with a Kind column,
and **Add asks the kind first** — past the name the two forms have nothing in
common. A row routes to the editor for its kind. The owner's requirement is one
heading and two editors; that is satisfied by the list, not by the schema.

---

## 5. A schedule template task

```
schedule_template_tasks
  id                          uuid
  schedule_template_id        -> schedule_templates.id
  name                        text
  trade_id                    -> trades.id      nullable
  cost_code_id                -> cost_codes.id  nullable
  notes                       text              nullable
  sort_order                  integer
  is_milestone                boolean

  duration_base_days          integer  not null default 0
  duration_source             enum: none|area|washrooms|kitchens|bedrooms
  duration_area_per_day_milli qty      nullable   -- when source = area
  duration_days_per_unit      integer  nullable   -- when source is a count

  predecessor_task_id         -> schedule_template_tasks.id  nullable
  lag_days                    integer  not null default 0

  condition_measurement       enum: washrooms|kitchens|bedrooms  nullable
  condition_rate_item_id      -> rate_items.id                   nullable

  ...auditColumns
```

`notes` earns its place because §1's motivating example is a supplier lead time:
the lag carries the fourteen days, but only a note carries *"call the cabinet
shop"*.

### 5.1 Duration

```
area   : days = base + divRoundUp(area_milli, area_per_day_milli)
count  : days = base + (count × days_per_unit)
none   : days = base
days   = max(days, 1)
```

**Area is stored as a divisor, not a rate.** A contractor says *"a day per 300
square feet"*, and storing that as `0.0033` days per square foot is both a
translation of his own sentence and inexact — 30,000 sqft would compute 99 days
against a true 100. `divRoundUp(area_milli, per_day_milli)` is exact and is the
sentence he would say. Counts stay days-per-unit, because *"two days per
washroom"* is already the natural direction.

**Rounded up.** You do not book half a framer-day, and a task that rounds down
finishes late. `src/lib/money/scale.ts` has `divRoundHalfUp` and no ceiling
helper; this needs `divRoundUp` beside it, tested on exact multiples as well as
remainders.

**A milestone is one day**, whatever the arithmetic says, matching
`schedule_tasks`. The editor hides the duration fields for a milestone rather
than collecting values it will discard.

**`base 0` with `source none` is refused in the form.** The one-day floor exists
for arithmetic, not to paper over a field somebody forgot.

### 5.2 End dates and order

`durationDays` counts both ends, so **`end = shiftDays(start, days - 1)`**. An
implementation writing `start + days` makes every task a day long, and the
milestone rule implies the subtraction without ever stating it.

Dates are derived in **dependency order, not `sort_order`** — a task may sort
above its own predecessor.

### 5.3 Constraints

`schedule_tasks` carries `no_self_dependency`, `lag_needs_predecessor`,
`lag_range` and `planned_order`. The template table takes the analogues, plus:

- `duration_base_days >= 0`
- source `area` → `area_per_day_milli` not null and `> 0`, `days_per_unit` null
- source count → `days_per_unit` not null and `> 0`, `area_per_day_milli` null
- source `none` → both null
- `num_nonnulls(condition_measurement, condition_rate_item_id) <= 1`
- predecessor must belong to the same template

A cycle is refused on save using `findPredecessorCycle` from
`src/lib/schedule/push.ts`. It reads only `id`, `name` and `predecessorTaskId`,
so its parameter widens to
`Pick<ScheduleTask, 'id' | 'name' | 'predecessorTaskId'>[]` — a one-line change,
named here so nobody fabricates dates to satisfy the current signature.

The schedule refuses cycles three ways: a CHECK, a trigger under an advisory
lock, and the action. **The template takes the CHECK and the action, not the
trigger.** One person edits this table, from one screen; the advisory lock
exists for concurrent writers the template editor does not have.

### 5.4 Voiding a template task

`voidTask` refuses while live dependents exist. The template editor does the
same, for consistency and because the editor is exactly where re-pointing is one
press. Capability `record:void`.

---

## 6. Conditions — when a task applies

Two nullable columns on the task row rather than a child table. Every worked
example has **one** condition per task, and where a second is wanted the answer
is a second task — which §6.1 already recommends for kitchen versus bathroom
plumbing. A join table for a cardinality nothing reaches is machinery to
maintain for nothing.

A task is **suggested** if it has no condition, or if its condition matches.

| Condition | Matches when |
|---|---|
| Measurement | the accepted estimate's count for it is greater than zero |
| Rate item | any accepted, active quote on the project has an **included**, non-void line carrying that rate item |

### 6.1 Why two kinds

The owner's example — *"only add the plumbing schedule if there is a bathroom"* —
is a measurement, and `quotes.washroom_count` answers it with one dropdown and
no rate-item hunting. A rate item is the precise fallback for work the counts
cannot express: a deck, a wet bar, underpinning.

Bathroom and kitchen plumbing separate without new machinery: one task
conditions on `washrooms`, the other on `kitchens`.

**`area` is not a condition.** `area > 0` is true of essentially every quote, so
it would tick everything while looking like a filter. The threshold that would
make it useful — *"a second inspection over 2,000 sqft"* — is a comparison this
design does not carry, and adding one for a single case is not worth it. Area
remains a duration source.

### 6.2 Which quote is read, and this is a correction

Measurements come from the **accepted estimate** (sequence 1). Change orders
carry no measurements — `src/lib/quote/change-order.ts` inserts none, so they
are null.

Rate-item conditions read lines from **every accepted, active quote on the
project**, estimate and change orders alike. A change order's lines are contract
scope, so reading only the estimate would silently miss a deck that CO-1 added.
This is distinct from §10's deferral of *re-suggesting* tasks when scope changes
later; it is about getting the first import right.

Counts are read as `coalesce(column, 0) > 0` — the columns are nullable.

**With no accepted quote**, every conditional row is unticked with the reason
*"no accepted quote on this job"*. Unconditional rows are unaffected.

### 6.3 Two defaults, stated

**No condition means unconditional**, not "never applies". Permits, site
protection, supervision and cleanup are on every job.

The failure mode — forgetting a condition, so a task ticks on every job — is
visible on the import sheet and one press from fixed. To catch it where it is
made, each row in the **editor** prints its condition or the word `Every job`.

**A hand-typed quote line matches nothing.** `quote_lines.rate_item_id` is
provenance and is null on a line somebody typed by hand, so a hand-built quote
suggests nothing. This is why unmatched rows stay visible and tickable (§7.3) —
that is the recovery path, not decoration.

### 6.4 The limit worth naming

**The schedule can only be as granular as the quote.** Price plumbing as one
bundled line with no room counts and nothing can recover which rooms it covered.
That is not fixable with more machinery; it is a reason to price at the
granularity you intend to schedule at. This belongs in this document, **not on
screen** — see §9.

---

## 7. Importing

An **Import from template** button in the job schedule's header, beside Add
task. It opens a `Sheet`, following `src/app/quotes/[id]/Acceptance.tsx` — the
precedent for "tick what applies, and be told the consequences before pressing".

### 7.1 Pick a template

Active schedule templates, those matching the job's `project_type` first. Not
filtered to them: a basement template is a reasonable start for a rec room.

### 7.2 Pick a start date

Defaults to `tenantToday`, never the server's date.

### 7.3 The task list

Every task in the template, in `sort_order`, showing name, trade, duration, what
it waits on, and **its computed start and finish**. The job's finish date sits
at the foot.

Dates rather than a sentence, because that is what `MoveDates` already does and
because a re-link changes the schedule's length — invisible if the sheet lists
only names.

Matching rows are **ticked**. Non-matching rows are **shown, greyed, unticked,
with the reason** — *"No washrooms on this quote"*, *"No line on QT-2026-0001
carries TILE-SHWR"*. A per-row fact, never the paragraph explaining why.

Hiding them was rejected: a hidden task makes the template look broken — *where
did plumbing go?* — and a silent omission is how a trade gets forgotten. Same
rule as the calendar printing "Nobody booked" rather than leaving a cell blank.

An unmatched row can still be ticked.

### 7.4 Unticking re-links, as a pure function

**`effectivePredecessor(task) = the nearest ticked ancestor in the template
chain, or null`.**

Stateless and order-independent. An earlier draft mutated predecessors on each
untick, which has a bug review caught: untick B, then tick it again, and C stays
attached to A — B and C then run in parallel when the template said C follows B.
A function of the ticked set cannot drift, and re-tick costs nothing.

It also means **a cycle cannot occur.** With single predecessors the template is
a forest, and walking up to an ancestor closes no loop. The earlier draft's
"drop that would create a cycle" test is removed; it tested a hazard that
existed only under mutation.

Three behaviours were considered:

| | |
|---|---|
| Refuse | Safe and unusable: dropping framing means hand-unticking drywall, then paint |
| Cascade | Dropping one task silently drops five. Destructive and surprising |
| **Re-link** | **What happens on a site: skip a step and the next follows the one before it** |

**Lag across a re-link.** The dependent keeps its own lag, and the lag of the
dropped edge is lost. Neither answer is right in every case — if the dropped lag
was concrete curing it mattered, if it was mud drying under a task now gone it
did not — and the dependent's own lag is the defensible default.

**A negative lag is clamped to zero across a re-link.** `lag_days` may be
negative on purpose (drywall overlapping framing), but carried onto a different
predecessor it starts a task before an ancestor it was never planned against.
The clamp is stated on the row.

Unticking a root leaves its dependents as roots.

### 7.5 Apply

Roots start on the given date. Everything else starts at
`startAfter(effective predecessor's end, lag)` — the existing tested function.
Calendar days including weekends, per `src/lib/schedule/calendar.ts`.

**The client posts `{ templateId, startDate, tickedTemplateTaskIds }` and
nothing else.** The server re-reads the template inside the transaction and
derives predecessors, durations and dates itself. Posted dates are never
trusted; the sheet computes them only to show them, exactly as `Acceptance.tsx`
computes totals with the same pure engine the transaction re-runs.

A ticked id no longer in the template — voided since the sheet opened — is
refused in a sentence, as `moveTaskDates` refuses a stale fingerprint.

One transaction. Template task ids map to new `schedule_tasks` ids so
`predecessor_task_id` points at the job's own rows. Roots are written with
`lag_days = 0` or the `lag_needs_predecessor` CHECK refuses them.

Applying to a job that **already has tasks appends**, and the message says how
many were added. Adding a second phase part-way through a job is legitimate.
Where an imported task's name already exists on the schedule, one line says so —
the cheap guard against importing the same template twice.

---

## 8. Permissions

`scopeTemplates.edit` maps to `rates:edit`. That fitted while a template was
purely a pricing artifact.

There is **no `schedule:*` capability** — the schedule's actions use
`quote:write`, and `CAPABILITIES` in `src/lib/auth/permissions.ts` has no
schedule member. `rates:edit` and `quote:write` also have identical role
coverage, so a split changes nothing observable today.

So this is a **rename for honesty, not a new capability**:
`quoteTemplates.edit` and `scheduleTemplates.edit`, both in
`SETTINGS_CAPABILITIES`. Importing into a job is a schedule write and uses what
the schedule actions already require. Nothing is designed around it.

---

## 9. Screens say facts, not reasoning

A standing failure in this codebase is agents writing their reasoning into the
interface. Three passages in this document are design notes and must not reach a
screen: the three-option table in §7.4, the granularity limit in §6.4, and the
explanation of `rate_item_id` as provenance in §6.3.

What the sheet says is what `Acceptance.tsx` says: consequences, counts, dates.
*"No washrooms on this quote."* *"Drywall will wait on Site survey."* *"12 tasks
added."*

---

## 10. Not in this build

- **The backward pass** — *"the client wants to be in by December 15; when do I
  need the framer?"* The more valuable question, and the one where scheduling
  tools go subtly wrong, so it follows once the forward path is proven. Same
  data, no migration.
- **Auto-generating a schedule from the quote.** Rejected by the owner, and
  correctly: the order of work is not derivable from the order of a quote, and a
  confidently wrong schedule is worse than none.
- **Re-suggesting tasks when a change order adds scope later.**
- **A threshold condition** (`area > 2000`). See §6.1.
- **Resource levelling**, in any form.

---

## 11. Testing

Pure units, no database, in the style of `tests/unit/schedule-agenda.test.ts`:

- `divRoundUp` — exact multiples, remainders, zero, a negative divisor refused
- duration — base only, area divisor, count rate, both, milestone forced to one
  day, the one-day floor, and `end = start + days - 1`
- `effectivePredecessor` — a dropped middle task, a dropped root, three drops in
  a chain, a fork, and **re-tick restoring the original predecessor**
- lag — the dependent's own lag survives, a negative lag clamps across a re-link
- conditions — no condition is suggested, a measurement of zero is not, an
  excluded optional line does not match, a null `rate_item_id` matches nothing,
  a change order's line does match, no accepted quote unticks every conditional
- dates — roots on the given date, lag zero as the next morning, a milestone, a
  chain crossing a month boundary, dependency order against a hostile
  `sort_order`

Against the database:

- apply to an empty schedule, and to one that already has tasks
- predecessor ids point at the job's rows, never a template's
- a cycle refused on template save; voiding a task with dependents refused
- a ticked id voided between open and apply is refused

---

## 12. What the review changed

Recorded because five of these reversed decisions this document had argued for,
and the arguments are still in it above.

| Was | Now | Why |
|---|---|---|
| Rename to `templates` with a `kind` | Two parent tables | A trigger reads the renamed column by name and fails at run time; a shared parent cannot enforce its own kind |
| `trade_id` on the template | Prerequisite migration first (§3) | `schedule_tasks.trade` is free text, so it had nowhere to land |
| Re-link by mutation | Pure `effectivePredecessor` | Untick-then-retick left two tasks running in parallel |
| A cycle-on-drop test | Removed | Impossible under a stateless walk over a forest |
| A conditions child table | Two nullable columns | Nothing reaches the cardinality it was built for |
| `area` as a condition | Duration source only | True of every quote; the useful version needs a threshold |
| Measurements from "the accepted quote" | Estimate for counts, all accepted quotes for rate items | Change orders carry no measurements but their lines are scope |
| Days per square foot | Square feet per day | Exact, and the sentence he would actually say |
| "the schedule's own capability" | A rename only | No `schedule:*` capability exists |

---

## 13. Open

- Whether a template should carry a default assignee. Argued against: who is
  free in March is not who is free in November, so the template carries the
  **trade** and the vendor arrives at the assignment step.
- Whether a quote's measurements should be editable on the job after acceptance.
  They are the quote's record today, and conditions read them — correct for
  provenance, possibly surprising on a job whose scope has moved.
