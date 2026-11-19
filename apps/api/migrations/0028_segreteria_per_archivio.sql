CREATE TYPE "public"."secretary_archive_decision" AS ENUM('confermata', 'rifiutata', 'da_confermare');--> statement-breakpoint
CREATE TABLE "archive_secretary" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"archive_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"decision" "secretary_archive_decision" NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archive_secretary" ADD CONSTRAINT "archive_secretary_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_secretary" ADD CONSTRAINT "archive_secretary_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_secretary" ADD CONSTRAINT "archive_secretary_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archive_secretary_archive_id_user_id_seq_index" ON "archive_secretary" USING btree ("archive_id","user_id","seq");--> statement-breakpoint
-- Ogni riga è una decisione: non si cambia e non si cancella (D181). Vale l'ultima.
CREATE TRIGGER archive_secretary_immutable BEFORE UPDATE OR DELETE ON archive_secretary
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le decisioni sulla segreteria di un archivio non si modificano e non si cancellano: se ne aggiunge una nuova');
--> statement-breakpoint
CREATE TRIGGER archive_secretary_no_truncate BEFORE TRUNCATE ON archive_secretary
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le decisioni sulla segreteria di un archivio non si svuotano');
--> statement-breakpoint
-- Le segreterie già confermate prima della regola restano su tutti gli archivi del loro studio,
-- come lavoravano: nessuna resta fuori di colpo. Ogni titolare la toglie dal suo, se vuole.
INSERT INTO archive_secretary (archive_id, user_id, decision, decided_by, decided_at)
SELECT a.id, u.id, 'confermata', NULL, now()
FROM app_user u
JOIN archive a ON a.studio_id = u.studio_id
WHERE 'secretary' = ANY (u.roles) AND NOT u.awaiting_confirmation
ORDER BY u.id, a.id;
