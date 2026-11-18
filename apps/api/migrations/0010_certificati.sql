CREATE TYPE "public"."certificate_status" AS ENUM('draft', 'sending', 'sent', 'error', 'cancelled', 'rectified');--> statement-breakpoint
CREATE TABLE "certificate_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"certificate_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"recipient" text,
	"environment" text,
	"outcome" text NOT NULL,
	"message_id" text,
	"error_message" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certificate_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"certificate_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"environment" text NOT NULL,
	"user_id" uuid NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"outcome" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"duration_ms" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sick_leave_certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"archive_id" uuid NOT NULL,
	"status" "certificate_status" DEFAULT 'draft' NOT NULL,
	"type" text NOT NULL,
	"visit" text NOT NULL,
	"role" text DEFAULT 'S' NOT NULL,
	"release_date" date NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"diagnosis_code" text,
	"diagnosis_notes" text,
	"worked_day" boolean DEFAULT false NOT NULL,
	"trauma" boolean DEFAULT false NOT NULL,
	"benefits" text,
	"residence" jsonb NOT NULL,
	"availability" jsonb,
	"snapshot" jsonb,
	"protocol" text,
	"received_at" timestamp with time zone,
	"rectifies_id" uuid,
	"cancel_protocol" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"prepared_by" uuid NOT NULL,
	"signed_by" uuid,
	"signed_at" timestamp with time zone,
	"last_error_kind" "send_error_kind",
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certificate_delivery" ADD CONSTRAINT "certificate_delivery_certificate_id_sick_leave_certificate_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."sick_leave_certificate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_delivery" ADD CONSTRAINT "certificate_delivery_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_submission" ADD CONSTRAINT "certificate_submission_certificate_id_sick_leave_certificate_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."sick_leave_certificate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_submission" ADD CONSTRAINT "certificate_submission_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sick_leave_certificate" ADD CONSTRAINT "sick_leave_certificate_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sick_leave_certificate" ADD CONSTRAINT "sick_leave_certificate_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sick_leave_certificate" ADD CONSTRAINT "sick_leave_certificate_cancelled_by_app_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sick_leave_certificate" ADD CONSTRAINT "sick_leave_certificate_prepared_by_app_user_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sick_leave_certificate" ADD CONSTRAINT "sick_leave_certificate_signed_by_app_user_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "certificate_delivery_certificate_id_index" ON "certificate_delivery" USING btree ("certificate_id");--> statement-breakpoint
CREATE INDEX "certificate_submission_certificate_id_index" ON "certificate_submission" USING btree ("certificate_id");--> statement-breakpoint
CREATE INDEX "sick_leave_certificate_patient_id_index" ON "sick_leave_certificate" USING btree ("patient_id");--> statement-breakpoint
-- Aggiunto a mano: storico e divieto di cancellazione per i certificati; invii e consegne immutabili.
DO $$
BEGIN
  EXECUTE 'CREATE TRIGGER sick_leave_certificate_history AFTER INSERT OR UPDATE ON sick_leave_certificate FOR EACH ROW EXECUTE FUNCTION mmg_record_change()';
  EXECUTE format('CREATE TRIGGER sick_leave_certificate_no_delete BEFORE DELETE ON sick_leave_certificate FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change(%L)',
    'I dati dei pazienti non si cancellano: si annullano con un motivo');
  EXECUTE format('CREATE TRIGGER sick_leave_certificate_no_truncate BEFORE TRUNCATE ON sick_leave_certificate FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change(%L)',
    'I dati dei pazienti non si cancellano');
END $$;
--> statement-breakpoint
CREATE TRIGGER certificate_submission_immutable BEFORE UPDATE OR DELETE ON certificate_submission
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Gli invii all''INPS non si modificano e non si cancellano');--> statement-breakpoint
CREATE TRIGGER certificate_submission_no_truncate BEFORE TRUNCATE ON certificate_submission
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Gli invii all''INPS non si svuotano');--> statement-breakpoint
CREATE TRIGGER certificate_delivery_immutable BEFORE UPDATE OR DELETE ON certificate_delivery
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le consegne dei certificati non si modificano e non si cancellano');--> statement-breakpoint
CREATE TRIGGER certificate_delivery_no_truncate BEFORE TRUNCATE ON certificate_delivery
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le consegne dei certificati non si svuotano');
