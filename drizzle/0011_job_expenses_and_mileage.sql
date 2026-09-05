CREATE TYPE "public"."expense_kind" AS ENUM('purchase', 'mileage');--> statement-breakpoint
CREATE TYPE "public"."expense_source" AS ENUM('manual', 'ocr', 'import');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('captured', 'review', 'posted');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'debit', 'credit', 'cheque', 'etransfer', 'account');--> statement-breakpoint
CREATE TABLE "expense_taxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_id" uuid NOT NULL,
	"label" text NOT NULL,
	"registration_number" text,
	"rate_ten_thou" bigint NOT NULL,
	"tax_amount_cents" bigint NOT NULL,
	"is_recoverable" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "expense_kind" DEFAULT 'purchase' NOT NULL,
	"project_id" uuid NOT NULL,
	"vendor_id" uuid,
	"cost_code_id" uuid,
	"expense_date" date NOT NULL,
	"description" text NOT NULL,
	"reference" text,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"tax_total_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"payment_method" "payment_method",
	"receipt_file_id" uuid,
	"vendor_tax_number_captured" text,
	"source" "expense_source" DEFAULT 'manual' NOT NULL,
	"ocr_confidence" numeric,
	"ocr_raw" jsonb,
	"status" "expense_status" DEFAULT 'captured' NOT NULL,
	"is_billable" boolean DEFAULT false NOT NULL,
	"billed_on_invoice_id" uuid,
	"distance_milli" bigint,
	"rate_per_km_ten_thou" bigint,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "expenses_total_identity" CHECK (total_cents = subtotal_cents + tax_total_cents),
	CONSTRAINT "expenses_kind_shape" CHECK (case kind
          when 'mileage' then
            vendor_id is null
            and receipt_file_id is null
            and payment_method is null
            and vendor_tax_number_captured is null
            and tax_total_cents = 0
            and is_billable = false
            and distance_milli is not null
            and rate_per_km_ten_thou is not null
          when 'purchase' then
            distance_milli is null
            and rate_per_km_ten_thou is null
        end),
	CONSTRAINT "expenses_mileage_not_negative" CHECK (kind <> 'mileage' or (distance_milli >= 0 and rate_per_km_ten_thou >= 0)),
	CONSTRAINT "expenses_mileage_cost_identity" CHECK (kind <> 'mileage'
        or subtotal_cents = round(distance_milli::numeric * rate_per_km_ten_thou / 100000)),
	CONSTRAINT "expenses_billed_only_when_billable" CHECK (billed_on_invoice_id is null or is_billable)
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "mileage_rate_per_km_ten_thou" bigint DEFAULT 7200 NOT NULL;--> statement-breakpoint
ALTER TABLE "expense_taxes" ADD CONSTRAINT "expense_taxes_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_receipt_file_id_files_id_fk" FOREIGN KEY ("receipt_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_billed_on_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("billed_on_invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_taxes_expense_idx" ON "expense_taxes" USING btree ("expense_id","sort_order");--> statement-breakpoint
CREATE INDEX "expenses_project_idx" ON "expenses" USING btree ("project_id","expense_date");--> statement-breakpoint
CREATE INDEX "expenses_vendor_idx" ON "expenses" USING btree ("vendor_id","expense_date");--> statement-breakpoint
CREATE INDEX "expenses_cost_code_idx" ON "expenses" USING btree ("cost_code_id");
--> statement-breakpoint

-- Every new mirrored table needs its updated_at trigger, or its rows would
-- update without moving the sync cursor and would stop mirroring after their
-- first change -- the Phase 1 invariant 0006 records. attach_touch_triggers()
-- reads the catalog rather than a hardcoded list, because the table a list
-- forgets is the one that silently stops syncing, and a catalog-driven test in
-- tests/db/triggers.test.ts asserts the coverage.
select attach_touch_triggers();
--> statement-breakpoint

-- An expense IS a tax record. Two things about it are worth an audit row and
-- neither has a column of its own: the amount, which somebody can correct
-- silently after a period is filed, and the recoverable flag, which is the
-- difference between a claimed input tax credit and one that should not have
-- been. The void is recorded too -- voiding is how this product reverses spend
-- against a job, and the audit row is the only trace the reversal happened.
--
-- Volume is the objection, and it is bounded: the log stores only the fields
-- that changed, and a receipt is typed once and rarely touched again.
do $$
declare t text;
begin
  foreach t in array array['expenses','expense_taxes'] loop
    execute format('drop trigger if exists audit_%1$s on %1$I', t);
    execute format(
      'create trigger audit_%1$s after insert or update on %1$I
       for each row execute function write_audit_log()', t);
  end loop;
end $$;
