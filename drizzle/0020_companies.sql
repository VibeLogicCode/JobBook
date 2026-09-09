CREATE TYPE "public"."work_posture" AS ENUM('both', 'service', 'contract');--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
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
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"payment_terms_text" text,
	"insurance_statement" text,
	"target_margin_bp" integer,
	"quote_validity_days" integer DEFAULT 30 NOT NULL,
	"quote_terms_text" text,
	"document_footer_text" text,
	"work_posture" "work_posture" DEFAULT 'both' NOT NULL,
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

-- ---------------------------------------------------------------------------
-- The company that existed before companies existed
-- ---------------------------------------------------------------------------
--
-- Copied out of `organization` rather than re-entered, so an installation that
-- has already run setup does not lose its letterhead, its HST registration
-- number or its holdback terms. The fixed id matches FIRST_COMPANY_ID in
-- src/lib/company/ids.ts -- this file cannot import it, so the two must be
-- kept in sync by hand, exactly as migration 0018 and 0019 are with their own
-- seed files.
--
-- `display_name` is copied and NOT moved: `organization` keeps its own as the
-- DEPLOYMENT's label, because the sign-in screen renders before authentication
-- and so has no session, no project and no way to choose between two
-- companies. A screen that cannot know which company it is must not be asking.
--
-- Inserts NOTHING on a database where setup has never run, because
-- `organization` has no row yet. That is correct: the wizard creates the first
-- company on a fresh install. Every backfill below therefore has to tolerate
-- an empty `companies`, and each does -- there are no projects, tax rates or
-- document sequences on such a database either.
insert into companies (
  id, legal_name, display_name, operating_name, tagline,
  owner_name, owner_title, logo_file_id, favicon_file_id, brand_color,
  address_line1, address_line2, city, province, postal_code,
  country, phone, alt_phone, email, website,
  tax_registration_number, tax_registration_label, business_number,
  fiscal_year_end_month, fiscal_year_end_day, tax_filing_frequency,
  tax_deferred_on_holdback, default_holdback_pct_ten_thou, holdback_label,
  holdback_terms_text, holdback_release_days, payment_terms_days,
  payment_terms_text, insurance_statement, target_margin_bp,
  quote_validity_days, quote_terms_text, document_footer_text
)
select
  'c0000001-0000-4a00-9000-000000000001'::uuid,
  o.legal_name, o.display_name, o.operating_name, o.tagline,
  o.owner_name, o.owner_title, o.logo_file_id, o.favicon_file_id, o.brand_color,
  o.address_line1, o.address_line2, o.city, o.province, o.postal_code,
  o.country, o.phone, o.alt_phone, o.email, o.website,
  o.tax_registration_number, o.tax_registration_label, o.business_number,
  o.fiscal_year_end_month, o.fiscal_year_end_day, o.tax_filing_frequency,
  o.tax_deferred_on_holdback, o.default_holdback_pct_ten_thou, o.holdback_label,
  o.holdback_terms_text, o.holdback_release_days, o.payment_terms_days,
  o.payment_terms_text, o.insurance_statement, o.target_margin_bp,
  o.quote_validity_days, o.quote_terms_text, o.document_footer_text
from organization o
where o.id = 1
on conflict (id) do nothing;
--> statement-breakpoint

-- Every new mirrored table needs its updated_at trigger, or its rows would
-- update without moving the sync cursor and would stop mirroring after their
-- first change -- the Phase 1 invariant 0006 records.
select attach_touch_triggers();
--> statement-breakpoint

-- Audited, and this one more than most: these columns ARE the letterhead, the
-- HST registration number and the holdback terms on documents a customer
-- signs and an auditor may ask about years later. "Which company issued this,
-- under which registration number, on what terms" is precisely the question an
-- audit log exists to answer.
do $$
declare t text;
begin
  foreach t in array array['companies'] loop
    execute format('drop trigger if exists audit_%1$s on %1$I', t);
    execute format(
      'create trigger audit_%1$s after insert or update on %1$I
       for each row execute function write_audit_log()', t);
  end loop;
end $$;
