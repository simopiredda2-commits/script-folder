CREATE TABLE "studio_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "template_certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"template_title" text NOT NULL,
	"template_version" text NOT NULL,
	"official" boolean NOT NULL,
	"source" jsonb,
	"fields" jsonb NOT NULL,
	"paragraphs" jsonb NOT NULL,
	"signature" text NOT NULL,
	"layout" jsonb NOT NULL,
	"issued_on" date NOT NULL,
	"valid_until" date,
	"issued_by" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"annulled_at" timestamp with time zone,
	"annulled_by" uuid,
	"annul_reason" text
);
--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "print_font" text DEFAULT 'sans' NOT NULL;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "print_font_size" integer DEFAULT 11 NOT NULL;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "print_header_align" text DEFAULT 'left' NOT NULL;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "print_margin_mm" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD COLUMN "print_place" text;--> statement-breakpoint
ALTER TABLE "studio_template" ADD CONSTRAINT "studio_template_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_template" ADD CONSTRAINT "studio_template_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_template" ADD CONSTRAINT "studio_template_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_certificate" ADD CONSTRAINT "template_certificate_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_certificate" ADD CONSTRAINT "template_certificate_issued_by_app_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_certificate" ADD CONSTRAINT "template_certificate_annulled_by_app_user_id_fk" FOREIGN KEY ("annulled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_template_studio_id_index" ON "studio_template" USING btree ("studio_id");--> statement-breakpoint
CREATE INDEX "template_certificate_patient_id_index" ON "template_certificate" USING btree ("patient_id");--> statement-breakpoint
-- Aggiunto a mano: storico e divieto di cancellazione per i modelli dello studio e per i
-- certificati rilasciati; il certificato rilasciato non cambia, si annulla una volta con un motivo.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['studio_template', 'template_certificate'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION mmg_record_change()',
      t || '_history', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change(%L)',
      t || '_no_delete', t, 'Non si cancella: un modello si archivia, un certificato si annulla con un motivo');
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change(%L)',
      t || '_no_truncate', t, 'Non si cancella');
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION mmg_template_certificate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.annulled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Il certificato annullato non si modifica';
  END IF;
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id OR
    NEW.template_key IS DISTINCT FROM OLD.template_key OR
    NEW.template_title IS DISTINCT FROM OLD.template_title OR
    NEW.template_version IS DISTINCT FROM OLD.template_version OR
    NEW.official IS DISTINCT FROM OLD.official OR
    NEW.source IS DISTINCT FROM OLD.source OR
    NEW.fields IS DISTINCT FROM OLD.fields OR
    NEW.paragraphs IS DISTINCT FROM OLD.paragraphs OR
    NEW.signature IS DISTINCT FROM OLD.signature OR
    NEW.layout IS DISTINCT FROM OLD.layout OR
    NEW.issued_on IS DISTINCT FROM OLD.issued_on OR
    NEW.valid_until IS DISTINCT FROM OLD.valid_until OR
    NEW.issued_by IS DISTINCT FROM OLD.issued_by OR
    NEW.issued_at IS DISTINCT FROM OLD.issued_at
  THEN
    RAISE EXCEPTION 'Il certificato rilasciato non si modifica: si annulla con un motivo';
  END IF;
  IF NEW.annulled_at IS NULL OR NEW.annulled_by IS NULL OR coalesce(trim(NEW.annul_reason), '') = '' THEN
    RAISE EXCEPTION 'Annullamento: servono data, autore e motivo';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER template_certificate_guard BEFORE UPDATE ON template_certificate
  FOR EACH ROW EXECUTE FUNCTION mmg_template_certificate_guard();
