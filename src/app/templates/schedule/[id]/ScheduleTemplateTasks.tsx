import { updateTemplateTask, voidTemplateTask } from '@/app/templates/schedule/actions';
import { conditionPhrase, durationPhrase, waitsOnPhrase } from '@/app/templates/schedule/wording';
import { ActionForm } from '@/components/settings/ActionForm';
import { FieldGrid, type Option, TextField } from '@/components/settings/Fields';
import { type EditableTemplateTask, TemplateTaskFields } from '@/components/schedule/TemplateTaskFields';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { AmountCell, TableWrap } from '@/components/ui/Table';
import { formatQty } from '@/lib/money/format';
import { durationDaysOf, type Scope, type TemplateTask } from '@/lib/schedule/template';

/**
 * The template's tasks, in `sort_order` -- the one table this whole screen is
 * for. A plain server component, unlike the quote template's own
 * `TemplateLines.tsx`: that file is a client component because its Derivation
 * column recomputes against FOUR live measurement inputs, and this table's
 * one extra column (see `SAMPLE_SCOPE` below) recomputes against nothing --
 * the design doc caps it at "one extra column at most" and does not ask for
 * it to be adjustable, so there is no state here to justify shipping this to
 * the browser at all.
 *
 * Per-row editing still opens a `SheetButton`, which is a client component on
 * its OWN -- a server component can render one as a child exactly as
 * `src/app/templates/[id]/page.tsx` already does for "Add a line", passing
 * server-rendered form markup in as children it never re-executes.
 */
export interface TemplateTaskRow {
  id: string;
  name: string;
  tradeId: string | null;
  costCodeId: string | null;
  notes: string | null;
  sortOrder: number;
  isMilestone: boolean;
  durationBaseDays: number;
  durationSource: 'none' | 'area' | 'washrooms' | 'kitchens' | 'bedrooms';
  durationAreaPerDayMilli: bigint | null;
  durationDaysPerUnit: number | null;
  predecessorTaskId: string | null;
  lagDays: number;
  conditionMeasurement: 'washrooms' | 'kitchens' | 'bedrooms' | null;
  conditionRateItemId: string | null;
}

/**
 * Fixed rather than adjustable -- see the docblock above. Chosen round enough
 * to read at a glance and big enough to exercise every one of the seven
 * seeded shapes with a non-zero, non-trivial result.
 */
const SAMPLE_SCOPE: Scope = {
  areaSqftMilli: 1_500_000n,
  washroomCount: 2,
  kitchenCount: 1,
  bedroomCount: 3,
};

function toTemplateTask(row: TemplateTaskRow): TemplateTask {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    isMilestone: row.isMilestone,
    durationBaseDays: row.durationBaseDays,
    durationSource: row.durationSource,
    durationAreaPerDayMilli: row.durationAreaPerDayMilli,
    durationDaysPerUnit: row.durationDaysPerUnit,
    predecessorTaskId: row.predecessorTaskId,
    lagDays: row.lagDays,
    conditionMeasurement: row.conditionMeasurement,
    conditionRateItemId: row.conditionRateItemId,
  };
}

