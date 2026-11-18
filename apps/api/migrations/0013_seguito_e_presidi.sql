CREATE TYPE "public"."supply_category" AS ENUM('monouso', 'diabetici', 'medicazione_tradizionale', 'medicazione_avanzata', 'dietetici', 'altro');--> statement-breakpoint
CREATE TYPE "public"."supply_prescriber" AS ENUM('mmg', 'specialista');--> statement-breakpoint
CREATE TYPE "public"."supply_status" AS ENUM('active', 'ended', 'annulled');--> statement-breakpoint
CREATE TABLE "attachment_content" (
	"attachment_id" uuid PRIMARY KEY NOT NULL,
	"content" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_execution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"prescription_line_id" uuid NOT NULL,
	"executed_on" date NOT NULL,
	"facility" text,
	"outcome" text,
	"session_number" integer,
	"report_entry_id" uuid,
	"notes" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "entry_status" DEFAULT 'active' NOT NULL,
	"annulled_at" timestamp with time zone,
	"annulled_by" uuid,
	"annul_reason" text
);
--> statement-breakpoint
CREATE TABLE "supply_prescription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"category" "supply_category" NOT NULL,
	"product" text NOT NULL,
	"code" text,
	"monthly_quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"months" integer NOT NULL,
	"start_on" date NOT NULL,
	"end_on" date NOT NULL,
	"prescriber" "supply_prescriber" DEFAULT 'mmg' NOT NULL,
	"first_specialist" text,
	"first_specialist_on" date,
	"indication_entry_id" uuid,
	"renews_id" uuid,
	"notes" text,
	"reserved" boolean DEFAULT false NOT NULL,
	"status" "supply_status" DEFAULT 'active' NOT NULL,
	"annulled_at" timestamp with time zone,
	"annulled_by" uuid,
	"annul_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attachment_content" ADD CONSTRAINT "attachment_content_attachment_id_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_execution" ADD CONSTRAINT "service_execution_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_execution" ADD CONSTRAINT "service_execution_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_execution" ADD CONSTRAINT "service_execution_prescription_line_id_prescription_line_id_fk" FOREIGN KEY ("prescription_line_id") REFERENCES "public"."prescription_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_execution" ADD CONSTRAINT "service_execution_report_entry_id_clinical_entry_id_fk" FOREIGN KEY ("report_entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_execution" ADD CONSTRAINT "service_execution_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_execution" ADD CONSTRAINT "service_execution_annulled_by_app_user_id_fk" FOREIGN KEY ("annulled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_prescription" ADD CONSTRAINT "supply_prescription_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_prescription" ADD CONSTRAINT "supply_prescription_indication_entry_id_clinical_entry_id_fk" FOREIGN KEY ("indication_entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_prescription" ADD CONSTRAINT "supply_prescription_annulled_by_app_user_id_fk" FOREIGN KEY ("annulled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_prescription" ADD CONSTRAINT "supply_prescription_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_execution_patient_id_index" ON "service_execution" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "service_execution_prescription_line_id_index" ON "service_execution" USING btree ("prescription_line_id");--> statement-breakpoint
CREATE INDEX "supply_prescription_patient_id_index" ON "supply_prescription" USING btree ("patient_id");--> statement-breakpoint
-- Aggiunto a mano: storico e divieto di cancellazione per seguito e presidi; contenuto degli
-- allegati immutabile (senza storico: il file intero finirebbe nello storico delle modifiche).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['service_execution', 'supply_prescription'] LOOP
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
CREATE TRIGGER attachment_content_immutable BEFORE UPDATE OR DELETE ON attachment_content
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Gli allegati non si modificano e non si cancellano');--> statement-breakpoint
CREATE TRIGGER attachment_content_no_truncate BEFORE TRUNCATE ON attachment_content
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Gli allegati non si svuotano');
