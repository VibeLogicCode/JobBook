import { settingsGroupsFor } from '@/app/settings/nav';
import { deploymentModules } from '@/lib/modules/read';
import { SettingsNav } from '@/components/settings/SettingsNav';
import { PageHeader } from '@/components/ui/PageHeader';

export const dynamic = 'force-dynamic';

/**
 * The settings shell.
 *
 * Every section is its own route segment, so a browser back button, a
 * bookmark, and a link in a support email all address one section rather than
 * a tab index nobody can name.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  // Async now: the menu leaves out the screens that configure parts this
  // deployment has switched off, and that answer lives in the organization row
  // the root layout has already cached.
  const groups = settingsGroupsFor(await deploymentModules());

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        title="Settings"
        description="Everything a customer document says about your company is here."
      />

      <div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
        <div className="sm:w-56 sm:shrink-0">
          <SettingsNav groups={groups} />
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
