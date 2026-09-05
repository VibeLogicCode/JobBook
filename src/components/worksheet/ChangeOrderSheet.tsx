'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Measurement, Sheet } from '@/components/worksheet/Sheet';
import { Button } from '@/components/ui/Button';
import type { WireChangeReason, WireQuote, WireRateItem } from '@/components/worksheet/types';
import { formatRate } from '@/lib/money/format';

/**
 * The six reasons, worded the way the owner would say them.
 *
 * The enum members are for the database. "error_omission" on a screen reads as
 * an accusation in a language nobody speaks; the wording here is what he would
 * write on the paper copy.
 */
const REASONS: { value: WireChangeReason; label: string }[] = [
  { value: 'customer_request', label: 'The customer asked for it' },
  { value: 'site_condition', label: 'Something found on site' },
  { value: 'design_change', label: 'A design change' },
  { value: 'code_requirement', label: 'Required by code or an inspector' },
  { value: 'error_omission', label: 'An error or omission in the estimate' },
  { value: 'allowance_reconciliation', label: 'Reconciling an allowance' },
];

/** The same wording on a change order's header as in the menu that raised it. */
export function reasonLabel(reason: WireChangeReason): string {
  return REASONS.find((entry) => entry.value === reason)?.label ?? reason;
}

interface Pick {
  /**
   * Local row key. The same rate item can appear twice on one change order --
   * added once, deducted once -- so the rate item's id cannot identify a row.
   */
  key: number;
  rateItemId: string;
  qty: string;
  deductive: boolean;
}

export interface ChangeOrderDraft {
  parentQuoteId: string;
  reason: WireChangeReason;
  scheduleImpactDays: string;
  notes: string;
  lines: { rateItemId: string; qty: string; deductive: boolean }[];
}

/**
 * Raising a change order against an accepted quote.
 *
 * A deduction is a per-line toggle rather than a separate document: a credit is
 * the same rate item at a negative price, which the engine already carries
 * through every base, so one change order can add work and take work away at
 * once -- which is what most of them actually do.
 */
