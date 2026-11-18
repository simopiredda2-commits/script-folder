ALTER TABLE "consent" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "consent" ADD COLUMN "expressed_by" text;--> statement-breakpoint
ALTER TABLE "consent" ADD COLUMN "recorded_by" uuid;--> statement-breakpoint
ALTER TABLE "consent" ADD COLUMN "recorded_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "therapeutic_plan" ADD COLUMN "reserved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "therapeutic_plan" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "therapeutic_plan" ADD COLUMN "status" "entry_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "therapeutic_plan" ADD COLUMN "annulled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "therapeutic_plan" ADD COLUMN "annulled_by" uuid;--> statement-breakpoint
ALTER TABLE "therapeutic_plan" ADD COLUMN "annul_reason" text;--> statement-breakpoint
ALTER TABLE "therapeutic_plan" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "therapeutic_plan" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "therapeutic_plan" ADD CONSTRAINT "therapeutic_plan_annulled_by_app_user_id_fk" FOREIGN KEY ("annulled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "therapeutic_plan" ADD CONSTRAINT "therapeutic_plan_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;