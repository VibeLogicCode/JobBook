'use client';

import { useState } from 'react';
import { saveQuoteClauses } from '@/app/quotes/[id]/actions';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import type { WireClause, WireQuote } from '@/components/worksheet/types';

/**
 * What the price does not include, and what it assumes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCREEN EXISTS
 * ---------------------------------------------------------------------------
 *
 * `quotes.exclusions_text` and `assumptions_text` have been in the schema
 * since the first migration, are carried onto every revision and change order,
 * and no form has ever written them -- so no quote this product printed had
 * ever said what it left out. That is the commonest argument on a job. "I
 * assumed that was included" is settled by a paragraph written before the work
 * starts or it is settled by whoever remembers harder.
 *
 * ---------------------------------------------------------------------------
 * THE LIBRARY IS A TAP, NOT A PICKER
 * ---------------------------------------------------------------------------
 *
 * The saved rows are suggestions, and tapping one APPENDS its sentence to the
 * box as a new line. It does not link to it, does not tick it, and does not
 * own the text afterwards -- so an exclusion can be reworded for this one job
 * without touching the library, and the quote keeps the words that were
 * actually printed even if somebody edits the library next year.
 *
 * That also means the textarea stays the whole truth. Nobody has to work out
 * which of two places the sentence came from, which for somebody with no IT
 * support is the difference between a feature and a support call.
 */
export function ClauseSheet({
  quote,
  clauses,
  pending,
  onClose,
  onCommit,
}: {
  quote: WireQuote;
  /** The saved suggestions, already filtered to the active ones. */
  clauses: WireClause[];
  pending: boolean;
  onClose: () => void;
  onCommit: (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => void;
}) {
  const [exclusionsText, setExclusions] = useState(quote.exclusionsText ?? '');
  const [assumptionsText, setAssumptions] = useState(quote.assumptionsText ?? '');

  const exclusions = clauses.filter((row) => row.kind === 'exclusion');
  const assumptions = clauses.filter((row) => row.kind === 'assumption');

  /** Appends on its own line, and never twice. */
  function append(current: string, text: string): string {
    if (current.split('\n').some((line) => line.trim() === text)) return current;
    return current === '' ? text : `${current.replace(/\s*$/, '')}\n${text}`;
  }

  return (
    <Sheet
      label="Not included, and assumed"
      title="Not included, and assumed"
      subtitle="Both print on the customer's copy, under the lines. Write them in your own words, or tap a saved one to add it."
      onClose={onClose}
      footer={
        <>
          <Button
            size="lg"
            className="flex-1"
            pending={pending}
            pendingLabel="Saving…"
            onClick={() => {
              onCommit(() =>
                saveQuoteClauses({ quoteId: quote.id, exclusionsText, assumptionsText }),
              );
              onClose();
            }}
          >
            Save
          </Button>
          <Button variant="secondary" size="lg" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="grid gap-5 pb-2">
        <ClauseField
          label="Not included in this price"
          hint="One per line. These are what stops a disagreement later."
          placeholder={'Permit fees\nPainting\nMoving furniture'}
          value={exclusionsText}
          onChange={setExclusions}
          suggestions={exclusions}
          onPick={(text) => setExclusions((current) => append(current, text))}
          autoFocus
        />

        <ClauseField
          label="This price assumes"
          hint="What you based the price on. If one turns out to be wrong, this is the change order."
          placeholder={'Existing panel has spare capacity\nWork during normal hours'}
          value={assumptionsText}
          onChange={setAssumptions}
          suggestions={assumptions}
          onPick={(text) => setAssumptions((current) => append(current, text))}
        />
      </div>
    </Sheet>
  );
}

function ClauseField({
  label,
  hint,
  placeholder,
  value,
  onChange,
  suggestions,
  onPick,
  autoFocus = false,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: WireClause[];
  onPick: (text: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="grid gap-2">
      <label className="grid gap-1">
        <span className="t-small font-semibold">{label}</span>
        <textarea
          autoFocus={autoFocus}
          rows={5}
          maxLength={4000}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          /**
           * `field`, not a hand-rolled box.
           *
           * This carried `t-body` -- a class that does not exist anywhere in
           * the stylesheet -- so it silently fell back to 14px and, worse,
           * bypassed `.field`, which is what sets 16px below `sm` for one
           * reason: iOS Safari zooms the whole page when a control under 16px
           * takes focus. This is the box somebody types site exclusions into,
           * one-handed, on a phone.
           */
          className="field w-full px-2 py-1.5"
        />
        <span className="t-small text-subtle">{hint}</span>
      </label>

      {suggestions.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="t-micro uppercase text-subtle">Tap to add</span>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((row) => (
              /**
               * A button and not a checkbox, because the action is "put this
               * sentence in the box" and not "this quote is linked to this
               * row". Pressing it twice adds nothing the second time.
               */
              <button
                key={row.id}
                type="button"
                onClick={() => onPick(row.clauseText)}
                /**
                 * `min-h-11`: the label above these says "Tap to add", so they
                 * are explicitly a touch affordance, and at `py-1` they were
                 * about 28px in a wrapped row with 6px between them -- small
                 * enough that the neighbouring sentence is the likely hit.
                 */
                className="min-h-11 rounded-control border border-line bg-surface-2 px-3 py-2 text-left t-small transition-colors duration-[120ms] hover:bg-surface-3"
              >
                {row.clauseText}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
