import {
  type Option,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/settings/Fields';
import { formatQty } from '@/lib/money/format';
import {
  CONDITION_KIND_OPTIONS,
  CONDITION_MEASUREMENT_OPTIONS,
  DURATION_SOURCE_OPTIONS,
} from '@/app/templates/schedule/schema';

/**
 * The fields that describe a SCHEDULE TEMPLATE task's shape, shared by adding
 * one and changing one -- the reason `TaskFields` (this directory's own
 * `TaskEditor.tsx`, for the live schedule) and `TemplateLineFields`
 * (`src/components/templates/TemplateLineFields.tsx`, for a scope template
 * line) are both split out the same way: one component rendered from both
 * forms is what makes an improved hint land in both places by construction,
 * rather than by remembering the other call site.
 *
 * Renders a bare fragment, like both of those -- the caller supplies the
 * `FieldGrid`.
 *
 * **Why a milestone hides the duration fields with CSS, not a second form.**
 * Section 5.1 of the design doc: "the editor hides the duration fields for a
 * milestone rather than collecting values it will discard." This reuses the
 * `.reveals-field` / `.revealed-field` mechanism `src/app/vendors/page.tsx`
 * already established for exactly this shape of problem (a box that only
 * some answers ask for, hidden without a client-side mirror of the form). It
 * is deliberately the ONLY reveal in this form: a durationSource-driven second
 * reveal (area needs one field, a count needs another) would need to nest
 * inside this one, and the CSS rule matches ANY `select[data-reveals]`
 * descendant, not a specific one -- so a second, nested reveal-field would
 * make the milestone toggle react to the duration-source select as well.
 * Those two fields stay always-visible instead, each with a hint saying when
 * it is actually read -- the same choice `TemplateLineFields` already made for
 * `fixedQty`, which is only read when `qtySource` is `fixed` and says so
 * rather than hiding.
 */
export interface EditableTemplateTask {
  name: string;
  tradeId: string | null;
  costCodeId: string | null;
  notes: string | null;
  sortOrder: number;
  isMilestone: boolean;
  durationBaseDays: number;
  durationSource: 'none' | 'area' | 'washrooms' | 'kitchens' | 'bedrooms';
  /** Thousandths. Formatted through `formatQty` for the box, same as a quantity anywhere else. */
  durationAreaPerDayMilli: bigint | null;
  durationDaysPerUnit: number | null;
  predecessorTaskId: string | null;
  lagDays: number;
  /** Not a column -- derived from which of the two condition columns is set, so the form has one selector instead of an implicit one. */
  conditionKind: 'none' | 'measurement' | 'rateItem';
  conditionMeasurement: 'washrooms' | 'kitchens' | 'bedrooms' | null;
  conditionRateItemId: string | null;
}

export function TemplateTaskFields({
  idPrefix,
  task,
  nextSortOrder,
  disabled,
  areaUnit,
  tradeOptions,
  costCodeOptions,
  predecessorOptions,
  rateItemOptions,
}: {
  idPrefix: string;
  /** Absent when adding: every field starts at the defaults a new task wants. */
  task?: EditableTemplateTask;
  /** Only read when `task` is absent -- the add form's next free slot. */
  nextSortOrder?: number;
  disabled: boolean;
  /** The tenant's own area unit (`organization.area_unit`), so the label reads "sqft" or whatever this tenant actually calls it. */
  areaUnit: string;
  tradeOptions: Option[];
  costCodeOptions: Option[];
  /** Every OTHER live task in this template. Excludes this task's own row so the picker cannot offer a self-dependency; the action still refuses one reached by a hand-made request. */
  predecessorOptions: Option[];
  rateItemOptions: Option[];
}) {
  return (
    <>
      <TextField
        idPrefix={idPrefix}
        name="name"
        label="Task"
        required
        maxLength={200}
        defaultValue={task?.name}
        disabled={disabled}
        hint="What you would call it on the phone — framing, rough-in, drywall."
      />
      <SelectField
        idPrefix={idPrefix}
        name="tradeId"
        label="Trade"
        defaultValue={task?.tradeId ?? ''}
        options={tradeOptions}
        blankLabel="None"
        disabled={disabled}
        hint="Which trade an imported job should offer subcontractors from."
      />
      <SelectField
        idPrefix={idPrefix}
        name="costCodeId"
        label="Cost code"
        defaultValue={task?.costCodeId ?? ''}
        options={costCodeOptions}
        blankLabel="None — code the spend when it arrives"
        disabled={disabled}
      />
      <TextField
        idPrefix={idPrefix}
        name="sortOrder"
        label="Order"
        required
        numeric
        inputMode="numeric"
        maxLength={4}
        defaultValue={String(task ? task.sortOrder : (nextSortOrder ?? 0))}
        disabled={disabled}
        hint="In steps of ten, so a task can be inserted without renumbering."
      />

      {/* One reveal, deliberately -- see the docblock above. */}
      <div className="contents reveals-field">
        <SelectField
          idPrefix={idPrefix}
          name="isMilestone"
          label="Kind of task"
          required
          wide
          reveals
          defaultValue={task?.isMilestone ? 'true' : 'false'}
          options={[
            { value: 'false', label: 'Has its own duration', reveals: true },
            { value: 'true', label: 'A milestone — a single day, no duration' },
          ]}
          disabled={disabled}
        />
        <div className="revealed-field contents">
          <TextField
            idPrefix={idPrefix}
            name="durationBaseDays"
            label="Base days"
            required
            numeric
            inputMode="numeric"
            maxLength={4}
            defaultValue={String(task?.durationBaseDays ?? 0)}
            disabled={disabled}
            hint="Always counted, before anything below adds to it."
          />
          <SelectField
            idPrefix={idPrefix}
            name="durationSource"
            label="Then scales with"
            required
            defaultValue={task?.durationSource ?? 'none'}
            options={DURATION_SOURCE_OPTIONS}
            disabled={disabled}
          />
          <TextField
            idPrefix={idPrefix}
            name="durationAreaPerDay"
            label={`${areaUnit} per extra day`}
            numeric
            inputMode="decimal"
            maxLength={12}
            defaultValue={
              task?.durationAreaPerDayMilli != null ? formatQty(task.durationAreaPerDayMilli) : ''
            }
            disabled={disabled}
            hint={`Only read when the source above is Area — "300" means a day per 300 ${areaUnit}.`}
          />
          <TextField
            idPrefix={idPrefix}
            name="durationDaysPerUnit"
            label="Days per unit"
            numeric
            inputMode="numeric"
            maxLength={4}
            defaultValue={task?.durationDaysPerUnit != null ? String(task.durationDaysPerUnit) : ''}
            disabled={disabled}
            hint="Only read when the source above is a room count."
          />
        </div>
      </div>

      <SelectField
        idPrefix={idPrefix}
        name="predecessorTaskId"
        label="Waits on"
        defaultValue={task?.predecessorTaskId ?? ''}
        options={predecessorOptions}
        blankLabel="Nothing — starts on its own"
        disabled={disabled}
      />
      <TextField
        idPrefix={idPrefix}
        name="lagDays"
        label="Lag (days)"
        required
        numeric
        inputMode="numeric"
        maxLength={5}
        defaultValue={String(task?.lagDays ?? 0)}
        disabled={disabled}
        hint="Days after the task above finishes. Needs a task chosen above, or must stay zero."
      />

      <SelectField
        idPrefix={idPrefix}
        name="conditionKind"
        label="Applies"
        required
        defaultValue={task?.conditionKind ?? 'none'}
        options={CONDITION_KIND_OPTIONS}
        disabled={disabled}
      />
      <SelectField
        idPrefix={idPrefix}
        name="conditionMeasurement"
        label="Measurement"
        defaultValue={task?.conditionMeasurement ?? ''}
        options={CONDITION_MEASUREMENT_OPTIONS}
        blankLabel="Not used"
        disabled={disabled}
        hint="Only read when Applies above is a measurement."
      />
      <SelectField
        idPrefix={idPrefix}
        name="conditionRateItemId"
        label="Rate item"
        defaultValue={task?.conditionRateItemId ?? ''}
        options={rateItemOptions}
        blankLabel="Not used"
        disabled={disabled}
        hint="Only read when Applies above is a rate item."
      />

      <TextAreaField
        idPrefix={idPrefix}
        name="notes"
        label="Notes"
        rows={2}
        defaultValue={task?.notes}
        disabled={disabled}
        hint="A lead time a lag can't carry — “call the cabinet shop”."
      />
    </>
  );
}
