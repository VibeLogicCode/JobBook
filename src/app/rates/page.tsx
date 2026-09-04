import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { costCodes, rateItems } from '@/db/schema';
import { formatBasisPoints, formatRate } from '@/lib/money/format';
import { marginBasisPoints } from '@/lib/money/scale';

export const dynamic = 'force-dynamic';

export default async function RatesPage() {
  const rows = await db
    .select({ item: rateItems, costCode: costCodes.name })
    .from(rateItems)
    .leftJoin(costCodes, eq(rateItems.costCodeId, costCodes.id))
    .where(and(eq(rateItems.recordStatus, 'active')))
    .orderBy(asc(rateItems.sortOrder), asc(rateItems.code));

  return (
    <div className="px-4 py-4 sm:px-6">
      <h1 className="t-title mb-1">Rates</h1>
      <p className="mb-4 max-w-prose t-small text-muted">
        One list per deployment. Editing a rate never moves a quote already
        written — every line snapshots its rates when it is created.
      </p>

      <div className="overflow-x-auto rounded-[6px] border border-line bg-surface">
        <table className="data-table data-table--stack" style={{ minWidth: '48rem' }}>
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col">Code</th>
              <th scope="col">Cost code</th>
              <th scope="col">Unit</th>
              <th scope="col" className="cell-num">Cost</th>
              <th scope="col" className="cell-num">Sell</th>
              <th scope="col" className="cell-num">Margin</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, costCode }) => {
              const margin = marginBasisPoints(item.sellRateTenThou, item.costRateTenThou);
              return (
                <tr key={item.id}>
                  <td data-label="Description">{item.description}</td>
                  <td data-label="Code" className="num t-small text-muted">{item.code}</td>
                  <td data-label="Cost code" className="t-small text-muted">{costCode ?? '—'}</td>
                  <td data-label="Unit" className="t-small text-muted">
                    {item.unitLabel || (item.calcMode === 'percent' ? '%' : '—')}
                  </td>
                  <td data-label="Cost" className="cell-num">{formatRate(item.costRateTenThou)}</td>
                  <td data-label="Sell" className="cell-num">{formatRate(item.sellRateTenThou)}</td>
                  <td
                    data-label="Margin"
                    className={`cell-num ${margin < 0 ? 'text-negative' : ''}`}
                  >
                    {formatBasisPoints(margin)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
