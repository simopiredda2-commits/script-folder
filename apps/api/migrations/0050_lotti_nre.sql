CREATE TABLE "nre_lot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_user_id" uuid NOT NULL,
	"doctor_fiscal_code" text NOT NULL,
	"environment" text NOT NULL,
	"region_code" text NOT NULL,
	"group_code" text NOT NULL,
	"lot_type" text NOT NULL,
	"lot_code" text NOT NULL,
	"prefix" text NOT NULL,
	"size" integer NOT NULL,
	"next_progressive" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response" jsonb,
	CONSTRAINT "nre_lot_progressive_check" CHECK ("nre_lot"."next_progressive" >= 0 and "nre_lot"."next_progressive" <= "nre_lot"."size")
);
--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "assigned_nre" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "nre_lot_id" uuid;--> statement-breakpoint
ALTER TABLE "nre_lot" ADD CONSTRAINT "nre_lot_doctor_user_id_app_user_id_fk" FOREIGN KEY ("doctor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nre_lot_prefix_key" ON "nre_lot" USING btree ("environment","prefix");--> statement-breakpoint
CREATE INDEX "nre_lot_doctor_user_id_environment_index" ON "nre_lot" USING btree ("doctor_user_id","environment");--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_nre_lot_id_nre_lot_id_fk" FOREIGN KEY ("nre_lot_id") REFERENCES "public"."nre_lot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_assigned_nre_key" ON "prescription" USING btree ("assigned_nre") WHERE "prescription"."assigned_nre" is not null;