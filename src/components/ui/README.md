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

Not for navigation -- a thing that changes the URL is a `<Link>`. Give it
`buttonClass(...)` so it matches without re-describing the styling.

```tsx
<Button variant="primary" pending={pending} pendingLabel="Saving…">Save quote</Button>
<Link href={`/quotes/${id}`} className={buttonClass('secondary')}>Open</Link>
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

---

Already here and unchanged: `Pill` (status chips, always carrying their word),
`Money` (integer cents, and the rule that a quoted total is not painted green),
`AppShell`. On a detail screen, `detail/Panel`, `DetailList`, `DetailRow` and
`detail/Fields.tsx` come first.
