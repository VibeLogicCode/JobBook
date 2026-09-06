import { TextField } from '@/components/settings/Fields';

export interface EditablePaymentMethod {
  name: string;
  sortOrder: number;
}

/**
 * The two fields a payment method keeps changeable, shared by the add sheet
 * and the change sheet on `/settings/payment-methods`, for the reason
 * `VendorTypeFields` was.
 *
 * `isOnAccount` is NOT here. It is fixed once the method exists -- the change
 * sheet shows it as a `ReadOnlyField` rather than a control this component
 * would have to disable -- so each caller keeps its own version of that
 * field.
 */
export function PaymentMethodFields({
  idPrefix,
  row,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding: every field starts at the same defaults a new method wants. */
  row?: EditablePaymentMethod;
  disabled: boolean;
}) {
  return (
    <>
      <TextField
        idPrefix={idPrefix}
        name="name"
        label="Name"
        required
        maxLength={120}
        defaultValue={row?.name}
        disabled={disabled}
        hint={
          row
            ? 'Expenses point at the row, not the text — nothing is orphaned by a rename.'
            : 'How the money left, in the words you would use out loud.'
        }
      />
      <TextField
        idPrefix={idPrefix}
        name="sortOrder"
        label="Order"
        numeric
        inputMode="numeric"
        maxLength={6}
        defaultValue={String(row ? row.sortOrder : 0)}
        disabled={disabled}
        hint="Where it sits in the picker. Equal numbers fall back to the name."
      />
    </>
  );
}
