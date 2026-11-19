CREATE TYPE "public"."identity_purpose" AS ENUM('recovery', 'link');--> statement-breakpoint
CREATE TABLE "identity_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "identity_purpose" NOT NULL,
	"user_id" uuid,
	"state_hash" text NOT NULL,
	"verifier_enc" "bytea" NOT NULL,
	"redirect_uri" text NOT NULL,
	"workstation" text,
	"address" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"returned_at" timestamp with time zone,
	"recovery_token_hash" text,
	"recovery_until" timestamp with time zone,
	"method" text,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "identity_fiscal_code" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "identity_linked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity_request" ADD CONSTRAINT "identity_request_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_request_state_hash_index" ON "identity_request" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_request_recovery_token_hash_index" ON "identity_request" USING btree ("recovery_token_hash");