import { CircleSlash, CircleX, Check } from 'lucide-react';
import type { CheckStatus, EnvironmentCheck } from '@/app/setup/environment';
import { TableWrap } from '@/components/ui/Table';

/**
 * The environment report.
 *
 * A data table, stacking to cards below `sm` through the shared
 * `.data-table--stack` classes -- one DOM tree at every width, so a check
 * appears in the document exactly once.
 *
 * Every row carries the same three things: what was looked at, what was found,
 * and what to do about it. The third is the one that matters. An installer
 * reading "SHAREPOINT_CERT_PATH is not set" at eleven at night needs the next
 * action, not the diagnosis, and a check that reports a failure without one is
 * a check that gets ignored.
 */

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: 'Pass',
  fail: 'Fail',
  off: 'Off',
};

const STATUS_TONE: Record<CheckStatus, string> = {
  pass: 'border-positive bg-positive-soft text-positive-soft-fg',
  fail: 'border-negative bg-negative-soft text-negative-soft-fg',
  // Neutral, and neither green nor red. A green tick beside a mirror that is
  // switched off would read as "the mirror works"; a red cross beside a
  // feature the owner deliberately declined teaches him to ignore red.
  off: 'border-line-strong bg-surface-2 text-muted',
};

const STATUS_ICON: Record<CheckStatus, typeof Check> = {
  pass: Check,
  fail: CircleX,
  off: CircleSlash,
};

export function StatusPill({ status }: { status: CheckStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-control border px-2 py-0.5 t-micro ${STATUS_TONE[status]}`}
    >
      <Icon size={12} aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function EnvironmentReport({ checks }: { checks: readonly EnvironmentCheck[] }) {
  return (
    <TableWrap minWidth="44rem">
        <caption className="sr-only">
          Environment checks, each with what was found and what to do about it
        </caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Result</th>
            <th scope="col">What was found</th>
            <th scope="col">What to do</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr key={check.id}>
              <td data-label="Check">
                {check.title}
                <span className="block num t-micro text-subtle">
                  {check.variables.join(' · ')}
                </span>
              </td>
              <td data-label="Result">
                <StatusPill status={check.status} />
              </td>
              <td data-label="What was found" className="t-small">
                {check.detail}
              </td>
              <td data-label="What to do" className="t-small text-muted">
                {check.remedy ?? <span className="text-subtle">Nothing.</span>}
              </td>
            </tr>
          ))}
        </tbody>
    </TableWrap>
  );
}
