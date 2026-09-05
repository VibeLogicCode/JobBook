# Plan — Job Costs and Scheduling

**Status:** written 2026-09-04, awaiting go-ahead. Not started.

**Specs:** `2026-08-30-phases-2-5-design.md` §3.2 (expenses, vendors), §3.4 (job
costing), §5.1–5.4 (scheduling, compliance). This plan does not restate them.
It records what the owner asked for, the four decisions he took, the one thing
the specs do not cover, and the order.

---

## What was asked for

In his words:

> "when will we add the option to add expenses to job which include what i am
> spending, mileage if i want, each additional needs to have receipt option,
> also planning for which sub contractors i need for this job and assign due
> dates to create a timeline to manage projects where each sub contract can be
> dependent on other. basically i want to plan out by job in which order i will
> do, and which delay will push out what."

Two features that share a spine: **money spent against a job**, and **work
planned across a job**. Both hang off vendors, both hang off cost codes, and
both are per-project.

This pulls **Phase 3** and **Phase 5** forward, ahead of the rest of Phase 4.
That is a deliberate reordering at the owner's request and worth naming: the
remainder of Phase 4 (purchase orders, payments, aging, cash flow) now comes
after, and the accountant export still waits on this work because it is the
first thing that produces expenses to export.

---

## Decisions taken

**1. Dependencies are per-task and opt-in.** His words: *"let me add if this is
a dependent task, if it is auto push, if not they would stay standalone."*

So a task either names a predecessor or does not. One that does moves when its
predecessor moves. One that does not is a fixed date and **never moves** — not
by inference, not because it sits between two tasks that did. This is exactly
the single-predecessor-with-lag model `phases-2-5-design.md` §5.2 already chose
over critical-path scheduling, so nothing in the schema changes to accommodate
it. What changes is that the UI must make "does this wait on something?" a
visible, deliberate answer rather than a field somebody skips.

**2. Mileage is tracked as distance, costed at a rate, and never billed.** A
per-kilometre rate lives in settings; kilometres are logged against a job and
become a cost line. It affects margin and never appears on a customer document.

**3. Receipts attach now; reading them comes later.** A photo or PDF stored
against the expense and viewable. No OCR in this pass — the engine is proven and
portable (`2026-09-04-reuse-from-budget-tracker.md` §2) but it is half a day on
its own plus 14 MB of weights, and the shoebox problem is solved the moment
paper stops being the only copy. The `source` and `ocr_*` columns in the spec's
`expenses` shape are created now and left unused, so adding OCR later is not a
migration against a live table.

**4. Subcontractors are real records, not typed names.** The `vendors` table
from §3.2. Both halves need it — assigned to tasks, paid on expenses — and
Phase 5's compliance gate is impossible without it. "Dave", "Dave M" and
"Dave Masonry" as three rows is a data problem that cannot be fixed later.

---

## The one thing the specs do not cover: mileage

`expenses` in §3.2 has no notion of distance. Rather than a second table, this
adds three columns and a kind:

```
expenses
  ... everything in spec §3.2 ...
  kind ENUM('purchase','mileage')     -- default 'purchase'
  distance_milli bigint               -- kilometres in thousandths
  rate_per_km_ten_thou bigint         -- SNAPSHOT, see below
```

**The rate is snapshotted on the row, not read from settings at display time**,
for exactly the reason a quote line snapshots its rate: the CRA per-kilometre
allowance changes every year, and a trip taken in 2026 must keep costing what
2026 cost. A stored rate is also what makes the figure defensible if it is ever
questioned — the alternative silently restates last year's mileage every January.

One table rather than two because job costing then stays a single query per
project. The cost of that is a `kind` discriminator and two columns that are
null on most rows; the cost of two tables is every costing query becoming a
union, forever.

A mileage row has no vendor and no receipt, and the UI must not ask for either.

---

## Auto-push: the part with real thinking in it

When a task's dates move, every task that names it as a predecessor shifts by
the same delta, and so on down the chain.

**Four things this must get right, none of them obvious:**

