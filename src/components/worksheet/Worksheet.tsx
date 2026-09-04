'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import {
  addLine,
  editLine,
  raiseChangeOrder,
  regenerateLines,
  setQuoteStatus,
  voidLine,
} from '@/app/quotes/[id]/actions';
import {
  ChangeOrderSheet,
  reasonLabel,
  type ChangeOrderDraft,
} from '@/components/worksheet/ChangeOrderSheet';
import {
  COLUMN_ATTR,
  focusNextInColumn,
  type WorksheetColumn,
} from '@/components/worksheet/keyboard';
import { MarginGauge } from '@/components/worksheet/MarginGauge';
import { RegenerateDialog, ScopeSheet } from '@/components/worksheet/ScopeSheet';
import type {
  WireLine,
  WireQuote,
  WireQuoteRef,
  WireRateItem,
  WireRelations,
  WireTax,
} from '@/components/worksheet/types';
import { Pill, statusTone } from '@/components/ui/Pill';
import { formatCents, formatQty, formatRate } from '@/lib/money/format';

/**
 * The quote worksheet.
 *
 * One DOM tree at every width. Desktop is a table; below `sm` the same table
 * reflows into cards and the inline inputs render read-only, with the row tap
 * opening the sheet editor -- two live editors for one value, one of them in a
 * 40px cell, is how a quantity gets changed by accident on a phone in a truck.
 *
 * Figures recalculate on commit, not on keystroke: a half-typed "1" in a
 * quantity field must not repaint the margin gauge red.
 */
