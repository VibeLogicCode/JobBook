# Phase 2 Plan — Pipeline, Activity, and Reminders

**Status:** written 2026-09-04, ahead of execution.

**Spec:** `2026-08-30-phases-2-5-design.md` §2. This plan does not restate the
spec; it records the decisions taken at execution time, the order, and the
seams. Where the two disagree, this document is the later thought and wins.

---

## What Phase 2 is for

The owner's process starts with a phone call and ends at a completed job.
Today the middle of that lives in his head and his text messages. Phase 1 made
the *quote* good. It did nothing about the follow-up, which is where the work
is actually lost: a quote sent and never chased is indistinguishable from a
quote that was declined, and both show up as silence.

So the measure of this phase is not that a board looks nice. It is that on a
Tuesday morning the owner opens one screen and it tells him who to call.

---

## Decisions taken at execution time

Three, all recorded here because each one changes what gets built.

**1. Reminders before the board.** The spec lists a pipeline board and a
reminder engine as one phase, in that order. Built the other way round. A board
is a view of state that already exists — it is satisfying to look at and
changes nothing on its own, because the owner already knows which four jobs he
has. The reminder engine is the part that does work while nobody is looking.
The board lands second, and lands better for having reminders to put on the
cards.

**2. Outbound email is deferred, not built.** The spec's §2.4 offers
`nodemailer` over Microsoft 365 SMTP or Graph `sendMail`. Neither ships in this
slice. Phase 2 ships a **log-an-email action** and the activity record behind
it.

The reasoning is the same one that cut email from the update notifier
(`distribution-and-updates.md` §4.2): the realistic failure mode is the machine
being unplugged, and a mail job on a dead machine sends nothing while looking
exactly like one that works. Add to that a stored credential on a mini PC in a
contractor's office, and app passwords being withdrawn across tenants, and the
cost lands before the benefit does. Sending is revisited once the reminder loop
is proven to be something the owner actually uses — if he is not opening the
reminders, an emailer that sends on his behalf is worse than nothing.

This is a deferral with a trigger, not a cut. The trigger is evidence of use.

**3. Inbound email stays deferred**, per the spec, and for the spec's reason.
Recorded rather than re-argued.

---

## Data model

`stage_history` already exists and is already written by a trigger on every
stage change. Phase 2 adds three tables and no columns to existing ones.

```
activities
  id, entity_type ENUM('customer','project','quote'), entity_id,
  kind ENUM('call_in','call_out','email_in','email_out','sms',
            'site_visit','meeting','note'),
  occurred_at, subject, body, duration_minutes, user_id,
  record_status, void_reason, created_at, updated_at
  INDEX (entity_type, entity_id, occurred_at DESC)

reminders
  id, entity_type, entity_id,
  title, detail, due_at,
  kind ENUM('callback','follow_up','quote_expiring','site_visit',
            'compliance','custom'),
  status ENUM('open','done','dismissed'), completed_at, completed_by,
  assigned_to, snoozed_until,
  recurrence ENUM('none','daily','weekly','biweekly','monthly'),
  recurrence_until DATE, generated_by_rule_id,
  record_status, void_reason, created_at, updated_at

reminder_rules
  id, name,
  trigger ENUM('quote_sent','quote_expiring','stage_entered','no_activity',
               'site_visit_scheduled','project_won'),
  trigger_stage,        -- for stage_entered only
  offset_days int,      -- negative means before
  reminder_kind, title_template, is_active,
  record_status, void_reason, created_at, updated_at
```

### Points where this is easy to get wrong

**`entity_type` + `entity_id` is a polymorphic reference, and the database
cannot enforce it.** A foreign key would be the normal answer and is not
available across three parent tables. Accepted deliberately, because the
alternative — three nullable FK columns with a CHECK that exactly one is set —
triples the width of every query that lists a timeline. The cost is that a
dangling `entity_id` is possible; the mitigation is that nothing is ever
deleted in this product, so the only way to dangle is a bug rather than
ordinary use.

**`occurred_at` is not `created_at`.** An owner logs Tuesday's call on
Thursday. The timeline orders by `occurred_at`; the audit trail keeps
`created_at`. Conflating them makes the timeline lie, and it is the kind of lie
nobody notices until they are reconstructing a dispute.

**`due_at` is a timestamp, `recurrence_until` is a date.** A reminder is due at
a moment; a recurrence stops on a day. Storing the second as a timestamp
invites a timezone bug at the boundary, in a product whose tenant timezone is
already configuration.

**Every table carries `record_status` and `void_reason`,** because nothing is
ever deleted and the application role holds no `DELETE` privilege. A dismissed
reminder is `status = 'dismissed'`; a reminder created in error is
`record_status = 'void'`. Those are different events and must not share a
column.

