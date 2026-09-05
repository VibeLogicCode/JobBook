import { PageHeader } from '@/components/ui/PageHeader';

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
  // Nothing about the company is built into the product — the names, the
  // address, the tax rate, the holdback and the words on every document are
  // all configuration, which is why there are nine steps and not a welcome
  // screen.
  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        title="Set this deployment up"
        description={
          <>
            This runs once. Each step saves as you finish it — a closed laptop costs you only
            the step you were on.
          </>
        }
      />
      {children}
    </div>
  );
}
