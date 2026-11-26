CREATE TYPE "public"."smoking_status" AS ENUM('yes', 'no', 'unknown');--> statement-breakpoint
ALTER TABLE "risk_factor_detail" ADD COLUMN "smoking_status" "smoking_status";