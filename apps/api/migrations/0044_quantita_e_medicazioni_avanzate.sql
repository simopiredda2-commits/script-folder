ALTER TABLE "archive" ADD COLUMN "advanced_dressing_codes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "ref_supply" ADD COLUMN "quantity" text;--> statement-breakpoint
ALTER TABLE "ref_supply" ADD COLUMN "quantity_heading" text;