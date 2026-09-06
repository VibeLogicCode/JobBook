import { TextField } from '@/components/settings/Fields';

export interface EditableTrade {
  name: string;
  sortOrder: number;
}

/**
 * The two fields a trade is made of, shared by the add sheet and the change
 * sheet on `/settings/trades`, for the reason `TemplateLineFields` was.
 *
 * `name`'s hint is the one thing kept per caller: a trade being added is
 * explained to someone deciding what to call it, and one that already exists
 * is explained to someone who might be about to rename it out from under
 * every subcontractor carrying it.
 */
export function TradeFields({
  idPrefix,
  row,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding: every field starts at the same defaults a new trade wants. */
  row?: EditableTrade;
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
            : 'One trade, in the words you would use asking for one.'
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
