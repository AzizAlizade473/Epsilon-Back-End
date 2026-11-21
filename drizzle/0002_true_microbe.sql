ALTER TABLE "fiscal_receipts" ADD COLUMN "extraction_engine" text DEFAULT 'structured' NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "pos_key_hash" text;