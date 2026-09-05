# Schedule templates

**2026-09-05.** A saved shape of work — the tasks, how long each takes, and what
waits on what — applied to a job with one date, so a schedule is imported rather
than rebuilt from memory.

Agreed with the owner in conversation on 2026-09-05. Forward pass only; the
backward pass is named in §9 and deliberately not built.

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

## 3. Where templates live

`scope_templates` is renamed to `templates` and gains a `kind` of `'quote'` or
`'schedule'`.

The parent row today is `name`, `project_type`, `description`, `is_active` plus
`auditColumns`. That is exactly what a schedule template needs, so the row is
shared rather than duplicated. The children are separate tables because they
have no columns in common — forcing them into one would mean a spread of
nullable columns valid for only one kind, which is the usual way this goes
wrong.

```
templates                      kind: 'quote' | 'schedule'
├── scope_template_items       kind = 'quote'     rate item, source, multiplier
└── schedule_template_tasks    kind = 'schedule'  duration, predecessor, lag
```

**On the rename.** `quotes.scope_template_id` references this table. Postgres
carries foreign keys through a rename automatically, and the code changes are
mechanical. Normally this would not be worth the risk against live quote data;
here it is free, because nothing is deployed and there is one development
database. The cost only rises from today, and `scope_templates` holding
schedule templates would be a name that misleads somebody in a year.

`quotes.scope_template_id` is renamed to `template_id` in the same migration.

**Screens.** One list at `/templates` with a Kind column. A row routes to the
editor for its kind. **Add asks the kind first**, because past the name the two
forms have nothing in common.

---

## 4. A schedule template task

```
schedule_template_tasks
  id                            uuid
  template_id                   -> templates.id
  name                          text
  trade_id                      -> trades.id            nullable
  cost_code_id                  -> cost_codes.id        nullable
  sort_order                    integer
  is_milestone                  boolean

  duration_base_days            integer  not null default 0
  duration_source               enum: none|area|washrooms|kitchens|bedrooms
  duration_per_unit_ten_thou    bigint   not null default 0

  predecessor_task_id           -> schedule_template_tasks.id  nullable
  lag_days                      integer  not null default 0

  ...auditColumns
```

### Duration

```
days = duration_base_days + ceil(source_value × duration_per_unit)
days = max(days, 1)
```

*"Two days, then a day per 250 square feet"* is `base 2`, `source area`,
`0.0040` days per square foot. A flat five days is `base 5`, `source none`.

**Rounded up, never half-up.** You do not book half a framer-day, and a task
that rounds down is a task that finishes late. `src/lib/money/scale.ts` has
`divRoundHalfUp` and no ceiling helper; this needs a new `divRoundUp` beside
it, tested on exact multiples as well as remainders.

**Scale discipline.** `duration_per_unit_ten_thou` is ten-thousandths, matching
every other rate in the product. Area arrives as thousandths (`QTY_SCALE`).
The product is BigInt throughout and is divided once, at the end. Counts
(washrooms, kitchens, bedrooms) are plain integers and are scaled to
thousandths before the multiply so one code path serves both.

**A milestone is one day.** `is_milestone` forces start and end to the same
date whatever the duration arithmetic says, matching how `schedule_tasks`
already treats one.

### Predecessor

Self-referencing within one template. A cycle must be refused on save, reusing
`findPredecessorCycle` from `src/lib/schedule/push.ts` rather than a second
implementation.

---

## 5. Conditions — when a task applies

```
schedule_template_task_conditions
  id
  task_id        -> schedule_template_tasks.id
  measurement    enum: area|washrooms|kitchens|bedrooms   nullable
  rate_item_id   -> rate_items.id                         nullable
  CHECK (num_nonnulls(measurement, rate_item_id) = 1)
```

A task is **suggested** if it has no conditions, or if **any one** matches.

| Kind | Matches when |
|---|---|
| Measurement | the accepted quote's corresponding column is greater than zero |
| Rate item | the accepted quote has an **included**, non-void line carrying that rate item |

**Why two kinds.** The owner's example — *"only add the plumbing schedule if
there is a bathroom"* — is a measurement, and `quotes.washroom_count` already
answers it with one dropdown and no rate-item hunting. A rate item is the
precise fallback for work the four measurements cannot express: a deck, a wet
bar, underpinning.

The two together also separate bathroom plumbing from kitchen plumbing without
any new machinery: one task conditions on `washrooms > 0`, the other on
`kitchens > 0`.

**No conditions means unconditional**, not "never applies". Permits, site
protection, supervision and cleanup are on every job and must not need a
condition invented for them.

**Only included lines count.** An optional upgrade the customer declined must
not schedule work. Optional lines start excluded, so this is the common case
rather than an edge.

**A hand-typed quote line matches nothing.** `quote_lines.rate_item_id` is
provenance and is null on a line somebody typed. Reading it here is a new use
of that column and its limit must be stated on screen rather than discovered:
the unmatched rows stay visible and tickable, which is what makes this
recoverable. See §6.4.