export function Worksheet({
  quote,
  lines,
  taxes,
  rateItems,
  relations,
}: {
  quote: WireQuote;
  lines: WireLine[];
  taxes: WireTax[];
  rateItems: WireRateItem[];
  relations: WireRelations;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<WireLine | null>(null);
  const [picking, setPicking] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [raising, setRaising] = useState(false);

  const editable = quote.status === 'draft' && quote.recordStatus === 'active';
  // A change order amends work the customer has already accepted. A quote still
  // out with them is revised instead -- there is no contract yet to change --
  // and chaining a change order onto another is refused by the engine.
  const amendable =
    quote.kind === 'estimate' && quote.status === 'accepted' && quote.recordStatus === 'active';

  // Measurements belong to an estimate. A change order amends accepted work at
  // stated quantities; it was never expanded from a template, so a square
  // footage on it would drive nothing and read as an unanswered question.
  const scopeEditable = editable && quote.kind === 'estimate';
  const hasScope =
    relations.templateName !== null ||
    quote.areaSqftMilli !== null ||
    quote.washroomCount !== null ||
    quote.kitchenCount !== null ||
    quote.bedroomCount !== null;

  const groups = useMemo(() => {
    const included = lines.filter((line) => line.isIncluded);
    const optional = lines.filter((line) => !line.isIncluded);
    const byGroup = new Map<string, WireLine[]>();
    for (const line of included) {
      const bucket = byGroup.get(line.lineGroup) ?? [];
      bucket.push(line);
      byGroup.set(line.lineGroup, bucket);
    }
    return { byGroup, optional };
  }, [lines]);

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
    });
  }

  /**
   * Regeneration reports what it did.
   *
   * The summary is the whole reason this is a separate control: an operation
   * that replaces twelve lines and says nothing is indistinguishable from one
   * that did nothing, and the owner needs to know his hand-added lines survived.
   */
  function regenerate() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await regenerateLines({ quoteId: quote.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { replaced, created, kept } = result.summary;
      setNotice(
        `Regenerated from the template: ${count(replaced, 'template line')} replaced, ` +
          `${count(created, 'line')} written at the current measurements, ` +
          `${count(kept, 'hand-added line')} kept. Replaced lines were voided, not deleted.`,
      );
    });
  }

  function raise(draft: ChangeOrderDraft) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await raiseChangeOrder(draft);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRaising(false);
      // The change order renders in this same worksheet: it is a quote with a
      // parent, so there is no second screen to build.
      router.push(`/quotes/${result.quoteId}`);
    });
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line bg-surface px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="t-title truncate">{quote.projectName}</h1>
          <span className="num t-small text-muted">{quote.quoteNumber}</span>
          <span className="t-small text-muted">v{quote.version}</span>
          <Pill tone={statusTone(quote.status, quote.expired)}>
            {quote.recordStatus === 'void'
              ? 'Void'
              : quote.expired && quote.status === 'sent'
                ? 'Expired'
                : quote.status}
          </Pill>
          {/* A change order must never be mistaken for the estimate. It carries
              its own number, its sequence on the job, and the word. */}
          {quote.kind === 'change_order' ? (
            <Pill tone="info">Change order {quote.sequence}</Pill>
          ) : null}

          <div className="no-print ml-auto flex gap-2">
            {amendable ? (
              <button
                type="button"
                disabled={pending}
                className="min-h-11 rounded-[4px] bg-accent px-3 text-accent-fg hover:bg-accent-hover disabled:opacity-60"
                onClick={() => setRaising(true)}
              >
                Raise a change order
              </button>
            ) : null}
            {quote.status === 'draft' ? (
              <button
                type="button"
                disabled={pending}
                className="min-h-11 rounded-[4px] border border-line-strong px-3 hover:bg-surface-2"
                onClick={() => run(() => setQuoteStatus({ quoteId: quote.id, status: 'sent' }))}
              >
                Mark sent
              </button>
            ) : null}
            {quote.status === 'sent' ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  className="min-h-11 rounded-[4px] bg-accent px-3 text-accent-fg hover:bg-accent-hover"
                  onClick={() =>
                    run(() => setQuoteStatus({ quoteId: quote.id, status: 'accepted' }))
                  }
                >
                  Accepted
                </button>
                <button
                  type="button"
                  disabled={pending}
                  className="min-h-11 rounded-[4px] border border-line-strong px-3 hover:bg-surface-2"
                  onClick={() =>
                    run(() => setQuoteStatus({ quoteId: quote.id, status: 'declined' }))
                  }
                >
                  Declined
                </button>
              </>
            ) : null}
          </div>
        </div>
        <p className="t-small text-muted">
          {quote.customerName}
          {quote.siteAddress ? ` · ${quote.siteAddress}` : ''}
        </p>

        {relations.parent ? (
          <p className="t-small text-muted">
            Amends{' '}
            <Link
              href={`/quotes/${relations.parent.id}`}
              className="num text-accent-text hover:underline"
            >
              {relations.parent.quoteNumber}
            </Link>
            {relations.amendment?.reason ? ` · ${reasonLabel(relations.amendment.reason)}` : ''}
            {relations.amendment?.scheduleImpactDays
              ? ` · ${count(relations.amendment.scheduleImpactDays, 'day')} added to the schedule`
              : ''}
          </p>
        ) : null}
      </header>

      {/* The job's change orders, reachable from the estimate they amend --
          otherwise the only route to one is the project screen, and the person
          looking at the contract is the person who needs them. */}
      {relations.changeOrders.length > 0 ? (
        <section className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-4 py-2 t-small sm:px-6">
          <span className="text-muted">Change orders</span>
          {relations.changeOrders.map((order) => (
            <ChangeOrderLink key={order.id} order={order} />
          ))}
        </section>
      ) : null}

      <section className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface-2 px-4 py-2 sm:px-6">
        {scopeEditable || hasScope ? (
          <ScopeLine
            quote={quote}
            templateName={relations.templateName}
            editable={scopeEditable}
            onOpen={() => setMeasuring(true)}
          />
        ) : null}

        {/* Regeneration is a separate, explicit control. Saving a measurement
            must not quietly discard ten minutes of hand adjustment, so changing
            a figure and rebuilding the lines are two different buttons. */}
        {scopeEditable && relations.templateName ? (
          <button
            type="button"
            disabled={pending}
            className="no-print min-h-11 rounded-[4px] border border-line-strong bg-surface px-3 hover:bg-surface-3 disabled:opacity-60"
            onClick={() => setConfirmingRegenerate(true)}
          >
            Regenerate
          </button>
        ) : null}

        <span className="t-small text-muted">
          valid to <span className="num">{quote.validUntil}</span>
        </span>
      </section>

      {error ? (
        <p role="alert" className="border-b border-negative bg-negative-soft px-4 py-2 t-small text-negative-soft-fg sm:px-6">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="border-b border-info bg-info-soft px-4 py-2 t-small text-info-soft-fg sm:px-6"
        >
          {notice}
        </p>
      ) : null}

      <div className="flex-1 overflow-x-auto px-0 sm:px-6 sm:py-4">
        <table
          role="table"
          // Busy rather than disabled: the fields stay focusable so Enter can
          // keep descending while the previous commit is still in flight.
          aria-busy={pending}
          className="data-table data-table--stack"
          style={{ minWidth: '52rem' }}
        >
          <caption className="sr-only">
            Quote lines for {quote.quoteNumber}, grouped by trade
          </caption>
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col" className="present-hide">Code</th>
              <th scope="col" className="cell-num">Qty</th>
              <th scope="col">Unit</th>
              <th scope="col" className="cell-num">Rate</th>
              <th scope="col" className="cell-num present-hide">Cost</th>
              <th scope="col" className="cell-num">Amount</th>
              <th scope="col" className="no-print">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {[...groups.byGroup.entries()].map(([group, groupLines]) => (
              <GroupRows
                key={group}
                group={group}
                lines={groupLines}
                editable={editable}
                pending={pending}
                onEdit={setEditing}
                onCommit={run}
                quoteId={quote.id}
              />
            ))}

            {groups.optional.length > 0 ? (
              <GroupRows
                group="Available upgrades"
                lines={groups.optional}
                editable={editable}
                pending={pending}
                onEdit={setEditing}
                onCommit={run}
                quoteId={quote.id}
                optional
              />
            ) : null}
          </tbody>
        </table>
      </div>

      {editable ? (
        <div className="no-print px-4 pb-4 sm:px-6">
          <button
            type="button"
            className="flex min-h-11 items-center gap-2 rounded-[4px] border border-line-strong bg-surface px-3 hover:bg-surface-2"
            onClick={() => setPicking(true)}
          >
            <Plus size={16} aria-hidden /> Add a line
          </button>
        </div>
      ) : null}

      <SumBar quote={quote} taxes={taxes} />

      {editing ? (
        <LineSheet
          line={editing}
          quoteId={quote.id}
          pending={pending}
          onClose={() => setEditing(null)}
          onCommit={run}
        />
      ) : null}

      {picking ? (
        <RatePicker
          items={rateItems}
          pending={pending}
          onClose={() => setPicking(false)}
          onPick={(rateItemId) => {
            run(() => addLine({ quoteId: quote.id, rateItemId, qty: '1' }));
            setPicking(false);
          }}
        />
      ) : null}

      {measuring ? (
        <ScopeSheet
          quote={quote}
          pending={pending}
          onClose={() => setMeasuring(false)}
          onCommit={run}
        />
      ) : null}

      {confirmingRegenerate ? (
        <RegenerateDialog
          templateName={relations.templateName}
          pending={pending}
          onClose={() => setConfirmingRegenerate(false)}
          onConfirm={regenerate}
        />
      ) : null}

      {raising ? (
        <ChangeOrderSheet
          quote={quote}
          rateItems={rateItems}
          pending={pending}
          onClose={() => setRaising(false)}
          onRaise={raise}
        />
      ) : null}
    </div>
  );
}

