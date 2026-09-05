import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { OpenGate } from '@/app/setup/state';
import {
  SETUP_STEPS,
  type SetupStepSlug,
  nextSlug,
  previousSlug,
  setupHref,
  stepAt,
  stepIndex,
} from '@/app/setup/steps';
import { StepIndicator } from '@/components/setup/StepIndicator';
import { buttonClass } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

/**
 * One step of the wizard: the indicator beside it, the reason it exists above
 * the fields, and the way forward below them.
 *
 * The two-column shell is the settings layout's, on purpose. This screen and
 * that one edit the same forty fields, and an owner who meets them here in a
 * sequence and returns to them there in sections should recognise the second
 * as the first rearranged, not learn a new page.
 *
 * "Continue" is a LINK, and it appears once the step has been saved. It is not
 * the submit button, and the form does not navigate on success: the sentence
 * confirming what was written -- which timezone the dates are now computed in,
 * which day the tax rate takes effect from -- is the whole reason the actions
 * return a message instead of throwing, and a step that navigated away on
 * success would show it for one frame.
 */
export function StepPanel({
  slug,
  gate,
  children,
}: {
  slug: SetupStepSlug;
  gate: OpenGate;
  children: React.ReactNode;
}) {
  const step = stepAt(slug);
  const index = stepIndex(slug);
  const previous = previousSlug(slug);
  const next = nextSlug(slug);
  const isComplete = gate.completed.has(slug);

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
      <div className="sm:w-56 sm:shrink-0">
        <StepIndicator current={slug} completed={gate.completed} resumeAt={gate.resumeAt} />
      </div>

      <div className="min-w-0 flex-1">
        <Card className="p-4 sm:p-5">
          <p className="t-micro text-subtle">
            STEP {index + 1} OF {SETUP_STEPS.length}
          </p>
          <h2 className="t-heading">{step.title}</h2>
          <p className="mt-1 mb-4 max-w-prose t-small text-muted">{step.why}</p>

          {children}
        </Card>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          {previous ? (
            <Link
              href={setupHref(previous)}
              className={buttonClass('secondary', { size: 'lg', className: 't-small' })}
            >
              <ArrowLeft size={16} aria-hidden />
              {stepAt(previous).title}
            </Link>
          ) : (
            <span />
          )}

          {next ? (
            isComplete ? (
              <Link
                href={setupHref(next)}
                className={buttonClass('primary', { size: 'lg', className: 't-small' })}
              >
                {stepAt(next).title}
                <ArrowRight size={16} aria-hidden />
              </Link>
            ) : (
              <span className="t-small text-subtle">
                Save this step to continue to {stepAt(next).title.toLowerCase()}.
              </span>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
