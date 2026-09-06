ALTER TABLE "schedule_tasks" ADD COLUMN "trade_id" uuid;--> statement-breakpoint
ALTER TABLE "schedule_tasks" ADD CONSTRAINT "schedule_tasks_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_tasks_trade_idx" ON "schedule_tasks" USING btree ("trade_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The free-text trades already on this table
-- ---------------------------------------------------------------------------
--
-- The exact precedent is migration 0014, which did this for `vendors.trade`.
-- The one thing this migration has to do that 0014 did not is match against a
-- `trades` list that is NOT empty: vendors and crew have been pointing at it
-- for a while, so "Framing" typed on a schedule task has to resolve to the
-- "Framing" a vendor already carries rather than becoming a second row.
--
-- So the existing list is checked FIRST, case-insensitively -- `trades_name_
-- unique` is on lower(name), so that is also the only comparison the database
-- itself would ever refuse a duplicate on. Only a value with no existing match
-- inserts a new row, and values that share a folded spelling with EACH OTHER
-- still collapse to one new row rather than one per task, exactly as 0014's
-- `distinct on` did. Internal whitespace is collapsed and both ends trimmed
-- before any comparison, so "framer", "Framer" and "Framer  " are one trade on
-- either side of the match. Where two tasks share a folded spelling that is
-- new to the list, the row that survives is the one from the oldest task --
-- the surviving spelling is the first one anybody used.
insert into trades (name, sort_order)
select distinct on (lower(btrim(regexp_replace(st.trade, '\s+', ' ', 'g'))))
       btrim(regexp_replace(st.trade, '\s+', ' ', 'g')),
       0
from schedule_tasks st
where st.trade is not null
  and btrim(st.trade) <> ''
  and not exists (
    select 1 from trades t
    where lower(t.name) = lower(btrim(regexp_replace(st.trade, '\s+', ' ', 'g')))
  )
order by lower(btrim(regexp_replace(st.trade, '\s+', ' ', 'g'))), st.created_at;
--> statement-breakpoint

-- Every task repointed at the row for its own value -- the one just inserted
-- above, or one that already existed on `trades` before this migration ran.
update schedule_tasks st
set trade_id = t.id
from trades t
where st.trade is not null
  and btrim(st.trade) <> ''
  and lower(t.name) = lower(btrim(regexp_replace(st.trade, '\s+', ' ', 'g')));
--> statement-breakpoint

-- Dropped only after every value it held has a row of its own above. The
-- column is gone rather than left beside `trade_id` because two columns
-- answering "which trade" is the drift this change exists to remove -- a
-- reader a year from now would have no way to tell which of them the schedule
-- believes.
ALTER TABLE "schedule_tasks" DROP COLUMN "trade";