/**
 * "1 washroom", "2 washrooms", "0 washrooms".
 *
 * One place, because the plural is wrong in a different way at each call site
 * and a quote that reads "1 lines replaced" undermines every other figure on
 * the screen.
 */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/**
 * The scope summary: the template and the four measurements on one line.
 *
 * Tapping it opens the measurements sheet, at every width. The sheet is the one
 * editor for these four figures -- there is no second set of inline boxes to
 * disagree with it, on a phone or on a desktop.
 */
function ScopeLine({
  quote,
  templateName,
  editable,
  onOpen,
}: {
  quote: WireQuote;
  templateName: string | null;
  editable: boolean;
  onOpen: () => void;
}) {
  const summary = (
    <>
      {templateName ? <span className="text-ink">{templateName}</span> : null}
      {templateName ? ' · ' : ''}
      <span className="num text-ink">
        {quote.areaSqftMilli ? formatQty(BigInt(quote.areaSqftMilli)) : '—'} {quote.areaUnit}
      </span>
      {' · '}
      {count(quote.washroomCount ?? 0, 'washroom')}
      {' · '}
      {count(quote.kitchenCount ?? 0, 'kitchen')}
      {' · '}
      {count(quote.bedroomCount ?? 0, 'bedroom')}
    </>
  );

  // Read-only once the quote leaves draft, following the same rule as the
  // inline fields: the figures still read, they just stop being a control.
  if (!editable) return <span className="t-small text-muted">{summary}</span>;

  return (
    <button
      type="button"
      className="flex min-h-11 min-w-0 flex-1 items-center rounded-[4px] px-1 text-left t-small text-muted hover:bg-surface-3"
      onClick={onOpen}
    >
      <span className="truncate">
        {summary}
        <span className="sr-only"> — change the measurements</span>
      </span>
    </button>
  );
}

