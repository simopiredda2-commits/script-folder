CREATE TYPE "public"."studio_kind" AS ENUM('single', 'group');--> statement-breakpoint
CREATE TABLE "studio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"kind" "studio_kind" DEFAULT 'single' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
