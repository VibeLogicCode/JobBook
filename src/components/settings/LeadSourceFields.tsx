import { TextField } from '@/components/settings/Fields';

export interface EditableLeadSource {
  name: string;
  sortOrder: number;
}

/**
 * The two fields a lead source is made of, shared by the add sheet and the
 * change sheet on `/settings/lead-sources`, for the reason `TradeFields` was.
 */
export function LeadSourceFields({
  idPrefix,
  row,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding: every field starts at the same defaults a new source wants. */
  row?: EditableLeadSource;
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
            ? 'Customers point at the row, not the text — nothing is orphaned by a rename.'
            : 'How a customer found you, in the words you would use describing it.'
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
