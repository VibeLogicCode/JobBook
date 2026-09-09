# Service work and contract work

**2026-09-09.** Agreed with the owner. **The next thing to be built**, ahead of
the launch-blockers, by his decision.

This supersedes §3 of `2026-09-07-two-companies-design.md`, which argued that
simple mode should key on the job *"not the company"*. That was overcorrected.
The owner's reply is the reason:

> *"regarding 2 companies its not just tax separation they will have different
> workflows correct? what i mean by that is 1 will be company setup that has to
> act like a builder or a big contractor and second as a small 1 man shop."*

He is right, and the earlier design was answering a smaller question.

---

## 1. What was wrong, and what replaces it

The 2026-09-07 design treated the difference as **form length** -- the same
screens with fewer fields. It is not. A one-man shop and a home builder run
**different businesses**: one is dispatched to a job, does it, invoices it once
and gets paid; the other signs a scope, draws against progress, holds back
statutory amounts, coordinates subcontractors against a schedule, and issues
change orders.

Those are different products, not different form lengths. A field that is
merely collapsed is still a field somebody has to understand and decline.

**So there are two levels, and they are different in kind:**

| Level | Decides | Granularity |
|---|---|---|
| **Company posture** | Which MODULES exist | Whole screens and nav entries, absent |
| **Project type** | Which FIELDS appear on a job | Forms, inside an enabled module |

Both are needed. Collapsing them into one was the error: a builder still wants
a short path for a warranty visit, which the company level cannot give; a solo
electrician should never see a holdback field at all, which the job level
cannot give.

---

## 2. The vocabulary, and why not "builder"

The owner's objection, which reframed this:

> *"can this app not be used for other services like electrician plumber? i
> dont want to call it a builder what do you say?"*

**Naming the trade would make the product narrower than it is.** An
electrician, a plumber, an HVAC contractor and a home builder all have the
same split *inside their own business*. The axis is the WORK, not the trade.

- **Service work.** Dispatched. One visit or a few days. One invoice. Usually
  no subcontractors, no holdback, no schedule worth drawing. A leaking tap, a
  panel swap, a furnace that will not fire.
- **Contract work.** A signed scope. Progress draws. Holdback.
  Subcontractors. A schedule with dependencies. Change orders. A custom home,
  a full rewire, a finished basement.

**This is not invented vocabulary.** Electrical, plumbing and HVAC companies
organise themselves exactly this way -- a service department and a
construction department, different paperwork, often different crews. It is the
language the customer already uses about himself, which is the only test that
matters for a word on a first-run screen.

**And the same two words work at both levels**, which is what makes the
two-level model teachable rather than a second thing to learn. The company
says which kinds of work it does; the project type says which kind this job
is.

---

## 3. What the company is asked

One question, three answers, in the first-run wizard's `financial` step or a
step of its own:

> **What kind of work do you do?**
> - Service work
> - Contract work
> - Both

**"Both" is today's behaviour**, which makes it the safe default and makes
this change backward-compatible by construction: an existing deployment reads
as "both" and nothing it can see moves. Only "service only" hides anything,
and only "contract only" is a claim about not doing service work.

A company that answers "both" gets every module, and the per-job project type
does all the narrowing. A company that answers "service" never sees the
contract modules again.

**Changeable afterwards, in Settings, always.** A service company that lands
its first contract turns contract work on; nothing about its existing jobs
changes, because they were all service jobs and remain so.

### 3.1 Where the answer lives

`organization`, not `companies`. This is a fact about the deployment's
operating posture and it is needed before `companies` exists (Wave B of the
two-companies design is not scheduled). When `companies` is built, the column
moves there and `organization` keeps a deployment-wide default -- and that
move is why the reader must be a function from the start (§6.1) rather than 40
call sites reading a column.

---

## 4. What "service only" removes

Removed means **absent** -- no nav entry, no settings section, no route, the
guard refusing the route directly rather than the link merely being hidden. A
hidden link is not a permission and it is not a simplification either; the
screen is still there to be found.

| Removed under "service only" | Why it does not apply |
|---|---|
| Holdback: the `/settings/financial` holdback fields, the project billing screen's holdback ledger, the `holdback_release` invoice kind | See §4.1 -- this is the one with a legal caveat |
| The `progress` invoice kind | A dispatched job is invoiced once, at the end |
| Schedule templates (`/templates/schedule`) and the forward pass | Three tasks do not want a critical path |
| Construction Act dates: substantial performance, publication, last supply | Same statutory regime as holdback |
| Purchase orders | Unbuilt. Recorded here so it is never built without asking. |
| T5018 reporting | Unbuilt. A service company with no subs files none. |
| The area / washrooms / kitchens / bedrooms scope inputs | Written for a build |

