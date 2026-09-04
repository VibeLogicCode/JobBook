import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '@/db/columns';
import { entityTypeEnum } from '@/db/enums';

/**
 * Polymorphic attachment table, one row per stored file. Local disk is
 * authoritative; SharePoint holds a copy in a document library.
 *
 * Files are served by id from a UUID filename, never by storagePath. Logo
 * uploads are restricted to PNG and JPEG: an SVG served from the app origin is
 * a cross-site scripting vector.
 *
 * SharePoint identifiers live in sp_item_map, not here.
 */
export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: entityTypeEnum('entity_type').notNull(),
  /**
   * The record this file belongs to, or NULL when it belongs to the tenant
   * itself -- the logo and the favicon.
   *
   * Nullable rather than a sentinel: `organization` has an integer primary key
   * by design, so there is no UUID to point at, and a nil UUID standing for
   * "not really a reference" is a value somebody eventually joins on.
   */
  entityId: uuid('entity_id'),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  storagePath: text('storage_path').notNull(),
  uploadedBy: uuid('uploaded_by'),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  ...auditColumns,
}, (t) => [index('files_entity_idx').on(t.entityType, t.entityId)]);

/**
 * Trigger-populated change log. NOT mirrored to SharePoint: it has no
 * updated_at, it will be the largest table in the database, and it is already
 * in every dump.
 */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tableName: text('table_name').notNull(),
  /**
   * Text, not uuid. The log is polymorphic across every audited table, and
   * `organization` has an integer primary key by design (CHECK id = 1). A uuid
   * column silently could not record the one table where every change is a
   * branding, tax or holdback setting -- the insert failed outright.
   */
  recordId: text('record_id').notNull(),
  action: text('action').notNull(),
  changedBy: uuid('changed_by'),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  diff: jsonb('diff'),
}, (t) => [index('audit_log_record_idx').on(t.tableName, t.recordId)]);

/**
 * Local only. Graph has no upsert by arbitrary key, so the sync cannot ask
 * SharePoint "which item holds this UUID" without a stored mapping; a $filter
 * lookup per row would be one extra round trip per row and would still race.
 */
export const spItemMap = pgTable('sp_item_map', {
  tableName: text('table_name').notNull(),
  /** Text for the same reason as audit_log.record_id: organization.id is an integer. */
  pgId: text('pg_id').notNull(),
  spItemId: text('sp_item_id').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tableName, t.pgId] })]);

/**
 * Local sync bookkeeping. Not mirrored, so it carries no audit columns.
 *
 * The cursor is a keyset pair, not a bare timestamp watermark. A watermark
 * loses rows two ways: a cohort of rows sharing one updated_at is truncated
 * mid-cohort (a forty-line quote syncs lines 1-20 and drops the rest), and a
 * row committed during a run is skipped forever, because now() is transaction
 * START time, so a long transaction's rows carry timestamps earlier than a
 * cursor already advanced past them.
 */
export const syncState = pgTable('sync_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  listName: text('list_name').notNull(),
  cursorUpdatedAt: timestamp('cursor_updated_at', { withTimezone: true }),
  cursorId: uuid('cursor_id'),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  rowsSynced: integer('rows_synced').notNull().default(0),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
}, (t) => [uniqueIndex('sync_state_list_unique').on(t.listName)]);
