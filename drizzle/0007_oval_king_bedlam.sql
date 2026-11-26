CREATE TYPE "public"."like_kind" AS ENUM('dish', 'review', 'restaurant');--> statement-breakpoint
CREATE TABLE "likes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "like_kind" NOT NULL,
	"target_id" text NOT NULL,
	"restaurant_id" text NOT NULL,
	"dish_id" text,
	"title" text NOT NULL,
	"subtitle" text NOT NULL,
	"image_url" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "likes_user_target_key" ON "likes" USING btree ("user_id","kind","target_id");--> statement-breakpoint
CREATE INDEX "likes_target_idx" ON "likes" USING btree ("target_id","kind");--> statement-breakpoint
CREATE INDEX "likes_user_created_idx" ON "likes" USING btree ("user_id","created_at");