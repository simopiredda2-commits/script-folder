CREATE TYPE "public"."access_type" AS ENUM('first', 'subsequent');--> statement-breakpoint
CREATE TYPE "public"."gateway_system" AS ENUM('sar', 'sistema_ts');--> statement-breakpoint
CREATE TYPE "public"."prescription_kind" AS ENUM('pharma_ssn', 'specialist_ssn', 'white', 'devices');--> statement-breakpoint
CREATE TYPE "public"."prescription_status" AS ENUM('draft', 'to_sign', 'sending', 'sent', 'error', 'cancelled', 'paper');--> statement-breakpoint
CREATE TYPE "public"."priority_class" AS ENUM('U', 'B', 'D', 'P');--> statement-breakpoint
CREATE TYPE "public"."send_error_kind" AS ENUM('rejected', 'unreachable', 'timeout');--> statement-breakpoint
CREATE TABLE "external_submission" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "external_submission_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"system" "gateway_system" NOT NULL,
	"environment" text NOT NULL,
	"operation" text NOT NULL,
	"prescription_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"outcome" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "prescription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"archive_id" uuid NOT NULL,
	"kind" "prescription_kind" NOT NULL,
	"status" "prescription_status" DEFAULT 'draft' NOT NULL,
	"nre" text,
	"priority" "priority_class",
	"access_type" "access_type",
	"diagnostic_question" text,
	"exemption_code" text,
	"request_id" uuid,
	"prepared_by" uuid NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_by" uuid,
	"signed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error_kind" "send_error_kind",
	"last_error_code" text,
	"last_error_message" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"paper_printed_at" timestamp with time zone,
	"paper_printed_by" uuid,
	"rules_version" text,
	"reminder_channel" "reminder_channel",
	"reminder_contact" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prescription_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"therapy_id" uuid,
	"drug_aic" text,
	"drug_name" text,
	"active_ingredient" text,
	"service_code" text,
	"service_description" text,
	"quantity" integer NOT NULL,
	"aifa_note" text,
	"by_active_ingredient" boolean DEFAULT false NOT NULL,
	"not_substitutable" boolean DEFAULT false NOT NULL,
	"not_substitutable_reason" text,
	"posology_text" text
);
--> statement-breakpoint
ALTER TABLE "external_submission" ADD CONSTRAINT "external_submission_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_submission" ADD CONSTRAINT "external_submission_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_request_id_patient_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."patient_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_prepared_by_app_user_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_signed_by_app_user_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_cancelled_by_app_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_paper_printed_by_app_user_id_fk" FOREIGN KEY ("paper_printed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD CONSTRAINT "prescription_line_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD CONSTRAINT "prescription_line_therapy_id_therapy_id_fk" FOREIGN KEY ("therapy_id") REFERENCES "public"."therapy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_submission_prescription_id_index" ON "external_submission" USING btree ("prescription_id");--> statement-breakpoint
CREATE INDEX "prescription_archive_id_status_index" ON "prescription" USING btree ("archive_id","status");--> statement-breakpoint
CREATE INDEX "prescription_patient_id_index" ON "prescription" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "prescription_line_prescription_id_index" ON "prescription_line" USING btree ("prescription_id");--> statement-breakpoint
-- Aggiunto a mano: storico e divieto di cancellazione per le ricette; invii esterni immutabili
-- («ogni invio esterno conserva richiesta, risposta ed esito»).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['prescription', 'prescription_line'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION mmg_record_change()',
      t || '_history', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change(%L)',
      t || '_no_delete', t, 'I dati dei pazienti non si cancellano: si annullano con un motivo');
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change(%L)',
      t || '_no_truncate', t, 'I dati dei pazienti non si cancellano');
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER external_submission_immutable BEFORE UPDATE OR DELETE ON external_submission
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Gli invii esterni non si modificano e non si cancellano');
--> statement-breakpoint
CREATE TRIGGER external_submission_no_truncate BEFORE TRUNCATE ON external_submission
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Gli invii esterni non si svuotano');
