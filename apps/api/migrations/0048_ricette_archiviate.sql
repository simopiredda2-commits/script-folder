ALTER TABLE "prescription" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_archived_by_app_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;