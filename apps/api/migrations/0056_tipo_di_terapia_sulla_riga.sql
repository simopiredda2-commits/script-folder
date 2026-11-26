ALTER TABLE "prescription_line" ADD COLUMN "therapy_kind" "therapy_kind";--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "therapy_end_on" date;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "therapy_typology" text;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "therapy_not_reimbursable" boolean;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "therapy_suggested_by_name" text;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "therapy_suggested_by_facility" text;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "therapy_suggested_on" date;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "therapy_proposed_by" uuid;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "therapy_proposal_decision" text;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "therapy_choice_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD CONSTRAINT "prescription_line_therapy_proposed_by_app_user_id_fk" FOREIGN KEY ("therapy_proposed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD CONSTRAINT "prescription_line_therapy_typology" CHECK ("prescription_line"."therapy_typology" is null or "prescription_line"."therapy_typology" in ('S', 'H'));--> statement-breakpoint
ALTER TABLE "prescription_line" ADD CONSTRAINT "prescription_line_therapy_decision" CHECK ("prescription_line"."therapy_proposal_decision" is null or "prescription_line"."therapy_proposal_decision" in ('confirmed', 'declined'));