**A cycle must be refused at write time.** A depends on B depends on A makes the
push walk forever. The check belongs in the action, not the UI, and it must run
inside the writing transaction — a stale tab can otherwise create one between
the read and the write.

**A standalone task is never moved, even mid-chain.** If A → B, and C is
standalone and sits between them by date, C stays. That is the whole point of
the opt-in, and the temptation to "helpfully" shift C is the thing to resist.

**Planned and actual are both kept.** §5.2 is explicit and the reasoning stands:
overwriting a planned date with an actual one destroys the only evidence of how
estimates perform, which is the data that makes the next quote better. Auto-push
moves **planned** dates only. An actual date is a fact and is never computed.

**The owner is told what moved, before it moves.** A drag that silently shifts
nine tasks is how somebody loses a schedule they spent an evening building. The
action returns what would change; the screen says "moving framing 3 days moves 4
tasks; the job now finishes Mar 25" and the owner confirms. This is the single
most important interaction in the feature.

**Open question, not blocking:** calendar days or working days. Calendar days
are proposed — a residential crew working Saturday is ordinary, and skipping
weekends needs a per-province holiday table that is its own small project. Worth
revisiting once there is a real schedule to look at, and cheap to change
because the arithmetic lives in one function.

---

## Order of work

Costs first. It is smaller, it has no dependency on scheduling, and it starts
paying back the day it ships.

1. **Vendors** — the table, plus add/edit/retire, shaped like `/rates` and
   `/settings/cost-codes` rather than a third CRUD idiom. `is_subcontractor`
   and `trade` from the start, because the schedule needs them.
2. **Expenses** — the table, `expense_taxes`, the mileage columns, the settings
   field for the per-kilometre rate, and the capture form. Receipt upload
   through the existing `files` layer.
3. **Job costing view** — spend against a job, grouped by cost code, against the
   contract value that is already derived. This is the screen that makes the
   first two worth having.
4. **Schedule tasks** — the table, the per-task predecessor, the push
   calculation as a **pure function tested at its boundaries** before any UI
   touches it, and the confirm-what-moves interaction.
5. **Assignments** — a subcontractor on a task, with agreed amount.
6. **Compliance** — WSIB and insurance expiry, the override-with-reason gate,
   and expiry reminders through the Phase 2 engine that already exists.

Steps 1–3 are a usable feature on their own. Steps 4–6 are the second half and
can wait if something else is more urgent.

---

## Constraints carried

Unchanged, and each has been violated once already by somebody moving fast:

1. **Nothing is ever deleted.** No `DELETE` in application code.
2. **Money never passes through a JavaScript `number` mid-calculation** —
   integer cents, thousandths, ten-thousandths, via `src/lib/money/**`.
3. **`updated_at` is maintained by trigger.**
4. **Rates are snapshots.** Applies to the mileage rate exactly as it applies to
   a quote line.
5. **No tenant-specific value outside `src/db/seed/`** — and the CRA
   per-kilometre allowance is a tenant setting with a sensible default, not a
   constant in code.
6. **Scale is internal.** Anything leaving for a human is unscaled.
7. **One DOM tree reflowed by CSS**, never two render paths.
8. **Authorization is a per-request lookup**, and every refusal lives in the
   action rather than only in the UI.

---

## Risks

**The schedule is only as good as the maintenance.** Same risk as the reminder
list, and the same mitigation: a task list that is quick to update from a phone
on site beats a complete one that has to be maintained at a desk. If updating it
is a chore, it will be wrong within a fortnight, and a wrong schedule is worse
than none because people act on it.

**Expenses are entered in bulk or not at all.** §3.3 already says this and it is
worth repeating: an owner catching up on forty receipts at a kitchen table needs
a fast keyboard-driven grid. A form that takes six fields and a page load per
receipt will lose to the shoebox.

**Cost codes must be right before spend lands on them.** They were built today,
and recoding a year of expenses is the kind of job nobody does. Worth a look at
the seeded list before step 2 ships.
