# Reuse from Budget Tracker

**Status:** accepted, 2026-09-04.

What this product takes from the maintainer's existing Budget Tracker project,
how it takes it, and where the two must be allowed to diverge.

Other specs already assume this reuse in scattered places — the token
vocabulary in `2026-08-30-ui-design.md` §2.1, the OCR stack in
`2026-08-30-phases-2-5-design.md` §3.1, the update module in
`2026-08-30-distribution-and-updates.md` §4. This document is the single
authority on the policy and the inventory; those sections stand and point here.

---

## 1. The rule: copy, do not share

Code is **copied in as a starting point and then modified freely**. There is no
shared package, no git submodule, no published library between the two
projects.

This is a deliberate trade, and the cost side of it is real: a fix made in one
codebase does not reach the other, so a bug found in the OCR engine here has to
be carried back by hand, and will sometimes not be. That is accepted because
the alternative is worse for this product. A shared library between two
applications maintained by one person, deployed on different schedules to
different customers, means every change has to be evaluated against two sets of
requirements before it can ship to either — and the requirements diverge
immediately. Scopeline needs tax on a holdback and a Construction Act clock;
Budget Tracker needs merchant categorisation and a savings goal. Nothing about
those futures is shared.

What IS worth preserving without drift is the *vocabulary* — token names,
component names, the money representation — because one person maintains both
and two mental models for the same concept is a tax paid on every context
switch.

**Practical consequence:** when copying a file, delete what this product does
not need rather than leaving it configurable "in case". A ported file carrying
three unused branches is harder to reason about than one rewritten to the job.

### 1.1 Obligations that travel with the code

- **Model licensing.** The PaddleOCR model weights in `vendor/ocr-models` ship
  with a `NOTICE` file. This product is distributed to customers, so the NOTICE
  is copied alongside the weights and referenced from the licence page.
  Attribution is not optional and is trivially cheap to honour.
- **Tenant literals.** Budget Tracker was written for one deployment. Every
  ported file gets a pass for hardcoded names, addresses and defaults;
  `tests/ops/white-label.test.ts` catches literals but cannot catch a
  jurisdiction assumption baked into a rule.
- **Pin discipline.** See §2.2. Copy the pins *and* the comment explaining
  them.

---

## 2. OCR and receipt capture

Replaces the "build it" assumption in `phases-2-5-design.md` §3.1 with a
concrete inventory. The stack is proven on the same class of hardware this
product targets, which removes the largest unknown in Phase 3: getting ONNX
Runtime, OpenCV and Tesseract to cooperate inside a container is the kind of
problem that consumes a day and produces no visible feature.

### 2.1 What ports essentially as-is

The image-to-text engine, roughly 2,500 lines, is self-contained. Its only
outside imports are node builtins, `sharp`, and three thin application shims
(`@/lib/env`, `@/lib/settings`, `@/lib/version`) plus an OpenCV loader — four
seams to re-point.

| From Budget Tracker | Purpose |
|---|---|
| `src/lib/warranty/ocr/onnx/*` (15 files) | detection, recognition, orientation classify, preprocess, contours, crop, dictionary, session, model resolution, ARM probe |
| `src/lib/warranty/ocr/{engine,tesseract,pdf,assets,health}.ts` | pipeline orchestration, Tesseract fallback, PDF page rasterising, asset resolution, runtime health |
| `src/lib/scanner/scan.ts` + `src/lib/scanner/load.ts` | jscanify edge detection and deskew |
| `vendor/ocr-models/*` (14 MB) + `NOTICE` | PaddleOCR v5 detection, recognition and orientation weights, English dictionary |

Destination here: `src/lib/ocr/**`, not under a domain folder. In Budget
Tracker it lives under `warranty/` for historical reasons; nothing about it is
warranty-specific and the next reader should not have to discover that.

### 2.2 The pins are load-bearing

Budget Tracker's `package.json` carries a `//ocr-pins` comment recording why
four dependencies are pinned exact. **Copy the pins and the comment.** Losing
the comment is how somebody bumps them in a year and the OCR quietly degrades:

- `onnxruntime-node` **exact**. The ARM instruction-set risk the runtime probe
  exists for is a property of one ORT build; a minor bump changes the MLAS
  kernels the release was probed against.
- `jscanify` **exact**, pinned against one OpenCV.js API generation.
- `@techstark/opencv-js` **exact at `4.7.0-release.1`**. The 5.0.x builds from
  the same publisher change enough API surface that pairing them with
  jscanify 1.4.3 is untested.
- `sharp` takes a caret: per-platform optional deps, mature.

### 2.3 What does NOT port

The extraction and the queue are warranty-shaped and must be rewritten against
this product's schema:

- `warranty/{receipts,suggest,staging,items,types}.ts` pull a vendor, a date
  and a total for a warranty record. A construction receipt needs vendor, date,
  subtotal, **tax and the vendor's registration number**, total, cost code, and
  the project the spend belongs to. The text-parsing helpers reuse; the
  destination does not.
- `ocr/queue.ts` (325 lines) couples to their tables. The **review-queue
  pattern** carries — OCR proposes, a person posts, nothing reaches the books
  on machine confidence alone (`phases-2-5-design.md` §3.3) — the code does
  not.
- `docs/CANADIAN-MERCHANT-RULES-PACK.md` is a merchant-categorisation asset for
  personal finance. Construction supplier recognition is a different list, and
  a wrong cost code is worse than none.

### 2.4 Cost to weigh before committing

