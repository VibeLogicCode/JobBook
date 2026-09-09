-- ---------------------------------------------------------------------------
-- The three columns that had to land in the FIRST migration
-- ---------------------------------------------------------------------------
--
-- HAND-WRITTEN, replacing what drizzle-kit generated, which was wrong twice
-- and would have failed on any database with rows in it:
--
--   1. It emitted `ADD COLUMN "company_id" uuid NOT NULL` with no default and
--      no backfill. That is rejected outright by Postgres the moment the table
--      is non-empty, which is every existing installation.
--   2. It emitted the new PRIMARY KEY on `document_sequences` BEFORE the
--      `company_id` column the key names.
--
-- So each column is added nullable, backfilled, and only then constrained --
-- the order that works on a database with history and on an empty one alike.
--
-- WHY ALL THREE ARE HERE AND NOT LATER. Adding a second company must never
-- require a migration on live data, and that is true only if these hold from
-- the moment companies exist at all. Every job, rate and series that existed
-- before this migration belonged to company one, because company one is the
-- only company that has ever existed -- so they are correctly stamped now, for
-- free. Deferred, the same statements would have to run on the day the owner
-- incorporates, which is the worst possible moment to be migrating anything.

ALTER TABLE "projects" ADD COLUMN "company_id" uuid;--> statement-breakpoint
UPDATE "projects" SET "company_id" = 'c0000001-0000-4a00-9000-000000000001'::uuid
  WHERE "company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "tax_rates" ADD COLUMN "company_id" uuid;--> statement-breakpoint
UPDATE "tax_rates" SET "company_id" = 'c0000001-0000-4a00-9000-000000000001'::uuid
  WHERE "company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "tax_rates" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- `document_sequences` is REKEYED rather than merely extended: the primary key
-- is the series identity, and `allocateDocumentNumber`'s ON CONFLICT targets
-- it by name. Company one keeps its counters exactly where they are and
-- company two starts at 0001; nothing is renumbered, ever.
ALTER TABLE "document_sequences" ADD COLUMN "company_id" uuid;--> statement-breakpoint
UPDATE "document_sequences" SET "company_id" = 'c0000001-0000-4a00-9000-000000000001'::uuid
  WHERE "company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "document_sequences" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_sequences" DROP CONSTRAINT "document_sequences_kind_year_pk";--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_company_id_kind_year_pk"
  PRIMARY KEY("company_id","kind","year");--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- The global unique indexes on `invoice_number` and `project_number` are
-- untouched, so global uniqueness now has to hold BY CONSTRUCTION. Two
-- companies both registering `INV` for the same kind and year would format two
-- documents with identical numbers, and the failure would surface as a unique
-- violation on `customer_invoices` a long way from the cause. Refused here
-- instead.
CREATE UNIQUE INDEX "document_sequences_kind_year_prefix_unique"
  ON "document_sequences" USING btree ("kind","year","prefix");
