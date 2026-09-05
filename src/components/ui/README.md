# UI primitives

Reach for one of these before writing a Tailwind string at a call site. That is
the whole point: the conventions below were re-derived per screen for two
releases, and drifted every time.

House rules that apply to all of them:

- **Colour comes from the token layer** (`src/app/globals.css`), never a hex.
  Both themes are real; a raw value is right in one of them.
- **Colour never carries meaning alone.** A tone always ships with a word.
- **44px minimum** for anything you can press, 48px for controls used on site.
  Inputs never shrink, and never below 16px type on a phone -- under that, iOS
  Safari zooms the page on focus.
- **Money is integer cents** and renders through `Money` or `formatCents`.
  Never format an amount at a call site.
- **Controls and fills do not print.** `Button`, a `CardHeader` action and
  `ProgressBar` carry `no-print` themselves; the customer's document comes from
  `/print/quote/[id]`.

---

## Button

Primary, secondary or danger, with a pending state. Sizes to its content;
`fullWidth` is the opt-in, never the default.

Pass `pending` to ANY button that awaits something. It disables the control,
sets `aria-busy`, swaps the label for `pendingLabel` and turns a spinner beside
it -- and it does not change the button's width doing it. Both labels sit in
one grid cell, so the box is always as wide as the wider of them; a button that
resized as it went busy would move its own edge out from under the second press
somebody makes when nothing appears to happen.

Passing the prop is also what reserves that width, which is why it has no
default: a button that never awaits anything omits it entirely and is laid out
exactly as it always was.

Not for navigation -- a thing that changes the URL is a `<Link>`. Give it
`buttonClass(...)` so it matches without re-describing the styling.

```tsx
<Button variant="primary" pending={pending} pendingLabel="Saving…">Save quote</Button>
<Link href={`/quotes/${id}`} className={buttonClass('secondary')}>Open</Link>
```

## SubmitButton

The submit for a form the BROWSER posts -- `<form method="get">`, which is what
the filter bar and the billing preview are. `useFormStatus` reports nothing for
those, because React only tracks a form whose `action` is a function, so they
were the two controls in the product that could be pressed twice with nothing
on screen to say why.

Not for a form with a server action: that is a plain `Button` with `pending`
from `useActionState`, and using this instead would report the browser's
submit rather than the action's.

```tsx
<SubmitButton variant="primary" pendingLabel="Searching…">Search</SubmitButton>
```

## PageHeader

The one `<h1>` on a page, and the page's primary action beside it. Title,
optional `eyebrow`, optional `description`, and an `actions` slot.

The action belongs at the TOP. Buried under the content it acts on it is two
screens down on any record with history, which is the complaint that produced
this component.

`eyebrow` is for real context -- a record's number, what kind of thing it is,
whether it is void. On a detail screen the status chips go there rather than
beside the title: inside the `<h1>` they become part of the heading's
accessible name, so the page announces itself as "Sample Client Commercial Tax
exempt".

The `actions` slot is ONE ROW that wraps -- full width and left-aligned below
`sm`, right-flush above it. Never a column: the version this was copied from
records making it `flex-col` for one dashboard's sake and stacking every other
page's two buttons on two lines. A page that genuinely needs several rows
composes its own wrapper and passes that one element in.

It carries no margin: half the screens here are `grid gap-4` and would space it
twice. On a page whose parent has no gap, pass `className="mb-4"`.

Not for a card's title (`CardHeader`) or a group's label (`SectionHeader`), and
not a second `<h1>` -- there is one per page.

```tsx
<PageHeader
  className="mb-4"
  eyebrow={<Pill tone="negative">Void</Pill>}
  title={customer.name}
  description="No company recorded · Referral"
  actions={<Link href="/quotes/new" className={buttonClass('primary')}>New quote</Link>}
/>
```

## Card, CardHeader, CardBody, CardFooter

The general container: surface, hairline, 6px radius. Use it when you need a
header action, a description under the title, an unpadded body for a table that
bleeds to the edge, or no title at all.

Not for a plain titled panel on a detail screen -- `detail/Panel` is the
shorter call and is pixel-identical. Never nest one card in another. Card does
not clip its overflow: clipping would break the data table's sticky header and
the sum bar.

```tsx
<Card>
  <CardHeader title="Quotes" action={<Button>New quote</Button>} />
  <CardBody padded={false}>{table}</CardBody>
  <CardFooter>2 versions · 1 accepted</CardFooter>
</Card>
```

## SectionHeader

The small-caps label over a *group* of cards or rows.

Not for the heading of a single card -- that is `CardHeader`. When a card sits
under one of these, pass `level={3}` to its header so the heading order stays
readable.

```tsx
<SectionHeader title="Change orders" action={<Button>Add</Button>} />
```

## Notice

A banner for what just happened, or the constraint about to bite. Errors
announce themselves, confirmations are polite, and the sentence -- not the
fill -- has to say which it is.

Not for a field's own validation message; that belongs beside the field
(`FormError` in `detail/Fields.tsx`). Not for anything a person has to dismiss.

```tsx
<Notice tone="negative" title="Could not save">The customer record was voided.</Notice>
```

## MetricCard

One dominant figure, a label, and optionally the line that makes it checkable.
`from` names what a derived figure was derived FROM, and this product derives
most of them -- so it reads "Contract value — accepted quotes". A stored figure
passes no `from`, which is how a reader tells the two apart.

Not for a row of four small numbers, and not for a figure nobody acts on. The
figure is not toned here: pass `<Money>` and let it decide.

