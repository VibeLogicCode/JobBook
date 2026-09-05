CREATE TYPE "public"."schedule_task_status" AS ENUM('not_started', 'in_progress', 'blocked', 'complete');--> statement-breakpoint
CREATE TABLE "schedule_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cost_code_id" uuid,
	"trade" text,
	"planned_start" date NOT NULL,
	"planned_end" date NOT NULL,
	"actual_start" date,
	"actual_end" date,
	"percent_complete_ten_thou" bigint,
	"is_milestone" boolean DEFAULT false NOT NULL,
	"predecessor_task_id" uuid,
	"lag_days" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" "schedule_task_status" DEFAULT 'not_started' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "schedule_tasks_planned_order" CHECK (planned_end >= planned_start),
	CONSTRAINT "schedule_tasks_actual_order" CHECK (actual_end is null or (actual_start is not null and actual_end >= actual_start)),
	CONSTRAINT "schedule_tasks_milestone_is_one_day" CHECK (not is_milestone or planned_end = planned_start),
	CONSTRAINT "schedule_tasks_no_self_dependency" CHECK (predecessor_task_id is null or predecessor_task_id <> id),
	CONSTRAINT "schedule_tasks_lag_needs_predecessor" CHECK (predecessor_task_id is not null or lag_days = 0),
	CONSTRAINT "schedule_tasks_lag_range" CHECK (lag_days >= -365 and lag_days <= 3650),
	CONSTRAINT "schedule_tasks_percent_range" CHECK (percent_complete_ten_thou is null
        or (percent_complete_ten_thou >= 0 and percent_complete_ten_thou <= 10000))
);
--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD CONSTRAINT "schedule_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD CONSTRAINT "schedule_tasks_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD CONSTRAINT "schedule_tasks_predecessor_task_id_schedule_tasks_id_fk" FOREIGN KEY ("predecessor_task_id") REFERENCES "public"."schedule_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_tasks_project_idx" ON "schedule_tasks" USING btree ("project_id","planned_start","sort_order");--> statement-breakpoint
CREATE INDEX "schedule_tasks_predecessor_idx" ON "schedule_tasks" USING btree ("predecessor_task_id");
--> statement-breakpoint

-- Every new mirrored table needs its updated_at trigger, or its rows would
-- update without moving the sync cursor and would stop mirroring after their
-- first change. attach_touch_triggers() reads the catalog rather than a
-- hardcoded list, because the table a list forgets is the one that silently
-- stops syncing, and tests/db/triggers.test.ts asserts the coverage.
select attach_touch_triggers();
--> statement-breakpoint

-- Deliberately NOT added to write_audit_log's table list.
--
-- The audited tables are the ones where a figure or a counterparty is at
-- stake and a silent change is what an audit question asks about. A schedule
-- is a plan: it is edited constantly, one date change writes a row for every
-- task downstream of it, and auditing that would put the largest volume of
-- rows in the log behind the least consequential change in the product. The
-- dates that DO matter -- actual_start and actual_end -- are facts nothing
-- computes, and the reason the planned pair is kept beside them is precisely
-- so the history is readable off the row itself.
--
-- The cycle guard: a task that reaches itself through its own predecessors.
--
-- A loop makes the auto-push walk forever, so it is refused here as well as in
-- the action. The action's version exists to say it in a sentence somebody can
-- act on -- "Framing already waits on Excavation" -- and this one exists
-- because the action's check cannot be the only one: a stale tab can create the
-- other half of a loop between the moment the form was rendered and the moment
-- the button was pressed, and no amount of care in application code closes that
-- window from outside the transaction that does the writing.
--
-- The advisory lock is what actually closes it. Two transactions each adding
-- one leg of a two-task loop cannot see each other's uncommitted rows under
-- read committed, so both would walk a chain that looked fine and both would
-- commit. Taking a lock keyed on the project serialises every write that
-- touches a dependency on one job -- there are tens of tasks on a job, not
-- thousands, so the cost is nothing -- and the second transaction then walks a
-- chain that includes the first one's row. It is a single lock rather than a
-- row-order lock so it cannot deadlock against the row locks the UPDATE
-- statement itself has already taken.
create or replace function refuse_schedule_cycle() returns trigger as $$
declare
  cursor_id uuid := new.predecessor_task_id;
  cursor_project uuid;
  hops int := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.project_id::text, 0));

  -- A predecessor on another job is not a dependency anybody can reason about:
  -- the schedule screen is per project, so the task it waits on would be
  -- invisible on the screen showing the delay it caused.
  select project_id into cursor_project from schedule_tasks where id = new.predecessor_task_id;
  if cursor_project is null then
    raise exception 'schedule_tasks: predecessor % does not exist', new.predecessor_task_id
      using errcode = '23503';
  end if;
  if cursor_project <> new.project_id then
    raise exception 'schedule_tasks: a task may only wait on another task on the same project'
      using errcode = '23514';
  end if;

  while cursor_id is not null loop
    if cursor_id = new.id then
      raise exception 'schedule_tasks: % would wait on itself through its predecessors', new.id
        using errcode = '23514';
    end if;

    hops := hops + 1;
    -- A loop that somehow predates this trigger would spin here rather than
    -- being reported. Bounded well above any real schedule.
    if hops > 5000 then
      raise exception 'schedule_tasks: the predecessor chain from % does not terminate', new.id
        using errcode = '23514';
    end if;

    select predecessor_task_id into cursor_id from schedule_tasks where id = cursor_id;
  end loop;

  return new;
end;
$$ language plpgsql;
--> statement-breakpoint

-- `update of predecessor_task_id` and not a bare update, so the auto-push --
-- which writes planned_start, planned_end and lag_days and never touches the
-- link -- does not walk a chain per row it moves.
drop trigger if exists schedule_tasks_refuse_cycle on schedule_tasks;
--> statement-breakpoint
create trigger schedule_tasks_refuse_cycle
  before insert or update of predecessor_task_id on schedule_tasks
  for each row when (new.predecessor_task_id is not null)
  execute function refuse_schedule_cycle();
