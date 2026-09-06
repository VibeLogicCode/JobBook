import { FieldGrid, SelectField, TextAreaField, TextField } from '@/components/settings/Fields';
import { listOptions, type ListRowRef } from '@/app/settings/project-lists';

/**
 * The three fields a template cannot exist without, whichever kind it is.
 *
 * `scope_templates` and `schedule_templates` share this shape column for
 * column on purpose (`src/db/schema/schedule-templates.ts`'s own docblock says
 * so) -- name, project type, description -- so this is the one place that
 * shape is written rather than three inline copies (the create sheet's quote
 * side, its schedule side, and the quote editor's own edit sheet) drifting
 * from each other one hint at a time.
 *
 * Renders its own `FieldGrid`, unlike `TemplateLineFields`: every caller here
 * wants exactly these three fields and nothing beside them, so there is no
 * form that needs to interleave a field of its own into this grid.
 *
 * `projectType` used to be a closed enum with a safe default ('renovation')
 * to fall back on. It is a maintained list now (`db/schema/project-lists.ts`),
 * so there is no member every deployment is guaranteed to keep -- the picker
 * asks explicitly rather than silently landing on whichever type happens to
 * still exist.
 */
export function TemplateHeaderFields({
  idPrefix,
  name,
  projectTypeId,
  projectTypes,
  description,
  disabled,
}: {
  idPrefix: string;
  /** Absent when creating: a fresh template starts blank. */
  name?: string;
  projectTypeId?: string;
  /** Every project type, retired and voided included -- see `listOptions`. */
  projectTypes: ListRowRef[];
  description?: string | null;
  disabled: boolean;
}) {
  return (
    <FieldGrid>
      <TextField
        idPrefix={idPrefix}
        name="name"
        label="Name"
        required
        maxLength={200}
        defaultValue={name}
        disabled={disabled}
      />
      <SelectField
        idPrefix={idPrefix}
        name="projectTypeId"
        label="Project type"
        required
        blankLabel={projectTypeId ? undefined : 'Choose a type of work'}
        defaultValue={projectTypeId ?? ''}
        options={listOptions(projectTypes, projectTypeId)}
        disabled={disabled}
      />
      <TextAreaField
        idPrefix={idPrefix}
        name="description"
        label="Description"
        rows={3}
        defaultValue={description}
        disabled={disabled}
        hint="What this template covers, and what it deliberately leaves out."
      />
    </FieldGrid>
  );
}
