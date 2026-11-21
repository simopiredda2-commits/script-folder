-- Modificato a mano (D232): la colonna nasce vuota, si riempie con l'archivio di oggi del paziente (prima l'archivio della prestazione non si scriveva) e poi diventa obbligatoria.
ALTER TABLE "ppip_record" ADD COLUMN "archive_id" uuid;--> statement-breakpoint
UPDATE "ppip_record" r SET "archive_id" = p."archive_id" FROM "patient" p WHERE p."id" = r."patient_id";--> statement-breakpoint
ALTER TABLE "ppip_record" ALTER COLUMN "archive_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ppip_record" ADD COLUMN "sending_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ppip_record" ADD COLUMN "sending_by" uuid;--> statement-breakpoint
ALTER TABLE "ppip_record" ADD CONSTRAINT "ppip_record_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppip_record" ADD CONSTRAINT "ppip_record_sending_by_app_user_id_fk" FOREIGN KEY ("sending_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ppip_record_archive_id_performed_on_index" ON "ppip_record" USING btree ("archive_id","performed_on");--> statement-breakpoint
-- Aggiunto a mano (D232): gli stati di una prestazione aggiuntiva, controllati anche dal database.
-- Un invio in corso ha il momento e chi manda; una prestazione partita non è in invio; una
-- prestazione annullata non parte e non è in invio.
ALTER TABLE "ppip_record" ADD CONSTRAINT "ppip_record_sending_check" CHECK (("sending_since" IS NULL) = ("sending_by" IS NULL));--> statement-breakpoint
ALTER TABLE "ppip_record" ADD CONSTRAINT "ppip_record_sent_check" CHECK ("report_id" IS NULL OR "sending_since" IS NULL);--> statement-breakpoint
ALTER TABLE "ppip_record" ADD CONSTRAINT "ppip_record_annulled_check" CHECK ("status" = 'active' OR ("report_id" IS NULL AND "sending_since" IS NULL));--> statement-breakpoint
-- Aggiunto a mano (D232): i dati di una prestazione registrata non cambiano. Cambiano solo
-- l'annullamento, l'invio in corso e il segno dell'invio; una prestazione partita o annullata non
-- cambia più.
CREATE FUNCTION mmg_ppip_record_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.report_id IS NOT NULL THEN
    RAISE EXCEPTION 'La prestazione è già partita con la distinta: la correzione si chiede all''ASL';
  END IF;
  IF OLD.status = 'annulled' THEN
    RAISE EXCEPTION 'La prestazione è annullata: non cambia più';
  END IF;
  IF (NEW.id, NEW.patient_id, NEW.archive_id, NEW.performed_on, NEW.code, NEW.section,
      NEW.description, NEW.authorization_required, NEW.unit_compensation, NEW.dataset_id,
      NEW.quantity, NEW.place, NEW.authorization_ref, NEW.notes, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.patient_id, OLD.archive_id, OLD.performed_on, OLD.code, OLD.section,
      OLD.description, OLD.authorization_required, OLD.unit_compensation, OLD.dataset_id,
      OLD.quantity, OLD.place, OLD.authorization_ref, OLD.notes, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'I dati di una prestazione aggiuntiva non si modificano: si annulla e si registra di nuovo';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER ppip_record_guard BEFORE UPDATE ON ppip_record
  FOR EACH ROW EXECUTE FUNCTION mmg_ppip_record_guard();
