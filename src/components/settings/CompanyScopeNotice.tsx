import Link from 'next/link';
import { Notice } from '@/components/ui/Notice';
import { Pill } from '@/components/ui/Pill';
import type { Company } from '@/lib/company/load';

/**
 * Which company's letterhead a company-scoped settings screen is editing.
 *
 * Rendered by the four screens that edit COMPANY fields -- identity, contact,
 * financial, documents. NOT by `/settings/locale`: currency, timezone and area
 * unit are the deployment's, and two companies sharing one office cannot
 * disagree about what day it is.
 *
 * ---------------------------------------------------------------------------
 * IT RENDERS NOTHING WHILE THERE IS ONE COMPANY
 * ---------------------------------------------------------------------------
 *
 * Not a disabled select with one option and not a heading saying which company
 * this is. A single-company installation has no such concept, and that rule
 * holds everywhere companies appear in this product -- the job picker follows
 * it too.
 *
 * ---------------------------------------------------------------------------
 * LINKS, NOT A SELECT
 * ---------------------------------------------------------------------------
 *
 * Because switching company has to be a NAVIGATION: the form below is filled
 * from the server with one company's values, so changing the selection has to
 * re-render it. A select that only changed a hidden field would leave the
 * builder's address on screen while the form saved to the repair company --
 * the exact mis-save this whole screen exists to prevent.
 *
 * Two companies is the expected case and five would be unusual, so a row of
 * links is both smaller than a select and shows the choice without a click.
 */
export function CompanyScopeNotice({
  companies,
  companyId,
  basePath,
}: {
  companies: Company[];
  /** Null when more than one exists and none is chosen yet. */
  companyId: string | null;
  /** The screen's own path, e.g. `/settings/identity`. */
  basePath: string;
}) {
  if (companies.length <= 1) return null;

  return (
    <div className="mb-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <span className="t-small font-semibold">Editing</span>
        {companies.map((company) => {
          const chosen = company.id === companyId;
          return (
            <Link
              key={company.id}
              href={`${basePath}?company=${company.id}`}
              aria-current={chosen ? 'page' : undefined}
              className="rounded-control hover:underline"
            >
              <Pill tone={chosen ? 'accent' : 'neutral'}>
                {company.documentPrefix
                  ? `${company.displayName} (${company.documentPrefix})`
                  : company.displayName}
              </Pill>
            </Link>
          );
        })}
      </div>

      {companyId === null ? (
        <Notice tone="warning" title="Pick a company first">
          <p>
            Every value on this screen prints on a document, so it has to say which company
            issued it. Choose one above — the form will fill in with its details.
          </p>
        </Notice>
      ) : (
        <p className="t-small text-muted">
          These values print on this company&rsquo;s quotes and invoices only. The other
          company keeps its own.
        </p>
      )}
    </div>
  );
}
