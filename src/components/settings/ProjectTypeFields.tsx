import { CheckboxField, SelectField, TextField } from '@/components/settings/Fields';
import {
  ALL_FLAGS_ON,
  POSTURE_LABELS,
  POSTURES,
  type ProjectTypeFlags,
  type WorkPosture,
} from '@/lib/posture/types';

export interface EditableProjectType extends ProjectTypeFlags {
  name: string;
  sortOrder: number;
  posture: WorkPosture;
}

/**
 * What a project type is made of, shared by the add sheet and the change sheet
 * on `/settings/project-types`, for the reason `TradeFields` was.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIVE FLAGS ARE EDITABLE HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 *
 * This screen is the only place they belong, because they describe a KIND OF
 * WORK rather than a job or a company. Since the 2018 amendments the
 * Construction Act's "improvement" includes capital repair and excludes
 * maintenance -- a leaking tap against a panel swap -- so whether holdback
 * applies is a fact about the work, and the owner is the one who knows which
 * of his own job types are which.
 *
 * A job reads them from its type at the moment it is quoted and keeps what it
 * read. So changing a flag here shapes NEW work and cannot reach back into a
 * contract already signed -- which is what makes the switch safe to try.
 *
 * `defaults` pre-fills a NEW type from the company's posture: a service-only
 * business gets everything off and turns back on what it wants, rather than
 * the reverse. On an existing row the stored values win.
 */
export function ProjectTypeFields({
  idPrefix,
  row,
  defaults = ALL_FLAGS_ON,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding: the flags then come from `defaults`. */
  row?: EditableProjectType;
  /** What a new type starts at, from `POSTURE_DEFAULTS`. Ignored when `row` is present. */
  defaults?: ProjectTypeFlags;
  disabled: boolean;
}) {
  const flags: ProjectTypeFlags = row ?? defaults;

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

      <SelectField
        idPrefix={idPrefix}
        name="posture"
        label="Offered for"
        options={POSTURES.map((posture) => ({ value: posture, label: POSTURE_LABELS[posture] }))}
        defaultValue={row?.posture ?? 'both'}
        disabled={disabled}
        hint="Which kind of work this type shows up for. Both means every job list sees it."
      />

      <CheckboxField
        idPrefix={idPrefix}
        name="holdback"
        label="Holdback applies"
        defaultChecked={flags.holdback}
        disabled={disabled}
        wide
        hint="Puts a holdback percentage on the quote and a ledger behind it. Off for maintenance — a leaking tap is not an improvement under the Construction Act; a panel swap is."
      />
      <CheckboxField
        idPrefix={idPrefix}
        name="progressInvoicing"
        label="Billed in draws"
        defaultChecked={flags.progressInvoicing}
        disabled={disabled}
        wide
        hint="Off means one invoice when the work is done. A service call is billed once."
      />
      <CheckboxField
        idPrefix={idPrefix}
        name="scheduleTemplate"
        label="Has a schedule"
        defaultChecked={flags.scheduleTemplate}
        disabled={disabled}
        wide
        hint="A task chain with dependencies. Three tasks do not want a critical path."
      />
      <CheckboxField
        idPrefix={idPrefix}
        name="constructionActDates"
        label="Construction Act dates"
        defaultChecked={flags.constructionActDates}
        disabled={disabled}
        wide
        hint="Substantial performance and certificate published. They start the clock on getting your holdback, so they mean nothing on work that withholds none."
      />
      <CheckboxField
        idPrefix={idPrefix}
        name="scopeInputs"
        label="Measurements"
        defaultChecked={flags.scopeInputs}
        disabled={disabled}
        wide
        hint="Area, washrooms, kitchens and bedrooms, which drive template quantities. Written for a build."
      />
    </>
  );
}
