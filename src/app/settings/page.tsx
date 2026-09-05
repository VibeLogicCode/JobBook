import Link from 'next/link';
import { loadSettings } from '@/app/settings/load';
import { SETTINGS_SECTIONS } from '@/app/settings/nav';
import { Notice } from '@/components/ui/Notice';
import { Section } from '@/components/settings/Section';

export const dynamic = 'force-dynamic';

export default async function SettingsIndexPage() {
  const context = await loadSettings('settings.read');

  return (
    <div className="flex flex-col gap-4">
      {context.org ? null : (
        <Notice tone="negative" title="This deployment has no organization record">
          Until one exists there is nothing for a document to print. Run first-run setup, or
          load the demo tenant, before editing these sections.
        </Notice>
      )}

      {context.actor ? null : <Notice tone="warning">{context.reason}</Notice>}

      <Section
        title={context.org ? context.org.displayName : 'Not set up'}
        description={
          context.actor ? (
            <p>
              Signed in as {context.actor.displayName} ({context.actor.email}), role{' '}
              <span className="font-semibold">{context.actor.role}</span>. What you can change
              below follows from that role, and every action checks it again on the server.
            </p>
          ) : (
            <p>Nothing here can be changed until this request carries an identity.</p>
          )
        }
      >
        <ul className="flex flex-col gap-2">
          {SETTINGS_SECTIONS.map((section) => (
            <li key={section.href}>
              <Link
                href={section.href}
                className="flex min-h-11 flex-col justify-center rounded-control border border-line px-3 py-2 hover:bg-surface-2"
              >
                <span className="font-semibold">{section.label}</span>
                <span className="t-small text-muted">{section.summary}</span>
              </Link>
            </li>
          ))}
          <li>
            {/* Scope templates are their own screen rather than a settings
                section: a template is edited while quoting, not while
                configuring a company. The link is here because this is where
                somebody looks for it. */}
            <Link
              href="/templates"
              className="flex min-h-11 flex-col justify-center rounded-control border border-line px-3 py-2 hover:bg-surface-2"
            >
              <span className="font-semibold">Scope templates</span>
              <span className="t-small text-muted">
                The line sets a quote is generated from, and how each quantity derives.
              </span>
            </Link>
          </li>
        </ul>
      </Section>
    </div>
  );
}
