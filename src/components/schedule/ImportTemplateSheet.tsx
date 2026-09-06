'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { applyScheduleTemplate } from '@/app/projects/[id]/schedule/actions';
import {
  LAG_CLAMPED_NOTE,
  dayFormatter,
  initialTickedIds,
  relinkedNote,
  scopeEvidenceOf,
  templateReasonText,
  templateTaskOf,
  waitsOnLabel,
  type ImportTemplateOption,
  type ImportTemplateTaskWire,
  type ScopeEvidenceWire,
} from '@/app/projects/[id]/schedule/schema';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { Sheet } from '@/components/ui/Sheet';
import { TableWrap } from '@/components/ui/Table';
import { conditionOutcome, durationDaysOf, effectiveLink, planFinish, planImport } from '@/lib/schedule/template';

/**
 * "Import from template" -- spec section 7. Tick what applies, and be told the
 * consequences before pressing, following `src/app/quotes/[id]/Acceptance.tsx`.
 *
 * **The engine runs here too, not only on the server.** `planImport`,
 * `effectiveLink`, `conditionOutcome` and `durationDaysOf` are all pure
 * functions from `src/lib/schedule/template.ts`, imported directly into this
 * client component exactly as `Acceptance.tsx` imports `computeQuote` -- the
 * preview on screen and the write the transaction makes are the same
 * arithmetic, run twice on data that happens to agree. The action re-reads
 * everything and recomputes rather than trusting a single date this sheet
 * sends; see the docblock on `applyScheduleTemplate`.
 *
 * Dates rather than a sentence per row (section 7.3): a re-link changes the
 * schedule's length, and that is invisible if the sheet lists only names.
 */
