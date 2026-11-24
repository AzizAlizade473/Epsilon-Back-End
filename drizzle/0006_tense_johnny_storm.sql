CREATE TYPE "public"."admin_role" AS ENUM('super_admin', 'operations', 'analyst', 'partner');--> statement-breakpoint
CREATE TYPE "public"."admin_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "admin_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"outcome" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "admin_role" NOT NULL,
	"status" "admin_status" DEFAULT 'active' NOT NULL,
	"access_sub" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp (3) with time zone,
	CONSTRAINT "admin_users_email_lower_check" CHECK ("admin_users"."email" = lower("admin_users"."email"))
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "hidden_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "hidden_reason" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "hidden_by" uuid;--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_created_idx" ON "admin_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_admin_idx" ON "admin_audit" USING btree ("admin_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_sessions_token_hash_key" ON "admin_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_sessions_admin_idx" ON "admin_sessions" USING btree ("admin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_access_sub_key" ON "admin_users" USING btree ("access_sub");--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_hidden_by_admin_users_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;