**Kept, deliberately, under "service only":**

- **Vendors, trades and subcontractor assignments.** A one-man electrician
  still calls a drywaller to patch what he cut. Removing vendors would be
  reading "small" as "alone".
- **The rate book, cost codes and the margin gauge.** A service company cares
  about margin at least as much as a builder, and usually knows it worse.
- **Change orders.** "While I'm here, can you also..." is the commonest
  service upsell there is.
- **Quotes, the pipeline, reminders, the calendar, expenses, AP/AR.** All of
  it applies. AP/AR especially: getting paid is not a builder feature. The
  2026-09-07 design listed AP/AR as removable and that was wrong.

### 4.1 The holdback caveat, which is load-bearing

**Hiding holdback by company can produce a legally wrong document.**

Under the Construction Act the holdback obligation attaches to the improvement
rather than to the size of the contract. If a service company signs a $50,000
renovation, holdback applies whether or not the screen shows a field for it.

So the posture sets a **default that a job can override**, never a hard
removal:

- Under "service only", holdback is off on every new job and its settings
  section is hidden.
- A project whose type is marked contract work turns it back on for that job,
  and the settings needed to compute it fall back to sane statutory defaults
  rather than being unreachable.
- **Off by default, never off by force.** A module the owner cannot re-enable
  on a single job is a module that will eventually be wrong on a real
  contract.

This is the one place where "absent" is downgraded to "off", and the reason is
written here so it is not tidied away later for consistency.

---

## 5. What the project type decides

`project_types` gains flags. It is already a maintained database list with a
case-insensitive uniqueness index and a retire-rather-than-delete rule, so it
is the right home.

The primary flag is the same axis as the company's: **is this job service work
or contract work.** Under a company that answers "both", this is what decides
which form a job gets. Under "service only", contract types are not offered,
and §4.1 is how one is still possible.

Secondary flags stay per type because they vary within an axis: a bathroom
renovation is contract work that wants no schedule template, and a large
service call may want progress invoicing.

### 5.1 The seeded defaults must follow the posture and the trade

`src/db/seed/project-lists.ts` currently seeds: Custom home, Basement,
Renovation, Kitchen, Bathroom, Addition, Commercial TI, Water leak, Other.

**Every one of those is a builder's list.** A plumber's first screen would be
somebody else's business, which is the worst possible first impression for a
product being sold to trades. §5.2 is how that is fixed.

---

## 5.2 Starter data per trade

**Owner, 2026-09-09:** *"also make sure this can be used by other trades too.
even if that means having sample codes and data per trade they are being used
for. so based on selection in company setup (construction, electrical,
plumbing and other generic trades we give them sample code list and other data
pre populated). is that possible?"*

Yes, and it is the single change that most affects whether anybody keeps using
this. **An empty rate book is why estimating software gets abandoned in week
one.** A contractor who has to type forty cost codes before he can price his
first job will go back to the spreadsheet he already has.

### 5.2.1 Trade is orthogonal to posture

§9 of the first draft of this document listed *"asking the customer's trade"*
as out of scope. **That was wrong, but the reasoning it came from is worth
keeping**, because it is what stops the two ideas being conflated:

| | Decides | Gates anything? |
|---|---|---|
| **Posture** (service / contract / both) | Which MODULES exist | Yes -- routes refuse |
| **Trade** (electrical, plumbing, ...) | Which STARTER DATA is loaded | **No. Nothing.** |

The trade must never gate a feature. The same electrician does service calls
and full rewires, which is the entire argument of §2. It selects a pack of
rows at first run and then has no further effect -- there is deliberately no
`trade` column consulted at runtime, and no screen that behaves differently
because of it.

### 5.2.2 It is a copy, never a link

The pack is inserted as ordinary rows the owner then owns: he edits them,
retires them, adds his own. **There is no mechanism that ever updates a
seeded row**, and there must not be -- an "update your rate book from the
latest pack" feature would overwrite a contractor's own prices, which is the
single most destructive thing this product could do to somebody's business.

A consequence to accept rather than fix: a pack improved in a later release
reaches only new installations. That is correct. The alternative is worse.

### 5.2.3 THE PACKS MUST NOT CONTAIN PRICES

The hard rule, and the reason it is in capitals.

**Ship codes, descriptions, units and cost-code structure. Never a dollar
figure.** A rate book pre-filled with invented numbers is worse than an empty
one, because it looks authoritative: a contractor who quotes at prices this
product guessed will either lose the job or lose money on it, and neither
failure will be traced back to a seed file. Labour and material rates vary by
region, by year, by supplier and by how busy he is -- none of which this
software knows.