export function ImportTemplateSheet({
  projectId,
  today,
  locale,
  templates,
  tasksByTemplate,
  scopeEvidence,
  allowed,
  disabledNote,
}: {
  projectId: string;
  /** `tenantToday`, never the server's own clock (section 7.2). */
  today: string;
  locale: string;
  templates: ImportTemplateOption[];
  tasksByTemplate: Record<string, ImportTemplateTaskWire[]>;
  scopeEvidence: ScopeEvidenceWire;
  allowed: boolean;
  disabledNote?: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const evidence = useMemo(() => scopeEvidenceOf(scopeEvidence), [scopeEvidence]);
  const day = useMemo(() => dayFormatter(locale), [locale]);

  const [templateId, setTemplateId] = useState<string>(() => templates[0]?.id ?? '');
  const [startDate, setStartDate] = useState(today);
  const [ticked, setTicked] = useState<Set<string>>(() =>
    initialTickedIds(tasksByTemplate[templates[0]?.id ?? ''] ?? [], evidence),
  );

  const tasks = tasksByTemplate[templateId] ?? [];
  const engineTasks = useMemo(() => tasks.map(templateTaskOf), [tasks]);
  const byId = useMemo(() => new Map(engineTasks.map((t) => [t.id, t])), [engineTasks]);
  const planned = useMemo(
    () => planImport(engineTasks, ticked, evidence.scope, startDate),
    [engineTasks, ticked, evidence, startDate],
  );
  const plannedById = useMemo(() => new Map(planned.map((row) => [row.templateTaskId, row])), [planned]);
  const finish = planFinish(planned);
  const selected = templates.find((t) => t.id === templateId) ?? null;

  // Below every Hook, on purpose: React requires the same Hooks in the same
  // order on every render of this instance, and the page never mounts this
  // component at all when there is nothing to import -- see the guard around
  // `<ImportTemplateSheet>` in `page.tsx`. This is the belt this file wears
  // under that braces anyway, so it has to sit after every Hook rather than
  // before the ones below it.
  if (templates.length === 0) return null;

  function selectTemplate(id: string) {
    setTemplateId(id);
    setTicked(initialTickedIds(tasksByTemplate[id] ?? [], evidence));
    setError(null);
  }

  function toggle(id: string) {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function close() {
    setOpen(false);
    setError(null);
  }

  function apply() {
    setError(null);
    startTransition(async () => {
      const result = await applyScheduleTemplate({
        projectId,
        templateId,
        startDate,
        tickedTemplateTaskIds: [...ticked],
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      close();
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Import from template…
      </Button>

      {open ? (
        <Sheet
          label="Import a schedule template into this job"
          title="Import from template"
          subtitle={selected?.name}
          size="xl"
          onClose={close}
          footer={
            <>
              <Button
                size="lg"
                className="flex-1"
                disabled={!allowed || ticked.size === 0}
                pending={pending}
                pendingLabel="Importing…"
                onClick={apply}
              >
                {ticked.size === 0
                  ? 'Tick at least one task'
                  : `Import ${ticked.size} ${ticked.size === 1 ? 'task' : 'tasks'}`}
              </Button>
              <Button variant="secondary" size="lg" onClick={close}>
                Cancel
              </Button>
            </>
          }
        >
          <div className="grid gap-4 pb-2">
            {error ? <Notice tone="negative">{error}</Notice> : null}
            {!allowed && disabledNote ? <Notice tone="warning">{disabledNote}</Notice> : null}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="grid gap-1">
                <span className="t-small text-muted">Template</span>
                <select
                  className="field min-h-12"
                  value={templateId}
                  disabled={!allowed || pending}
                  onChange={(event) => selectTemplate(event.target.value)}
                >
                  {templates.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} — {option.projectTypeName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1">
                <span className="t-small text-muted">Starts</span>
                <input
                  type="date"
                  className="field min-h-12"
                  value={startDate}
                  disabled={!allowed || pending}
                  onChange={(event) => setStartDate(event.target.value)}
                />
              </label>
            </div>

            <TableWrap minWidth="56rem">
              <caption className="sr-only">
                Tasks on {selected?.name ?? 'this template'}, to tick as imported
              </caption>
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Waits on</th>
                  <th scope="col">Start – Finish</th>
                </tr>
              </thead>
              <tbody aria-busy={pending}>
                {tasks.map((row) => {
                  const engineTask = byId.get(row.id)!;
                  const outcome = conditionOutcome(engineTask, evidence);
                  const reason = templateReasonText(outcome, {
                    estimateQuoteNumber: scopeEvidence.estimateQuoteNumber,
                    acceptedQuoteNumbers: scopeEvidence.acceptedQuoteNumbers,
                    conditionRateItemCode: row.conditionRateItemCode,
                  });
                  const link = effectiveLink(engineTask, byId, ticked);
                  const predecessorName =
                    link.predecessorTaskId !== null ? (byId.get(link.predecessorTaskId)?.name ?? null) : null;
                  const isTicked = ticked.has(row.id);
                  const plan = plannedById.get(row.id);
                  const days = durationDaysOf(engineTask, evidence.scope);

                  return (
                    <tr key={row.id} className={isTicked ? '' : 'opacity-60'}>
                      <td data-label="Task">
                        <label className="flex min-h-11 items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-0.5 h-5 w-5 shrink-0"
                            checked={isTicked}
                            disabled={!allowed || pending}
                            onChange={() => toggle(row.id)}
                          />
                          <span className="min-w-0">
                            <span className="block">{row.name}</span>
                            <span className="block t-small text-subtle">
                              {row.tradeName ?? 'No trade recorded'}
                            </span>
                          </span>
                        </label>
                      </td>
                      <td data-label="Duration" className="t-small text-muted">
                        {row.isMilestone ? 'Milestone' : `${days} ${days === 1 ? 'day' : 'days'}`}
                      </td>
                      <td data-label="Waits on" className="t-small text-muted">
                        {predecessorName === null ? (
                          'Nothing'
                        ) : (
                          <>
                            <span className="block">{predecessorName}</span>
                            <span className="block t-small text-subtle">
                              {waitsOnLabel(predecessorName, link.lagDays)}
                            </span>
                          </>
                        )}
                        {isTicked && link.relinked ? (
                          <span className="mt-1 block t-small text-subtle">
                            {relinkedNote(row.name, predecessorName)}
                          </span>
                        ) : null}
                        {isTicked && link.lagClamped ? (
                          <span className="block t-small text-subtle">{LAG_CLAMPED_NOTE}</span>
                        ) : null}
                      </td>
                      <td data-label="Start – Finish" className="t-small">
                        {isTicked && plan ? (
                          <span className="num">
                            {row.isMilestone ? day(plan.start) : `${day(plan.start)} – ${day(plan.end)}`}
                          </span>
                        ) : (
                          <span className="text-subtle">{reason ?? '—'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>

            <p className="flex items-baseline justify-between gap-3 t-small">
              <span className="text-muted">
                {ticked.size} {ticked.size === 1 ? 'task' : 'tasks'} will be added
              </span>
              <span className="num t-heading">{finish ? `Finishes ${day(finish)}` : '—'}</span>
            </p>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
