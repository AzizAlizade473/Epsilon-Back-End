-- The enum is recreated, not extended: a value added with ADD VALUE cannot be used in the same
-- transaction, and the migrator runs this file (including the backfill) in one.
ALTER TYPE "public"."identity_provider" RENAME TO "identity_provider_old";--> statement-breakpoint
CREATE TYPE "public"."identity_provider" AS ENUM('phone', 'google', 'apple', 'email');--> statement-breakpoint
DROP INDEX "auth_identities_user_provider_key";--> statement-breakpoint
ALTER TABLE "auth_identities" ALTER COLUMN "provider" SET DATA TYPE "public"."identity_provider" USING "provider"::text::"public"."identity_provider";--> statement-breakpoint
DROP TYPE "public"."identity_provider_old";--> statement-breakpoint
ALTER TABLE "otp_challenges" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "otp_challenges" ADD COLUMN "make_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "otp_challenges_email_created_idx" ON "otp_challenges" USING btree ("email","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_user_provider_key" ON "auth_identities" USING btree ("user_id","provider") WHERE "auth_identities"."provider" <> 'email';--> statement-breakpoint
-- Backfill: one e-mail identity per live account whose users.email was proven (a verified identity,
-- e.g. Google, or a login code for this account that was e-mailed there and entered correctly),
-- skipping every address that a second live account also holds. Accounts are never merged.
INSERT INTO "auth_identities" ("user_id", "provider", "provider_user_id", "email", "email_verified")
SELECT u."id", 'email', lower(btrim(u."email")), lower(btrim(u."email")), true
FROM "users" u
WHERE u."deleted_at" IS NULL
  AND btrim(u."email") <> ''
  AND (
    EXISTS (
      SELECT 1 FROM "auth_identities" i
      WHERE i."user_id" = u."id" AND i."email_verified" AND lower(btrim(i."email")) = lower(btrim(u."email"))
    )
    OR EXISTS (
      SELECT 1 FROM "otp_challenges" c
      WHERE c."consumed_at" IS NOT NULL AND lower(btrim(c."email")) = lower(btrim(u."email"))
        AND (c."user_id" = u."id" OR (c."user_id" IS NULL AND c."phone" = u."phone"))
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "users" o
    WHERE o."id" <> u."id" AND o."deleted_at" IS NULL AND lower(btrim(o."email")) = lower(btrim(u."email"))
  )
  AND NOT EXISTS (
    SELECT 1 FROM "auth_identities" o
    JOIN "users" ou ON ou."id" = o."user_id"
    WHERE o."user_id" <> u."id" AND ou."deleted_at" IS NULL AND lower(btrim(o."email")) = lower(btrim(u."email"))
  );--> statement-breakpoint
-- The same normalisation the API applies, so users.email matches its identity subject.
UPDATE "users" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));
