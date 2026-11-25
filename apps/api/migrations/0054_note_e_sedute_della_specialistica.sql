CREATE TABLE "ref_service_note" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_service_note_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"national_code" text NOT NULL,
	"note" text NOT NULL,
	"note_kind" text NOT NULL,
	"note_text" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "service_note" text;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "service_note_kind" text;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "service_note_letter" text;--> statement-breakpoint
ALTER TABLE "prescription_line" ADD COLUMN "sessions" integer;--> statement-breakpoint
ALTER TABLE "ref_service" ADD COLUMN "cycle" boolean;--> statement-breakpoint
ALTER TABLE "ref_service" ADD COLUMN "sessions" integer;--> statement-breakpoint
ALTER TABLE "ref_service_note" ADD CONSTRAINT "ref_service_note_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ref_service_note_dataset_id_national_code_index" ON "ref_service_note" USING btree ("dataset_id","national_code");--> statement-breakpoint
-- Aggiunto a mano, come per le altre banche dati (0040, 0041): le versioni importate non si toccano.
CREATE TRIGGER ref_service_note_immutable BEFORE UPDATE OR DELETE ON ref_service_note
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_service_note_no_truncate BEFORE TRUNCATE ON ref_service_note
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