`rate_items.sellRateTenThou` is NOT NULL, so seeded rows carry zero, which the
existing form hint already describes: *"Blank records as zero, and the margin
will read 100%."* The rate list must say plainly that a zero-priced item is
unpriced and will not quote correctly until he prices it. **The value being
handed over is the STRUCTURE -- the list of things an electrician bills for,
already coded and cost-coded -- not the arithmetic.**

The same rule applies to the target margin and to holdback percentages: a
statutory default is a fact and may be seeded; a business's margin is not.

### 5.2.4 Cost codes: do not reproduce a proprietary standard

The obvious move for a construction pack is CSI MasterFormat divisions. **Do
not ship them.** MasterFormat's numbering and titles are CSI's copyrighted
compilation, and this is a product being sold. Reproducing it wholesale is a
licensing question, not a technical one.

What is safe is plain-language divisions that any tradesperson would
recognise -- Concrete, Framing, Roofing, Electrical, Plumbing -- because short
functional names are not the protectable part. If MasterFormat alignment is
ever genuinely wanted, that is a licence to buy, and the owner's own
accountant-driven chart of accounts is the authority anyway
(`2026-09-07-generated-codes-design.md` §2).

### 5.2.5 One pack per trade, rows tagged by posture

The combination could be a matrix -- trade times posture -- and must not be.
Each pack is one list, and every row in it carries the posture it belongs to:
`service`, `contract`, or both. The wizard then loads the pack for the trade
and offers the rows the posture allows.

So an electrical pack holds `Service call` tagged service, `Rewire` tagged
contract, and `Panel upgrade` tagged both. One pack, no matrix, and adding a
posture later does not multiply the content.

### 5.2.6 The trades to ship, and how many

Deliberately few. **A bad pack is worse than no pack**, because a wrong list
on the first screen reads as a product that does not understand the business:

1. **General contracting / renovation** -- today's list, which already exists
   and is already proven against a real company.
2. **Electrical**
3. **Plumbing**
4. **HVAC**
5. **Other / none** -- project types and line groups only, no rate items, no
   cost codes. The honest answer for a trade there is no pack for, and it must
   not be a worse experience than today's empty start, only a plainer one.

Landscaping, roofing, painting and drywall are the obvious next four and are
deliberately not in this build. Each pack is content work that wants somebody
who knows the trade to read it, and shipping four good packs beats eight
guessed ones.

### 5.2.7 What a pack contains

- **Project types**, posture-tagged (§5.2.5).
- **Cost codes**, one shallow division per bucket the trade actually reports
  on. Shallow on purpose: a deep hierarchy nobody asked for is the first thing
  a new user has to delete.
- **Rate items**, coded and cost-coded, **unpriced** (§5.2.3).
- **Line groups**, which are how a quote is sectioned and are strongly
  trade-shaped.
- **Trades** (the `trades` table, meaning subcontractor kinds hired) -- the
  general-contracting pack wants the full list; an electrician's is short.
- **Nothing else.** Not vendors, not customers, not tax rates. Vendors and
  customers are the owner's actual relationships and inventing them would put
  fictional companies in a real business's records -- which the demo tenant
  does deliberately and a production install must never do. Tax rates are
  jurisdictional and already their own wizard step.

### 5.2.8 Where it lives

`src/db/seed/project-lists.ts` already holds `DEFAULT_PROJECT_TYPES` and
`DEFAULT_LEAD_SOURCES` with fixed ids, so the mechanism exists. It grows into
one module per trade under the same directory, each exporting the same shape,
with an index mapping a trade to its pack.

**Fixed ids per pack row, as the existing seed already does.** That is what
makes re-running the wizard idempotent rather than duplicating a list.

**This is a content problem wearing a code problem's clothes.** The code is a
day; the packs are the work, and they are the part that decides whether the
feature is any good.

---

## 6. How it is implemented

### 6.1 One reader, not forty

A single function answers the question -- something of the shape
`workPosture()` returning `'service' | 'contract' | 'both'`, cached per request
the way `loadOrganization` already is.

**Nothing reads the column directly.** The two-companies design counts 23
files that read the organization row directly rather than through
`loadOrganization`, and that count is the whole reason repointing them is a
day's work. This must not add a twenty-fourth pattern. When the posture later
moves to `companies`, one function changes.

Derived predicates sit beside it -- `hasContractWork()`, `hasServiceWork()` --
so a call site reads as a question about the business rather than a string
comparison, and a fourth posture (§9) would not touch the call sites.