/** One change order in the estimate's header band, with its state in words. */
function ChangeOrderLink({ order }: { order: WireQuoteRef }) {
  return (
    <span className="flex items-center gap-1.5">
      <Link href={`/quotes/${order.id}`} className="num text-accent-text hover:underline">
        {order.quoteNumber}
      </Link>
      <Pill tone={statusTone(order.status, false)}>{order.status}</Pill>
      <span className="num text-muted">{formatCents(order.totalCents)}</span>
    </span>
  );
}

function GroupRows({
  group,
  lines,
  editable,
  pending,
  quoteId,
  optional = false,
  onEdit,
  onCommit,
}: {
  group: string;
  lines: WireLine[];
  editable: boolean;
  pending: boolean;
  quoteId: string;
  optional?: boolean;
  onEdit: (line: WireLine) => void;
  onCommit: (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => void;
}) {
  // Available upgrades start closed. They are not part of the price the
  // customer is being quoted, and open by default they push the trade the owner
  // is actually working on off the bottom of the screen.
  const [open, setOpen] = useState(!optional);

  const total = lines.reduce(
    (sum, line) => sum + (optional ? line.displayPriceCents : line.lineTotalCents),
    0,
  );

  return (
    <>
      <tr className="group-band" role="row">
        <td colSpan={7} data-label="Group">
          <button
            type="button"
            aria-expanded={open}
            className="flex min-h-11 w-full items-center gap-2 text-left"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? (
              <ChevronDown size={14} aria-hidden />
            ) : (
              <ChevronRight size={14} aria-hidden />
            )}
            <span>{group}</span>
            <span className="num ml-auto">{formatCents(total)}</span>
            <span className="sr-only">
              , {count(lines.length, 'line')}, {open ? 'expanded' : 'collapsed'}
            </span>
          </button>
        </td>
        <td className="no-print" aria-hidden />
      </tr>
      {/* Collapsed rows leave the DOM rather than hiding: an input the owner
          cannot see is an input Enter must not descend into, and the descent
          reads document order. */}
      {open
        ? lines.map((line) => (
            <LineRow
              key={line.id}
              line={line}
              editable={editable}
              pending={pending}
              quoteId={quoteId}
              optional={optional}
              onEdit={onEdit}
              onCommit={onCommit}
            />
          ))
        : null}
    </>
  );
}