### The limit worth naming

**The schedule can only be as granular as the quote.** Price plumbing as one
bundled line with no room counts and nothing can recover which rooms it
covered. That is not fixable with more machinery; it is a reason to price at
the granularity you intend to schedule at.

---

## 6. Importing

An **Import from template** button in the job schedule's header, beside Add
task. It opens a `Sheet`, following `src/app/quotes/[id]/Acceptance.tsx` — the
precedent for "tick what applies, and be told the consequences in words before
pressing".

### 6.1 Pick a template

Templates of `kind = 'schedule'` that are active, with the ones matching the
job's `project_type` first. Not filtered to them — a basement template is a
reasonable start for a rec-room job.

### 6.2 Pick a start date

Defaults to the tenant's today via `tenantToday`, never the server's.

### 6.3 The task list

Every task in the template, in `sort_order`. Each row shows its name, trade,
computed duration, and what it waits on.

Rows whose conditions match are **ticked**. Rows whose conditions do not match
are **shown, greyed, and unticked, with the reason** — *"no washrooms on this
quote"*.

Hiding them was rejected. A hidden task makes the template look broken — *where
did plumbing go?* — and a silent omission is how a trade gets forgotten. This is
the same rule the calendar follows in printing "Nobody booked" rather than
leaving a cell blank.

An unmatched row can still be ticked. That is the recovery path for a quote
built by hand.

### 6.4 Unticking re-links, it does not orphan or cascade

Untick a task others wait on and **its dependents attach to whatever it waited
on**, keeping their own lag.

Three behaviours were considered:

| | |
|---|---|
| Refuse | Safe and unusable: dropping framing would mean hand-unticking drywall, then paint |
| Cascade | Dropping one task silently drops five. Destructive and surprising |
| **Re-link** | **What actually happens on a site: skip a step and the next follows the one before it** |

The consequence is stated before it is applied — *"Drywall will wait on Site
survey instead."* Same rule as `MoveDates`: show what will happen before it
happens, never after.

Unticking a **root** leaves its dependents as roots.

### 6.5 Apply

Tasks that wait on nothing start on the given date. Everything else starts at
`startAfter(predecessor's end, lag)` — the existing tested function, not a
second implementation. Calendar days including weekends, per the rule
`src/lib/schedule/calendar.ts` already documents.

Writing is one transaction. Template task ids map to new `schedule_tasks` ids
so `predecessor_task_id` points at the job's own rows, never at a template.

Applying to a job that **already has tasks appends**, and the success message
says how many were added. Part-way through a job, adding a second phase is
legitimate; refusing would make the feature useless exactly when it is most
useful.

---

## 7. Permissions

`scopeTemplates.edit` currently maps to `rates:edit`. That fitted while a
template was purely a pricing artifact. Someone who can edit the rate list is
not automatically who should define how a job is sequenced, so it splits:

- `quoteTemplates.edit` → `rates:edit` (unchanged behaviour, new name)
- `scheduleTemplates.edit` → the schedule's own capability

Importing a template into a job is a schedule write and uses the capability the
schedule actions already require.

---

## 8. Testing

Pure units, no database, in the style of `tests/unit/schedule-agenda.test.ts`:

- `divRoundUp` — exact multiples, remainders, zero, negatives refused
- duration — base only, rate only, both, milestone forced to one day, the
  minimum of one day
- condition evaluation — no conditions is suggested; any-match; an excluded
  optional line does not match; a null `rate_item_id` matches nothing
- re-linking — a dropped middle task, a dropped root, a chain of three drops,
  and a drop that would otherwise create a cycle
- date computation — roots on the given date, lag zero as the next morning,
  a milestone, and a chain crossing a month boundary

Against the database:

- apply to an empty schedule, and to one that already has tasks
- predecessor ids point at the job's rows, never a template's
- cycle refused on template save

---

## 9. Not in this build

- **The backward pass** — *"the client wants to be in by December 15; when do I
  need the framer?"* It is the more valuable question and the one where
  scheduling tools get subtly wrong, so it follows once the forward path is
  proven. Same data, no migration.
- **Auto-generating a schedule from the quote.** Rejected by the owner and
  correctly: the order of work is not derivable from the order of a quote, and
  a confidently wrong schedule is worse than none.
- **Re-suggesting tasks when a change order adds scope.**
- **Resource levelling**, in any form.

---

## 10. Open

- Whether a schedule template should carry a default assignee per task. Argued
  against for now: who is free in March is not who is free in November, so the
  template carries the **trade** and the vendor arrives at the assignment step.
- Whether the quote's measurements should be editable on the job after
  acceptance. They are the quote's record today. Conditions read them, so a
  job whose scope changed reads its original measurements — correct for
  provenance, possibly surprising on import.
