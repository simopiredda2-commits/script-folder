CREATE TYPE "public"."session_mode" AS ENUM('email', 'spid_cie');--> statement-breakpoint
CREATE TABLE "regional_authorization_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"verifier_enc" "bytea" NOT NULL,
	"redirect_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "service_session" ADD COLUMN "mode" "session_mode" DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_session" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "regional_authorization_request" ADD CONSTRAINT "regional_authorization_request_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "regional_authorization_request_state_hash_index" ON "regional_authorization_request" USING btree ("state_hash");