CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_on_account" boolean DEFAULT false NOT NULL,
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
ALTER TABLE "expenses" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_name_unique" ON "payment_methods" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_payment_method_idx" ON "expenses" USING btree ("payment_method_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A fifth enum promoted to a maintained list
-- ---------------------------------------------------------------------------
--
-- The exact precedent is migration 0018, which did this for `project_type`
-- and `lead_source`: every possible member of the old `payment_method` enum
-- is inserted here as a row with a fixed id, and every existing row is
-- repointed at the id for its own value by a literal CASE. The fixed ids
-- match `PAYMENT_METHOD_IDS` in src/db/seed/payment-methods.ts exactly --
-- that file is SQL's single source of truth turned into TypeScript for the
-- demo seed and the tests to point at, and the two must be kept in sync by
-- hand because this file cannot import it.
--
-- This one differs from 0018's pair in carrying a rule, the way
-- `vendor_types.is_subcontractor` does rather than the plain lists
-- `project_types` and `lead_sources` are: `is_on_account` is set here, once,
-- for the one member -- 'account' -- whose whole reason for existing was
-- that the money had not left yet. Every other method settles immediately.
-- Nothing else in this migration writes that column; the application layer
-- offers it only on create, exactly as `vendor_types.is_subcontractor` is.
insert into payment_methods (id, name, is_on_account, sort_order) values
  ('c1a3e000-0000-4a00-9000-000000000001', 'Cash', false, 10),
  ('c1a3e000-0000-4a00-9000-000000000002', 'Debit', false, 20),
  ('c1a3e000-0000-4a00-9000-000000000003', 'Credit card', false, 30),
  ('c1a3e000-0000-4a00-9000-000000000004', 'Cheque', false, 40),
  ('c1a3e000-0000-4a00-9000-000000000005', 'Transfer', false, 50),
  ('c1a3e000-0000-4a00-9000-000000000006', 'On account', true, 60);
--> statement-breakpoint

-- `payment_method` is nullable on `expenses` -- unlike `project_type`, which
-- migration 0018 backfilled under a NOT NULL constraint, an expense with no
-- payment method recorded is a real and common state (a receipt entered
-- before anybody has said how it was paid), so the new column stays nullable
-- too and this WHERE clause is required: a CASE with no ELSE errors the
-- moment it meets a null rather than passing one through.
update expenses set payment_method_id = case payment_method::text
  when 'cash' then 'c1a3e000-0000-4a00-9000-000000000001'
  when 'debit' then 'c1a3e000-0000-4a00-9000-000000000002'
  when 'credit' then 'c1a3e000-0000-4a00-9000-000000000003'
  when 'cheque' then 'c1a3e000-0000-4a00-9000-000000000004'
  when 'etransfer' then 'c1a3e000-0000-4a00-9000-000000000005'
  when 'account' then 'c1a3e000-0000-4a00-9000-000000000006'
end::uuid
where payment_method is not null;
--> statement-breakpoint

-- The CHECK is dropped and re-added around the column swap because it names
-- the column directly (`payment_method is null`, on the mileage shape) -- it
-- cannot survive the rename any other way. Dropped before the column so the
-- DROP COLUMN below is not itself refused by the constraint that still reads
-- the column being removed.
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_kind_shape";--> statement-breakpoint

-- Dropped only after every value it held has a row of its own above, and
-- after the CASE above has read it for the last time. Kept beside
-- `payment_method_id` would be two columns answering one question, which is
-- the drift this change exists to remove.
ALTER TABLE "expenses" DROP COLUMN "payment_method";--> statement-breakpoint

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_kind_shape" CHECK (case kind
          when 'mileage' then
            vendor_id is null
            and receipt_file_id is null
            and payment_method_id is null
            and vendor_tax_number_captured is null
            and tax_total_cents = 0
            and is_billable = false
            and distance_milli is not null
            and rate_per_km_ten_thou is not null
          when 'purchase' then
            distance_milli is null
            and rate_per_km_ten_thou is null
        end);--> statement-breakpoint

-- The enum itself, now unreferenced by any column.
DROP TYPE "public"."payment_method";
--> statement-breakpoint

-- Every new mirrored table needs its updated_at trigger, or its rows would
-- update without moving the sync cursor and would stop mirroring after their
-- first change -- the Phase 1 invariant 0006 records. attach_touch_triggers()
-- reads the catalog rather than a hardcoded list, and tests/db/triggers.test.ts
-- asserts the coverage.
select attach_touch_triggers();
--> statement-breakpoint

-- Audited for the same reason vendor_types, trades, project_types and
-- lead_sources are: this is a taxonomy priced records point at, it gains a
-- row rarely, and a change to one -- especially to the row nobody may
-- rename-and-relabel into meaning something else -- is exactly what an audit
-- question asks about a year later.
do $$
declare t text;
begin
  foreach t in array array['payment_methods'] loop
    execute format('drop trigger if exists audit_%1$s on %1$I', t);
    execute format(
      'create trigger audit_%1$s after insert or update on %1$I
       for each row execute function write_audit_log()', t);
  end loop;
end $$;
