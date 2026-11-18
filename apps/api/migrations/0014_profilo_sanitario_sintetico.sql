CREATE TYPE "public"."allergy_agent" AS ENUM('drug', 'food', 'hymenoptera_venom', 'environment', 'other');--> statement-breakpoint
CREATE TYPE "public"."allergy_criticality" AS ENUM('low', 'moderate', 'high');--> statement-breakpoint
CREATE TYPE "public"."allergy_kind" AS ENUM('allergy', 'intolerance');--> statement-breakpoint
CREATE TYPE "public"."problem_category" AS ENUM('diagnosis', 'missing_organ', 'transplant', 'malformation');--> statement-breakpoint
CREATE TYPE "public"."fse_operation" AS ENUM('validation', 'publication', 'replacement', 'status');--> statement-breakpoint
CREATE TYPE "public"."fse_outcome" AS ENUM('ok', 'problem', 'unreachable', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."pss_file_kind" AS ENUM('pdf', 'signed_pdf');--> statement-breakpoint
CREATE TYPE "public"."pss_status" AS ENUM('draft', 'validated', 'signed', 'submitted', 'published', 'replaced', 'discarded');--> statement-breakpoint
ALTER TYPE "public"."clinical_entry_kind" ADD VALUE 'functional_status';--> statement-breakpoint
CREATE TABLE "functional_status_detail" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"motor_capacity" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fse_setting" (
	"studio_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT '010' NOT NULL,
	"organization_name" text DEFAULT 'Regione Piemonte' NOT NULL,
	"document_id_root" text,
	"repository_id" text,
	"submission_id_root" text,
	"custodian_id_root" text,
	"custodian_id_extension" text,
	"custodian_name" text,
	"custodian_street" text,
	"custodian_city" text,
	"custodian_istat_code" text,
	"custodian_province" text,
	"locality" text,
	"facility_type" text DEFAULT 'Territorio' NOT NULL,
	"practice_setting" text DEFAULT 'AD_PSC130' NOT NULL,
	"clinical_activity" text,
	"administrative_request" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "fse_transmission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"operation" "fse_operation" NOT NULL,
	"outcome" "fse_outcome" NOT NULL,
	"http_status" integer,
	"problem_type" text,
	"problem_title" text,
	"problem_detail" text,
	"trace_id" text,
	"workflow_instance_id" text,
	"actor_user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pss_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"status" "pss_status" DEFAULT 'draft' NOT NULL,
	"set_root" text NOT NULL,
	"set_extension" text NOT NULL,
	"version" integer NOT NULL,
	"doc_root" text NOT NULL,
	"doc_extension" text NOT NULL,
	"replaces_id" uuid,
	"content" jsonb NOT NULL,
	"cda_xml" text,
	"cda_sha256" text,
	"workflow_instance_id" text,
	"trace_id" text,
	"last_problem" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"replaced_at" timestamp with time zone,
	"discarded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pss_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" "pss_file_kind" NOT NULL,
	"content" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "pec" text;--> statement-breakpoint
ALTER TABLE "allergy_detail" ADD COLUMN "kind" "allergy_kind" DEFAULT 'allergy' NOT NULL;--> statement-breakpoint
ALTER TABLE "allergy_detail" ADD COLUMN "agent_category" "allergy_agent";--> statement-breakpoint
ALTER TABLE "allergy_detail" ADD COLUMN "agent_code" text;--> statement-breakpoint
ALTER TABLE "allergy_detail" ADD COLUMN "agent_system" text;--> statement-breakpoint
ALTER TABLE "allergy_detail" ADD COLUMN "criticality" "allergy_criticality";--> statement-breakpoint
ALTER TABLE "allergy_detail" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "anamnesis_detail" ADD COLUMN "relative_code" text;--> statement-breakpoint
ALTER TABLE "anamnesis_detail" ADD COLUMN "icd_code" text;--> statement-breakpoint
ALTER TABLE "anamnesis_detail" ADD COLUMN "onset_age" integer;--> statement-breakpoint
ALTER TABLE "problem_detail" ADD COLUMN "chronic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "problem_detail" ADD COLUMN "category" "problem_category" DEFAULT 'diagnosis' NOT NULL;--> statement-breakpoint
ALTER TABLE "functional_status_detail" ADD CONSTRAINT "functional_status_detail_entry_id_clinical_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fse_setting" ADD CONSTRAINT "fse_setting_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fse_setting" ADD CONSTRAINT "fse_setting_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fse_transmission" ADD CONSTRAINT "fse_transmission_document_id_pss_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."pss_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fse_transmission" ADD CONSTRAINT "fse_transmission_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pss_document" ADD CONSTRAINT "pss_document_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pss_document" ADD CONSTRAINT "pss_document_author_user_id_app_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pss_file" ADD CONSTRAINT "pss_file_document_id_pss_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."pss_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fse_transmission_document_id_at_index" ON "fse_transmission" USING btree ("document_id","at");--> statement-breakpoint
CREATE INDEX "pss_document_patient_id_created_at_index" ON "pss_document" USING btree ("patient_id","created_at");--> statement-breakpoint
-- Aggiunto a mano: storico e divieto di cancellazione per la capacità motoria e per il Profilo;
-- PDF e invii al Gateway immutabili (i PDF senza storico: il file intero finirebbe nello storico).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['functional_status_detail', 'pss_document'] LOOP
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
-- Il Profilo cambia stato solo nei passaggi ammessi; dopo la bozza il contenuto non cambia più.
CREATE FUNCTION mmg_pss_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('validated', 'discarded')) OR
    (OLD.status = 'validated' AND NEW.status IN ('signed', 'discarded')) OR
    (OLD.status = 'signed' AND NEW.status = 'submitted') OR
    (OLD.status = 'submitted' AND NEW.status = 'published') OR
    (OLD.status = 'published' AND NEW.status = 'replaced')
  ) THEN
    RAISE EXCEPTION 'Profilo sanitario sintetico: passaggio non ammesso da % a %', OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.content IS DISTINCT FROM OLD.content OR
    NEW.cda_xml IS DISTINCT FROM OLD.cda_xml OR
    NEW.cda_sha256 IS DISTINCT FROM OLD.cda_sha256 OR
    NEW.patient_id IS DISTINCT FROM OLD.patient_id OR
    NEW.author_user_id IS DISTINCT FROM OLD.author_user_id OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.set_root IS DISTINCT FROM OLD.set_root OR
    NEW.set_extension IS DISTINCT FROM OLD.set_extension OR
    NEW.doc_root IS DISTINCT FROM OLD.doc_root OR
    NEW.doc_extension IS DISTINCT FROM OLD.doc_extension OR
    NEW.replaces_id IS DISTINCT FROM OLD.replaces_id
  ) THEN
    RAISE EXCEPTION 'Il Profilo validato non si modifica: se ne prepara una versione nuova';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER pss_document_guard BEFORE UPDATE ON pss_document
  FOR EACH ROW EXECUTE FUNCTION mmg_pss_document_guard();--> statement-breakpoint
CREATE TRIGGER pss_file_immutable BEFORE UPDATE OR DELETE ON pss_file
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('I documenti del Profilo non si modificano e non si cancellano');--> statement-breakpoint
CREATE TRIGGER pss_file_no_truncate BEFORE TRUNCATE ON pss_file
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('I documenti del Profilo non si svuotano');--> statement-breakpoint
CREATE TRIGGER fse_transmission_immutable BEFORE UPDATE OR DELETE ON fse_transmission
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Gli invii al Gateway non si modificano e non si cancellano');--> statement-breakpoint
CREATE TRIGGER fse_transmission_no_truncate BEFORE TRUNCATE ON fse_transmission
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Gli invii al Gateway non si svuotano');
