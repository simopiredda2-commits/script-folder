CREATE TYPE "public"."ppip_place" AS ENUM('studio', 'home');--> statement-breakpoint
CREATE TYPE "public"."ppip_report_outcome" AS ENUM('accepted', 'rejected', 'unreachable');--> statement-breakpoint
CREATE TYPE "public"."ppip_status" AS ENUM('active', 'annulled');--> statement-breakpoint
CREATE TABLE "ref_additional_service" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_additional_service_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"code" text NOT NULL,
	"section" text NOT NULL,
	"description" text NOT NULL,
	"authorization" boolean NOT NULL,
	"compensation" numeric(12, 2),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "ppip_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"performed_on" date NOT NULL,
	"code" text NOT NULL,
	"section" text NOT NULL,
	"description" text NOT NULL,
	"authorization_required" boolean NOT NULL,
	"unit_compensation" numeric(12, 2),
	"dataset_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"place" "ppip_place" NOT NULL,
	"authorization_ref" text,
	"notes" text,
	"status" "ppip_status" DEFAULT 'active' NOT NULL,
	"report_id" uuid,
	"annulled_at" timestamp with time zone,
	"annulled_by" uuid,
	"annul_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ppip_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"archive_id" uuid NOT NULL,
	"month" text NOT NULL,
	"outcome" "ppip_report_outcome" NOT NULL,
	"protocol" text,
	"message" text,
	"environment" text NOT NULL,
	"lines" integer NOT NULL,
	"total" numeric(12, 2),
	"content" jsonb NOT NULL,
	"sent_by" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ref_additional_service" ADD CONSTRAINT "ref_additional_service_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppip_record" ADD CONSTRAINT "ppip_record_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppip_record" ADD CONSTRAINT "ppip_record_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppip_record" ADD CONSTRAINT "ppip_record_report_id_ppip_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."ppip_report"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppip_record" ADD CONSTRAINT "ppip_record_annulled_by_app_user_id_fk" FOREIGN KEY ("annulled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppip_record" ADD CONSTRAINT "ppip_record_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppip_report" ADD CONSTRAINT "ppip_report_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppip_report" ADD CONSTRAINT "ppip_report_sent_by_app_user_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ref_additional_service_dataset_id_code_index" ON "ref_additional_service" USING btree ("dataset_id","code");--> statement-breakpoint
CREATE INDEX "ppip_record_patient_id_index" ON "ppip_record" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "ppip_record_performed_on_index" ON "ppip_record" USING btree ("performed_on");--> statement-breakpoint
CREATE INDEX "ppip_report_archive_id_month_index" ON "ppip_report" USING btree ("archive_id","month");--> statement-breakpoint
-- Aggiunto a mano, come le altre banche dati (0006, 0037, 0039): le versioni importate non si modificano e non si cancellano.
CREATE TRIGGER ref_additional_service_immutable BEFORE UPDATE OR DELETE ON ref_additional_service
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_additional_service_no_truncate BEFORE TRUNCATE ON ref_additional_service
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
--> statement-breakpoint
-- Aggiunto a mano, come per seguito e presidi (0013): storico e divieto di cancellazione delle prestazioni aggiuntive.
CREATE TRIGGER ppip_record_history AFTER INSERT OR UPDATE ON ppip_record
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER ppip_record_no_delete BEFORE DELETE ON ppip_record
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('I dati dei pazienti non si cancellano: si annullano con un motivo');
--> statement-breakpoint
CREATE TRIGGER ppip_record_no_truncate BEFORE TRUNCATE ON ppip_record
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('I dati dei pazienti non si cancellano');
--> statement-breakpoint
-- Gli invii della distinta restano come sono partiti.
CREATE TRIGGER ppip_report_immutable BEFORE UPDATE OR DELETE ON ppip_report
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Gli invii della distinta non si modificano e non si cancellano');
--> statement-breakpoint
CREATE TRIGGER ppip_report_no_truncate BEFORE TRUNCATE ON ppip_report
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Gli invii della distinta non si cancellano');