`onnxruntime-node`'s native binaries plus 14 MB of weights land on top of the
~300 MB Chromium the image already carries for PDF rendering. The disk is not
the concern on a mini PC; the **update download** is, since
`distribution-and-updates.md` promises unattended updates over a domestic
connection. Measure the image delta before this is called done, and if it is
material, consider fetching the weights on first run rather than baking them
in — noting that an offline install must still work, which is most of the point
of a local OCR stack.

---

## 3. Spreadsheet and CSV import

`src/lib/import/**`, about 2,550 lines: column mapping, format presets,
parsing, a preview pass, and staging. Built for bank statements; the machinery
is format-agnostic.

This lands earlier than Phase 3, because it is most of the **rate-item
importer** — the single largest adoption risk in this product. An owner who
opens a fresh install, sees sixty empty rate rows and no way to paste his price
list does not type a second quote. The importer was scoped at a day of work;
with this it is closer to an afternoon.

`mapping.ts` and `preview.ts` carry most directly. `ofx.ts` and `presets.ts`
are bank-statement specific and are not needed — delete rather than port, per
§1.

---

## 4. Design language

The user's assessment, recorded because it is the reason this section exists:
Budget Tracker's design language is strong, particularly its **cards, tables,
group collapsing and charts**, and this product should take from it liberally.

`ui-design.md` §2.1 already adopts the colour tokens wholesale. This widens
that to the component vocabulary.

### 4.1 Primitives

`src/components/ui/` holds 20 hand-rolled primitives with no component library
behind them: `Button`, `Card`, `EmptyState`, `PageHeader`, `Notice`, `Pill`,
`ListRow`, `RowDialog`, `RowMenu`, `MetricCard`, `ProgressBar`,
`SectionHeader`, `Money`, `Table` (`TableWrap`, `AmountCell`), `AutoSave`,
`GuidePanel`, `PageGuide`, `DateRangePicker`, `PillNav`, `MonthNav`.

Phase 1's Plan 2 listed twelve of these as deliverables and shipped three; the
rest became Tailwind utilities written inline at each call site. That is a
recorded deviation in this product, and porting closes it at a fraction of the
cost of designing them again.

Not all 20 apply. `MonthNav` and `DateRangePicker` belong to a monthly-budget
shape this product does not have; `GuidePanel`/`PageGuide` are a help system
that is a product decision, not a styling one.

### 4.2 Tables — the part with real thinking in it

`src/components/ui/Table.tsx` is only 112 lines and most of it is comment,
because the reasoning is subtle and was learned the hard way. It documents why
`table-layout: fixed` requires a `<colgroup>`, why a fixed table needs a
`min-width` equal to its own colgroup total or every column collapses on a
phone, and how that interacts with the `.data-table--stack` rule.

**This product already depends on that reasoning** — the single-DOM-tree
stacking rule is Budget Tracker's ruling R5, and today's worksheet fix turned
on exactly the empty-cell behaviour the file describes. Porting `TableWrap` and
`AmountCell` replaces conventions currently re-derived per screen.

### 4.3 Group collapsing

Collapsible groups appear across their screens (`budgets-client.tsx`,
`goals-client.tsx`, `settings/*-manager.tsx`) rather than in one primitive.
The pattern is worth extracting into a primitive **here** as it is ported,
because this product needs it in more places than that one did: quote line
groups by trade, cost codes by division, invoices by job, receipts by vendor.

Extract on the second use, not the first. The worksheet's existing group bands
are the first.

### 4.4 Charts

`recharts` with a 38-line `chart-theme.ts` that maps the CSS token layer onto
chart colours, plus five chart components (`CashflowChart`, `CategoryBarChart`,
`NetWorthChart`, `SavingsChart`, `DebtTrendChart`).

`chart-theme.ts` is the valuable part and ports directly: it is what keeps a
chart legible in both themes and in print without a second palette. The chart
components themselves are personal-finance subjects; this product's are
different — cash flow by job, budget versus actual by cost code, margin by
project type, holdback receivable ageing — but `CashflowChart` is a close
structural model for the first of those.

Charts arrive with Phase 3 job costing and Phase 4's cash-flow view. Nothing in
Phase 1 or 2 needs a chart, and a dashboard of charts over three quotes is
decoration.

### 4.5 What is deliberately not taken

- **Their app shell.** This product's rail plus bottom tab bar is already built
  and already carries the destinations this domain needs.
- **Their route-group layout** beyond what `scopeline-design.md` §62 already
  adopts.
- **Their notification stack.** `distribution-and-updates.md` §4.2 already
  records why: email from the app was cut, since the realistic failure is the
  machine being unplugged, and an email job on a dead machine sends nothing.

---

## 5. Sequencing

| Item | Lands with | Effect on estimate |
|---|---|---|
| `lib/import` → rate-item importer | M2, with Phase 1 close-out | 1.5 h → ~0.5 h |
| `ui/` primitives + `Table.tsx` | alongside the next screen built | closes a Plan 2 deviation, ~1 h |
| OCR engine + models | Phase 3, first task | Phase 3 ~11 h → ~7 h, and the largest unknown becomes known |
| `chart-theme.ts` + chart patterns | Phase 3 job costing | folded into that work |

The saving is real but secondary. The reason to do this is that the risky,
fiddly, invisible work — native runtimes, model pairing, print-safe chart
palettes, why a fixed table collapses on a phone — is already solved and proven
on the same hardware, by the same maintainer, and is sitting on the same
machine.
