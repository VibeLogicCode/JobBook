export const dynamic = 'force-dynamic';

/**
 * The first-run shell.
 *
 * Deliberately without the step indicator: a layout cannot see which child
 * segment rendered, so the indicator lives in `StepPanel` beside the fields,
 * where the current step is known. Putting it here would mean either threading
 * the pathname through a client component or rendering a second copy of the
 * step list -- and one node per step is what keeps a query for a step
 * unambiguous.
 */
export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-4 sm:px-6">
      <h1 className="t-title mb-1">Set this deployment up</h1>
      <p className="mb-4 max-w-prose t-small text-muted">
        This runs once. Nothing about your company is built into the product — the names, the
        address, the tax rate, the holdback and the words on every document are all
        configuration, which is why there are nine steps and not a welcome screen. Each one
        saves as you finish it, so a closed laptop costs you the step you were on and nothing
        before it.
      </p>
      {children}
    </div>
  );
}