**`updated_at` is maintained by trigger,** never in application code. Each new
table needs the trigger attached in the same migration that creates it — a
mirrored table without one is a Phase 1 invariant violation.

---

## The scheduler

Rules are evaluated hourly. **In its own container, on the same image**, which
is exactly the shape `docker-compose.app.yml` already uses for backups, and for
the same two reasons: a slow evaluation cannot slow the web server, and a
failing evaluation cannot take the quoting system down with it. It updates with
the app rather than drifting a major version behind.

**Idempotency is the whole problem.** A rule that has already produced an open
reminder for an entity must not produce a second. Without that, an hourly job
creates twenty-four duplicates a day and the owner stops opening the screen —
which is the only failure mode that matters, because a reminder system nobody
trusts is worse than no reminder system.

The guard is a **unique partial index**, not an application-level check:

```sql
CREATE UNIQUE INDEX reminders_one_open_per_rule
  ON reminders (generated_by_rule_id, entity_type, entity_id)
  WHERE status = 'open' AND record_status = 'active';
```

Application code checks too, because a friendly outcome beats an exception. But
the index is what makes it true, and it is what survives two evaluations racing
after a restart. A `SELECT` followed by an `INSERT` is not a guard.

Note what the index deliberately allows: once a reminder is completed, the rule
may fire again. That is correct — a quote followed up in March and still open in
June should be chased again.

**Hand-made reminders have `generated_by_rule_id IS NULL`** and are therefore
outside the index entirely. The owner may write "call Dave" twice if he wants
to; that is not the machine duplicating itself.

### Seeded default rules

All editable, all seeded rather than hardcoded, per the spec:

| Trigger | Default | Produces |
|---|---|---|
| `quote_sent` | +3 days | "Follow up on quote to {customer}" |
| `quote_expiring` | −5 days | "Quote {number} expires in 5 days" |
| `site_visit_scheduled` | −1 day | "Site visit tomorrow at {address}" |
| `no_activity` | +14 days | "No contact with {customer} in 14 days" |
| `project_won` | +1 day | "Won {project} — confirm start date and deposit" |

`title_template` interpolation is a closed set of named fields, resolved
server-side. It is not a template language and must not become one.

**Seeds go in `src/db/seed/`** — the only place a tenant-specific literal is
permitted, and `tests/ops/white-label.test.ts` enforces that everywhere else.

---

## Order of work

1. **Schema + migration + triggers.** Three tables, the partial index, seeded
   rules. Nothing visible ships.
2. **Reminder repository and the rule evaluator, as pure functions.** Tested
   against a clock passed in, never `Date.now()` — a rule engine that reads the
   wall clock cannot be tested at a boundary, and every interesting case is a
   boundary.
3. **The hourly job and its container.** Proved by running it twice in a row
   against the same state and asserting the second run creates nothing.
4. **Reminders screen** — list, complete, snooze, reschedule.
5. **Today gains a reminders panel** — due, overdue, snoozed.
6. **Activity timeline** on customer and project detail, plus the log-an-activity
   form that includes log-an-email.
7. **Pipeline board** — by stage, cards showing customer, value, days in stage,
   next reminder. Below `sm`, a stage-filtered list rather than a horizontally
   scrolling board.

Steps 1–3 are the phase. Steps 4–7 are what makes it visible.

---

## Constraints carried from Phase 1

Unchanged, and every one of them has already been violated once by somebody
moving fast:

1. **Nothing is ever deleted.** No `DELETE` in application code.
2. **No tenant-specific value outside `src/db/seed/`.**
3. **Money never passes through a JavaScript `number` mid-calculation.**
4. **`updated_at` is maintained by trigger.**
5. **Scale is internal** — anything leaving the system for a human is unscaled.
6. **One DOM tree reflowed by CSS**, never two render paths. The board below
   `sm` is a filtered list produced by CSS and a filter, not a second component.
7. **Authorization is a separate per-request lookup**, never a provider claim,
   and every refusal lives in the server action rather than only in the UI. A
   narrowed dropdown is a hint; a stale tab and a hand-made POST both go
   through the action.

---

## Risks

**The owner does not use it.** The real one. A reminder system is only as good
as the habit, and no amount of correctness substitutes. Mitigation is scope:
the seeded rules must produce a small number of obviously-useful reminders on
day one. Five rules that each fire usefully beat twenty that make the list
noise. If the first week produces a screen he scrolls past, the rules are wrong
and should be cut rather than tuned.

**Timezone.** Reminders are due at a local moment and the tenant timezone is
already configuration. "Due today" must be computed in the tenant's zone, not
the server's and not UTC. This is the single most likely source of an off-by-one
that reads as the system being broken.

**`no_activity` is the expensive rule.** It is the only trigger that scans
rather than reacting to an event, and it is the one most likely to produce
noise across a customer list that grows. Built last of the five, and measured.
