import { redirect } from 'next/navigation';
import { type OpenGate, readSetupGate, stepIsReachable } from '@/app/setup/state';
import { type SetupStepSlug, setupHref } from '@/app/setup/steps';

/**
 * What every page under `/setup` opens with.
 *
 * Two refusals, and each one is a decision:
 *
 * 1. **Setup is closed.** A finished deployment, or a company this wizard did
 *    not create, redirects to the application. Not to a confirmation screen
 *    offering to overwrite -- there is deliberately no route by which these
 *    forms can replace a live tenant's details, because the failure is silent
 *    and total: the owner's own legal name, tax registration and holdback
 *    terms replaced by whatever somebody typed, on documents already in a
 *    customer's inbox. Editing a live company is Settings, one field at a
 *    time, owner role only.
 *
 * 2. **The step is ahead of the resume point.** Sent back to the first
 *    unfinished step rather than rendered, because a later step edits a row an
 *    earlier one has not created yet. A step already finished stays open, so
 *    walking back to correct a typo works.
 *
 * The database being unreachable is neither. It goes to the environment check,
 * which needs no database, collects nothing, and names that exact failure with
 * what to do about it -- a redirect to the application would render a blank
 * dashboard, and a 500 would name nothing.
 */
export async function requireOpenSetup(slug: SetupStepSlug): Promise<OpenGate> {
  const gate = await readSetupGate();

  if (!gate.open) {
    if (gate.reason === 'unreachable' && slug !== 'environment') {
      redirect(setupHref('environment'));
    }
    if (gate.reason === 'unreachable') {
      // The environment step itself. Handed an empty gate so the page renders
      // its report; every check that needs the database reports its own
      // failure rather than borrowing this one.
      return { open: true, org: null, completed: new Set(), resumeAt: 'environment', values: new Map() };
    }
    redirect('/');
  }

  if (!stepIsReachable(gate, slug)) redirect(setupHref(gate.resumeAt));

  return gate;
}