### 6.2 Nav and settings are data, not markup

`src/components/ui/destinations.ts` already exists as the single list behind
both the desktop rail and the phone bar, with `tests/unit/navigation.test.ts`
asserting that every destination is reachable from exactly one of them. A
destination gains a posture predicate and the filtering happens in that
module, so the rail, the bottom bar and the overflow sheet cannot disagree
about what exists.

`src/app/settings/nav.ts` takes the same treatment for its grouped sections.

### 6.3 The guard is the route, not the link

Every removed route refuses directly. A hidden nav entry is not a permission
-- this codebase has already written that sentence about the estimator role
and it is no less true when the thing being hidden is a module rather than a
column.

### 6.4 Absence is the off state

`src/db/schema/system.ts` states the rule: *"Absence is the off state, so no
defaulted column can switch a feature on for someone who never asked."* Here
that means the posture column defaults to the value that changes nothing --
`'both'`. An existing deployment, and the demo tenant, read as they do today.

The same file's *"deliberately no feature_flags table"* rule is overridden for
these flags, as the 2026-09-07 design records: that rule protects
CREDENTIALS, and nothing about "this company does not do contract work" is a
secret or costs anything by appearing in a backup.

---

## 7. Testing

The suite is `environment: 'node'` with no component tests, so the rules have
to be assertable as data. That is the same reasoning that produced
`destinations.ts`.

- **Posture resolution**: all three values, and the default when the column has
  never been set.
- **Nav filtering**: under each posture, every destination is reachable from
  exactly one of the bar or the overflow -- the existing invariant, now once
  per posture. And that a removed destination appears in neither.
- **Every removed route refuses** under "service only", called directly rather
  than through a link. This is the test that would catch a hidden-link
  implementation.
- **The holdback override** (§4.1): a contract-type job under a service-only
  company computes holdback correctly, using fallback defaults. This is the
  test that stops "absent" being implemented where "off" was meant.
- **Backward compatibility**: a deployment with no posture set behaves
  byte-identically to today. Worth asserting on the seeded demo tenant, which
  is what anybody evaluating the product sees.
- **Seeded project types** match the posture chosen in the wizard.

---

## 8. Cost and sequence

**The posture work: two to four days**, most of it in §4's audit -- finding
every surface that mentions holdback (27 files match `holdback` today) and
deciding for each whether it is absent, off, or untouched. The code is not the
hard part; the list is.

**The trade packs: a day of code, and the packs themselves are content.** The
seed mechanism exists. Writing four packs that a tradesperson would recognise
as his own list is the real work, and it wants review by somebody who does
that trade -- an electrical pack written by guessing is exactly the "bad pack"
§5.2.6 argues against shipping.

Splitting them is possible: posture first, packs second, with the
general-contracting pack being today's list unchanged and therefore free.

**Sequenced ahead of the launch-blockers by the owner's decision** (§10b.1,
§10b.2a of the backlog). One thing recorded and then dropped: **the backup key
still blocks selling.** Posture is what makes the product sellable to more
people; the key is what makes it defensible to sell to anyone. This may move
ahead of it, but not indefinitely.

**Relationship to the two-companies design:** independent, and this one comes
first. Posture is per-deployment today and moves to per-company when
`companies` is built, which §6.1 is what makes cheap. Nothing here assumes
that wave ever happens.

---

## 9. Not in this design

- **A third level between service and contract.** Offered and declined by the
  owner. If a $15,000 bathroom turns out to want something between a dispatch
  and a custom home, that is a project type with contract work and no schedule
  template -- which §5 already allows -- rather than a third posture.
- **Letting the trade gate a feature.** The trade is asked, and it selects a
  starter pack (§5.2) -- but nothing at runtime consults it, there is no
  screen that behaves differently because of it, and there is no `trade`
  column read after first run. The same electrician does service calls and
  full rewires, which is why posture and trade are separate questions.
- **A rate pack containing prices.** §5.2.3. Not a scope decision, a rule.
- **Reproducing MasterFormat.** §5.2.4. A licence to buy, not code to write.
- **Any mechanism that updates a seeded row after first run.** §5.2.2. It
  would overwrite a contractor's own prices.
- **More than four trade packs in this build.** §5.2.6.
- **Removing vendors, rates, change orders or AP/AR under "service only".**
  §4 argues each. The 2026-09-07 design's claim that AP/AR is removable was
  wrong: getting paid is not a builder feature.
- **Per-user posture.** It is a property of the business, not of who is
  looking.
- **Hiding holdback outright.** §4.1.
