import { TextField } from '@/components/settings/Fields';

export interface EditableVendorType {
  name: string;
  sortOrder: number;
}

/**
 * The two fields a vendor type keeps changeable, shared by the add sheet and
 * the change sheet on `/settings/vendor-types`, for the reason
 * `TemplateLineFields` was.
 *
 * `isSubcontractor` is NOT here. It is fixed once the type exists -- the
 * change sheet shows it as a `ReadOnlyField` rather than a control this
 * component would have to disable -- so each caller keeps its own version of
 * that field, the same way a template line's rate-item picker stays with the
 * add form alone.
 */
export function VendorTypeFields({
  idPrefix,
  row,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding: every field starts at the same defaults a new type wants. */
  row?: EditableVendorType;
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
            ? 'Vendors point at the row, not the text — nothing is orphaned by a rename.'
            : 'The kind of counterparty, in the words you would use out loud.'
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
