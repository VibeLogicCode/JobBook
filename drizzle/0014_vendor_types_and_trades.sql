CREATE TABLE "trades" (
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
CREATE TABLE "vendor_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_subcontractor" boolean DEFAULT false NOT NULL,
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
ALTER TABLE "vendors" ADD COLUMN "vendor_type_id" uuid;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "trade_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "trades_name_unique" ON "trades" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_types_name_unique" ON "vendor_types" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_vendor_type_id_vendor_types_id_fk" FOREIGN KEY ("vendor_type_id") REFERENCES "public"."vendor_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendors_vendor_type_idx" ON "vendors" USING btree ("vendor_type_id");--> statement-breakpoint
CREATE INDEX "vendors_trade_idx" ON "vendors" USING btree ("trade_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The free-text trades that are already on the table
-- ---------------------------------------------------------------------------
--
-- `vendors.trade` was a text box, so whatever is in it is what somebody typed
-- on the day a sub was hired. Every distinct value becomes a row in `trades`
-- and every vendor is repointed at the row for its own value. Nothing is
-- dropped and nothing is matched against a shipped list: the list of default
-- trades lives in src/db/seed/vendor-lists.ts and is loaded separately, on
-- conflict do nothing, so a value promoted here keeps the row it got here and
-- the seeded twin is simply never inserted.
--
-- The one thing this DOES merge is case and whitespace: "framer", "Framer" and
-- "Framer  " become one row, because `trades_name_unique` is on lower(name)
-- and because three spellings of one trade is the failure a list exists to
-- fix. The row that survives is the one from the oldest vendor, so the
-- surviving spelling is the first one anybody used.
insert into trades (name, sort_order)
select distinct on (lower(btrim(regexp_replace(v.trade, '\s+', ' ', 'g'))))
       btrim(regexp_replace(v.trade, '\s+', ' ', 'g')),
       0
from vendors v
where v.trade is not null
  and btrim(v.trade) <> ''
order by lower(btrim(regexp_replace(v.trade, '\s+', ' ', 'g'))), v.created_at;
--> statement-breakpoint

update vendors v
set trade_id = t.id
from trades t
where v.trade is not null
  and btrim(v.trade) <> ''
  and lower(t.name) = lower(btrim(regexp_replace(v.trade, '\s+', ' ', 'g')));
--> statement-breakpoint

-- Dropped only after every value it held has a row of its own above. The
-- column is gone rather than left beside `trade_id` because two columns
-- answering one question is the drift this change exists to remove -- a reader
-- a year from now would have no way to tell which of them the screen believes.
ALTER TABLE "vendors" DROP COLUMN "trade";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- is_subcontractor is derived, and this is the only thing that writes it
-- ---------------------------------------------------------------------------
--
-- Three things and nothing else turn on `vendors.is_subcontractor`: who
-- receives a T5018 statement of contract payments, who needs current WSIB
-- clearance before a cheque is written, and who may be assigned to a scheduled
-- task. Paying a sub whose clearance lapsed transfers liability for their
-- premiums to the general contractor, so this is a bill and not a label.
--
-- The owner maintains `vendor_types` freely. What he cannot do is make the
-- rule mean something else by typing, because the flag on a type is chosen
-- once at creation and is never editable, and because the value on a vendor is
-- computed here rather than submitted. A form field, a stale tab, a hand-made
-- POST and a psql session all land on the same answer.
--
-- Rows that predate the list keep whatever the old checkbox left them: with no
-- type there is nothing to derive from, and inventing one would be inventing a
-- tax filing. The form asks for a type the next time such a vendor is saved.
create or replace function derive_vendor_subcontractor() returns trigger as $$
begin
  if new.vendor_type_id is not null then
    select vt.is_subcontractor into new.is_subcontractor
    from vendor_types vt
    where vt.id = new.vendor_type_id;
  end if;
  return new;
end;
$$ language plpgsql;
--> statement-breakpoint

drop trigger if exists derive_vendors_subcontractor on vendors;
--> statement-breakpoint
create trigger derive_vendors_subcontractor before insert or update on vendors
  for each row execute function derive_vendor_subcontractor();
--> statement-breakpoint

-- Every new mirrored table needs its updated_at trigger, or its rows would
-- update without moving the sync cursor and would stop mirroring after their
-- first change -- the Phase 1 invariant 0006 records. attach_touch_triggers()
-- reads the catalog rather than a hardcoded list, because the table a list
-- forgets is the one that silently stops syncing, and a catalog-driven test in
-- tests/db/triggers.test.ts asserts the coverage.
select attach_touch_triggers();
--> statement-breakpoint

-- Audited for the same reason cost_codes is. These are the taxonomies priced
-- and filed records point at, they gain a row rarely, and one of them decides
-- who the system believes has a tax and insurance obligation -- which is
-- exactly the kind of change an audit question asks about a year later.
do $$
declare t text;
begin
  foreach t in array array['vendor_types','trades'] loop
    execute format('drop trigger if exists audit_%1$s on %1$I', t);
    execute format(
      'create trigger audit_%1$s after insert or update on %1$I
       for each row execute function write_audit_log()', t);
  end loop;
end $$;