```tsx
<MetricCard
  label="Contract value"
  from="accepted quotes"
  value={<Money cents={contractValueCents} plain />}
  secondary={`${accepted} accepted of ${total} quotes`}
/>
```

## ProgressBar

How much of something has happened against a limit. The fill clamps at 100%;
`aria-valuenow` and the figure beside it keep reporting the truth.

Not a chart, and not a substitute for the number -- it never prints, so the
figure has to be beside it. `tone` is yours: this component derives no
threshold, because a bar that turns amber on a rule the rest of the app has
never heard of is a bar telling the owner something untrue.

```tsx
<ProgressBar pct={pct} tone={pct > 100 ? 'negative' : 'accent'} label="Invoiced against contract value" />
```

## FilterBar, NoMatches

Search, filter and the count, above a list. A plain `GET` form, so the state of
the screen IS the URL: the back button works, a filtered view is a link
somebody can be sent, and the filtering happens in SQL rather than over an
array that stops being the whole list the first time one needs a page.

`reveal` is the one control that shows what the screen hides by default --
closed quotes, lost and complete work. Its `hiddenCount` is not decoration: a
list that quietly drops records is a list the owner reads as having lost them,
so the count line says how many are behind the control before he has a reason
to press it. Every select carries a real word on its empty option ("Any
status"), never a blank.

Not for a filter that has to change something other than the URL, and not for
a control that filters a table already on screen without a round trip -- both
want state, and this has none. Pair it with `NoMatches`, which is the empty
result: a blank page reads as a broken query, so it says what was searched and
offers to clear it.

```tsx
<FilterBar
  basePath="/quotes"
  q={q}
  searchLabel="Search quotes"
  selects={[{ name: 'status', label: 'Status', value: status, anyLabel: 'Any status', options }]}
  reveal={{ name: 'closed', on: showClosed, showLabel: 'Show closed quotes',
            hideLabel: 'Hide closed quotes', hiddenCount, hiddenNoun: 'closed' }}
  shown={rows.length}
  noun={{ singular: 'quote', plural: 'quotes' }}
/>
```

The SQL half lives in `src/lib/list/search.ts`: `normalizeSearch` trims what
was typed, and `searchCondition` escapes `%` and `_` before binding the
pattern, so a search for "50%" narrows the list rather than matching every row
in the table.

## CollapsibleGroup

A named group that folds away and keeps showing its total while folded --
quote lines by trade, cost codes by division, invoices by job, receipts by
vendor.

Not for a group band inside a data table: a `<details>` cannot wrap `<tr>`
elements, so a table's band is a `<tr className="group-band">` holding a
button, the way the worksheet already does it. Not for hiding something a
person is looking for -- a group with no figure to show while shut is usually
a `Card` that should not fold.

```tsx
<CollapsibleGroup title="Concrete" summary={<Money cents={groupTotal} plain />} defaultOpen>
  {lines}
</CollapsibleGroup>
```

## Sheet, SheetButton

The one modal. A bottom sheet below `sm` and the same panel centred above it,
over a blurred scrim -- with the four things a hand-rolled overlay always
forgets: a focus trap, Escape, a body-scroll lock, and focus returned to the
control that opened it. `toolbar` pins a search box above the scrolling body;
`footer` pins the submit below it, reached from a form in the body with
`form={id}`.

`size` is the centred width from `sm` up -- `md` (32rem, the default and what
the measurement sheets were written for), `lg` (42rem, a real two-column form)
or `xl` (56rem, a table). It changes nothing below `sm`: a phone gets the full
width at the bottom edge whatever it says. Pick by what is inside, not by
importance -- a two-field sheet at 56rem is as wrong as a ten-field form at
32rem, which is the complaint that produced the prop. A wider panel is never a
taller one: the panel caps at `85dvh` and only the body scrolls, so the footer's
save button is still on screen on a 720px laptop.

`SheetButton` is the press that opens one, and exists so a SERVER component can
have a modal without becoming a client component: the page renders the form as
children, and only the open/shut lives in the browser. Give it `discardPrompt`
whenever the sheet holds typed work -- Escape and the backdrop both dismiss,
and a modal that silently eats a half-written entry is worse than the
disclosure it replaced.

What goes in one: a form, a focused task with a consequence. What does not: a
confirm belonging to ONE ROW, where the answer turns on still being able to see
that row -- that stays anchored where it is (`RowAction`'s own confirm). Length
is not the test; what the decision is about is.

`autoFocus` does not work through it. React applies it during commit and the
Sheet's own focus effect wins the race, so a caller wanting a particular field
focused does it from its own `useEffect` with a ref -- a child's effects run
before its parent's, and `Sheet` is the child. `RatePicker` in
`worksheet/Worksheet.tsx` is the worked example. `Measurement`, the 48px
on-site numeric field the worksheet sheets are built from, lives in this file
too.

```tsx
<SheetButton trigger="Change…" label={`Change ${item.code}`} title={`Change ${item.code}`}
             subtitle={item.description} discardPrompt="Throw away the changes to this item?">
  <ActionForm action={updateRateItem} submitLabel="Save this item">…</ActionForm>
</SheetButton>
```

---

Already here and unchanged: `Pill` (status chips, always carrying their word),
`Money` (integer cents, and the rule that a quoted total is not painted green),
`AppShell`. On a detail screen, `detail/Panel`, `DetailList`, `DetailRow` and
`detail/Fields.tsx` come first.
