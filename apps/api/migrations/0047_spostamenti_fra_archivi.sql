CREATE TABLE "patient_archive_move" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"from_archive_id" uuid NOT NULL,
	"to_archive_id" uuid NOT NULL,
	"moved_at" timestamp with time zone NOT NULL,
	"moved_by" uuid NOT NULL,
	"doctor_change_id" uuid
);
--> statement-breakpoint
ALTER TABLE "patient_archive_move" ADD CONSTRAINT "patient_archive_move_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_archive_move" ADD CONSTRAINT "patient_archive_move_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_archive_move" ADD CONSTRAINT "patient_archive_move_from_archive_id_archive_id_fk" FOREIGN KEY ("from_archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_archive_move" ADD CONSTRAINT "patient_archive_move_to_archive_id_archive_id_fk" FOREIGN KEY ("to_archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_archive_move" ADD CONSTRAINT "patient_archive_move_moved_by_app_user_id_fk" FOREIGN KEY ("moved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_archive_move" ADD CONSTRAINT "patient_archive_move_doctor_change_id_aura_doctor_change_id_fk" FOREIGN KEY ("doctor_change_id") REFERENCES "public"."aura_doctor_change"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_archive_move_patient_id_moved_at_index" ON "patient_archive_move" USING btree ("patient_id","moved_at");--> statement-breakpoint
CREATE TRIGGER patient_archive_move_immutable BEFORE UPDATE OR DELETE ON patient_archive_move
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Gli spostamenti di un paziente fra gli archivi non si modificano e non si cancellano');
--> statement-breakpoint
CREATE TRIGGER patient_archive_move_no_truncate BEFORE TRUNCATE ON patient_archive_move
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Gli spostamenti di un paziente fra gli archivi non si cancellano');
--> statement-breakpoint
-- Gli spostamenti fatti prima di questa migrazione, dal registro degli accessi (D200, D240).
INSERT INTO patient_archive_move (studio_id, patient_id, from_archive_id, to_archive_id, moved_at, moved_by, doctor_change_id)
SELECT l.studio_id, l.patient_id, (l.details->>'da')::uuid, (l.details->>'a')::uuid, l.at, l.user_id,
       (SELECT c.id FROM aura_doctor_change c WHERE c.id::text = l.details->>'cambio')
FROM access_log l
WHERE l.action = 'spostamento_archivio' AND l.outcome = 'riuscito'
  AND l.studio_id IS NOT NULL AND l.patient_id IS NOT NULL AND l.user_id IS NOT NULL
  AND l.details->>'da' IS NOT NULL AND l.details->>'a' IS NOT NULL
ORDER BY l.seq;
