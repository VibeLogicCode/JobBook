import Link from 'next/link';
import { Check } from 'lucide-react';
import { SETUP_STEPS, type SetupStepSlug, setupHref, stepIndex } from '@/app/setup/steps';

/**
 * Where the installer is in the sequence, and what is still ahead.
 *
 * Visible rather than implied, because the single question a first-run wizard
 * has to answer is "how much of this is left" -- an owner standing up his own
 * business software at nine at night needs to know whether to keep going or
 * come back tomorrow, and eight unnumbered forms cannot tell him.
 *
 * ONE DOM TREE, reflowed by CSS: a horizontal scroller of chips below `sm`, a
 * vertical list above it -- the ruling the settings nav and the data table
 * both follow. A separate mobile presentation would put every step link in the
 * document twice, which makes a test query for a step ambiguous rather than
 * merely wrong.
 *
 * A finished step is a link; a step still ahead is plain text. Not a disabled
 * link -- there is nothing to disable, because it is not a control. A step
 * cannot be jumped to, since a later one edits a row an earlier one creates.
 */
export function StepIndicator({
  current,
  completed,
  resumeAt,
}: {
  current: SetupStepSlug;
  completed: ReadonlySet<SetupStepSlug>;
  /** The first unfinished step: the furthest point that may be opened. */
  resumeAt: SetupStepSlug;
}) {
  const furthest = stepIndex(resumeAt);

  return (
    <nav aria-label="Setup steps" className="min-w-0">
      <ol className="flex gap-1 overflow-x-auto pb-1 sm:flex-col sm:overflow-x-visible sm:pb-0">
        {SETUP_STEPS.map((step, index) => {
          const isCurrent = step.slug === current;
          const isDone = completed.has(step.slug);
          const reachable = index <= furthest;

          const number = (
            <span
              aria-hidden
              className={`flex size-6 shrink-0 items-center justify-center rounded-full border t-micro ${
                isDone
                  ? 'border-positive bg-positive-soft text-positive-soft-fg'
                  : isCurrent
                    ? 'border-accent bg-accent text-accent-fg'
                    : 'border-line-strong text-subtle'
              }`}
            >
              {isDone ? <Check size={12} /> : index + 1}
            </span>
          );

          const label = <span className="truncate">{step.title}</span>;

          // 44px minimum on every row, at every width: this is a form somebody
          // works through on a tablet on a kitchen table as often as at a desk.
          const shell = `flex min-h-11 items-center gap-2 whitespace-nowrap rounded-[4px] px-3 t-small ${
            isCurrent ? 'bg-accent-soft font-semibold text-accent-soft-fg' : 'text-muted'
          }`;

          return (
            <li key={step.slug} className="shrink-0 sm:shrink">
              {reachable && !isCurrent ? (
                <Link
                  href={setupHref(step.slug)}
                  title={step.summary}
                  className={`${shell} hover:bg-surface-2 hover:text-ink`}
                >
                  {number}
                  {label}
                </Link>
              ) : (
                <span
                  aria-current={isCurrent ? 'step' : undefined}
                  title={step.summary}
                  className={shell}
                >
                  {number}
                  {label}
                  {!reachable ? <span className="sr-only"> (not yet reached)</span> : null}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
