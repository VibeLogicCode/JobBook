import { acknowledgeEnvironmentStep } from '@/app/setup/actions';
import { checkSummary, runEnvironmentChecks } from '@/app/setup/environment';
import { requireOpenSetup } from '@/app/setup/guard';
import { ActionForm } from '@/components/settings/ActionForm';
import { Notice } from '@/components/ui/Notice';
import { EnvironmentReport } from '@/components/setup/EnvironmentReport';
import { StepPanel } from '@/components/setup/StepPanel';

export const dynamic = 'force-dynamic';

/**
 * Step 7. Read-only.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO FIELD ON THIS PAGE, AND THAT IS THE POINT.
 *
 * Every value reported here is an environment variable or a mounted file. Not
 * one of them is collectable, because a form writes to the database, and this
 * database is mirrored to a SharePoint site and dumped hourly to three
 * destinations — a certificate typed into a text box would be in every one of
 * those copies, forever, encrypted with a key held on the same machine.
 *
 * So the page reports, and the fixing happens in a Compose file or a Docker
 * secret. The only thing the button below writes is that the report was read.
 * ---------------------------------------------------------------------------
 */
export default async function EnvironmentStepPage() {
  const gate = await requireOpenSetup('environment');
  const checks = await runEnvironmentChecks();
  const summary = checkSummary(checks);

  return (
    <StepPanel slug="environment" gate={gate}>
      <ActionForm action={acknowledgeEnvironmentStep} submitLabel="I have read this">
        <Notice
          tone={summary.failing > 0 ? 'warning' : 'positive'}
          title={
            summary.failing > 0
              ? `${summary.failing} of these ${summary.failing === 1 ? 'needs' : 'need'} attention`
              : 'Nothing here is failing'
          }
        >
          <p>
            {summary.passing} passing
            {summary.off > 0 ? `, ${summary.off} deliberately switched off` : ''}
            {summary.failing > 0 ? `, ${summary.failing} failing` : ''}. Nothing here is
            collected — every fix is an environment variable or a mounted file.
          </p>
          {summary.failing > 0 ? (
            <p className="mt-2">
              You can finish setup with items still failing — some are decisions you&apos;re
              entitled to make differently. What&apos;s failing stays visible on the dashboard
              until it isn&apos;t.
            </p>
          ) : null}
        </Notice>

        <EnvironmentReport checks={checks} />
      </ActionForm>
    </StepPanel>
  );
}
