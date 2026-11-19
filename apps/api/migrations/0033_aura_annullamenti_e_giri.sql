CREATE TABLE "aura_sync_run_studio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"studio_id" uuid NOT NULL,
	"patients" integer DEFAULT 0 NOT NULL,
	"changed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exemption" ADD COLUMN "annulled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exemption" ADD COLUMN "annulled_by" uuid;--> statement-breakpoint
ALTER TABLE "exemption" ADD COLUMN "annul_reason" text;--> statement-breakpoint
ALTER TABLE "patient_choice" ADD COLUMN "annulled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patient_choice" ADD COLUMN "annulled_by" uuid;--> statement-breakpoint
ALTER TABLE "patient_choice" ADD COLUMN "annul_reason" text;--> statement-breakpoint
ALTER TABLE "aura_sync_run_studio" ADD CONSTRAINT "aura_sync_run_studio_run_id_aura_sync_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."aura_sync_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aura_sync_run_studio" ADD CONSTRAINT "aura_sync_run_studio_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aura_sync_run_studio_run_id_studio_id_index" ON "aura_sync_run_studio" USING btree ("run_id","studio_id");--> statement-breakpoint
ALTER TABLE "exemption" ADD CONSTRAINT "exemption_annulled_by_app_user_id_fk" FOREIGN KEY ("annulled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_choice" ADD CONSTRAINT "patient_choice_annulled_by_app_user_id_fk" FOREIGN KEY ("annulled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Annullamento completo (D197): data e motivo insieme, oppure niente; l'autore resta vuoto solo
-- se ha annullato il controllo su AURA.
ALTER TABLE "exemption" ADD CONSTRAINT "exemption_annulment_complete" CHECK (
  (annulled_at IS NULL AND annulled_by IS NULL AND annul_reason IS NULL)
  OR (annulled_at IS NOT NULL AND coalesce(trim(annul_reason), '') <> '')
);
--> statement-breakpoint
ALTER TABLE "patient_choice" ADD CONSTRAINT "patient_choice_annulment_complete" CHECK (
  (annulled_at IS NULL AND annulled_by IS NULL AND annul_reason IS NULL)
  OR (annulled_at IS NOT NULL AND coalesce(trim(annul_reason), '') <> '')
);
--> statement-breakpoint
-- Una riga annullata non si modifica più: resta com'era quando è stata annullata.
CREATE FUNCTION mmg_annulled_row_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.annulled_at IS NOT NULL THEN
    PERFORM mmg_forbid(TG_ARGV[0]);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER exemption_annulled_guard BEFORE UPDATE ON exemption
  FOR EACH ROW EXECUTE FUNCTION mmg_annulled_row_guard('L''esenzione annullata non si modifica');
--> statement-breakpoint
CREATE TRIGGER patient_choice_annulled_guard BEFORE UPDATE ON patient_choice
  FOR EACH ROW EXECUTE FUNCTION mmg_annulled_row_guard('La scelta annullata non si modifica');
--> statement-breakpoint
-- Collegamento con AURA (dati del paziente): storico quando cambia lo stato (identificativo, esito,
-- motivo), non a ogni controllo di ogni notte; non si cancella.
CREATE TRIGGER aura_link_history AFTER INSERT ON aura_link
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER aura_link_history_update AFTER UPDATE ON aura_link
  FOR EACH ROW
  WHEN (OLD.aura_id IS DISTINCT FROM NEW.aura_id
    OR OLD.outcome IS DISTINCT FROM NEW.outcome
    OR OLD.message IS DISTINCT FROM NEW.message)
  EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER aura_link_no_delete BEFORE DELETE ON aura_link
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('I dati dei pazienti non si cancellano');
--> statement-breakpoint
CREATE TRIGGER aura_link_no_truncate BEFORE TRUNCATE ON aura_link
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('I dati dei pazienti non si cancellano');
