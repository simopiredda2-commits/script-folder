CREATE TYPE "public"."fse_regional_operation" AS ENUM('create', 'replace', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "public"."fse_regional_status" AS ENUM('queued', 'waiting', 'done', 'to_fix', 'failed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."fse_operation" ADD VALUE 'regional_create';--> statement-breakpoint
ALTER TYPE "public"."fse_operation" ADD VALUE 'regional_replace';--> statement-breakpoint
ALTER TYPE "public"."fse_operation" ADD VALUE 'regional_update';--> statement-breakpoint
ALTER TYPE "public"."fse_operation" ADD VALUE 'regional_delete';--> statement-breakpoint
ALTER TYPE "public"."fse_operation" ADD VALUE 'regional_outcome';--> statement-breakpoint
ALTER TYPE "public"."fse_operation" ADD VALUE 'regional_search';--> statement-breakpoint
ALTER TYPE "public"."pss_status" ADD VALUE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."pss_status" ADD VALUE 'deleted';--> statement-breakpoint
CREATE TABLE "fse_regional_send" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"doctor_user_id" uuid NOT NULL,
	"operation" "fse_regional_operation" NOT NULL,
	"status" "fse_regional_status" DEFAULT 'queued' NOT NULL,
	"confidentiality" text,
	"temporary_id" text,
	"oid" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"phase" text DEFAULT 'ripetizione' NOT NULL,
	"polls" integer DEFAULT 0 NOT NULL,
	"queued_since" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"errors" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "fse_setting" ADD COLUMN "regional_sending_suspended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fse_setting" ADD COLUMN "regional_suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fse_setting" ADD COLUMN "regional_suspended_reason" text;--> statement-breakpoint
ALTER TABLE "fse_transmission" ADD COLUMN "request" text;--> statement-breakpoint
ALTER TABLE "fse_transmission" ADD COLUMN "response" text;--> statement-breakpoint
ALTER TABLE "pss_document" ADD COLUMN "regional_oid" text;--> statement-breakpoint
ALTER TABLE "pss_document" ADD COLUMN "confidentiality" text DEFAULT 'N' NOT NULL;--> statement-breakpoint
ALTER TABLE "pss_document" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pss_document" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fse_regional_send" ADD CONSTRAINT "fse_regional_send_document_id_pss_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."pss_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fse_regional_send" ADD CONSTRAINT "fse_regional_send_doctor_user_id_app_user_id_fk" FOREIGN KEY ("doctor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fse_regional_send_status_next_attempt_at_index" ON "fse_regional_send" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "fse_regional_send_document_id_created_at_index" ON "fse_regional_send" USING btree ("document_id","created_at");--> statement-breakpoint
-- Pubblicazione con i servizi del Fascicolo regionale (V09, D280): il Profilo firmato può essere
-- scartato se la Regione non lo prende in carico; preso in carico, diventa pubblicato o scartato
-- («KO»); pubblicato, può essere sostituito o cancellato dal Fascicolo.
CREATE OR REPLACE FUNCTION mmg_pss_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('validated', 'discarded')) OR
    (OLD.status = 'validated' AND NEW.status IN ('signed', 'discarded')) OR
    (OLD.status = 'signed' AND NEW.status IN ('submitted', 'discarded')) OR
    (OLD.status = 'submitted' AND NEW.status IN ('published', 'rejected')) OR
    (OLD.status = 'published' AND NEW.status IN ('replaced', 'deleted'))
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
  -- L'OID del Fascicolo regionale, una volta dato, non cambia.
  IF OLD.regional_oid IS NOT NULL AND NEW.regional_oid IS DISTINCT FROM OLD.regional_oid THEN
    RAISE EXCEPTION 'L’identificativo del Profilo nel Fascicolo regionale non cambia';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER fse_regional_send_no_delete BEFORE DELETE ON fse_regional_send
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Gli invii al Fascicolo regionale non si cancellano');--> statement-breakpoint
CREATE TRIGGER fse_regional_send_no_truncate BEFORE TRUNCATE ON fse_regional_send
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Gli invii al Fascicolo regionale non si svuotano');
