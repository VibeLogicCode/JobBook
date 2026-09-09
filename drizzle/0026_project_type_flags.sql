-- What paperwork a kind of work needs.
--
-- Five flags and a posture tag on `project_types`. Documented in full on
-- `ProjectTypeFlags` in src/lib/posture/types.ts; the short version of why
-- they are on the TYPE rather than on `companies` is that since the 2018
-- amendments the Construction Act's "improvement" includes capital repair and
-- excludes maintenance -- so whether holdback applies is a fact about the
-- work, a leaking tap against a panel swap, not about the company.
--
-- ---------------------------------------------------------------------------
-- THE BACKFILL IS THE WHOLE RISK, AND IT IS `DEFAULT true`
-- ---------------------------------------------------------------------------
--
-- Every one of the nine types migration 0018 created keeps today's behaviour,
-- and `Water leak` and `Other` are included DELIBERATELY. A migration that
-- reasoned "a water leak is maintenance, so holdback off" would change the
-- terms of jobs already signed under that type -- quietly, on documents a
-- customer is holding.
--
-- So the defaults are all-on and no UPDATE runs. Turning any of them off is
-- something a person does on the project-types screen, for new work.
--
-- `posture` defaults to `both`, the value that changes nothing about which
-- types are offered.

ALTER TABLE "project_types" ADD COLUMN "posture" "work_posture" DEFAULT 'both' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_types" ADD COLUMN "holdback" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_types" ADD COLUMN "progress_invoicing" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_types" ADD COLUMN "schedule_template" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_types" ADD COLUMN "construction_act_dates" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_types" ADD COLUMN "scope_inputs" boolean DEFAULT true NOT NULL;
