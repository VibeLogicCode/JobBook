CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_task_id" uuid NOT NULL,
	"vendor_id" uuid,
	"user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"agreed_amount_cents" bigint,
	"purchase_order_id" uuid,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"removal_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "assignments_one_assignee" CHECK (num_nonnulls(vendor_id, user_id) = 1),
	CONSTRAINT "assignments_not_confirmed_and_declined" CHECK (confirmed_at is null or declined_at is null),
	CONSTRAINT "assignments_agreed_amount_not_negative" CHECK (agreed_amount_cents is null or agreed_amount_cents >= 0),
	CONSTRAINT "assignments_removal_detail_needs_removal" CHECK (removed_at is not null or (removed_by is null and removal_reason is null))
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_schedule_task_id_schedule_tasks_id_fk" FOREIGN KEY ("schedule_task_id") REFERENCES "public"."schedule_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignments_task_idx" ON "assignments" USING btree ("schedule_task_id");--> statement-breakpoint
CREATE INDEX "assignments_vendor_idx" ON "assignments" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "assignments_user_idx" ON "assignments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_one_live_vendor_per_task" ON "assignments" USING btree ("schedule_task_id","vendor_id") WHERE vendor_id is not null and removed_at is null and record_status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_one_live_user_per_task" ON "assignments" USING btree ("schedule_task_id","user_id") WHERE user_id is not null and removed_at is null and record_status = 'active';
--> statement-breakpoint

-- Every new mirrored table needs its updated_at trigger, or its rows would
-- update without moving the sync cursor and would stop mirroring after their
-- first change. attach_touch_triggers() reads the catalog rather than a
-- hardcoded list, because the table a list forgets is the one that silently
-- stops syncing, and tests/db/triggers.test.ts asserts the coverage.
select attach_touch_triggers();
--> statement-breakpoint

-- Deliberately NOT added to write_audit_log's table list, for the reason
-- 0012 gives for schedule_tasks: the audited tables are the ones where a
-- figure or a counterparty on a CUSTOMER-FACING document is at stake. An
-- assignment is a plan about who turns up, edited as often as the schedule it
-- hangs off. What it does carry is its own history on the row -- confirmed_at,
-- declined_at, removed_at with a reason and an actor -- which is the record an
-- audit question about "who was on that task" would actually read, and it is
-- readable without joining the log.
