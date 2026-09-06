CREATE TYPE "public"."condition_measurement" AS ENUM('washrooms', 'kitchens', 'bedrooms');--> statement-breakpoint
CREATE TYPE "public"."duration_source" AS ENUM('none', 'area', 'washrooms', 'kitchens', 'bedrooms');--> statement-breakpoint
CREATE TABLE "schedule_template_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_template_id" uuid NOT NULL,
	"name" text NOT NULL,
	"trade_id" uuid,
	"cost_code_id" uuid,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_milestone" boolean DEFAULT false NOT NULL,
	"duration_base_days" integer DEFAULT 0 NOT NULL,
	"duration_source" "duration_source" DEFAULT 'none' NOT NULL,
	"duration_area_per_day_milli" bigint,
	"duration_days_per_unit" integer,
	"predecessor_task_id" uuid,
	"lag_days" integer DEFAULT 0 NOT NULL,
	"condition_measurement" "condition_measurement",
	"condition_rate_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "schedule_template_tasks_id_template_unique" UNIQUE("id","schedule_template_id"),
	CONSTRAINT "schedule_template_tasks_no_self_dependency" CHECK (predecessor_task_id is null or predecessor_task_id <> id),
	CONSTRAINT "schedule_template_tasks_lag_needs_predecessor" CHECK (predecessor_task_id is not null or lag_days = 0),
	CONSTRAINT "schedule_template_tasks_lag_range" CHECK (lag_days >= -365 and lag_days <= 3650),
	CONSTRAINT "schedule_template_tasks_duration_base_days_range" CHECK (duration_base_days >= 0),
	CONSTRAINT "schedule_template_tasks_duration_source_columns" CHECK ((duration_source = 'area'
          and duration_area_per_day_milli is not null and duration_area_per_day_milli > 0
          and duration_days_per_unit is null)
        or (duration_source in ('washrooms', 'kitchens', 'bedrooms')
          and duration_days_per_unit is not null and duration_days_per_unit > 0
          and duration_area_per_day_milli is null)
        or (duration_source = 'none'
          and duration_area_per_day_milli is null
          and duration_days_per_unit is null)),
	CONSTRAINT "schedule_template_tasks_condition_single" CHECK (num_nonnulls(condition_measurement, condition_rate_item_id) <= 1)
);
--> statement-breakpoint
CREATE TABLE "schedule_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"project_type" "project_type" NOT NULL,
	"description" text,
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
ALTER TABLE "schedule_template_tasks" ADD CONSTRAINT "schedule_template_tasks_schedule_template_id_schedule_templates_id_fk" FOREIGN KEY ("schedule_template_id") REFERENCES "public"."schedule_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_tasks" ADD CONSTRAINT "schedule_template_tasks_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_tasks" ADD CONSTRAINT "schedule_template_tasks_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_tasks" ADD CONSTRAINT "schedule_template_tasks_condition_rate_item_id_rate_items_id_fk" FOREIGN KEY ("condition_rate_item_id") REFERENCES "public"."rate_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_template_tasks" ADD CONSTRAINT "schedule_template_tasks_predecessor_same_template_fk" FOREIGN KEY ("predecessor_task_id","schedule_template_id") REFERENCES "public"."schedule_template_tasks"("id","schedule_template_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_template_tasks_template_idx" ON "schedule_template_tasks" USING btree ("schedule_template_id","sort_order");--> statement-breakpoint
CREATE INDEX "schedule_template_tasks_predecessor_idx" ON "schedule_template_tasks" USING btree ("predecessor_task_id");--> statement-breakpoint
CREATE INDEX "schedule_template_tasks_trade_idx" ON "schedule_template_tasks" USING btree ("trade_id");
--> statement-breakpoint

-- Every new mirrored table needs its updated_at trigger, or its rows would
-- update without moving the sync cursor and would stop mirroring after their
-- first change -- the Phase 1 invariant 0006 records. attach_touch_triggers()
-- reads the catalog rather than a hardcoded list, and tests/db/triggers.test.ts
-- asserts the coverage.
select attach_touch_triggers();
--> statement-breakpoint

-- Audited for the same reason scope_templates and scope_template_items are
-- (migration 0001), and unlike schedule_tasks (migration 0012, deliberately
-- NOT audited). The distinction is volume and consequence, not the word
-- "schedule": schedule_tasks is a live plan edited constantly, where one date
-- change writes a row per downstream task and auditing it would put the
-- largest volume of rows in the log behind the least consequential change in
-- the product. A schedule TEMPLATE is the opposite of that -- config edited
-- rarely, from one screen, by the same person who edits scope_templates -- and
-- it decides what gets imported onto every job of a project type, which is
-- exactly the kind of change an audit question asks about later.
do $$
declare t text;
begin
  foreach t in array array['schedule_templates','schedule_template_tasks'] loop
    execute format('drop trigger if exists audit_%1$s on %1$I', t);
    execute format(
      'create trigger audit_%1$s after insert or update on %1$I
       for each row execute function write_audit_log()', t);
  end loop;
end $$;