function dayCount(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

export function ScheduleTemplateTasks({
  templateId,
  tasks,
  areaUnit,
  tradeOptions,
  tradeNameById,
  costCodeOptions,
  rateItemOptions,
  rateItemCodeById,
  allowed,
  mayVoid,
  refusal,
}: {
  templateId: string;
  tasks: TemplateTaskRow[];
  areaUnit: string;
  tradeOptions: Option[];
  tradeNameById: ReadonlyMap<string, string>;
  costCodeOptions: Option[];
  rateItemOptions: Option[];
  rateItemCodeById: ReadonlyMap<string, string>;
  /** The role may write, and the template itself is not void. */
  allowed: boolean;
  mayVoid: boolean;
  /** The sentence saying why the role may not write, when it may not. */
  refusal?: string;
}) {
  const nameById = new Map(tasks.map((task) => [task.id, task.name]));

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose t-small text-muted">
        The <span className="font-semibold">At sample scope</span> column is a worked example,
        not a live calculator: {formatQty(SAMPLE_SCOPE.areaSqftMilli)} {areaUnit},{' '}
        {SAMPLE_SCOPE.washroomCount} washrooms, {SAMPLE_SCOPE.kitchenCount} kitchen,{' '}
        {SAMPLE_SCOPE.bedroomCount} bedrooms, every time this screen opens.
      </p>

      <TableWrap minWidth="76rem">
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">Task</th>
            <th role="columnheader" scope="col">Trade</th>
            <th role="columnheader" scope="col">Duration</th>
            <th role="columnheader" scope="col" className="cell-num">
              At sample scope
            </th>
            <th role="columnheader" scope="col">Waits on</th>
            <th role="columnheader" scope="col">Condition</th>
            <th role="columnheader" scope="col">Flags</th>
            <th role="columnheader" scope="col" className="cell-num">
              Order
            </th>
            <th role="columnheader" scope="col">Change</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {tasks.length === 0 ? (
            <tr role="row">
              <td role="cell" data-label="Task" colSpan={9}>
                No tasks yet. Add one from the button above — until then, importing this template
                adds nothing to a job.
              </td>
            </tr>
          ) : null}

          {tasks.map((task) => {
            const conditionKind: EditableTemplateTask['conditionKind'] =
              task.conditionMeasurement !== null
                ? 'measurement'
                : task.conditionRateItemId !== null
                  ? 'rateItem'
                  : 'none';

            const editable: EditableTemplateTask = {
              name: task.name,
              tradeId: task.tradeId,
              costCodeId: task.costCodeId,
              notes: task.notes,
              sortOrder: task.sortOrder,
              isMilestone: task.isMilestone,
              durationBaseDays: task.durationBaseDays,
              durationSource: task.durationSource,
              durationAreaPerDayMilli: task.durationAreaPerDayMilli,
              durationDaysPerUnit: task.durationDaysPerUnit,
              predecessorTaskId: task.predecessorTaskId,
              lagDays: task.lagDays,
              conditionKind,
              conditionMeasurement: task.conditionMeasurement,
              conditionRateItemId: task.conditionRateItemId,
            };

            // Excludes this row's own id, so the picker itself cannot offer a
            // self-dependency. The action still refuses one reached by a
            // hand-made request, via `findPredecessorCycle` -- see
            // `src/app/templates/schedule/actions.ts`.
            const predecessorOptions: Option[] = tasks
              .filter((other) => other.id !== task.id)
              .map((other) => ({ value: other.id, label: other.name }));

            const predecessorName =
              task.predecessorTaskId !== null ? (nameById.get(task.predecessorTaskId) ?? null) : null;
            const sampleDays = durationDaysOf(toTemplateTask(task), SAMPLE_SCOPE);

            return (
              <tr role="row" key={task.id}>
                <td role="cell" data-label="Task">{task.name}</td>
                <td role="cell" data-label="Trade" className="t-small text-muted">
                  {task.tradeId ? (tradeNameById.get(task.tradeId) ?? '—') : '—'}
                </td>
                <td role="cell" data-label="Duration" className="t-small">
                  {durationPhrase(task, areaUnit, formatQty)}
                </td>
                <AmountCell data-label="At sample scope">{dayCount(sampleDays)}</AmountCell>
                <td role="cell" data-label="Waits on" className="t-small text-muted">
                  {waitsOnPhrase(predecessorName, task.lagDays)}
                </td>
                <td role="cell" data-label="Condition" className="t-small">
                  {conditionPhrase(task, rateItemCodeById)}
                </td>
                <td role="cell" data-label="Flags">
                  {task.isMilestone ? (
                    <Pill tone="info">Milestone</Pill>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
                <AmountCell data-label="Order">{task.sortOrder}</AmountCell>
                <td role="cell" data-label="Change">
                  <SheetButton
                    trigger="Change…"
                    label={`Change ${task.name}`}
                    title={`Change ${task.name}`}
                    subtitle={task.tradeId ? tradeNameById.get(task.tradeId) : undefined}
                    discardPrompt="Throw away the changes to this task? Nothing has been saved yet."
                  >
                    <div className="flex flex-col gap-4">
                      <ActionForm
                        action={updateTemplateTask}
                        submitLabel="Save this task"
                        disabled={!allowed}
                        disabledNote={refusal}
                      >
                        <input type="hidden" name="id" value={task.id} />
                        <FieldGrid>
                          <TemplateTaskFields
                            idPrefix={`edit-${task.id}`}
                            task={editable}
                            disabled={!allowed}
                            areaUnit={areaUnit}
                            tradeOptions={tradeOptions}
                            costCodeOptions={costCodeOptions}
                            predecessorOptions={predecessorOptions}
                            rateItemOptions={rateItemOptions}
                          />
                        </FieldGrid>
                      </ActionForm>

                      {/* The database refuses a delete outright, same reason
                          the quote template's own lines do: nothing here is
                          ever hard-deleted. */}
                      <div>
                        <h3 className="t-small font-semibold">Void it</h3>
                        <p className="mb-2 max-w-prose t-small text-subtle">
                          Refused while another task still waits on this one.
                        </p>
                        <ActionForm
                          action={voidTemplateTask}
                          submitLabel="Void this task"
                          destructive
                          disabled={!mayVoid}
                          disabledNote={
                            mayVoid ? undefined : 'Your role does not permit voiding a record.'
                          }
                        >
                          <input type="hidden" name="id" value={task.id} />
                          <input type="hidden" name="scheduleTemplateId" value={templateId} />
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
                    </div>
                  </SheetButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
    </div>
  );
}
