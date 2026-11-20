CREATE TABLE "ref_supply" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_supply_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"group" text NOT NULL,
	"annex" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ref_supply" ADD CONSTRAINT "ref_supply_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ref_supply_dataset_id_entry_type_index" ON "ref_supply" USING btree ("dataset_id","entry_type");--> statement-breakpoint
-- Aggiunto a mano, come per le altre banche dati (0040): le versioni importate non si toccano.
CREATE TRIGGER ref_supply_immutable BEFORE UPDATE OR DELETE ON ref_supply
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_supply_no_truncate BEFORE TRUNCATE ON ref_supply
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