function LineRow({
  line,
  editable,
  pending,
  quoteId,
  optional,
  onEdit,
  onCommit,
}: {
  line: WireLine;
  editable: boolean;
  pending: boolean;
  quoteId: string;
  optional: boolean;
  onEdit: (line: WireLine) => void;
  onCommit: (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => void;
}) {
  const isPercent = line.calcMode === 'percent';
  const amount = optional ? line.displayPriceCents : line.lineTotalCents;

  return (
    <tr role="row" onClick={() => editable && onEdit(line)}>
      <td role="cell" data-label="Description">
        <span className="truncate">{line.description}</span>
        {line.isAllowance ? (
          <span className="ml-2">
            <Pill tone="warning">Allowance</Pill>
          </span>
        ) : null}
      </td>
      <td role="cell" data-label="Code" className="present-hide num t-small text-muted">
        {line.code}
      </td>
      <td role="cell" data-label="Qty" className="cell-num">
        {isPercent || line.calcMode === 'flat' ? (
          <span className="text-subtle">—</span>
        ) : (
          <NumberField
            label={`Quantity for ${line.description}`}
            value={formatQty(BigInt(line.qtyMilli))}
            column="qty"
            editable={editable}
            onCommit={(next) => onCommit(() => editLine({ quoteId, lineId: line.id, qty: next }))}
          />
        )}
      </td>
      <td role="cell" data-label="Unit" className="t-small text-muted">
        {line.unitLabel || (isPercent ? '%' : '—')}
      </td>
      <td role="cell" data-label="Rate" className="cell-num">
        <NumberField
          label={`Rate for ${line.description}`}
          value={formatRate(BigInt(line.unitPriceTenThou))}
          column="rate"
          editable={editable}
          onCommit={(next) =>
            onCommit(() => editLine({ quoteId, lineId: line.id, unitPrice: next }))
          }
        />
      </td>
      <td role="cell" data-label="Cost" className="present-hide cell-num text-muted">
        {formatCents(line.lineCostCents)}
      </td>
      <td role="cell" data-label="Amount" className="cell-num font-medium">
        {formatCents(amount)}
      </td>
      <td role="cell" className="no-print cell-num">
        {editable ? (
          <button
            type="button"
            aria-label={`Remove ${line.description}`}
            disabled={pending}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[4px] text-muted hover:bg-negative-soft hover:text-negative-soft-fg disabled:opacity-60"
            onClick={(event) => {
              event.stopPropagation();
              onCommit(() => voidLine({ quoteId, lineId: line.id }));
            }}
          >
            <Trash2 size={15} aria-hidden />
          </button>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * An inline numeric field. Tab across, Enter commits and descends, Escape
 * cancels.
 *
 * Below `sm` it renders read-only and the row tap opens the sheet instead; the
 * input still exists exactly once in the DOM at every width, which is what
 * keeps a test query pointed at one node.
 *
 * It is NOT disabled while a commit is in flight. Disabling the field the owner
 * has just descended into throws focus back to the document body, which breaks
 * Enter-to-descend on exactly the keystroke it is meant to serve; the table
 * carries `aria-busy` instead, and each field commits one column of one line,
 * so two in flight cannot contradict each other.
 */
function NumberField({
  label,
  value,
  column,
  editable,
  onCommit,
}: {
  label: string;
  value: string;
  column: WorksheetColumn;
  editable: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  // Mirrored in a ref because the Enter path commits and THEN moves focus, and
  // moving focus fires blur in the same tick, before the state set above is
  // visible. Without the ref that blur commits the same edit a second time.
  const dirtyRef = useRef(false);

  // A re-render after a commit brings the server's value back down.
  if (!dirty && draft !== value) setDraft(value);

  if (!editable) return <span className="num">{value}</span>;

  /** Figures recalculate here, on commit, never on a keystroke. */
  function commit() {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    setDirty(false);
    if (draft !== value) onCommit(draft);
  }

  return (
    <input
      aria-label={label}
      value={draft}
      inputMode="decimal"
      {...{ [COLUMN_ATTR]: column }}
      className="field field-num max-sm:pointer-events-none max-sm:border-transparent max-sm:bg-transparent"
      readOnly={false}
      onChange={(event) => {
        setDraft(event.target.value);
        setDirty(true);
        dirtyRef.current = true;
      }}
      onFocus={(event) => event.currentTarget.select()}
      // The row's tap opens the sheet editor. Stopped here so a click INTO a
      // field edits it inline instead of throwing a modal over the table --
      // below `sm` the field takes no pointer events at all, so the tap still
      // reaches the row and the sheet is still the only editor at that width.
      onClick={(event) => event.stopPropagation()}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          focusNextInColumn(event.currentTarget, column);
        }
        if (event.key === 'Escape') {
          // Stopped here so Escape reverts the figure rather than reaching a
          // sheet behind the table and closing it mid-edit.
          event.preventDefault();
          event.stopPropagation();
          setDraft(value);
          setDirty(false);
          dirtyRef.current = false;
        }
      }}
    />
  );
}

/** Pinned totals. Square corners, and the one dominant figure on the view. */
function SumBar({ quote, taxes }: { quote: WireQuote; taxes: WireTax[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="sum-bar px-4 py-2 sm:px-6 sm:py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          className="flex items-baseline gap-3 text-left sm:cursor-default"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="t-small text-muted">Total</span>
          <span className="num t-display">{formatCents(quote.totalCents)}</span>
        </button>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <span className="present-hide t-small text-muted">
            Cost <span className="num">{formatCents(quote.totalCostCents)}</span>
          </span>
          <span className="present-hide">
            <MarginGauge marginBp={quote.marginBp} targetBp={quote.targetMarginBp} />
          </span>
          <a
            href={`/api/quotes/${quote.id}/pdf`}
            className="no-print flex min-h-11 items-center rounded-[4px] bg-accent px-3 text-accent-fg hover:bg-accent-hover"
          >
            PDF
          </a>
        </div>
      </div>

      <dl
        className={`${open ? 'grid' : 'hidden'} grid-cols-2 gap-x-6 gap-y-1 pt-2 t-small sm:grid`}
      >
        <dt className="text-muted">Subtotal</dt>
        <dd className="num text-right">{formatCents(quote.subtotalCents)}</dd>
        {taxes.map((tax) => (
          <div key={tax.label} className="col-span-2 grid grid-cols-2 gap-x-6">
            <dt className="text-muted">
              {tax.label} {(Number(tax.rateTenThou) / 100).toFixed(2)}%
            </dt>
            <dd className="num text-right">{formatCents(tax.taxAmountCents)}</dd>
          </div>
        ))}
        {quote.optionalTotalCents !== 0 ? (
          <>
            <dt className="text-muted">Available upgrades</dt>
            <dd className="num text-right">{formatCents(quote.optionalTotalCents)}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/** The mobile editor: 48px fields, a number pad, and a live line total. */
function LineSheet({
  line,
  quoteId,
  pending,
  onClose,
  onCommit,
}: {
  line: WireLine;
  quoteId: string;
  pending: boolean;
  onClose: () => void;
  onCommit: (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => void;
}) {
  const [qty, setQty] = useState(formatQty(BigInt(line.qtyMilli)));
  const [rate, setRate] = useState(formatRate(BigInt(line.unitPriceTenThou)));

  return (
    <div className="fixed inset-0 z-20 flex items-end bg-black/40 sm:items-center sm:justify-center">
      <div
        role="dialog"
        aria-label={`Edit ${line.description}`}
        className="w-full rounded-t-[6px] border-t border-line-strong bg-surface p-4 shadow-pop sm:max-w-md sm:rounded-[6px] sm:border"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <p className="t-heading">{line.description}</p>
            <p className="present-hide num t-small text-muted">{line.code}</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-[4px] text-muted hover:bg-surface-2"
            onClick={onClose}
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="grid gap-3">
          {line.calcMode === 'qty' ? (
            <label className="grid gap-1">
              <span className="t-small text-muted">Quantity ({line.unitLabel})</span>
              <input
                className="field field-num min-h-12"
                inputMode="decimal"
                value={qty}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setQty(event.target.value)}
              />
            </label>
          ) : null}
          <label className="grid gap-1">
            <span className="t-small text-muted">
              {line.calcMode === 'percent' ? 'Percent' : 'Rate'}
            </span>
            <input
              className="field field-num min-h-12"
              inputMode="decimal"
              value={rate}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setRate(event.target.value)}
            />
          </label>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <span className="t-small text-muted">Line total</span>
          <span className="num t-title">{formatCents(line.lineTotalCents)}</span>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={pending}
            className="min-h-12 flex-1 rounded-[4px] bg-accent px-3 text-accent-fg disabled:opacity-60"
            onClick={() => {
              onCommit(() =>
                editLine({
                  quoteId,
                  lineId: line.id,
                  qty: line.calcMode === 'qty' ? qty : undefined,
                  unitPrice: rate,
                }),
              );
              onClose();
            }}
          >
            Save
          </button>
          <button
            type="button"
            className="min-h-12 rounded-[4px] border border-line-strong px-3"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Search first, never a long select: the rate list runs to hundreds of items. */
function RatePicker({
  items,
  pending,
  onClose,
  onPick,
}: {
  items: WireRateItem[];
  pending: boolean;
  onClose: () => void;
  onPick: (rateItemId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? items.filter(
        (item) =>
          item.description.toLowerCase().includes(needle) ||
          item.code.toLowerCase().includes(needle),
      )
    : items;

  return (
    <div className="fixed inset-0 z-20 flex items-end bg-black/40 sm:items-center sm:justify-center">
      <div
        role="dialog"
        aria-label="Add a line"
        className="flex max-h-[80dvh] w-full flex-col rounded-t-[6px] border-t border-line-strong bg-surface p-4 shadow-pop sm:max-w-lg sm:rounded-[6px] sm:border"
      >
        <div className="mb-3 flex items-center gap-2">
          <input
            autoFocus
            aria-label="Search the rate list"
            placeholder="Search the rate list"
            className="field"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            aria-label="Close"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-[4px] text-muted hover:bg-surface-2"
            onClick={onClose}
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <ul className="flex-1 overflow-y-auto">
          {matches.length === 0 ? (
            <li className="py-6 text-center t-small text-muted">
              Nothing matches. Rate items are managed under Rates.
            </li>
          ) : (
            matches.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={pending}
                  className="flex min-h-12 w-full items-center justify-between gap-3 border-b border-line px-1 text-left hover:bg-surface-2"
                  onClick={() => onPick(item.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{item.description}</span>
                    <span className="present-hide num t-small text-muted">{item.code}</span>
                  </span>
                  <span className="num t-small">
                    {formatRate(BigInt(item.sellRateTenThou))}
                    {item.unitLabel ? ` / ${item.unitLabel}` : ''}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
