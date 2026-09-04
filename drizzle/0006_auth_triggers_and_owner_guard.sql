-- Migration 0001 attached the updated_at trigger to every table that had an
-- updated_at column AT THAT MOMENT. `user_identities`, added in 0005, carries
-- one through the shared audit columns and got no trigger -- so its rows would
-- have updated silently without moving the sync cursor, and would have stopped
-- mirroring after their first change.
--
-- The loop becomes a function so that every future migration adding a mirrored
-- table ends with `select attach_touch_triggers();` instead of rediscovering
-- this. A catalog-driven test asserts the coverage, which is what caught it.
create or replace function attach_touch_triggers() returns void as $$
declare t text;
begin
  for t in
    select c.table_name
    from information_schema.columns c
    where c.table_schema = 'public' and c.column_name = 'updated_at'
      and c.table_name not in ('settings', 'document_sequences')
  loop
    execute format('drop trigger if exists touch_%1$s on %1$I', t);
    execute format(
      'create trigger touch_%1$s before update on %1$I
       for each row execute function touch_updated_at()', t);
  end loop;
end;
$$ language plpgsql;
--> statement-breakpoint

select attach_touch_triggers();
--> statement-breakpoint

-- user_identities is a record of which account was linked to which person and
-- when, so a change to it is exactly the kind of thing an audit question asks
-- about. sessions is deliberately NOT audited: it is machine state, it is not
-- mirrored, and a row per sign-in would bury the log it shares.
drop trigger if exists audit_user_identities on user_identities;
--> statement-breakpoint
create trigger audit_user_identities after insert or update on user_identities
  for each row execute function write_audit_log();
--> statement-breakpoint

-- The last active owner cannot be demoted, deactivated, or voided.
--
-- Enforced here as well as in the application because it is the one rule whose
-- failure leaves no way back in through the interface: with no active owner,
-- nobody can grant the role back, and recovery becomes a script run on the box.
-- The application check is advisory -- two concurrent transactions can each see
-- a second owner that the other is removing -- and this is what actually holds.
create or replace function guard_last_owner() returns trigger as $$
declare
  remaining int;
begin
  -- Only a row that IS currently an active owner can be the last one.
  if old.role <> 'owner' or not old.is_active or old.record_status <> 'active' then
    return new;
  end if;

  if new.role = 'owner' and new.is_active and new.record_status = 'active' then
    return new;  -- still an active owner; nothing is being removed
  end if;

  -- FOR UPDATE, so a concurrent transaction removing the other owner blocks
  -- here rather than both reading a count of one and both proceeding.
  select count(*) into remaining
  from (
    select 1 from users
    where id <> old.id and role = 'owner' and is_active and record_status = 'active'
    for update
  ) others;

  if remaining = 0 then
    raise exception
      'this is the last active owner: promote another owner before changing this one';
  end if;

  return new;
end;
$$ language plpgsql;
--> statement-breakpoint

drop trigger if exists guard_last_owner on users;
--> statement-breakpoint
create trigger guard_last_owner before update on users
  for each row execute function guard_last_owner();
