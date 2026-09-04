'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { acceptQuote } from '@/app/quotes/[id]/actions';
import type { AcceptanceSibling } from '@/app/quotes/[id]/siblings';
import { Pill } from '@/components/ui/Pill';
import { Sheet } from '@/components/worksheet/Sheet';
import type { WireLine, WireQuote } from '@/components/worksheet/types';
import { formatCents } from '@/lib/money/format';
import { computeQuote } from '@/lib/quote/totals';
import type { LineInput } from '@/lib/quote/types';

/**
 * Winning the quote: tick what the customer agreed to, and the opportunity
 * becomes a job.
 *
 * A sheet rather than a second table on the page. The worksheet above is the
 * document -- eight columns, grouped by trade, with cost and margin on it --
 * and this is a decision about three facts: which lines, who agreed, and what
 * happens to the other prices out with the same customer. Repeating the priced
 * document underneath itself with checkboxes bolted on would give the screen
 * two line lists that have to be read against each other.
 *
 * What it will do is stated in words before the button is pressed, because the
 * consequences are not reversible from this screen: a subset writes a new
 * version and supersedes the one that was sent, and the losing quotes get
 * declined.
 */
export function Acceptance({
  quote,
  lines,
  siblings,
}: {
  quote: WireQuote;
  lines: WireLine[];
  siblings: AcceptanceSibling[];
}) {
  const [open, setOpen] = useState(false);

  /**
   * Offered on a draft as well as on a sent quote.
   *
   * The engine accepts both, for the reason written there: a quote printed at
   * the kitchen table and signed is a contract whether or not anybody pressed
   * "Mark sent" first, and the button that would have to be pressed asserts a
   * send that did not happen.
   */
  const winnable =
    quote.kind === 'estimate' &&
    quote.recordStatus === 'active' &&
    (quote.status === 'draft' || quote.status === 'sent');

  if (!winnable) return null;

  return (
    <section className="no-print border-t border-line-strong bg-surface-2 px-4 py-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="t-small text-muted">
          When the customer says yes, convert this quote into the job — pick the lines they
          agreed to and the opportunity becomes work.
        </p>
        <button
          type="button"
          className="ml-auto min-h-11 rounded-[4px] bg-accent px-3 text-accent-fg hover:bg-accent-hover"
          onClick={() => setOpen(true)}
        >
          Convert to a job
        </button>
      </div>

      {open ? (
        <AcceptanceSheet
          quote={quote}
          lines={lines}
          siblings={siblings}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </section>
  );
}

/**
 * A line as the engine wants it, for the running figure only.
 *
 * `isOptional` and `isIncluded` are forced the way the transaction will force
 * them, so the subtotal on the sheet is the subtotal the contract will carry:
 * an upgrade the customer took is contracted work, and it has to attract the
 * percent lines that included work attracts.
 *
 * Provenance is dropped: this computation is thrown away when the sheet closes,
 * and a cost code on a figure nobody stores is noise.
 */
function toInput(line: WireLine): LineInput & { id: string } {
  return {
    id: line.id,
    code: line.code,
    description: line.description,
    lineGroup: line.lineGroup,
    sortOrder: line.sortOrder,
    calcMode: line.calcMode,
    unitLabel: line.unitLabel,
    qtyMilli: BigInt(line.qtyMilli),
    unitCostTenThou: BigInt(line.unitCostTenThou),
    unitPriceTenThou: BigInt(line.unitPriceTenThou),
    isTaxable: line.isTaxable,
    isOptional: false,
    isIncluded: true,
    isAllowance: line.isAllowance,
    rateItemId: null,
    costCodeId: null,
  };
}

function AcceptanceSheet({
  quote,
  lines,
  siblings,
  onClose,
}: {
  quote: WireQuote;
  lines: WireLine[];
  siblings: AcceptanceSibling[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [acceptedByName, setName] = useState('');
  const [declineSiblings, setDeclineSiblings] = useState(true);

  /**
   * A percent line is arithmetic, not scope.
   *
   * Overhead at 10% prices itself off whatever work is included, so there is
   * nothing for the customer to say yes or no to and no checkbox for it. It
   * carries forward on its own and re-resolves against whatever is ticked --
   * which is also why the figure beside it moves as boxes are ticked.
   */
  const automatic = useMemo(
    () => lines.filter((line) => line.calcMode === 'percent' && line.isIncluded),
    [lines],
  );
  const quoted = useMemo(
    () => lines.filter((line) => line.isIncluded && line.calcMode !== 'percent'),
    [lines],
  );
  // An excluded line is optional by database constraint, so these are exactly
  // the upgrades the customer was offered and has not taken yet.
  const upgrades = useMemo(() => lines.filter((line) => !line.isIncluded), [lines]);

  // Everything quoted starts ticked and every upgrade starts clear, which is
  // what the document already says. The common case is then one press.
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(quoted.map((line) => line.id)),
  );

  const carried = useMemo(
    () => lines.filter((line) => picked.has(line.id) || isAutomatic(line)),
    [lines, picked],
  );

  /**
   * Every figure on the sheet comes from one engine pass over the ticked lines,
   * so the rows add up to the subtotal printed under them.
   *
   * Keyed by line id rather than by position, following `recalculateQuote`: the
   * arithmetic happens to preserve order today, and a positional read would
   * write every figure onto its neighbour the day something filters a line.
   *
   * Tax is deliberately absent. The rates in force are a server question --
   * effective dating, compounding, the customer's exemption -- and a guess at
   * them here would put a total on the screen that the contract then disagrees
   * with. The subtotal is exact, and it is labelled as the subtotal.
   */
  const priced = useMemo(() => {
    const totals = computeQuote(carried.map(toInput), [], {
      onDate: quote.quoteDate,
      customerExempt: true,
    });
    const amounts = new Map<string, number>();
    for (const line of totals.lines) {
      const id = (line as LineInput & { id?: string }).id;
      if (id) amounts.set(id, line.lineTotalCents);
    }
    return { amounts, subtotalCents: totals.subtotalCents };
  }, [carried, quote.quoteDate]);

  /**
   * Whether the ticked set IS the document already.
   *
   * The same test the transaction makes, and it has to stay the same test: this
   * sentence is the promise, and the transaction is what keeps it.
   */
  const unchanged =
    quoted.every((line) => picked.has(line.id)) && upgrades.every((line) => !picked.has(line.id));
  const ready = picked.size > 0 && acceptedByName.trim() !== '';
  const willDecline = declineSiblings ? siblings : [];

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function convert() {
    setError(null);
    startTransition(async () => {
      const result = await acceptQuote({
        quoteId: quote.id,
        wonLineIds: [...picked],
        declineSiblings,
        acceptedByName,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      // A subset put the contract on a different row, and that row is the one
      // worth looking at. An acceptance in place has nothing to navigate to.
      if (result.acceptedQuoteId === quote.id) router.refresh();
      else router.push(`/quotes/${result.acceptedQuoteId}`);
    });
  }

  return (
    <Sheet
      label="Convert this quote to a job"
      title="Convert to a job"
      subtitle={`${quote.quoteNumber} v${quote.version} · ${quote.customerName}`}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            disabled={pending || !ready}
            className="min-h-12 flex-1 rounded-[4px] bg-accent px-3 text-accent-fg hover:bg-accent-hover disabled:opacity-60"
            onClick={convert}
          >
            {unchanged ? 'Accept and win the job' : 'Accept these lines and win the job'}
          </button>
          <button
            type="button"
            className="min-h-12 rounded-[4px] border border-line-strong px-3 hover:bg-surface-2"
            onClick={onClose}
          >
            Cancel
          </button>
        </>
      }
    >
      <div className="grid gap-4 pb-2">
        {error ? (
          <p
            role="alert"
            className="rounded-[4px] border border-negative bg-negative-soft px-3 py-2 t-small text-negative-soft-fg"
          >
            {error}
          </p>
        ) : null}

        <div className="grid gap-2">
          <h3 className="t-heading">What did they agree to?</h3>

          {/* One DOM tree, reflowed by CSS: a table at `sm` and above, the same
              rows as cards below it. No inline minWidth, so three columns fit a
              sheet at every width without a horizontal scroll. */}
          <table
            // Busy rather than disabled. Disabling a checkbox mid-flight throws
            // focus to the document body, which loses the owner's place in a
            // list he is halfway down.
            aria-busy={pending}
            className="data-table data-table--stack"
          >
            <caption className="sr-only">
              Lines on {quote.quoteNumber}, to tick as accepted
            </caption>
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col" className="present-hide">Code</th>
                <th scope="col" className="cell-num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {quoted.map((line) => (
                <PickRow
                  key={line.id}
                  line={line}
                  checked={picked.has(line.id)}
                  amountCents={priced.amounts.get(line.id) ?? line.lineTotalCents}
                  onToggle={() => toggle(line.id)}
                />
              ))}

              {upgrades.map((line) => (
                <PickRow
                  key={line.id}
                  line={line}
                  checked={picked.has(line.id)}
                  // Untaken, the figure shown is what accepting it would add --
                  // its price grossed up by the percent lines it would then
                  // attract. Printing the raw price and invoicing the grossed-up
                  // one is the bug that figure exists to prevent.
                  amountCents={priced.amounts.get(line.id) ?? line.displayPriceCents}
                  onToggle={() => toggle(line.id)}
                  upgrade
                />
              ))}

              {automatic.map((line) => (
                <tr key={line.id}>
                  <td data-label="Line">
                    <span className="text-muted">{line.description}</span>
                    <span className="ml-2">
                      <Pill>Carried</Pill>
                    </span>
                  </td>
                  <td data-label="Code" className="present-hide num t-small text-muted">
                    {line.code}
                  </td>
                  <td data-label="Amount" className="cell-num text-muted">
                    {formatCents(priced.amounts.get(line.id) ?? line.lineTotalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="flex items-baseline justify-between gap-3 t-small">
            <span className="text-muted">Subtotal of the accepted work, before tax</span>
            <span className="num t-heading">{formatCents(priced.subtotalCents)}</span>
          </p>
        </div>

        {/* Not autofocused, unlike the other sheets. Focusing a field below the
            table would scroll the sheet past the line list, which is the thing
            the person opened it to read. */}
        <label className="grid gap-1">
          <span className="t-small text-muted">Who accepted it?</span>
          <input
            className="field min-h-12"
            value={acceptedByName}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        {/* Not offered when there is nothing to decline: a checkbox about an
            empty list is a question with one answer. */}
        {siblings.length > 0 ? (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 shrink-0"
              checked={declineSiblings}
              onChange={(event) => setDeclineSiblings(event.target.checked)}
            />
            <span className="grid gap-0.5">
              <span>
                Decline the other {siblings.length === 1 ? 'price' : 'prices'} on this job
              </span>
              <span className="t-small text-muted">
                {siblings.map((sibling) => sibling.quoteNumber).join(', ')} — turn this off if
                more than one of them can be won, because the job&rsquo;s contract value is the
                sum of the quotes that were accepted.
              </span>
            </span>
          </label>
        ) : null}

        {/* The whole consequence, in words, before the press. */}
        <div className="rounded-[4px] border border-line bg-surface-2 px-3 py-2 t-small">
          <p className="mb-1 t-micro uppercase text-muted">What this will do</p>
          <ul className="grid gap-1">
            {unchanged ? (
              <li>
                Version {quote.version} is accepted exactly as it stands. Nothing changed, so no
                new version is written and the page the customer signed stays the contract.
              </li>
            ) : (
              <li>
                A new version of {quote.quoteNumber} is written carrying only these{' '}
                {carried.length === 1 ? 'line' : `${carried.length} lines`}, and that version is
                the accepted one. Version {quote.version} is marked superseded, so the accepted
                document matches the agreed work line for line.
              </li>
            )}
            <li>This opportunity becomes a job.</li>
            {willDecline.length > 0 ? (
              <li>
                {willDecline.length === 1 ? '1 other quote' : `${willDecline.length} other quotes`}{' '}
                on this job {willDecline.length === 1 ? 'is' : 'are'} declined:{' '}
                <span className="num">
                  {willDecline.map((sibling) => sibling.quoteNumber).join(', ')}
                </span>
                .
              </li>
            ) : siblings.length > 0 ? (
              <li>
                The other {siblings.length === 1 ? 'quote' : 'quotes'} on this job{' '}
                {siblings.length === 1 ? 'stays' : 'stay'} open.
              </li>
            ) : null}
            <li className="text-muted">Nothing is deleted. Superseded versions stay readable.</li>
          </ul>
        </div>
      </div>
    </Sheet>
  );
}

function isAutomatic(line: WireLine): boolean {
  return line.calcMode === 'percent' && line.isIncluded;
}

/**
 * One tickable line.
 *
 * The checkbox and the description sit inside one `<label>`, so the whole first
 * cell -- the card headline below `sm` -- is the hit target. The row carries no
 * click handler of its own: an inline control inside a clickable row fires the
 * row's handler as well as its own, and the fix for that is not to have the
 * second handler.
 */
function PickRow({
  line,
  checked,
  amountCents,
  onToggle,
  upgrade = false,
}: {
  line: WireLine;
  checked: boolean;
  amountCents: number;
  onToggle: () => void;
  upgrade?: boolean;
}) {
  return (
    <tr>
      <td data-label="Line">
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            className="h-5 w-5 shrink-0"
            checked={checked}
            onChange={onToggle}
          />
          <span className="min-w-0">
            <span className={checked ? '' : 'text-muted'}>{line.description}</span>
            {upgrade ? (
              <span className="ml-2">
                <Pill tone="info">Upgrade</Pill>
              </span>
            ) : null}
            {line.isAllowance ? (
              <span className="ml-2">
                <Pill tone="warning">Allowance</Pill>
              </span>
            ) : null}
          </span>
        </label>
      </td>
      <td data-label="Code" className="present-hide num t-small text-muted">
        {line.code}
      </td>
      <td data-label="Amount" className={`cell-num ${checked ? '' : 'text-subtle'}`}>
        {formatCents(amountCents)}
      </td>
    </tr>
  );
}
