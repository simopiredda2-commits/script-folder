CREATE TABLE "ref_drug_registry" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_drug_registry_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"name" text NOT NULL,
	"active_ingredient" text,
	"atc" text,
	"reimbursed_indication" text,
	"condition" text,
	"monitoring_type" text,
	"monitoring_state" text,
	"therapeutic_area" text,
	"monitoring_start" date,
	"sheet_url" text
);
--> statement-breakpoint
ALTER TABLE "ref_drug_registry" ADD CONSTRAINT "ref_drug_registry_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ref_drug_registry_dataset_id_atc_index" ON "ref_drug_registry" USING btree ("dataset_id","atc");--> statement-breakpoint
-- Aggiunto a mano, come le altre banche dati (0006, 0037): le versioni importate non si modificano e non si cancellano.
CREATE TRIGGER ref_drug_registry_immutable BEFORE UPDATE OR DELETE ON ref_drug_registry
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_drug_registry_no_truncate BEFORE TRUNCATE ON ref_drug_registry
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
