CREATE TABLE "reply_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reply_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_reports_reason_check" CHECK (char_length("reply_reports"."reason") between 1 and 300)
);
--> statement-breakpoint
CREATE TABLE "restaurant_staff" (
	"user_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restaurant_staff_user_id_restaurant_id_pk" PRIMARY KEY("user_id","restaurant_id")
);
--> statement-breakpoint
CREATE TABLE "review_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feedback_id" uuid NOT NULL,
	"restaurant_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"hidden_at" timestamp (3) with time zone,
	CONSTRAINT "review_replies_body_check" CHECK (char_length("review_replies"."body") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "scan_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"at" timestamp (3) with time zone NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"retryable" boolean NOT NULL,
	"fiscal_document" text,
	"receipt_id" uuid,
	"restaurant_name" text
);
--> statement-breakpoint
ALTER TABLE "reply_reports" ADD CONSTRAINT "reply_reports_reply_id_review_replies_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."review_replies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_reports" ADD CONSTRAINT "reply_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_staff" ADD CONSTRAINT "restaurant_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_staff" ADD CONSTRAINT "restaurant_staff_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_attempts" ADD CONSTRAINT "scan_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_attempts" ADD CONSTRAINT "scan_attempts_receipt_id_purchases_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reply_reports_reply_reporter_key" ON "reply_reports" USING btree ("reply_id","reporter_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_replies_feedback_key" ON "review_replies" USING btree ("feedback_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_attempts_user_subject_key" ON "scan_attempts" USING btree ("user_id","subject");--> statement-breakpoint
CREATE INDEX "scan_attempts_user_at_idx" ON "scan_attempts" USING btree ("user_id","at");--> statement-breakpoint
-- Databases that already have the admin read-only role (src/db/admin-readonly-role.sql): the
-- dashboard reads replies, reports and staff, never customers' scanned codes.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'epsilon_admin_ro') THEN
    REVOKE ALL ON "scan_attempts" FROM epsilon_admin_ro;
    GRANT SELECT ON "restaurant_staff", "review_replies", "reply_reports" TO epsilon_admin_ro;
  END IF;
END $$;
