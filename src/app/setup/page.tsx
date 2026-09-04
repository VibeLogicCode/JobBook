import { redirect } from 'next/navigation';
import { readSetupGate } from '@/app/setup/state';
import { setupHref } from '@/app/setup/steps';

export const dynamic = 'force-dynamic';

/**
 * `/setup` is not a page: it is the resume point.
 *
 * Whoever arrives here is either starting or coming back, and in both cases
 * the answer is a step. Redirecting rather than rendering a ninth screen keeps
 * one URL per step -- a browser back button, a bookmark and a link in a
 * support email each address the step they were written about.
 */
export default async function SetupIndexPage() {
  const gate = await readSetupGate();

  if (!gate.open) {
    // A finished deployment, or a company this wizard did not create. The
    // application, not a confirmation screen: there is no route by which these
    // forms replace a live tenant's details.
    if (gate.reason === 'unreachable') redirect(setupHref('environment'));
    redirect('/');
  }

  redirect(setupHref(gate.resumeAt));
}
