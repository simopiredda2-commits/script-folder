CREATE TABLE "ref_diagnosis" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_diagnosis_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"parent_code" text,
	"included_terms" text,
	"notes" text,
	"chapter" text,
	"section" text
);
--> statement-breakpoint
ALTER TABLE "ref_diagnosis" ADD CONSTRAINT "ref_diagnosis_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ref_diagnosis_dataset_id_code_index" ON "ref_diagnosis" USING btree ("dataset_id","code");--> statement-breakpoint
-- Aggiunto a mano, come le altre banche dati (0006): le versioni importate non si modificano e non si cancellano.
CREATE TRIGGER ref_diagnosis_immutable BEFORE UPDATE OR DELETE ON ref_diagnosis
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_diagnosis_no_truncate BEFORE TRUNCATE ON ref_diagnosis
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
