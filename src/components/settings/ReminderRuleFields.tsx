import { type Option, SelectField, TextField } from '@/components/settings/Fields';
import {
  KIND_OPTIONS,
  TEMPLATE_FIELDS,
  FIELD_NOTES,
  TRIGGER_LABELS,
  directionOf,
  offsetPhrase,
} from '@/app/settings/reminder-rules/schema';
import type { ReminderTrigger } from '@/lib/reminders/types';

/** The direction the offset controls default to when a rule is opened. */
export const DIRECTION_OPTIONS: Option[] = [
  { value: 'after', label: 'after' },
  { value: 'before', label: 'before' },
];

/** The placeholders this trigger can fill, spelled out rather than listed bare. */
function placeholderHint(trigger: ReminderTrigger) {
  return (
    <>
      A closed set of named fields, not a template language. “{TRIGGER_LABELS[trigger]}” can fill
      in{' '}
      {TEMPLATE_FIELDS[trigger].map((field, index) => (
        <span key={field}>
          {index > 0 ? ', ' : ''}
          <span className="font-semibold">{`{${field}}`}</span> ({FIELD_NOTES[field]})
        </span>
      ))}
      . Anything else is refused when you save.
    </>
  );
}

export interface EditableReminderRule {
  name: string;
  trigger: ReminderTrigger;
  offsetDays: number;
  reminderKind: string;
  titleTemplate: string;
}

/**
 * The five fields a reminder rule keeps regardless of what it watches --
 * `name`, `offsetAmount`, `offsetDirection`, `reminderKind` and
 * `titleTemplate` -- shared by the add sheet and the change sheet for the
 * reason `TemplateLineFields` was.
 *
 * `trigger` and `triggerStage` are NOT here, deliberately, and for two
 * different reasons. `trigger` is fixed once the rule exists -- the change
 * sheet shows it read-only, with a `Reveal` explaining why, rather than a
 * `<select>` this component would have to disable -- so it stays with each
 * caller. `triggerStage` is offered unconditionally when adding, because
 * nothing has been chosen yet to gate it on, and only when `watchesStage`
 * once a rule exists; that presence-or-absence is the caller's to decide, not
 * a difference this component can paper over with a shared prop.
 */
export function ReminderRuleFields({
  idPrefix,
  row,
  disabled,
}: {
  idPrefix: string;
  /** Absent when adding: every field starts at the same defaults a new rule wants. */
  row?: EditableReminderRule;
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
            ? 'What this rule is called on this screen. It is never printed on a reminder.'
            : 'What you will call this rule when you come back to switch it off.'
        }
      />
      <TextField
        idPrefix={idPrefix}
        name="offsetAmount"
        label="How long"
        required
        numeric
        inputMode="numeric"
        maxLength={3}
        defaultValue={row ? String(Math.abs(row.offsetDays)) : '3'}
        disabled={disabled}
        suffix="days"
        hint={
          row
            ? 'Zero means the reminder is due on the day of the event itself.'
            : 'Zero means due the same day. A year is the ceiling.'
        }
      />
      <SelectField
        idPrefix={idPrefix}
        name="offsetDirection"
        label="Before or after"
        required={!row}
        defaultValue={row ? directionOf(row.offsetDays) : 'after'}
        options={DIRECTION_OPTIONS}
        disabled={disabled}
        hint={
          row
            ? `Reads as: ${offsetPhrase(row.offsetDays, row.trigger)}.`
            : 'Before a deadline; after a silence.'
        }
      />
      <SelectField
        idPrefix={idPrefix}
        name="reminderKind"
        label="Kind of reminder"
        required
        defaultValue={row?.reminderKind ?? 'follow_up'}
        options={KIND_OPTIONS}
        disabled={disabled}
        hint={row ? 'Labels it on the list. Does not change when it fires.' : undefined}
      />
      <TextField
        idPrefix={idPrefix}
        name="titleTemplate"
        label="What the reminder says"
        required
        maxLength={200}
        defaultValue={row?.titleTemplate}
        disabled={disabled}
        wide
        hint={
          row
            ? placeholderHint(row.trigger)
            : 'One sentence; which placeholders work depends on the event chosen, above.'
        }
      />
    </>
  );
}
