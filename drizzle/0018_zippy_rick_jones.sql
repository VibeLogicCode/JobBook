CREATE TABLE "lead_sources" (
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
CREATE TABLE "project_types" (
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
ALTER TABLE "customers" ADD COLUMN "lead_source_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "project_type_id" uuid;--> statement-breakpoint
ALTER TABLE "scope_templates" ADD COLUMN "project_type_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD COLUMN "project_type_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_sources_name_unique" ON "lead_sources" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "project_types_name_unique" ON "project_types" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_lead_source_id_lead_sources_id_fk" FOREIGN KEY ("lead_source_id") REFERENCES "public"."lead_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_project_type_id_project_types_id_fk" FOREIGN KEY ("project_type_id") REFERENCES "public"."project_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_templates" ADD CONSTRAINT "scope_templates_project_type_id_project_types_id_fk" FOREIGN KEY ("project_type_id") REFERENCES "public"."project_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_project_type_id_project_types_id_fk" FOREIGN KEY ("project_type_id") REFERENCES "public"."project_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_lead_source_idx" ON "customers" USING btree ("lead_source_id");--> statement-breakpoint
CREATE INDEX "projects_project_type_idx" ON "projects" USING btree ("project_type_id");--> statement-breakpoint
CREATE INDEX "scope_templates_project_type_idx" ON "scope_templates" USING btree ("project_type_id");--> statement-breakpoint
CREATE INDEX "schedule_templates_project_type_idx" ON "schedule_templates" USING btree ("project_type_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Two more enums promoted to maintained lists
-- ---------------------------------------------------------------------------
--
-- The exact precedent is migration 0016, which did this for
-- `schedule_tasks.trade`. This one differs in being an ENUM rather than free
-- text: there is no free-text spelling to fold, so instead of 0016's
-- case-insensitive match-or-insert, every possible member of the old
-- `project_type` and `lead_source` enums is inserted here as a row with a
-- fixed id, and every existing row is repointed at the id for its own value by
-- a literal CASE. The fixed ids match `PROJECT_TYPE_IDS` and `LEAD_SOURCE_IDS`
-- in src/db/seed/project-lists.ts exactly -- that file is SQL's single source
-- of truth turned into TypeScript for the demo seed and the tests to point
-- at, and the two must be kept in sync by hand because this file cannot
-- import it.
--
-- Display names are written out rather than derived from the enum member:
-- `commercial_ti` becomes "Commercial TI" and `water_leak` becomes "Water
-- leak", neither of which a naive title-case would produce. `'other'` is
-- seeded as a real row, not dropped -- it is a genuine catch-all a project,
-- scope template or schedule template may still be filed under.
insert into project_types (id, name, sort_order) values
  ('c1a1e000-0000-4a00-9000-000000000001', 'Custom home', 10),
  ('c1a1e000-0000-4a00-9000-000000000002', 'Basement', 20),
  ('c1a1e000-0000-4a00-9000-000000000003', 'Renovation', 30),
  ('c1a1e000-0000-4a00-9000-000000000004', 'Kitchen', 40),
  ('c1a1e000-0000-4a00-9000-000000000005', 'Bathroom', 50),
  ('c1a1e000-0000-4a00-9000-000000000006', 'Addition', 60),
  ('c1a1e000-0000-4a00-9000-000000000007', 'Commercial TI', 70),
  ('c1a1e000-0000-4a00-9000-000000000008', 'Water leak', 80),
  ('c1a1e000-0000-4a00-9000-000000000009', 'Other', 900);
--> statement-breakpoint

insert into lead_sources (id, name, sort_order) values
  ('c1a2e000-0000-4a00-9000-000000000001', 'Phone call', 10),
  ('c1a2e000-0000-4a00-9000-000000000002', 'Email', 20),
  ('c1a2e000-0000-4a00-9000-000000000003', 'Referral', 30),
  ('c1a2e000-0000-4a00-9000-000000000004', 'Website', 40),
  ('c1a2e000-0000-4a00-9000-000000000005', 'Repeat customer', 50),
  ('c1a2e000-0000-4a00-9000-000000000006', 'Other', 900);
--> statement-breakpoint

-- Every project, scope template and schedule template repointed at the row
-- for its own value. `project_type` is NOT NULL on all three tables, so this
-- has to run -- and every row has to match one of the nine arms -- before the
-- new column can take the same constraint below.
update projects set project_type_id = case project_type::text
  when 'custom_home' then 'c1a1e000-0000-4a00-9000-000000000001'
  when 'basement' then 'c1a1e000-0000-4a00-9000-000000000002'
  when 'renovation' then 'c1a1e000-0000-4a00-9000-000000000003'
  when 'kitchen' then 'c1a1e000-0000-4a00-9000-000000000004'
  when 'bathroom' then 'c1a1e000-0000-4a00-9000-000000000005'
  when 'addition' then 'c1a1e000-0000-4a00-9000-000000000006'
  when 'commercial_ti' then 'c1a1e000-0000-4a00-9000-000000000007'
  when 'water_leak' then 'c1a1e000-0000-4a00-9000-000000000008'
  when 'other' then 'c1a1e000-0000-4a00-9000-000000000009'
end::uuid;
--> statement-breakpoint

update scope_templates set project_type_id = case project_type::text
  when 'custom_home' then 'c1a1e000-0000-4a00-9000-000000000001'
  when 'basement' then 'c1a1e000-0000-4a00-9000-000000000002'
  when 'renovation' then 'c1a1e000-0000-4a00-9000-000000000003'
  when 'kitchen' then 'c1a1e000-0000-4a00-9000-000000000004'
  when 'bathroom' then 'c1a1e000-0000-4a00-9000-000000000005'
  when 'addition' then 'c1a1e000-0000-4a00-9000-000000000006'
  when 'commercial_ti' then 'c1a1e000-0000-4a00-9000-000000000007'
  when 'water_leak' then 'c1a1e000-0000-4a00-9000-000000000008'
  when 'other' then 'c1a1e000-0000-4a00-9000-000000000009'
end::uuid;
--> statement-breakpoint

update schedule_templates set project_type_id = case project_type::text
  when 'custom_home' then 'c1a1e000-0000-4a00-9000-000000000001'
  when 'basement' then 'c1a1e000-0000-4a00-9000-000000000002'
  when 'renovation' then 'c1a1e000-0000-4a00-9000-000000000003'
  when 'kitchen' then 'c1a1e000-0000-4a00-9000-000000000004'
  when 'bathroom' then 'c1a1e000-0000-4a00-9000-000000000005'
  when 'addition' then 'c1a1e000-0000-4a00-9000-000000000006'
  when 'commercial_ti' then 'c1a1e000-0000-4a00-9000-000000000007'
  when 'water_leak' then 'c1a1e000-0000-4a00-9000-000000000008'
  when 'other' then 'c1a1e000-0000-4a00-9000-000000000009'
end::uuid;
--> statement-breakpoint

-- `lead_source` is nullable, unlike `project_type` -- a customer who never
-- had one recorded stays null on the new column too, rather than matching a
-- CASE with no ELSE and erroring.
update customers set lead_source_id = case lead_source::text
  when 'call' then 'c1a2e000-0000-4a00-9000-000000000001'
  when 'email' then 'c1a2e000-0000-4a00-9000-000000000002'
  when 'referral' then 'c1a2e000-0000-4a00-9000-000000000003'
  when 'website' then 'c1a2e000-0000-4a00-9000-000000000004'
  when 'repeat' then 'c1a2e000-0000-4a00-9000-000000000005'
  when 'other' then 'c1a2e000-0000-4a00-9000-000000000006'
end::uuid
where lead_source is not null;
--> statement-breakpoint

-- NOT NULL only after the backfill above has given every existing row a
-- value -- adding the constraint first would fail on this populated database
-- while passing on an empty one. `lead_source_id` stays nullable: not knowing
-- how a customer found the company is a real and common state.
ALTER TABLE "projects" ALTER COLUMN "project_type_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scope_templates" ALTER COLUMN "project_type_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_templates" ALTER COLUMN "project_type_id" SET NOT NULL;--> statement-breakpoint

-- Dropped only after every value each held has a row of its own above. Two
-- columns answering one question is the drift this change exists to remove.
ALTER TABLE "projects" DROP COLUMN "project_type";--> statement-breakpoint
ALTER TABLE "scope_templates" DROP COLUMN "project_type";--> statement-breakpoint
ALTER TABLE "schedule_templates" DROP COLUMN "project_type";--> statement-breakpoint
ALTER TABLE "customers" DROP COLUMN "lead_source";--> statement-breakpoint

-- The enums themselves, now unreferenced by any column.
DROP TYPE "public"."project_type";--> statement-breakpoint
DROP TYPE "public"."lead_source";--> statement-breakpoint

-- Every new mirrored table needs its updated_at trigger, or its rows would
-- update without moving the sync cursor and would stop mirroring after their
-- first change -- the Phase 1 invariant 0006 records. attach_touch_triggers()
-- reads the catalog rather than a hardcoded list, and tests/db/triggers.test.ts
-- asserts the coverage.
select attach_touch_triggers();
--> statement-breakpoint

-- Audited for the same reason vendor_types and trades are (migration 0014):
-- these are taxonomies priced, scheduled and filed records point at, they
-- gain a row rarely, and a change to one is exactly what an audit question
-- asks about a year later.
do $$
declare t text;
begin
  foreach t in array array['project_types','lead_sources'] loop
    execute format('drop trigger if exists audit_%1$s on %1$I', t);
    execute format(
      'create trigger audit_%1$s after insert or update on %1$I
       for each row execute function write_audit_log()', t);
  end loop;
end $$;
