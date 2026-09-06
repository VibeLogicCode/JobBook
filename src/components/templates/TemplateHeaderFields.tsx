import { FieldGrid, SelectField, TextAreaField, TextField } from '@/components/settings/Fields';
import { PROJECT_TYPE_OPTIONS } from '@/app/templates/schema';

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
 */
export function TemplateHeaderFields({
  idPrefix,
  name,
  projectType,
  description,
  disabled,
}: {
  idPrefix: string;
  /** Absent when creating: a fresh template starts blank. */
  name?: string;
  projectType?: string;
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
        name="projectType"
        label="Project type"
        required
        defaultValue={projectType ?? 'renovation'}
        options={PROJECT_TYPE_OPTIONS}
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