export function ChangeOrderSheet({
  quote,
  rateItems,
  pending,
  onClose,
  onRaise,
}: {
  quote: WireQuote;
  rateItems: WireRateItem[];
  pending: boolean;
  onClose: () => void;
  onRaise: (draft: ChangeOrderDraft) => void;
}) {
  const [reason, setReason] = useState<WireChangeReason | ''>('');
  const [scheduleImpactDays, setDays] = useState('');
  const [notes, setNotes] = useState('');
  const [picks, setPicks] = useState<Pick[]>([]);
  const [query, setQuery] = useState('');
  const [nextKey, setNextKey] = useState(1);

  const byId = new Map(rateItems.map((item) => [item.id, item]));

  const needle = query.trim().toLowerCase();
  // Search first, never a long select: the rate list runs to hundreds of items.
  // Nothing is listed until he types, so the sheet stays on the lines he has
  // already chosen rather than opening on a wall of everything.
  const matches = needle
    ? rateItems.filter(
        (item) =>
          item.description.toLowerCase().includes(needle) ||
          item.code.toLowerCase().includes(needle),
      )
    : [];

  const ready = reason !== '' && picks.length > 0;

  function patch(key: number, change: Partial<Pick>) {
    setPicks((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  return (
    <Sheet
      label="Raise a change order"
      title="Raise a change order"
      subtitle={`Amending ${quote.quoteNumber}`}
      onClose={onClose}
      footer={
        <>
          <Button
            size="lg"
            className="flex-1"
            disabled={!ready}
            pending={pending}
            pendingLabel="Raising…"
            onClick={() => {
              if (reason === '') return;
              onRaise({
                parentQuoteId: quote.id,
                reason,
                scheduleImpactDays,
                notes,
                lines: picks.map((pick) => ({
                  rateItemId: pick.rateItemId,
                  qty: pick.qty,
                  deductive: pick.deductive,
                })),
              });
            }}
          >
            Raise the change order
          </Button>
          <Button variant="secondary" size="lg" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="grid gap-4 pb-2">
        <label className="grid gap-1">
          <span className="t-small text-muted">Why is the work changing?</span>
          <select
            autoFocus
            className="field min-h-12"
            value={reason}
            onChange={(event) => setReason(event.target.value as WireChangeReason | '')}
          >
            <option value="">Choose a reason</option>
            {REASONS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        {/* Unpriced time is the most common way a contractor loses money while
            appearing to break even, so a delay is recorded even at zero
            dollars. */}
        <Measurement
          label="Days added to the schedule"
          unit="days"
          value={scheduleImpactDays}
          onChange={setDays}
        />

        <label className="grid gap-1">
          <span className="t-small text-muted">What changed (optional)</span>
          <textarea
            className="field"
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>

        <div className="grid gap-2">
          <h3 className="t-heading">Lines</h3>

          {picks.length === 0 ? (
            <p className="t-small text-muted">
              Nothing on it yet. Add what changed from the rate list below. Turn on Deduction
              for work coming off the job, which prices as a credit.
            </p>
          ) : (
            <ul>
              {picks.map((pick) => {
                const item = byId.get(pick.rateItemId);
                if (!item) return null;
                // A deduction is the same rate at a negative price, so the
                // figure shown is the figure the change order will carry.
                const signed = BigInt(item.sellRateTenThou) * (pick.deductive ? -1n : 1n);
                return (
                  <li key={pick.key} className="grid gap-2 border-b border-line py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate">{item.description}</span>
                      <span className="present-hide num t-small text-muted">{item.code}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="t-small text-muted">Qty</span>
                        <input
                          aria-label={`Quantity of ${item.description} on this change order`}
                          className="field field-num min-h-12"
                          inputMode="decimal"
                          value={pick.qty}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => patch(pick.key, { qty: event.target.value })}
                        />
                      </label>
                      <label className="flex min-h-12 items-center gap-2 px-1">
                        <input
                          type="checkbox"
                          className="h-5 w-5"
                          checked={pick.deductive}
                          onChange={(event) =>
                            patch(pick.key, { deductive: event.target.checked })
                          }
                        />
                        <span className="t-small">Deduction</span>
                      </label>
                      <button
                        type="button"
                        aria-label={`Take ${item.description} off this change order`}
                        className="flex min-h-12 min-w-12 items-center justify-center rounded-control text-muted hover:bg-negative-soft hover:text-negative-soft-fg"
                        onClick={() =>
                          setPicks((rows) => rows.filter((row) => row.key !== pick.key))
                        }
                      >
                        <Trash2 size={15} aria-hidden />
                      </button>
                    </div>
                    <p className={`num t-small ${pick.deductive ? 'text-negative' : 'text-muted'}`}>
                      {formatRate(signed)}
                      {item.unitLabel ? ` / ${item.unitLabel}` : ''}
                      {pick.deductive ? ' · credited to the customer' : ''}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}

          <label className="grid gap-1">
            <span className="t-small text-muted">Add work from the rate list</span>
            <input
              className="field min-h-12"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          {needle !== '' ? (
            <ul>
              {matches.length === 0 ? (
                <li className="py-4 text-center t-small text-muted">
                  Nothing matches. Rate items are managed under Rates.
                </li>
              ) : (
                // Capped rather than paged: past thirty matches the answer is a
                // narrower search, not more scrolling inside a sheet.
                matches.slice(0, 30).map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex min-h-12 w-full items-center justify-between gap-3 border-b border-line px-1 text-left hover:bg-surface-2"
                      onClick={() => {
                        setPicks((rows) => [
                          ...rows,
                          { key: nextKey, rateItemId: item.id, qty: '1', deductive: false },
                        ]);
                        setNextKey((key) => key + 1);
                        setQuery('');
                      }}
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
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}
