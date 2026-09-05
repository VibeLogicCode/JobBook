CREATE TABLE "line_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "line_groups_name_unique" ON "line_groups" USING btree (lower("name"));
--> statement-breakpoint

-- Every new mirrored table needs its updated_at trigger, or its rows would
-- update without moving the sync cursor and would stop mirroring after their
-- first change -- the Phase 1 invariant 0006 records. attach_touch_triggers()
-- reads the catalog rather than a hardcoded list, because the table a list
-- forgets is the one that silently stops syncing, and
-- tests/db/triggers.test.ts asserts the coverage.
select attach_touch_triggers();
--> statement-breakpoint

-- Audited for the same reason trades and vendor_types are (0014): a taxonomy
-- that prints on a customer document, gains a row rarely, and is exactly the
-- kind of change an audit question asks about a year later.
drop trigger if exists audit_line_groups on line_groups;
--> statement-breakpoint
create trigger audit_line_groups after insert or update on line_groups
  for each row execute function write_audit_log();