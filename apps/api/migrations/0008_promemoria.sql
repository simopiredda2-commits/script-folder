CREATE TYPE "public"."prescription_document_kind" AS ENUM('promemoria_dati', 'promemoria_sac');--> statement-breakpoint
CREATE TYPE "public"."reminder_delivery_channel" AS ENUM('stampa_promemoria', 'stampa_nre', 'email', 'sms');--> statement-breakpoint
CREATE TABLE "prescription_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_id" uuid NOT NULL,
	"kind" "prescription_document_kind" NOT NULL,
	"media_type" text NOT NULL,
	"content" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_delivery" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reminder_delivery_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"prescription_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "reminder_delivery_channel" NOT NULL,
	"recipient_kind" text,
	"delegation_id" uuid,
	"recipient" text,
	"environment" text,
	"outcome" text NOT NULL,
	"message_id" text,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "region_name" text;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "fiscal_code" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "auth_code" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "sac_doctor_name" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "pin_nrbe" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "obscured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "repeat_count" integer;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "validity_months" integer;--> statement-breakpoint
ALTER TABLE "prescription_document" ADD CONSTRAINT "prescription_document_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_delivery" ADD CONSTRAINT "reminder_delivery_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_delivery" ADD CONSTRAINT "reminder_delivery_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prescription_document_prescription_id_index" ON "prescription_document" USING btree ("prescription_id");--> statement-breakpoint
CREATE INDEX "reminder_delivery_prescription_id_index" ON "reminder_delivery" USING btree ("prescription_id");
--> statement-breakpoint
-- Aggiunto a mano: i documenti del promemoria e le consegne non si modificano e non si cancellano.
CREATE TRIGGER prescription_document_immutable BEFORE UPDATE OR DELETE ON prescription_document
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('I documenti delle ricette non si modificano e non si cancellano');--> statement-breakpoint
CREATE TRIGGER prescription_document_no_truncate BEFORE TRUNCATE ON prescription_document
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('I documenti delle ricette non si svuotano');--> statement-breakpoint
CREATE TRIGGER reminder_delivery_immutable BEFORE UPDATE OR DELETE ON reminder_delivery
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le consegne dei promemoria non si modificano e non si cancellano');--> statement-breakpoint
CREATE TRIGGER reminder_delivery_no_truncate BEFORE TRUNCATE ON reminder_delivery
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le consegne dei promemoria non si svuotano');
