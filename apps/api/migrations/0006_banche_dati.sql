CREATE TABLE "ref_dpc_drug" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_dpc_drug_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"active_ingredient" text NOT NULL,
	"atc" text,
	"aifa_note" text,
	"plan_required" boolean
);
--> statement-breakpoint
CREATE TABLE "ref_drug" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_drug_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"aic" text NOT NULL,
	"name" text,
	"pack" text,
	"active_ingredient" text,
	"atc" text,
	"form" text,
	"supply_regime" text
);
--> statement-breakpoint
CREATE TABLE "ref_drug_class" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_drug_class_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"aic" text NOT NULL,
	"drug_class" text NOT NULL,
	"active_ingredient" text,
	"price" numeric(12, 2),
	"equivalence_group" text,
	"aifa_note" text
);
--> statement-breakpoint
CREATE TABLE "ref_exemption" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_exemption_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ref_exemption_service" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_exemption_service_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"exemption_code" text NOT NULL,
	"service_code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ref_municipality" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_municipality_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"istat_code" text NOT NULL,
	"name" text NOT NULL,
	"region" text,
	"province_abbr" text,
	"cadastral_code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ref_service" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ref_service_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dataset_id" uuid NOT NULL,
	"regional_code" text NOT NULL,
	"national_code" text,
	"description" text NOT NULL,
	"branch" text,
	"fee" numeric(12, 2),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "reference_dataset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"series" text NOT NULL,
	"title" text NOT NULL,
	"mapping_version" text NOT NULL,
	"origin" text NOT NULL,
	"source" text,
	"file_key" text,
	"original_name" text,
	"url" text,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"origin_sha256" text,
	"downloaded_at" timestamp with time zone,
	"valid_from" date NOT NULL,
	"valid_from_basis" text NOT NULL,
	"act" text,
	"transcribed_by" text,
	"transcribed_on" date,
	"checked_by" text,
	"rows" integer NOT NULL,
	"discarded_rows" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_by" text NOT NULL,
	CONSTRAINT "reference_dataset_series_sha256_unique" UNIQUE("series","sha256")
);
--> statement-breakpoint
ALTER TABLE "ref_dpc_drug" ADD CONSTRAINT "ref_dpc_drug_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_drug" ADD CONSTRAINT "ref_drug_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_drug_class" ADD CONSTRAINT "ref_drug_class_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_exemption" ADD CONSTRAINT "ref_exemption_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_exemption_service" ADD CONSTRAINT "ref_exemption_service_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_municipality" ADD CONSTRAINT "ref_municipality_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ref_service" ADD CONSTRAINT "ref_service_dataset_id_reference_dataset_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."reference_dataset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ref_dpc_drug_dataset_id_index" ON "ref_dpc_drug" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "ref_drug_dataset_id_aic_index" ON "ref_drug" USING btree ("dataset_id","aic");--> statement-breakpoint
CREATE INDEX "ref_drug_class_dataset_id_aic_index" ON "ref_drug_class" USING btree ("dataset_id","aic");--> statement-breakpoint
CREATE INDEX "ref_drug_class_dataset_id_equivalence_group_index" ON "ref_drug_class" USING btree ("dataset_id","equivalence_group");--> statement-breakpoint
CREATE INDEX "ref_exemption_dataset_id_code_index" ON "ref_exemption" USING btree ("dataset_id","code");--> statement-breakpoint
CREATE INDEX "ref_exemption_service_dataset_id_exemption_code_index" ON "ref_exemption_service" USING btree ("dataset_id","exemption_code");--> statement-breakpoint
CREATE INDEX "ref_municipality_dataset_id_cadastral_code_index" ON "ref_municipality" USING btree ("dataset_id","cadastral_code");--> statement-breakpoint
CREATE INDEX "ref_service_dataset_id_regional_code_index" ON "ref_service" USING btree ("dataset_id","regional_code");--> statement-breakpoint
CREATE INDEX "reference_dataset_kind_valid_from_index" ON "reference_dataset" USING btree ("kind","valid_from");--> statement-breakpoint
-- Aggiunto a mano: le versioni importate delle banche dati non si modificano e non si cancellano.
CREATE TRIGGER reference_dataset_immutable BEFORE UPDATE OR DELETE ON reference_dataset
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER reference_dataset_no_truncate BEFORE TRUNCATE ON reference_dataset
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
--> statement-breakpoint
CREATE TRIGGER ref_drug_immutable BEFORE UPDATE OR DELETE ON ref_drug
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_drug_no_truncate BEFORE TRUNCATE ON ref_drug
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
--> statement-breakpoint
CREATE TRIGGER ref_drug_class_immutable BEFORE UPDATE OR DELETE ON ref_drug_class
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_drug_class_no_truncate BEFORE TRUNCATE ON ref_drug_class
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
--> statement-breakpoint
CREATE TRIGGER ref_dpc_drug_immutable BEFORE UPDATE OR DELETE ON ref_dpc_drug
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_dpc_drug_no_truncate BEFORE TRUNCATE ON ref_dpc_drug
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
--> statement-breakpoint
CREATE TRIGGER ref_municipality_immutable BEFORE UPDATE OR DELETE ON ref_municipality
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_municipality_no_truncate BEFORE TRUNCATE ON ref_municipality
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
--> statement-breakpoint
CREATE TRIGGER ref_service_immutable BEFORE UPDATE OR DELETE ON ref_service
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_service_no_truncate BEFORE TRUNCATE ON ref_service
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
--> statement-breakpoint
CREATE TRIGGER ref_exemption_immutable BEFORE UPDATE OR DELETE ON ref_exemption
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_exemption_no_truncate BEFORE TRUNCATE ON ref_exemption
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
--> statement-breakpoint
CREATE TRIGGER ref_exemption_service_immutable BEFORE UPDATE OR DELETE ON ref_exemption_service
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si modificano e non si cancellano: si importa una versione nuova');
--> statement-breakpoint
CREATE TRIGGER ref_exemption_service_no_truncate BEFORE TRUNCATE ON ref_exemption_service
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le banche dati importate non si svuotano');
