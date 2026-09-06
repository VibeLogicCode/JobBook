import { TextField } from '@/components/settings/Fields';

export interface EditableLineGroup {
  name: string;
  sortOrder: number;
}

/**
 * The two fields a line group is made of, shared by the add sheet and the
 * change sheet on `/settings/line-groups`, for the reason `TemplateLineFields`
 * was.
 */
export function LineGroupFields({
  idPrefix,
  row,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding: every field starts at the same defaults a new heading wants. */
  row?: EditableLineGroup;
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
            ? 'What prints on the quote, exactly as it should read.'
            : 'What it should say on the quote, exactly.'
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
