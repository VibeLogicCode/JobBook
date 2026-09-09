ALTER TABLE "companies" ALTER COLUMN "payment_terms_days" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "payment_terms_days" DROP NOT NULL;