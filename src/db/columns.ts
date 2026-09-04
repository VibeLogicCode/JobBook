import { bigint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { recordStatusEnum } from '@/db/enums';

/**
 * Columns every mirrored table carries.
 *
 * `updatedAt` drives the SharePoint sync cursor, so a table without it can
 * never be mirrored. `recordStatus` replaces deletion entirely.
 */
export const auditColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  recordStatus: recordStatusEnum('record_status').notNull().default('active'),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedBy: uuid('voided_by'),
  voidReason: text('void_reason'),
};

/**
 * Money, in integer cents.
 *
 * `mode: 'number'` is safe here: a cent value stays far below
 * Number.MAX_SAFE_INTEGER, and it lets the value pass straight to the Money
 * formatter, which takes a number. BigInt is used inside the calculation
 * engine, where the intermediate products genuinely overflow.
 */
export const cents = (name: string) => bigint(name, { mode: 'number' });

/** Quantity, in integer thousandths: 1240.500 sqft is 1240500n. */
export const qty = (name: string) => bigint(name, { mode: 'bigint' });

/** Rate or percent, in integer ten-thousandths: $4.0000 is 40000n, 13% is 1300n. */
export const rate = (name: string) => bigint(name, { mode: 'bigint' });
