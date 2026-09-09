import { Notice } from '@/components/ui/Notice';

/**
 * Shown on the four settings screens that edit fields belonging to a COMPANY
 * rather than to the deployment: identity, contact, financial and documents.
 *
 * ---------------------------------------------------------------------------
 * WHY A NOTICE AND NOT A COMPANY PICKER
 * ---------------------------------------------------------------------------
 *
 * Because a picker here would be a per-company settings UI, which is real work
 * and a real design -- five screens times two companies, with a way to tell
 * which one you are editing at a glance, or the first mis-save puts one
 * corporation's HST number on the other's invoices.
 *
 * Until that exists, `patchOrganization` REFUSES to write these fields when
 * there is more than one company, rather than guessing which one they belong
 * to. That refusal is correct and it is also invisible until somebody has
 * typed into a form. This notice is what stops them typing.
 *
 * `/settings/locale` deliberately does not render it: currency, timezone and
 * area unit are the deployment's, and two companies sharing one office cannot
 * disagree about what day it is.
 */
export function CompanyScopeNotice({ companyCount }: { companyCount: number }) {
  if (companyCount <= 1) return null;

  return (
    <div className="mb-3">
      <Notice tone="warning" title="These fields belong to one company, and there are two">
        <p>
          Every value on this screen prints on a document, so it has to say which company
          issued it — and with more than one company this screen cannot know. Saving here is
          refused rather than applied to a guess.
        </p>
        <p className="mt-2">
          Per-company editing is not built yet. Until it is, a second company&rsquo;s
          letterhead has to be set by whoever maintains the deployment.
        </p>
      </Notice>
    </div>
  );
}
