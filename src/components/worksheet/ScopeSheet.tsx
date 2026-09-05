'use client';

import { useState } from 'react';
import { saveScopeInputs } from '@/app/quotes/[id]/actions';
import { Measurement, Sheet } from '@/components/worksheet/Sheet';
import { Button } from '@/components/ui/Button';
import type { WireQuote } from '@/components/worksheet/types';
import { formatQty } from '@/lib/money/format';

/**
 * The four measurements a quote is built from.
 *
 * Saving records what was measured and nothing else. It does not rebuild the
 * line list -- see the Regenerate control, which is deliberately a separate
 * button with its own confirmation.
 */
export function ScopeSheet({
  quote,
  pending,
  onClose,
  onCommit,
}: {
  quote: WireQuote;
  pending: boolean;
  onClose: () => void;
  onCommit: (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => void;
}) {
  // Scaled integers cross the wire as strings and are parsed by the action with
  // the money helpers. Nothing here multiplies a float by a thousand.
  const [areaSqft, setAreaSqft] = useState(
    quote.areaSqftMilli ? formatQty(BigInt(quote.areaSqftMilli)) : '',
  );
  const [washroomCount, setWashrooms] = useState(String(quote.washroomCount ?? ''));
  const [kitchenCount, setKitchens] = useState(String(quote.kitchenCount ?? ''));
  const [bedroomCount, setBedrooms] = useState(String(quote.bedroomCount ?? ''));

  return (
    <Sheet
      label="Measurements"
      title="Measurements"
      subtitle="What the quote is built from. Saving records the figures; it does not rebuild the lines."
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
                saveScopeInputs({
                  quoteId: quote.id,
                  areaSqft,
                  washroomCount,
                  kitchenCount,
                  bedroomCount,
                }),
              );
              onClose();
            }}
          >
            Save measurements
          </Button>
          <Button variant="secondary" size="lg" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="grid gap-3 pb-2">
        <Measurement
          autoFocus
          label="Area"
          unit={quote.areaUnit}
          value={areaSqft}
          onChange={setAreaSqft}
        />
        <Measurement label="Washrooms" value={washroomCount} onChange={setWashrooms} />
        <Measurement label="Kitchens" value={kitchenCount} onChange={setKitchens} />
        <Measurement label="Bedrooms" value={bedroomCount} onChange={setBedrooms} />
        <p className="t-small text-subtle">
          A field left blank keeps the figure it already has. Type 0 for none.
        </p>
      </div>
    </Sheet>
  );
}

/**
 * Regeneration, and what it will do, said before it does it.
 *
 * The confirmation is the point of the control. A measurement change that
 * silently rebuilt the lines would discard ten minutes of hand adjustment
 * without ever naming what it threw away, so the two operations are separate
 * and this one states its consequences first.
 */
export function RegenerateDialog({
  templateName,
  pending,
  onClose,
  onConfirm,
}: {
  templateName: string | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Sheet
      label="Regenerate from the template"
      title="Regenerate from the template"
      subtitle={templateName ?? undefined}
      onClose={onClose}
      footer={
        <>
          <Button
            size="lg"
            className="flex-1"
            pending={pending}
            pendingLabel="Regenerating…"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Regenerate
          </Button>
          <Button variant="secondary" size="lg" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <ul className="grid list-disc gap-2 pb-2 pl-5">
        <li>
          Every line that came from the template is replaced, at the measurements on this quote
          and re-priced at today&apos;s rates.
        </li>
        <li>Lines you added by hand are kept exactly as they are.</li>
        <li>
          Nothing is deleted. A replaced line is voided with its reason and stays on the record,
          so what the quote said an hour ago is still there.
        </li>
      </ul>
    </Sheet>
  );
}
