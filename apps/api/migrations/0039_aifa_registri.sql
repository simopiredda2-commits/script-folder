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
CREATE INDEX "ref_drug_registry_dataset_id_atc_index" ON "ref_drug_registry" USING btree ("dataset_id","atc");