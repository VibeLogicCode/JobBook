'use client';

import { useActionState, useState } from 'react';
import { Field, FormError, SelectField } from '@/components/detail/Fields';
import type { FormAction } from '@/components/detail/form-state';
import { PROJECT_STAGES, type ProjectStage, stagesOpenTo } from '@/components/detail/labels';

/**
 * Moving a record along its own half of the lifecycle.
 *
 * The options are narrowed by whether a quote has been won, and `won` is never
 * among them: a job exists because a quote was accepted, so winning is
 * something acceptance does, not something a dropdown sets. The same rule is
 * enforced in the action -- this list is a convenience, not the guarantee.
 *
 *
 * A separate control from the edit form, and its own action, because a stage
 * change is an event: a trigger writes a `stage_history` row for every one, and
 * time-in-stage is derived from those rows. A stage moved silently while
 * somebody was correcting a street name would put a day into the wrong stage
 * forever.
 */
export function StageControl({
  action,
  projectId,
  stage,
  lostReason,
  hasAcceptedQuote,
}: {
  action: FormAction;
  projectId: string;
  stage: ProjectStage;
  lostReason: string | null;
  /** Decides which half of the lifecycle this record is in. */
  hasAcceptedQuote: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [next, setNext] = useState<string>(stage);

  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="id" value={projectId} />

      <FormError error={state && !state.ok ? state.error : null} />

      {/* The button sits next to the select at its own width rather than
          filling the panel. Stretched across a wide screen it read as the
          panel's primary surface, and a stage change is a small, frequent
          adjustment. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 sm:max-w-64">
        <SelectField
          label="Stage"
          name="stage"
          required
          value={next}
          onChange={(event) => setNext(event.currentTarget.value)}
          options={stagesOpenTo(hasAcceptedQuote, stage).map((value) => ({
            value,
            label: PROJECT_STAGES[value],
          }))}
        />
        </div>
        <button
          type="submit"
          disabled={pending || next === stage}
          className="min-h-12 rounded-[4px] bg-accent px-4 text-accent-fg hover:bg-accent-hover disabled:opacity-60"
        >
          {pending ? 'Moving…' : 'Change stage'}
        </button>
      </div>

      {/* Why a bid was lost is the only thing that makes a lost opportunity
          useful later, and it is never remembered a week afterwards. */}
      {next === 'lost' ? (
        <Field
          label="Why was it lost?"
          name="lostReason"
          required
          maxLength={300}
          defaultValue={lostReason ?? ''}
        />
      ) : null}

      {/* On hold is where a job goes quiet. Three months on, the difference
          between waiting on a permit, waiting on the customer's financing and
          waiting on an answer somebody owes us is the difference between a
          job to chase and a job to leave alone -- and it is written on the
          history row, so each spell on hold keeps its own reason. */}
      {next === 'on_hold' ? (
        <Field
          label="What is it waiting on?"
          name="holdReason"
          required
          maxLength={300}
          hint="Kept against this hold, so a later one can say something different."
        />
      ) : null}
    </form>
  );
}
