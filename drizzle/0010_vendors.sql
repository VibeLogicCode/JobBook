CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"contact_name" text,
	"email" text,
	"phone" text,
	"address_line1" text,
	"city" text,
	"province" text,
	"postal_code" text,
	"business_number" text,
	"tax_registration_number" text,
	"is_subcontractor" boolean DEFAULT false NOT NULL,
	"trade" text,
	"payment_terms_days" integer,
	"default_cost_code_id" uuid,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "vendors_payment_terms_not_negative" CHECK (payment_terms_days is null or payment_terms_days >= 0)
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_default_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("default_cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_name_unique" ON "vendors" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "vendors_subcontractor_idx" ON "vendors" USING btree ("is_subcontractor","is_active");
--> statement-breakpoint

-- Every new mirrored table needs its updated_at trigger, or its rows would
-- update without moving the sync cursor and would stop mirroring after their
-- first change -- the Phase 1 invariant 0006 records. attach_touch_triggers()
-- reads the catalog rather than a hardcoded list, because the table a list
-- forgets is the one that silently stops syncing, and a catalog-driven test in
-- tests/db/triggers.test.ts asserts the coverage.
select attach_touch_triggers();
--> statement-breakpoint

-- Audited for the two numbers on the row, not for the row itself.
--
-- business_number is what a T5018 slip identifies a subcontractor by, and
-- tax_registration_number is what an input tax credit over $30 is evidenced
-- against. Both are typed once, read years later by somebody reconstructing a
-- filing, and neither has a column that would record a correction. Changing
-- one silently is precisely the kind of change an audit question asks about,
-- and without this there would be no trace it happened. Volume is not a
-- concern: this table gains a row when somebody is hired, not when work is
-- done.
do $$
declare t text;
begin
  foreach t in array array['vendors'] loop
    execute format('drop trigger if exists audit_%1$s on %1$I', t);
    execute format(
      'create trigger audit_%1$s after insert or update on %1$I
       for each row execute function write_audit_log()', t);
  end loop;
end $$;
