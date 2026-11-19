CREATE TABLE "ref_drug_shortage" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_drug_shortage_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"aic" text NOT NULL,
	"name" text,
	"active_ingredient" text,
	"form_strength" text,
	"holder" text,
	"start_on" date,
	"expected_end_on" date,
	"equivalent_available" boolean,
	"reason" text,
	"aifa_advice" text,
	"aifa_note" text,
	"reimbursement_class" text,
	"atc" text
);
--> statement-breakpoint
CREATE TABLE "ref_drug_transparency" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_drug_transparency_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"aic" text NOT NULL,
	"active_ingredient" text,
	"reference_pack" text,
	"atc" text,
	"name" text,
	"pack" text,
	"holder" text,
	"reference_price" numeric(12, 2),
	"public_price" numeric(12, 2),
	"price_difference" numeric(12, 2),
	"remark" text,
	"equivalence_group" text
);
--> statement-breakpoint
ALTER TABLE "ref_drug_shortage" ADD CONSTRAINT "ref_drug_shortage_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_drug_transparency" ADD CONSTRAINT "ref_drug_transparency_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ref_drug_shortage_dataset_id_aic_index" ON "ref_drug_shortage" USING btree ("dataset_id","aic");--> statement-breakpoint
CREATE INDEX "ref_drug_transparency_dataset_id_aic_index" ON "ref_drug_transparency" USING btree ("dataset_id","aic");--> statement-breakpoint
CREATE INDEX "ref_drug_transparency_dataset_id_equivalence_group_index" ON "ref_drug_transparency" USING btree ("dataset_id","equivalence_group");--> statement-breakpoint
-- Aggiunto a mano, come le altre banche dati (0006): le versioni importate non si modificano e non si cancellano.
CREATE TRIGGER ref_drug_transparency_immutable BEFORE UPDATE OR DELETE ON ref_drug_transparency
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_drug_transparency_no_truncate BEFORE TRUNCATE ON ref_drug_transparency
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
--> statement-breakpoint
CREATE TRIGGER ref_drug_shortage_immutable BEFORE UPDATE OR DELETE ON ref_drug_shortage
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_drug_shortage_no_truncate BEFORE TRUNCATE ON ref_drug_shortage
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
