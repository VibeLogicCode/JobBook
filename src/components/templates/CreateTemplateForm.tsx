'use client';

import { useState } from 'react';
import { createScheduleTemplate, createTemplate } from '@/app/templates/actions';
import { ActionForm } from '@/components/settings/ActionForm';
import { TemplateHeaderFields } from '@/components/templates/TemplateHeaderFields';

type Kind = 'quote' | 'schedule';

const KIND_OPTIONS: ReadonlyArray<{ value: Kind; label: string; hint: string }> = [
  { value: 'quote', label: 'Quote template', hint: 'Priced lines for a quote.' },
  { value: 'schedule', label: 'Schedule template', hint: 'A task chain for a schedule.' },
];

/**
 * The body of "Create a template": which kind, then the fields for it.
 *
 * Past the kind, the two forms have nothing to disagree about --
 * `scope_templates` and `schedule_templates` share name, project type and
 * description exactly (design spec §4) -- so nothing here toggles a FIELD.
 * What the kind picks is which server action the one form submits to, and
 * which record's page the browser lands on afterward.
 *
 * The smallest client component that can do that: the list page stays a
 * server component, and only this choice -- and the plain state it takes to
 * remember it -- lives in the browser. `key={kind}` on the form remounts it on
 * a switch, so a refusal from one kind's action never lingers under the
 * other's fields.
 */
export function CreateTemplateForm({
  allowed,
  disabledNote,
}: {
  allowed: boolean;
  disabledNote?: string;
}) {
  const [kind, setKind] = useState<Kind>('quote');

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Kind of template" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {KIND_OPTIONS.map((option) => {
          const checked = kind === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => setKind(option.value)}
              className={`min-h-11 rounded-control border px-3 py-2 text-left ${
                checked
                  ? 'border-accent bg-accent-soft text-accent-soft-fg'
                  : 'border-line-strong bg-surface hover:bg-surface-2'
              }`}
            >
              <span className="block t-small font-semibold">{option.label}</span>
              <span className="block t-small text-subtle">{option.hint}</span>
            </button>
          );
        })}
      </div>

      <ActionForm
        key={kind}
        action={kind === 'quote' ? createTemplate : createScheduleTemplate}
        submitLabel={kind === 'quote' ? 'Create quote template' : 'Create schedule template'}
        disabled={!allowed}
        disabledNote={disabledNote}
      >
        <TemplateHeaderFields idPrefix="new-template" disabled={!allowed} />
      </ActionForm>
    </div>
  );
}
