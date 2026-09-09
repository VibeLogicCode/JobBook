-- The contract half of the split: `organization` gives up the thirty-six
-- columns that describe a legal person.
--
-- Run only after every reader was repointed, and the proof that they were is
-- the TYPECHECKER rather than a review: with these columns gone from the
-- Drizzle table, `tsc --noEmit` is clean, so nothing in the application or the
-- suite reads them. That is a stronger guarantee than reading twenty-eight
-- files, which is how the expand-then-contract order earns its extra
-- migration.
--
-- `display_name` is NOT dropped. Three places need a name with no company in
-- hand and no way to get one -- the sign-in heading, which renders before
-- authentication and so has no session and no project; the browser tab title
-- template; and the shell heading. A screen that cannot know which company it
-- is must not be asking, so the deployment keeps a label of its own. It never
-- prints on a document.
--
-- What stays, and why exactly these: `currency`, `locale`, `timezone`,
-- `area_unit` and `mileage_rate_per_km_ten_thou`. Two companies sharing one
-- office cannot disagree about any of them without one of them being wrong --
-- what day it is, what a kilometre costs to drive, what units the area is
-- measured in.
--
-- Nothing is lost: migration 0020 copied every one of these values into
-- `companies` before anything read them there, and 0021 through 0024 have run
-- against that copy since.

ALTER TABLE "organization" DROP COLUMN "legal_name";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "operating_name";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "tagline";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "owner_name";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "owner_title";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "logo_file_id";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "favicon_file_id";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "brand_color";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "address_line1";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "address_line2";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "city";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "province";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "postal_code";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "country";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "phone";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "alt_phone";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "website";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "tax_registration_number";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "tax_registration_label";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "business_number";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "fiscal_year_end_month";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "fiscal_year_end_day";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "tax_filing_frequency";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "tax_deferred_on_holdback";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "default_holdback_pct_ten_thou";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "holdback_label";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "holdback_terms_text";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "holdback_release_days";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "payment_terms_days";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "payment_terms_text";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "insurance_statement";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "target_margin_bp";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "quote_validity_days";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "quote_terms_text";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "document_footer_text";
