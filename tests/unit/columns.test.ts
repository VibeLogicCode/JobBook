import { describe, expect, it } from 'vitest';
import { auditColumns } from '@/db/columns';
import { calcModeEnum, quoteStatusEnum, recordStatusEnum } from '@/db/enums';

describe('auditColumns', () => {
  it('carries every column the sync cursor and void model require', () => {
    expect(Object.keys(auditColumns).sort()).toEqual([
      'createdAt',
      'createdBy',
      'recordStatus',
      'updatedAt',
      'voidReason',
      'voidedAt',
      'voidedBy',
    ]);
  });
});

describe('enums', () => {
  it('offers exactly active and void as record statuses', () => {
    expect(recordStatusEnum.enumValues).toEqual(['active', 'void']);
  });

  it('separates how a line calculates from what it is labelled', () => {
    expect(calcModeEnum.enumValues).toEqual(['qty', 'flat', 'percent']);
  });

  it('does not store expiry as a quote status', () => {
    expect(quoteStatusEnum.enumValues).not.toContain('expired');
  });
});
