import { CheckboxField, TextField } from '@/components/settings/Fields';

/**
 * A tax rate's fields, split into the two groups `/settings/tax-rates`
 * already treats as two different acts, and shared by the add sheet and the
 * change sheet for the reason `TemplateLineFields` was.
 *
 * The change sheet keeps the split it always had -- superseding a rate closes
 * the row and inserts its successor, while correcting the presentation edits
 * in place -- so there is no single "edit" form to share the add form's
 * fields with. What is shared instead is each GROUP: the add sheet renders
 * both, one after the other, in one form; the change sheet renders each in
 * its own form, with its own action and its own consequence.
 */

/** `rate` and `effectiveFrom` -- asked once for a brand-new rate, and again every time it is superseded. */
export function TaxRateAmountFields({
  idPrefix,
  supersede,
  disabled,
}: {
  idPrefix: string;
  /** True in the change sheet: labels and hints talk about a successor rather than the first rate. */
  supersede?: boolean;
  disabled: boolean;
}) {
  return (
    <>
      <TextField
        idPrefix={idPrefix}
        name="rate"
        label={supersede ? 'New rate' : 'Rate'}
        required
        numeric
        inputMode="decimal"
        suffix="%"
        maxLength={8}
        disabled={disabled}
        hint={supersede ? undefined : 'Two decimal places at most.'}
      />
      <TextField
        idPrefix={idPrefix}
        name="effectiveFrom"
        label={supersede ? 'Takes effect on' : 'In force from'}
        type="date"
        required
        disabled={disabled}
        hint={
          supersede
            ? "The first day the new rate applies. It must be after this row's start date."
            : 'The first day this rate applies. Back-dating is allowed.'
        }
      />
    </>
  );
}

export interface EditableTaxRatePresentation {
  label: string;
  shortLabel: string | null;
  registrationNumber: string | null;
  sortOrder: number;
  isCompound: boolean;
}

/** `label`, `shortLabel`, `registrationNumber`, `sortOrder` and `isCompound` -- everything about how a rate prints, never its amount or its dates. */
export function TaxRatePresentationFields({
  idPrefix,
  row,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding: sortOrder defaults to 1 and isCompound starts unchecked. */
  row?: EditableTaxRatePresentation;
  disabled: boolean;
}) {
  return (
    <>
      <TextField
        idPrefix={idPrefix}
        name="label"
        label="Label"
        required
        maxLength={50}
        defaultValue={row?.label}
        disabled={disabled}
        hint={row ? 'Printed on the document beside the amount.' : 'As it prints on a document.'}
      />
      <TextField
        idPrefix={idPrefix}
        name="shortLabel"
        label="Short label"
        maxLength={20}
        defaultValue={row?.shortLabel}
        disabled={disabled}
        hint={row ? 'For a narrow column, where the full label will not fit.' : undefined}
      />
      <TextField
        idPrefix={idPrefix}
        name="registrationNumber"
        label="Registration number"
        maxLength={50}
        numeric
        defaultValue={row?.registrationNumber}
        disabled={disabled}
        hint={row ? undefined : "Printed beside this tax. It can differ from the company's other numbers."}
      />
      <TextField
        idPrefix={idPrefix}
        name="sortOrder"
        label="Order"
        required
        numeric
        inputMode="numeric"
        maxLength={3}
        defaultValue={row ? String(row.sortOrder) : '1'}
        disabled={disabled}
        hint={row ? 'Application order. It matters when a compound tax is in the list.' : undefined}
      />
      <CheckboxField
        idPrefix={idPrefix}
        name="isCompound"
        label="Applies on the subtotal plus taxes already added"
        defaultChecked={row?.isCompound}
        disabled={disabled}
        wide
        // No current Canadian jurisdiction compounds; one historically did.
        hint={row ? 'Evaluates after every non-compound tax, in the order above.' : undefined}
      />
    </>
  );
}
