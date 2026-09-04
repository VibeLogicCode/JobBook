import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { costCodes, rateItems } from '@/db/schema';
import { AmountCell, TableWrap } from '@/components/ui/Table';
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

      <TableWrap minWidth="48rem">
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
                {/* Rates are ten-thousandths, not cents, so these take the
                    numeric cell but keep their own formatter. */}
                <AmountCell data-label="Cost">{formatRate(item.costRateTenThou)}</AmountCell>
                <AmountCell data-label="Sell">{formatRate(item.sellRateTenThou)}</AmountCell>
                <AmountCell data-label="Margin" className={margin < 0 ? 'text-negative' : ''}>
                  {formatBasisPoints(margin)}
                </AmountCell>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
    </div>
  );
}
