'use client';

import { useActionState, useState } from 'react';
import { Field, FormError, SelectField } from '@/components/detail/Fields';
import type { FormAction } from '@/components/detail/form-state';
import { PROJECT_STAGES, type ProjectStage } from '@/components/detail/labels';

/**
 * Moving a job along.
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
}: {
  action: FormAction;
  projectId: string;
  stage: ProjectStage;
  lostReason: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [next, setNext] = useState<string>(stage);

  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="id" value={projectId} />

      <FormError error={state && !state.ok ? state.error : null} />

      <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_auto] sm:items-end">
        <SelectField
          label="Stage"
          name="stage"
          required
          value={next}
          onChange={(event) => setNext(event.currentTarget.value)}
          options={Object.entries(PROJECT_STAGES).map(([value, label]) => ({ value, label }))}
        />
        <button
          type="submit"
          disabled={pending || next === stage}
          className="min-h-12 rounded-[4px] bg-accent px-4 text-accent-fg hover:bg-accent-hover disabled:opacity-60"
        >
          {pending ? 'Moving…' : 'Change stage'}
        </button>
      </div>

      {/* Why a job was lost is the only thing that makes a lost job useful
          later, and it is never remembered a week afterwards. */}
      {next === 'lost' ? (
        <Field
          label="Why was it lost?"
          name="lostReason"
          required
          maxLength={300}
          defaultValue={lostReason ?? ''}
        />
      ) : null}
    </form>
  );
}
