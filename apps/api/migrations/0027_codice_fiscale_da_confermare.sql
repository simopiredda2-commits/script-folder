ALTER TABLE "doctor_profile" ADD COLUMN "pending_fiscal_code" text;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "pending_fiscal_code_by" uuid;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "pending_fiscal_code_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD CONSTRAINT "doctor_profile_pending_fiscal_code_by_app_user_id_fk" FOREIGN KEY ("pending_fiscal_code_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;