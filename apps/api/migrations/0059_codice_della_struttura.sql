CREATE TYPE "public"."structure_type" AS ENUM('gp_office', 'pediatric_office', 'aft', 'uccp', 'community_house', 'out_of_hours', 'tourist_service', 'semi_residential', 'residential');--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "structure_code" text;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "structure_type" "structure_type" DEFAULT 'gp_office' NOT NULL;--> statement-breakpoint
ALTER TABLE "aft" ADD COLUMN "structure_code" text;--> statement-breakpoint
ALTER TABLE "aft" ADD COLUMN "uccp_name" text;--> statement-breakpoint
ALTER TABLE "aft" ADD COLUMN "uccp_structure_code" text;--> statement-breakpoint
ALTER TABLE "studio" ADD CONSTRAINT "studio_structure_code" CHECK ("studio"."structure_code" ~ '^[A-Z0-9]{6}$');--> statement-breakpoint
ALTER TABLE "aft" ADD CONSTRAINT "aft_structure_code" CHECK ("aft"."structure_code" ~ '^[A-Z0-9]{6}$');--> statement-breakpoint
ALTER TABLE "aft" ADD CONSTRAINT "aft_uccp_structure_code" CHECK ("aft"."uccp_structure_code" ~ '^[A-Z0-9]{6}$');