CREATE TABLE "aura_doctor_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"from_archive_id" uuid NOT NULL,
	"to_archive_id" uuid NOT NULL,
	"to_doctor_user_id" uuid NOT NULL,
	"chosen_on" date NOT NULL,
	"status" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "aura_doctor_change_patientId_unique" UNIQUE("patient_id")
);
--> statement-breakpoint
ALTER TABLE "aura_doctor_change" ADD CONSTRAINT "aura_doctor_change_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aura_doctor_change" ADD CONSTRAINT "aura_doctor_change_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aura_doctor_change" ADD CONSTRAINT "aura_doctor_change_from_archive_id_archive_id_fk" FOREIGN KEY ("from_archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aura_doctor_change" ADD CONSTRAINT "aura_doctor_change_to_archive_id_archive_id_fk" FOREIGN KEY ("to_archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aura_doctor_change" ADD CONSTRAINT "aura_doctor_change_to_doctor_user_id_app_user_id_fk" FOREIGN KEY ("to_doctor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aura_doctor_change" ADD CONSTRAINT "aura_doctor_change_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aura_doctor_change_from_archive_id_status_index" ON "aura_doctor_change" USING btree ("from_archive_id","status");--> statement-breakpoint
CREATE INDEX "aura_doctor_change_to_doctor_user_id_status_index" ON "aura_doctor_change" USING btree ("to_doctor_user_id","status");
--> statement-breakpoint
-- Cambi di medico dentro lo studio (D200): stati ammessi; due archivi diversi; spostato e non
-- spostato vogliono chi l'ha deciso e quando.
ALTER TABLE "aura_doctor_change" ADD CONSTRAINT "aura_doctor_change_status_known"
  CHECK (status IN ('da_decidere', 'spostato', 'non_spostato', 'superato'));
--> statement-breakpoint
ALTER TABLE "aura_doctor_change" ADD CONSTRAINT "aura_doctor_change_two_archives"
  CHECK (from_archive_id <> to_archive_id);
--> statement-breakpoint
ALTER TABLE "aura_doctor_change" ADD CONSTRAINT "aura_doctor_change_decided"
  CHECK (status NOT IN ('spostato', 'non_spostato') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL));
--> statement-breakpoint
-- Storico di ogni modifica; le righe non si cancellano.
CREATE TRIGGER aura_doctor_change_history AFTER INSERT OR UPDATE ON aura_doctor_change
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER aura_doctor_change_no_delete BEFORE DELETE ON aura_doctor_change
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('I dati dei pazienti non si cancellano');
--> statement-breakpoint
CREATE TRIGGER aura_doctor_change_no_truncate BEFORE TRUNCATE ON aura_doctor_change
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('I dati dei pazienti non si cancellano');
