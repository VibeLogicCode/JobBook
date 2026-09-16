import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import { organization } from '@/db/schema';
import { authMode } from '@/lib/auth/mode';
import { configuredProviders } from '@/lib/auth/oidc/providers';

export const dynamic = 'force-dynamic';

const LABELS: Record<string, string> = {
  google: 'Continue with Google',
  microsoft: 'Continue with Microsoft',
  apple: 'Continue with Apple',
};

/**
 * The sign-in page.
 *
 * It names the company, not the product: the person arriving has been told to
 * open their employer's quoting system, and a page branded with something else
 * reads as the wrong address.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; return_to?: string }>;
}) {
  // In access and local mode there is no sign-in surface at all.
  if (authMode() !== 'sso') notFound();

  const { reason, return_to: returnTo } = await searchParams;
  const [org] = await db.select().from(organization).where(eq(organization.id, 1));
  const providers = configuredProviders();

  const query = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '';

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="t-title">{org?.displayName ?? 'Sign in'}</h1>
        <p className="t-small text-muted">Quotes, jobs and documents</p>
      </div>

      {/*
        * `status`, not `alert`. This is server-rendered and present at first
        * paint, and an assertive live region on load either fires before the
        * page settles -- where it is unreliable -- or talks over somebody who
        * is already reading it. Nothing here interrupts: it explains why the
        * sign-in screen appeared.
        */}
      {reason ? (
        <p role="status" className="rounded-panel border border-warning bg-warning-soft px-3 py-2 t-small text-warning-soft-fg">
          {reason}
        </p>
      ) : null}

      {providers.length === 0 ? (
        <p className="rounded-panel card-surface p-4 t-small text-muted">
          No sign-in provider is configured on this installation. An operator sets one in the
          container environment; nothing about it is stored in the database.
        </p>
      ) : (
        <ul className="grid gap-2">
          {providers.map((provider) => (
            <li key={provider}>
              {/* A link, not a form: starting a sign-in changes nothing on the
                  server except a transient cookie. */}
              <a
                href={`/auth/start/${provider}${query}`}
                className="flex min-h-12 items-center justify-center rounded-control border border-line-strong bg-surface px-4 hover:bg-surface-2"
              >
                {LABELS[provider] ?? provider}
              </a>
            </li>
          ))}
        </ul>
      )}

      <p className="t-small text-subtle">
        Accounts are created by an administrator. Signing in does not create one.
      </p>
    </div>
  );
}
