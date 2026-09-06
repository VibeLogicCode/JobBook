import { permanentRedirect } from 'next/navigation';

/**
 * The billing screen moved to `/projects/[id]/billing` (backlog #5): under
 * `/projects`, the rail's own `startsWith('/projects')` check marks Pipeline
 * current for free, where this address matched no destination at all and
 * left the nav dark on the one screen that turns work into money owed.
 *
 * This stub is what is left at the old address, permanently redirecting --
 * a 308, not a 307 -- because the old address is not coming back: nothing
 * here is a temporary detour, an emailed or bookmarked link to `/billing/…`
 * should keep landing on the same job for as long as anything points at it.
 * Any query string (`?issued=…` from a just-completed invoice) rides along
 * unchanged.
 */
export default async function OldBillingRoute({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const query = await searchParams;

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const one of value) qs.append(key, one);
    } else if (value !== undefined) {
      qs.append(key, value);
    }
  }
  const suffix = qs.toString();

  permanentRedirect(`/projects/${projectId}/billing${suffix ? `?${suffix}` : ''}`);
}
