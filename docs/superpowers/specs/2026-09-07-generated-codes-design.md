# Who owns the code fields

**2026-09-07.** Agreed with the owner. **Not scheduled. Nothing here is
built.**

The owner, looking at the "Add a cost code" and "Add a rate item" forms:
*"also the code fields in app shouldnt they be created and controlled by you?
couldnt the code come the the cost cost associated with the rate or the rate
list should have its own code based on code cost associated px. PLM-01,
PLM-02"*

He is right about the rate list and his suggested form is the right one. He is
wrong about cost codes, for a reason that has nothing to do with software.

---

## 1. The distinction that decides both answers

**A rate code is a label. A cost code is an identity that has to agree with
something outside this app.**

The schema already says so, and the asymmetry is easy to miss because the two
forms look alike:

| | Rate item code | Cost code |
|---|---|---|
| On a quote line | `quote_lines.code` -- **snapshotted**, frozen at creation | `quote_lines.cost_code_id` -- **live foreign key** |
| Renaming it later | Past quotes keep the old code | Past quotes' reporting changes with it |
| Who else needs to agree | Nobody | The accountant's chart of accounts |

So a rate code is a word that gets copied onto documents and then never
changes. That is exactly the kind of thing software should generate, and
exactly the kind of thing that should be MEANINGFUL rather than opaque --
which is the owner's point, and why `PLM-02` beats `RT-0047`.

A cost code is the opposite. It is a live identity that a person outside the
app has to recognise.

---

## 2. Cost codes: keep them typed, suggest the child

**The app must not invent cost codes.**

A cost code list is a chart of accounts for job costing, and contractors
inherit theirs: CSI MasterFormat divisions, NAHB codes, or whatever their
bookkeeper already uses. The export this app will eventually hand an
accountant has to line up with the books that accountant already keeps. This
is the one field in the product that must agree with something the product
does not own, so generating it would be the app overruling the only authority
that matters.

`cost_codes` is hierarchical: `parentId` references `cost_codes.id`, and the
form's "Sits under" field is that column.

**What the app can do:** when a parent is chosen, prefill the code from the
parent -- parent `PLM` suggests `PLM-10`. Editable, and it can be cleared
entirely. A suggestion, not an allocation, because the person may be pasting a
code their accountant gave them.

Nothing else about the cost code form changes.

---

## 3. Rate item codes: allocate on save, do not prefill

The owner asked for a prefilled suggestion. **Allocating server-side when the
field is left blank is strictly better**, and the reasons are specific rather
than stylistic.

### 3.1 The form

The Code field stops being required and gains hint text naming what will
happen:

> Leave blank and it becomes PLM-03.

The hint reads the currently selected cost code, so it is accurate at render
time. On save, `PLM-03` is allocated inside the transaction that inserts the
row, and the existing confirmation already names it: `saved(\`${code}
added.\`)` at `src/app/rates/actions.ts:87`.

### 3.2 Why not a prefilled value

**A prefilled code goes stale.** Two people adding a plumbing rate both get
`PLM-03` in their browsers. The second save hits
`rate_items_code_unique`, and `actions.ts:80` correctly refuses it -- so a
convenience becomes an error the person has to go and fix. Allocating inside
the insert transaction cannot collide.

**These forms are server-rendered.** A suggestion that follows the cost code
dropdown needs a client component. Allocating at submit needs nothing, which
matters because `src/components/ui/Reveal.tsx` records the same reasoning for
its own shape.

**The product already works this way.** Nobody types a quote number:
`allocateDocumentNumber` (`src/lib/quote/numbering.ts`) issues it inside the
transaction and the confirmation names it afterwards. Following that pattern
means one idea about allocated identifiers rather than two.

### 3.3 What it must not do

**It must not become the only way to get a code.** The CSV importer requires
the field and matches on it -- `REQUIRED_FIELDS = ['code', 'description',
'sellRate']` in `src/lib/import/mapping.ts:64` -- and recognises the header
aliases `itemcode`, `item`, `sku`, `ref`, `reference`, `itemno`,
`itemnumber`, `number`.

That alias list is the evidence: the owner's rate book already exists, in a
spreadsheet or a supplier catalogue or an old estimating package, and it
already has codes. If the app insisted on its own, an import would either be
refused or would silently renumber his book and break every reference he has
on paper and every supplier cross-reference. So a supplied code is always
accepted and never rewritten. The importer is untouched by this change.

### 3.4 No cost code, no prefix

`cost_code_id` is nullable, and the form's default is "Not costed". With no
cost code there is no prefix to derive from, and **the field stays required in
that case** -- a code that means nothing is worse than one the person chose.
The hint text says so instead of naming a number.

### 3.5 Gaps stay gaps

`src/app/rates/actions.ts:179` records that retiring or voiding a rate item
*"does not free the code: the unique index is on the column, not on the live
rows"*. So `PLM-05` voided means `PLM-05` can never be reused.

The allocator therefore takes the highest existing suffix under the prefix and
adds one, counting voided rows. `PLM-05` voided with `PLM-09` live gives
`PLM-10`. Consistent with the principle this codebase already applies to
document numbers: **the gap is the record.**

### 3.6 The guarantee is still the index

`rate_items_code_unique` remains the thing that makes a duplicate impossible.
The allocator is a convenience layered on top of it, and the refusal sentence
at `actions.ts:80` stays for the case where somebody types a code that is
already taken. Nothing about this change relaxes a constraint.

---

## 4. Testing

The suite runs in a node environment with no DOM (`environment: 'node'`,
`include: ['tests/**/*.test.ts']`), so the allocator belongs in a plain module
that a unit test can call -- the same reason `src/components/ui/destinations.ts`
exists.

- **The next code under a prefix**, including: no existing rows, a gap from a
  voided row, a suffix at 9 rolling to 10, and a prefix that is a substring of
  another (`PL` must not count `PLM-01`). The substring case is the one a naive
  `LIKE 'PL%'` gets wrong.
- **A supplied code is never rewritten**, which is the importer's guarantee.
- **A blank code with no cost code is refused**, rather than allocated under
  some invented prefix.
- **Concurrency**: two inserts in the same prefix in one transaction each get
  their own number, and the unique index refuses a duplicate if the allocator
  is ever bypassed.

---

## 5. Cost

Roughly half a day for both forms. Independent of everything else queued.

## 6. Not in this design

- **Renumbering existing rate items** to fit the derived scheme. The codes on
  past quotes are frozen at `quote_lines.code`, so renumbering would leave the
  rate book and the documents disagreeing about what `PLM-02` is.
- **Deriving the code from anything but the cost code.** The trade is the only
  thing on that form that a person would recognise in a prefix.
- **Making the cost code hierarchy enforce its own codes** -- that a child of
  `PLM` must start with `PLM`. Tempting, and wrong for the same reason as §2:
  an inherited chart may not be shaped that way.
