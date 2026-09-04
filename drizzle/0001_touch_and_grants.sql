-- updated_at drives the SharePoint sync cursor. A row updated without it moving
-- would never sync again, so the database maintains it rather than trusting
-- every future code path to remember.
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
--> statement-breakpoint

-- Attached to every table that HAS an updated_at column, read from the catalog
-- rather than from a hardcoded list. A list is the failure this avoids: it
-- drifts silently as tables are added, and the table it forgets is the one
-- that stops syncing.
do $$
declare t text;
begin
  for t in
    select c.table_name
    from information_schema.columns c
    where c.table_schema = 'public' and c.column_name = 'updated_at'
      and c.table_name <> 'settings'
      and c.table_name <> 'document_sequences'
  loop
    execute format('drop trigger if exists touch_%1$s on %1$I', t);
    execute format(
      'create trigger touch_%1$s before update on %1$I
       for each row execute function touch_updated_at()', t);
  end loop;
end $$;
--> statement-breakpoint

-- Time in stage is derived from these rows, never stored: a stored duration is
-- stale the moment the clock moves. Recorded by trigger so a stage change made
-- from a script, a migration or a future code path cannot skip it.
create or replace function record_stage_change() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    insert into stage_history (project_id, from_stage, to_stage, changed_by)
    values (new.id, null, new.stage, new.created_by);
  elsif new.stage is distinct from old.stage then
    insert into stage_history (project_id, from_stage, to_stage, changed_by)
    values (new.id, old.stage, new.stage, new.created_by);
  end if;
  return new;
end;
$$ language plpgsql;
--> statement-breakpoint

drop trigger if exists record_stage_change_ins on projects;
--> statement-breakpoint
create trigger record_stage_change_ins after insert on projects
  for each row execute function record_stage_change();
--> statement-breakpoint
drop trigger if exists record_stage_change_upd on projects;
--> statement-breakpoint
create trigger record_stage_change_upd after update on projects
  for each row execute function record_stage_change();
--> statement-breakpoint

-- The audit log records only the fields that actually changed. Storing whole
-- row snapshots would make the largest table in the database larger still, and
-- reading a diff is what an audit question actually asks for.
create or replace function write_audit_log() returns trigger as $$
declare
  changed jsonb := '{}'::jsonb;
  k text;
  old_row jsonb;
  new_row jsonb;
  actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
begin
  if tg_op = 'INSERT' then
    insert into audit_log (table_name, record_id, action, changed_by, diff)
    values (tg_table_name, new.id, 'insert', coalesce(actor, new.created_by), to_jsonb(new));
    return new;
  end if;

  old_row := to_jsonb(old);
  new_row := to_jsonb(new);
  for k in select jsonb_object_keys(new_row) loop
    -- updated_at moves on every write by trigger, so logging it would make
    -- every diff non-empty and tell the reader nothing.
    if k <> 'updated_at' and new_row -> k is distinct from old_row -> k then
      changed := changed || jsonb_build_object(
        k, jsonb_build_object('from', old_row -> k, 'to', new_row -> k));
    end if;
  end loop;

  if changed = '{}'::jsonb then
    return new;
  end if;

  insert into audit_log (table_name, record_id, action, changed_by, diff)
  values (
    tg_table_name,
    new.id,
    case when new.record_status = 'void' and old.record_status <> 'void'
      then 'void' else 'update' end,
    actor,
    changed
  );
  return new;
end;
$$ language plpgsql;
--> statement-breakpoint

-- Audited where a financial or customer record is at stake. Deliberately not on
-- files, stage_history or the local-only tables: the first is already immutable
-- once written, the second IS a history, and the last three are machine state.
do $$
declare t text;
begin
  foreach t in array array[
    'organization','tax_rates','users','customers','projects','cost_codes',
    'rate_items','scope_templates','scope_template_items',
    'quotes','quote_lines','quote_taxes','quote_clauses'
  ] loop
    execute format('drop trigger if exists audit_%1$s on %1$I', t);
    execute format(
      'create trigger audit_%1$s after insert or update on %1$I
       for each row execute function write_audit_log()', t);
  end loop;
end $$;
--> statement-breakpoint

-- Nothing is ever deleted (spec section 4). Withholding the privilege turns an
-- accidental delete into a permission error instead of a destroyed tax record.
-- The role is NOLOGIN here; production grants it LOGIN with a password, and
-- migrations run as a separate owner role that holds the DDL this one must not.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'quote_app') then
    create role quote_app;
  end if;
end $$;
--> statement-breakpoint

grant usage on schema public to quote_app;
--> statement-breakpoint
grant select, insert, update on all tables in schema public to quote_app;
--> statement-breakpoint
revoke delete, truncate on all tables in schema public from quote_app;
--> statement-breakpoint
grant usage, select on all sequences in schema public to quote_app;
--> statement-breakpoint

-- Without this, a table added by a later migration would silently be
-- unreadable to the application until somebody re-ran the grants by hand.
alter default privileges in schema public
  grant select, insert, update on tables to quote_app;
--> statement-breakpoint
alter default privileges in schema public
  revoke delete on tables from quote_app;
