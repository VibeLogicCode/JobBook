import { updateTask, voidTask } from '@/app/projects/[id]/schedule/actions';
import { MoveDates } from '@/app/projects/[id]/schedule/MoveDates';
import { STATUS_LABELS, TASK_STATUSES } from '@/app/projects/[id]/schedule/schema';
import { ActionForm } from '@/components/settings/ActionForm';
import {
  FieldGrid,
  type Option,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/settings/Fields';
import { Reveal } from '@/components/ui/Reveal';

/**
 * Editing one scheduled task — the sheet's contents, and the ONE copy of them.
 *
 * This markup used to live inline in `/projects/[id]/schedule/page.tsx`. It was
 * lifted here rather than copied, because the cross-job calendar has to open
 * the SAME editor when a block is tapped, and the owner's requirement is
 * literally that: *"tapping on the task should open it up for editing. acts the
 * same way as a list."*
 *
 * The thing that must not be duplicated is not the fields. It is `MoveDates`.
 * A planned date change can push every task waiting behind it, and the plan
 * calls the preview the single most important interaction in the feature: *a
 * drag that silently shifts nine tasks is how somebody loses a schedule they
 * spent an evening building.* A second editor that wrote dates without the
 * two-press confirmation would not be a duplicate -- it would be a hole, on
 * the screen most likely to tempt somebody into moving a date quickly.
 *
 * So there is one component, hosted two ways: from a `SheetButton` on the job
 * schedule's row, and from a URL-driven `Sheet` on the calendar. What is inside
 * is identical, down to the wording, and neither host knows anything about
 * dates.
 *
 * **Planned dates are not in the "everything else" form on purpose.** They move
 * above, where the consequence is shown first. Adding them here would be the
 * same hole one field lower down.
 */

/** What the editor needs off the row. A `schedule_tasks` select satisfies it. */
export interface EditableTask {
  id: string;
  name: string;
  trade: string | null;
  costCodeId: string | null;
  predecessorTaskId: string | null;
  notes: string | null;
  status: string;
  plannedStart: string;
  plannedEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  isMilestone: boolean;
  recordStatus: string;
  voidReason: string | null;
}

/**
 * The four fields that describe a task rather than schedule it.
 *
 * Shared by adding a task and changing one, which is why they are a component
 * and not a fragment repeated twice: the "Waits on" hint and its `Reveal` are
 * product reasoning, and two copies of them drift the first time somebody
 * improves one.
 */
export function TaskFields({
  idPrefix,
  task,
  disabled,
  costCodeOptions,
  predecessorOptions,
}: {
  idPrefix: string;
  /** Absent when adding: every field renders empty. */
  task?: Pick<EditableTask, 'name' | 'trade' | 'costCodeId' | 'predecessorTaskId'>;
  disabled: boolean;
  costCodeOptions: Option[];
  predecessorOptions: Option[];
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
        hint="What you would call it on the phone — excavation, rough-in, drywall."
      />
      <TextField
        idPrefix={idPrefix}
        name="trade"
        label="Trade"
        maxLength={120}
        defaultValue={task?.trade}
        disabled={disabled}
        hint="Which trade this needs — the subcontractor is named with assignments, not here."
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
      <SelectField
        idPrefix={idPrefix}
        name="predecessorTaskId"
        label="Waits on"
        defaultValue={task?.predecessorTaskId ?? ''}
        options={predecessorOptions}
        blankLabel="Nothing — this date stands on its own"
        disabled={disabled}
        hint="A task that waits on another moves when that one moves."
      />
      <div className="sm:col-span-2">
        <Reveal label="Why a task in the middle might not move">
          A task that waits on nothing never moves on its own — not because it sits between two
          tasks that did, and not because anything looked like it was in the way.
        </Reveal>
      </div>
    </>
  );
}

export function TaskEditor({
  task,
  costCodeOptions,
  predecessorOptions,
  locale,
  allowed,
  mayVoid,
  refusal,
  above,
}: {
  task: EditableTask;
  costCodeOptions: Option[];
  predecessorOptions: Option[];
  /** The tenant's own locale, so the move preview reads in the dates he uses. */
  locale: string;
  /** The role may write, and the job itself is not void. */
  allowed: boolean;
  mayVoid: boolean;
  /** The sentence saying why the role may not write. */
  refusal: string;
  /**
   * Anything the host wants above the editor — the calendar puts the job it
   * belongs to and who is on it there, because a block tapped on a calendar
   * carries no row above it to say which job it came from.
   */
  above?: React.ReactNode;
}) {
  const isVoid = task.recordStatus === 'void';
  const disabled = !allowed || isVoid;
  const disabledNote = isVoid
    ? 'This task is void. A void row is kept as a record and is not edited.'
    : allowed
      ? undefined
      : refusal;

  return (
    <div className="flex flex-col gap-4">
      {above}

      <div>
        <h3 className="t-small font-semibold">Move the dates</h3>
        <p className="mb-2 max-w-prose t-small text-subtle">
          Everything waiting behind this task moves with it, by the same number of days.
        </p>
        {/* Deliberately NOT keyed on the row's dates. The revalidation that
            follows a successful move would change that key, remount the form,
            and take the confirmation message with it -- so the owner would
            press "Move them" and be told nothing. The boxes are already right
            without it: they hold what was submitted, and the sheet mounts
            fresh from the row every time it is opened. */}
        <MoveDates
          taskId={task.id}
          taskName={task.name}
          plannedStart={task.plannedStart}
          plannedEnd={task.plannedEnd}
          isMilestone={task.isMilestone}
          locale={locale}
          disabled={disabled}
          disabledNote={
            isVoid
              ? 'This task is void. Its dates are a record rather than a plan.'
              : allowed
                ? undefined
                : refusal
          }
        />
      </div>

      <div>
        <h3 className="t-small font-semibold">Everything else</h3>
        <p className="mb-2 max-w-prose t-small text-subtle">Planned dates are above, not here.</p>
        <ActionForm
          action={updateTask}
          submitLabel="Save this task"
          disabled={disabled}
          disabledNote={disabledNote}
        >
          <input type="hidden" name="id" value={task.id} />
          <FieldGrid>
            <TaskFields
              idPrefix={`edit-${task.id}`}
              task={task}
              disabled={disabled}
              costCodeOptions={costCodeOptions}
              predecessorOptions={predecessorOptions}
            />
            <SelectField
              idPrefix={`edit-${task.id}`}
              name="status"
              label="Status"
              defaultValue={task.status}
              options={TASK_STATUSES.map((status) => ({
                value: status,
                label: STATUS_LABELS[status],
              }))}
              disabled={disabled}
            />
            <TextField
              idPrefix={`edit-${task.id}`}
              name="actualStart"
              label="Actually started"
              type="date"
              defaultValue={task.actualStart ?? ''}
              disabled={disabled}
              hint="A fact, never computed."
            />
            <TextField
              idPrefix={`edit-${task.id}`}
              name="actualEnd"
              label="Actually finished"
              type="date"
              defaultValue={task.actualEnd ?? ''}
              disabled={disabled}
            />
          </FieldGrid>
          {/* The planned/actual gap this preserves is also the measurement that
              makes the next quote's estimates better. */}
          <Reveal label="Why recording a start changes the schedule">
            Recording a start takes this task out of the auto-push: once work has begun, moving
            its plan would erase the difference between what was planned and what happened.
          </Reveal>
          <TextAreaField
            idPrefix={`edit-${task.id}`}
            name="notes"
            label="Notes"
            rows={2}
            defaultValue={task.notes}
            disabled={disabled}
          />
        </ActionForm>
      </div>

      {isVoid ? (
        <div>
          <h3 className="t-small font-semibold">Voided</h3>
          <p className="max-w-prose t-small text-subtle">
            {task.voidReason ?? 'No reason was recorded.'}
          </p>
        </div>
      ) : (
        <div>
          <h3 className="t-small font-semibold">Void it</h3>
          <p className="mb-2 max-w-prose t-small text-subtle">
            Not for work you decided against — that&rsquo;s a status and a note.
          </p>
          <ActionForm
            action={voidTask}
            submitLabel="Void this task"
            destructive
            disabled={!mayVoid}
            disabledNote={mayVoid ? undefined : 'Your role does not permit voiding a record.'}
          >
            <input type="hidden" name="id" value={task.id} />
            <TextField
              idPrefix={`void-${task.id}`}
              name="reason"
              label="Reason"
              required
              maxLength={300}
              disabled={!mayVoid}
              wide
              hint="Kept on the record permanently."
            />
          </ActionForm>
        </div>
      )}
    </div>
  );
}
