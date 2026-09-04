CREATE TYPE "public"."area_unit" AS ENUM('sqft', 'sqm');--> statement-breakpoint
CREATE TYPE "public"."calc_mode" AS ENUM('qty', 'flat', 'percent');--> statement-breakpoint
CREATE TYPE "public"."change_reason" AS ENUM('customer_request', 'site_condition', 'design_change', 'code_requirement', 'error_omission', 'allowance_reconciliation');--> statement-breakpoint
CREATE TYPE "public"."clause_kind" AS ENUM('exclusion', 'assumption');--> statement-breakpoint
CREATE TYPE "public"."contract_type" AS ENUM('lump_sum', 'unit_price', 'cost_plus', 'time_and_material');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('residential', 'commercial');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('organization', 'quote', 'project', 'customer', 'receipt', 'vendor_invoice', 'purchase_order');--> statement-breakpoint
CREATE TYPE "public"."filing_frequency" AS ENUM('annual', 'quarterly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('call', 'email', 'referral', 'website', 'repeat', 'other');--> statement-breakpoint
CREATE TYPE "public"."pricing_display" AS ENUM('detailed', 'group_totals', 'lump_sum');--> statement-breakpoint
CREATE TYPE "public"."project_stage" AS ENUM('lead', 'site_visit', 'quoting', 'quote_sent', 'won', 'lost', 'in_progress', 'complete', 'on_hold');--> statement-breakpoint
CREATE TYPE "public"."project_type" AS ENUM('custom_home', 'basement', 'renovation', 'kitchen', 'bathroom', 'addition', 'commercial_ti', 'water_leak', 'other');--> statement-breakpoint
CREATE TYPE "public"."qty_source" AS ENUM('area', 'washrooms', 'kitchens', 'bedrooms', 'fixed', 'manual');--> statement-breakpoint
CREATE TYPE "public"."quote_kind" AS ENUM('estimate', 'change_order');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'sent', 'accepted', 'declined', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."record_status" AS ENUM('active', 'void');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('owner', 'admin', 'bookkeeper');--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"kind" text NOT NULL,
	"year" integer NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_sequences_kind_year_pk" PRIMARY KEY("kind","year")
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" integer PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"operating_name" text,
	"tagline" text,
	"owner_name" text,
	"owner_title" text,
	"logo_file_id" uuid,
	"favicon_file_id" uuid,
	"brand_color" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"province" text,
	"postal_code" text,
	"country" text,
	"phone" text,
	"alt_phone" text,
	"email" text,
	"website" text,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"locale" text DEFAULT 'en-CA' NOT NULL,
	"timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"area_unit" "area_unit" DEFAULT 'sqft' NOT NULL,
	"tax_registration_number" text,
	"tax_registration_label" text,
	"business_number" text,
	"fiscal_year_end_month" integer,
	"fiscal_year_end_day" integer,
	"tax_filing_frequency" "filing_frequency",
	"tax_deferred_on_holdback" boolean DEFAULT true NOT NULL,
	"default_holdback_pct_ten_thou" bigint,
	"holdback_label" text,
	"holdback_terms_text" text,
	"holdback_release_days" integer DEFAULT 60 NOT NULL,
	"payment_terms_days" integer,
	"payment_terms_text" text,
	"insurance_statement" text,
	"target_margin_bp" integer,
	"quote_validity_days" integer DEFAULT 30 NOT NULL,
	"quote_terms_text" text,
	"document_footer_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "organization_single_row" CHECK ("organization"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"short_label" text,
	"registration_number" text,
	"rate_ten_thou" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"is_compound" boolean DEFAULT false NOT NULL,
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
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "role" NOT NULL,
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
CREATE TABLE "cost_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"category" text,
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
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"company_name" text,
	"email" text,
	"phone" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"province" text,
	"postal_code" text,
	"alt_contact_name" text,
	"alt_contact_email" text,
	"alt_contact_phone" text,
	"customer_type" "customer_type" NOT NULL,
	"lead_source" "lead_source",
	"is_tax_exempt" boolean DEFAULT false NOT NULL,
	"tax_exempt_number" text,
	"tax_exempt_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"project_number" text NOT NULL,
	"name" text NOT NULL,
	"site_address_line1" text,
	"site_city" text,
	"site_province" text,
	"site_postal_code" text,
	"project_type" "project_type" NOT NULL,
	"contract_type" "contract_type",
	"stage" "project_stage" DEFAULT 'lead' NOT NULL,
	"scheduled_start" date,
	"scheduled_end" date,
	"actual_start" date,
	"actual_end" date,
	"substantial_performance_date" date,
	"certificate_published_date" date,
	"lost_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"from_stage" "project_stage",
	"to_stage" "project_stage" NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "rate_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"cost_code_id" uuid,
	"calc_mode" "calc_mode" NOT NULL,
	"unit_label" text NOT NULL,
	"cost_rate_ten_thou" bigint NOT NULL,
	"sell_rate_ten_thou" bigint NOT NULL,
	"is_taxable" boolean DEFAULT true NOT NULL,
	"is_allowance" boolean DEFAULT false NOT NULL,
	"default_qty_milli" bigint,
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
CREATE TABLE "scope_template_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_template_id" uuid NOT NULL,
	"rate_item_id" uuid NOT NULL,
	"qty_source" "qty_source" NOT NULL,
	"qty_multiplier_ten_thou" bigint DEFAULT 10000 NOT NULL,
	"fixed_qty_milli" bigint,
	"is_optional" boolean DEFAULT false NOT NULL,
	"is_allowance" boolean DEFAULT false NOT NULL,
	"line_group" text NOT NULL,
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
CREATE TABLE "scope_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"project_type" "project_type" NOT NULL,
	"description" text,
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
CREATE TABLE "quote_clauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "clause_kind" NOT NULL,
	"text" text NOT NULL,
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
CREATE TABLE "quote_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"line_group" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"calc_mode" "calc_mode" NOT NULL,
	"unit_label" text NOT NULL,
	"rate_item_id" uuid,
	"cost_code_id" uuid,
	"qty_milli" bigint NOT NULL,
	"unit_cost_ten_thou" bigint NOT NULL,
	"unit_price_ten_thou" bigint NOT NULL,
	"line_cost_cents" bigint NOT NULL,
	"line_total_cents" bigint NOT NULL,
	"is_taxable" boolean DEFAULT true NOT NULL,
	"is_allowance" boolean DEFAULT false NOT NULL,
	"is_optional" boolean DEFAULT false NOT NULL,
	"is_included" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "quote_lines_excluded_only_if_optional" CHECK ("quote_lines"."is_optional" or "quote_lines"."is_included")
);
--> statement-breakpoint
CREATE TABLE "quote_taxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
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
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"quote_number" text NOT NULL,
	"kind" "quote_kind" DEFAULT 'estimate' NOT NULL,
	"parent_quote_id" uuid,
	"sequence" integer DEFAULT 1 NOT NULL,
	"reason" "change_reason",
	"schedule_impact_days" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"quote_date" date NOT NULL,
	"valid_until" date NOT NULL,
	"scope_template_id" uuid,
	"area_sqft_milli" bigint,
	"washroom_count" integer,
	"kitchen_count" integer,
	"bedroom_count" integer,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"tax_total_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"total_cost_cents" bigint DEFAULT 0 NOT NULL,
	"margin_bp" integer DEFAULT 0 NOT NULL,
	"holdback_pct_ten_thou" bigint,
	"pricing_display" "pricing_display" DEFAULT 'group_totals' NOT NULL,
	"exclusions_text" text,
	"assumptions_text" text,
	"terms" text,
	"notes" text,
	"internal_notes" text,
	"payment_terms_text" text,
	"accepted_by_name" text,
	"acceptance_file_id" uuid,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"pdf_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_name" text NOT NULL,
	"record_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"diff" jsonb
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_path" text NOT NULL,
	"uploaded_by" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"record_status" "record_status" DEFAULT 'active' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "sp_item_map" (
	"table_name" text NOT NULL,
	"pg_id" uuid NOT NULL,
	"sp_item_id" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sp_item_map_table_name_pg_id_pk" PRIMARY KEY("table_name","pg_id")
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_name" text NOT NULL,
	"cursor_updated_at" timestamp with time zone,
	"cursor_id" uuid,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"rows_synced" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_codes" ADD CONSTRAINT "cost_codes_parent_id_cost_codes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."cost_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_history" ADD CONSTRAINT "stage_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_items" ADD CONSTRAINT "rate_items_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_template_items" ADD CONSTRAINT "scope_template_items_scope_template_id_scope_templates_id_fk" FOREIGN KEY ("scope_template_id") REFERENCES "public"."scope_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_template_items" ADD CONSTRAINT "scope_template_items_rate_item_id_rate_items_id_fk" FOREIGN KEY ("rate_item_id") REFERENCES "public"."rate_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_rate_item_id_rate_items_id_fk" FOREIGN KEY ("rate_item_id") REFERENCES "public"."rate_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_cost_code_id_cost_codes_id_fk" FOREIGN KEY ("cost_code_id") REFERENCES "public"."cost_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_taxes" ADD CONSTRAINT "quote_taxes_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_parent_quote_id_quotes_id_fk" FOREIGN KEY ("parent_quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_scope_template_id_scope_templates_id_fk" FOREIGN KEY ("scope_template_id") REFERENCES "public"."scope_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_codes_code_unique" ON "cost_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_number_unique" ON "projects" USING btree ("project_number");--> statement-breakpoint
CREATE INDEX "stage_history_project_idx" ON "stage_history" USING btree ("project_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_items_code_unique" ON "rate_items" USING btree ("code");--> statement-breakpoint
CREATE INDEX "quote_lines_quote_idx" ON "quote_lines" USING btree ("quote_id","sort_order");--> statement-breakpoint
CREATE INDEX "quote_taxes_quote_idx" ON "quote_taxes" USING btree ("quote_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_project_kind_sequence_version_unique" ON "quotes" USING btree ("project_id","kind","sequence","version");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_one_accepted_per_sequence" ON "quotes" USING btree ("project_id","kind","sequence") WHERE status = 'accepted' and record_status = 'active';--> statement-breakpoint
CREATE INDEX "quotes_number_idx" ON "quotes" USING btree ("quote_number");--> statement-breakpoint
CREATE INDEX "audit_log_record_idx" ON "audit_log" USING btree ("table_name","record_id");--> statement-breakpoint
CREATE INDEX "files_entity_idx" ON "files" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_state_list_unique" ON "sync_state" USING btree ("list_name");