CREATE TYPE "public"."counterparty_type" AS ENUM('customer', 'vendor');--> statement-breakpoint
CREATE TYPE "public"."holdback_direction" AS ENUM('receivable', 'payable');--> statement-breakpoint
CREATE TYPE "public"."holdback_entry_kind" AS ENUM('accrual', 'release');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('deposit', 'progress', 'final', 'holdback_release', 'change_order');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'partial', 'paid');--> statement-breakpoint
CREATE TABLE "customer_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"line_group" text DEFAULT '' NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"description" text NOT NULL,
	"calc_mode" "calc_mode" NOT NULL,
	"unit_label" text DEFAULT '' NOT NULL,
	"cost_code_id" uuid,
	"source_quote_line_id" uuid,
	"qty_milli" bigint NOT NULL,
	"unit_price_ten_thou" bigint NOT NULL,
	"line_total_cents" bigint NOT NULL,
	"is_taxable" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "customer_invoice_lines_no_percent_mode" CHECK (calc_mode <> 'percent')
);
--> statement-breakpoint
CREATE TABLE "customer_invoice_taxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"label" text NOT NULL,
	"registration_number" text,
	"rate_ten_thou" bigint NOT NULL,
	"taxable_base_cents" bigint NOT NULL,
	"tax_amount_cents" bigint NOT NULL,
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
CREATE TABLE "customer_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"kind" "invoice_kind" NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date,
	"period_from" date,
	"period_to" date,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"tax_total_cents" bigint DEFAULT 0 NOT NULL,
	"holdback_cents" bigint DEFAULT 0 NOT NULL,
	"holdback_released_cents" bigint DEFAULT 0 NOT NULL,
	"deposit_applied_cents" bigint DEFAULT 0 NOT NULL,
	"taxable_base_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"amount_due_cents" bigint DEFAULT 0 NOT NULL,
	"contract_value_at_invoice_cents" bigint DEFAULT 0 NOT NULL,
	"percent_complete_ten_thou" bigint,
	"previously_billed_cents" bigint DEFAULT 0 NOT NULL,
	"holdback_pct_ten_thou" bigint,
	"tax_deferred_on_holdback" boolean NOT NULL,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "customer_invoices_total_identity" CHECK (total_cents = subtotal_cents - holdback_cents + tax_total_cents),
	CONSTRAINT "customer_invoices_amount_due_identity" CHECK (amount_due_cents = total_cents - deposit_applied_cents),
	CONSTRAINT "customer_invoices_release_bills_no_work" CHECK (kind <> 'holdback_release' or subtotal_cents = 0),
	CONSTRAINT "customer_invoices_release_only_on_release" CHECK (holdback_released_cents = 0 or (kind = 'holdback_release' and holdback_released_cents > 0)),
	CONSTRAINT "customer_invoices_percent_on_progress_only" CHECK ((kind in ('progress', 'final')) = (percent_complete_ten_thou is not null)),
	CONSTRAINT "customer_invoices_percent_in_range" CHECK (percent_complete_ten_thou is null
        or (percent_complete_ten_thou >= 0 and percent_complete_ten_thou <= 10000)),
	CONSTRAINT "customer_invoices_final_bills_in_full" CHECK (kind <> 'final' or percent_complete_ten_thou = 10000)
);
--> statement-breakpoint
CREATE TABLE "holdback_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"direction" "holdback_direction" NOT NULL,
	"counterparty_type" "counterparty_type" NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"entry_kind" "holdback_entry_kind" NOT NULL,
	"invoice_id" uuid,
	"accrued_cents" bigint DEFAULT 0 NOT NULL,
	"released_cents" bigint DEFAULT 0 NOT NULL,
	"release_eligible_date" date,
	"released_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "holdback_ledger_one_event_per_row" CHECK (case entry_kind
          when 'accrual' then released_cents = 0
          when 'release' then accrued_cents = 0 and released_cents >= 0
        end)
);
--> statement-breakpoint
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoice_lines" ADD CONSTRAINT "customer_invoice_lines_source_quote_line_id_quote_lines_id_fk" FOREIGN KEY ("source_quote_line_id") REFERENCES "public"."quote_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoice_taxes" ADD CONSTRAINT "customer_invoice_taxes_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_invoices" ADD CONSTRAINT "customer_invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdback_ledger" ADD CONSTRAINT "holdback_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdback_ledger" ADD CONSTRAINT "holdback_ledger_invoice_id_customer_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."customer_invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_invoice_lines_invoice_idx" ON "customer_invoice_lines" USING btree ("invoice_id","sort_order");--> statement-breakpoint
CREATE INDEX "customer_invoice_taxes_invoice_idx" ON "customer_invoice_taxes" USING btree ("invoice_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_invoices_number_unique" ON "customer_invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "customer_invoices_project_idx" ON "customer_invoices" USING btree ("project_id","issue_date");--> statement-breakpoint
CREATE INDEX "holdback_ledger_project_idx" ON "holdback_ledger" USING btree ("project_id","direction");--> statement-breakpoint
CREATE INDEX "holdback_ledger_invoice_idx" ON "holdback_ledger" USING btree ("invoice_id");
--> statement-breakpoint

-- Every new mirrored table needs its updated_at trigger, or its rows would
-- update without moving the sync cursor and would stop mirroring after their
-- first change. attach_touch_triggers() reads the catalog rather than a
-- hardcoded list, for the reason 0006 records: the table a list forgets is the
-- one that silently stops syncing. A catalog-driven test asserts the coverage.
select attach_touch_triggers();
--> statement-breakpoint

-- An invoice IS the financial record, so every change to one is what an audit
-- question asks about -- the void included. Voiding is how this product
-- reverses an invoice's effect on a job, and the audit row is the only trace
-- that the reversal happened.
do $$
declare t text;
begin
  foreach t in array array[
    'customer_invoices','customer_invoice_lines','customer_invoice_taxes','holdback_ledger'
  ] loop
    execute format('drop trigger if exists audit_%1$s on %1$I', t);
    execute format(
      'create trigger audit_%1$s after insert or update on %1$I
       for each row execute function write_audit_log()', t);
  end loop;
end $$;
