CREATE TABLE "fiscal_cashback_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiscal_receipt_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"fiscal_id" text NOT NULL,
	"provider" text NOT NULL,
	"document" jsonb NOT NULL,
	"raw" jsonb,
	"merchant_voen" text,
	"object_code" text,
	"sector" text NOT NULL,
	"business_type" text NOT NULL,
	"classification_method" text NOT NULL,
	"classification_evidence" jsonb NOT NULL,
	"restaurant_id" uuid,
	"branch_id" uuid,
	"retrieved_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gemini_usage" (
	"day" text PRIMARY KEY NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchant_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voen" text NOT NULL,
	"object_code" text NOT NULL,
	"sector" text NOT NULL,
	"business_type" text NOT NULL,
	"method" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchases" ALTER COLUMN "branch_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "object_code" text;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD COLUMN IF NOT EXISTS "line_no" smallint;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "fiscal_receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "restaurants" ADD COLUMN "voen" text;--> statement-breakpoint
ALTER TABLE "fiscal_cashback_claims" ADD CONSTRAINT "fiscal_cashback_claims_fiscal_receipt_id_fiscal_receipts_id_fk" FOREIGN KEY ("fiscal_receipt_id") REFERENCES "public"."fiscal_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_cashback_claims" ADD CONSTRAINT "fiscal_cashback_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_receipts" ADD CONSTRAINT "fiscal_receipts_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_receipts" ADD CONSTRAINT "fiscal_receipts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_cashback_claims_line_key" ON "fiscal_cashback_claims" USING btree ("fiscal_receipt_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_receipts_identity_key" ON "fiscal_receipts" USING btree ("issuer","fiscal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_classifications_key" ON "merchant_classifications" USING btree ("voen","object_code");--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_fiscal_receipt_id_fiscal_receipts_id_fk" FOREIGN KEY ("fiscal_receipt_id") REFERENCES "public"."fiscal_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branches_object_code_key" ON "branches" USING btree ("object_code") WHERE "branches"."object_code" is not null;--> statement-breakpoint
CREATE INDEX "restaurants_voen_idx" ON "restaurants" USING btree ("voen");