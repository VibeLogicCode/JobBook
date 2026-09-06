import { TextField } from '@/components/settings/Fields';

export interface EditableProjectType {
  name: string;
  sortOrder: number;
}

/**
 * The two fields a project type is made of, shared by the add sheet and the
 * change sheet on `/settings/project-types`, for the reason `TradeFields` was.
 */
export function ProjectTypeFields({
  idPrefix,
  row,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding: every field starts at the same defaults a new type wants. */
  row?: EditableProjectType;
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
            ? 'Projects, scope templates and schedule templates point at the row, not the text — nothing is orphaned by a rename.'
            : 'One type of work, in the words you would use describing the job.'
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
