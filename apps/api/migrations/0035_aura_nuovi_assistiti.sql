CREATE TABLE "aura_new_patient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"archive_id" uuid NOT NULL,
	"doctor_user_id" uuid NOT NULL,
	"aura_id" text NOT NULL,
	"fiscal_code" text NOT NULL,
	"last_name" text NOT NULL,
	"first_name" text NOT NULL,
	"birth_date" date NOT NULL,
	"chosen_on" date NOT NULL,
	"expires_on" date,
	"registry" jsonb,
	"status" text NOT NULL,
	"patient_id" uuid,
	"notified_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "aura_new_patient" ADD CONSTRAINT "aura_new_patient_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aura_new_patient" ADD CONSTRAINT "aura_new_patient_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aura_new_patient" ADD CONSTRAINT "aura_new_patient_doctor_user_id_app_user_id_fk" FOREIGN KEY ("doctor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aura_new_patient" ADD CONSTRAINT "aura_new_patient_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aura_new_patient" ADD CONSTRAINT "aura_new_patient_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aura_new_patient_studio_id_aura_id_index" ON "aura_new_patient" USING btree ("studio_id","aura_id");--> statement-breakpoint
CREATE INDEX "aura_new_patient_archive_id_status_index" ON "aura_new_patient" USING btree ("archive_id","status");
--> statement-breakpoint
-- Nuovi assistiti segnalati da AURA (D199): stati ammessi; registrato vuol dire con il paziente.
ALTER TABLE "aura_new_patient" ADD CONSTRAINT "aura_new_patient_status_known"
  CHECK (status IN ('da_registrare', 'registrato', 'non_registrato', 'superato'));
--> statement-breakpoint
ALTER TABLE "aura_new_patient" ADD CONSTRAINT "aura_new_patient_registered_has_patient"
  CHECK (status <> 'registrato' OR patient_id IS NOT NULL);
--> statement-breakpoint
-- Storico di ogni modifica; le righe non si cancellano.
CREATE TRIGGER aura_new_patient_history AFTER INSERT OR UPDATE ON aura_new_patient
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER aura_new_patient_no_delete BEFORE DELETE ON aura_new_patient
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('I dati dei pazienti non si cancellano');
--> statement-breakpoint
CREATE TRIGGER aura_new_patient_no_truncate BEFORE TRUNCATE ON aura_new_patient
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('I dati dei pazienti non si cancellano');
