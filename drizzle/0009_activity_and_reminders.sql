CREATE TYPE "public"."activity_kind" AS ENUM('call_in', 'call_out', 'email_in', 'email_out', 'sms', 'site_visit', 'meeting', 'note');--> statement-breakpoint
CREATE TYPE "public"."reminder_kind" AS ENUM('callback', 'follow_up', 'quote_expiring', 'site_visit', 'compliance', 'custom');--> statement-breakpoint
CREATE TYPE "public"."reminder_recurrence" AS ENUM('none', 'daily', 'weekly', 'biweekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('open', 'done', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."reminder_trigger" AS ENUM('quote_sent', 'quote_expiring', 'stage_entered', 'no_activity', 'site_visit_scheduled', 'project_won');--> statement-breakpoint
CREATE TYPE "public"."timeline_entity_type" AS ENUM('customer', 'project', 'quote');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" timeline_entity_type NOT NULL,
	"entity_id" uuid NOT NULL,
	"kind" "activity_kind" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subject" text,
	"body" text,
	"duration_minutes" integer,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "activities_duration_not_negative" CHECK (duration_minutes is null or duration_minutes >= 0)
);
--> statement-breakpoint
CREATE TABLE "reminder_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"trigger" "reminder_trigger" NOT NULL,
	"trigger_stage" "project_stage",
	"offset_days" integer DEFAULT 0 NOT NULL,
	"reminder_kind" "reminder_kind" NOT NULL,
	"title_template" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "reminder_rules_stage_only_on_stage_trigger" CHECK (trigger_stage is null or trigger = 'stage_entered')
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" timeline_entity_type NOT NULL,
	"entity_id" uuid NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"due_at" timestamp with time zone NOT NULL,
	"kind" "reminder_kind" NOT NULL,
	"status" "reminder_status" DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"assigned_to" uuid,
	"snoozed_until" timestamp with time zone,
	"recurrence" "reminder_recurrence" DEFAULT 'none' NOT NULL,
	"recurrence_until" date,
	"generated_by_rule_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "reminders_completed_iff_done" CHECK ((status = 'done') = (completed_at is not null)),
	CONSTRAINT "reminders_recurrence_until_needs_recurrence" CHECK (recurrence <> 'none' or recurrence_until is null)
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_generated_by_rule_id_reminder_rules_id_fk" FOREIGN KEY ("generated_by_rule_id") REFERENCES "public"."reminder_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_timeline_idx" ON "activities" USING btree ("entity_type","entity_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reminder_rules_trigger_idx" ON "reminder_rules" USING btree ("trigger","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_one_open_per_rule" ON "reminders" USING btree ("generated_by_rule_id","entity_type","entity_id") WHERE status = 'open' and record_status = 'active';--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "reminders_entity_idx" ON "reminders" USING btree ("entity_type","entity_id","status");
--> statement-breakpoint

-- Every new mirrored table needs its updated_at trigger, or its rows would
-- update without moving the sync cursor and would stop mirroring after their
-- first change -- the Phase 1 invariant 0006 records. attach_touch_triggers()
-- reads the catalog rather than a hardcoded list, and a catalog-driven test
-- asserts the coverage.
select attach_touch_triggers();
--> statement-breakpoint

-- An activity is the record of what was said to a customer and when, which is
-- exactly what a dispute is reconstructed from, and a rule change alters what
-- the machine does on the owner's behalf while nobody is watching.
--
-- `reminders` is audited for one specific reason: dismissing a reminder is a
-- person deciding not to do something, and unlike completion it has no
-- dedicated columns on the row -- the plan gives the table `completed_at` and
-- `completed_by` and no dismissed pair. Without this trigger nothing would
-- record who dismissed it. The volume is small because the unique partial
-- index above keeps the hourly job from inserting the same reminder twice.
do $$
declare t text;
begin
  foreach t in array array['activities','reminders','reminder_rules'] loop
    execute format('drop trigger if exists audit_%1$s on %1$I', t);
    execute format(
      'create trigger audit_%1$s after insert or update on %1$I
       for each row execute function write_audit_log()', t);
  end loop;
end $$;
