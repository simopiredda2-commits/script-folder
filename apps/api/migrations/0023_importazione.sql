CREATE TABLE "historical_prescription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"archive_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"prescribed_on" date NOT NULL,
	"drug_aic" text,
	"drug_name" text,
	"active_ingredient" text,
	"atc_code" text,
	"quantity" integer,
	"posology_text" text,
	"service_code" text,
	"service_description" text,
	"nre" text,
	"prescriber_name" text,
	"notes" text,
	"source_program" text,
	"import_batch_id" uuid,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"annulled_at" timestamp with time zone,
	"annul_reason" text
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"archive_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" uuid,
	"source_program" text,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"file_size" integer NOT NULL,
	"format" text NOT NULL,
	"destination" text NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"report" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_origin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"archive_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_program" text,
	"format" text NOT NULL,
	"destination" text NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "historical_prescription" ADD CONSTRAINT "historical_prescription_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_prescription" ADD CONSTRAINT "historical_prescription_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_prescription" ADD CONSTRAINT "historical_prescription_import_batch_id_import_batch_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_prescription" ADD CONSTRAINT "historical_prescription_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_profile_id_import_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."import_profile"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_origin" ADD CONSTRAINT "import_origin_batch_id_import_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_origin" ADD CONSTRAINT "import_origin_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_profile" ADD CONSTRAINT "import_profile_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_profile" ADD CONSTRAINT "import_profile_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "historical_prescription_patient_id_prescribed_on_index" ON "historical_prescription" USING btree ("patient_id","prescribed_on");--> statement-breakpoint
CREATE INDEX "import_batch_archive_id_created_at_index" ON "import_batch" USING btree ("archive_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_origin_source_key" ON "import_origin" USING btree ("archive_id","table_name","source_key");--> statement-breakpoint
CREATE INDEX "import_origin_table_name_row_id_index" ON "import_origin" USING btree ("table_name","row_id");--> statement-breakpoint
-- Aggiunto a mano: le ricette passate sono dati dei pazienti (storico, nessuna cancellazione);
-- importazioni e profili hanno lo storico; la provenienza delle righe non si modifica.
CREATE TRIGGER historical_prescription_history AFTER INSERT OR UPDATE ON historical_prescription
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER historical_prescription_no_delete BEFORE DELETE ON historical_prescription
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('I dati dei pazienti non si cancellano: si annullano con un motivo');
--> statement-breakpoint
CREATE TRIGGER historical_prescription_no_truncate BEFORE TRUNCATE ON historical_prescription
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('I dati dei pazienti non si cancellano');
--> statement-breakpoint
CREATE TRIGGER import_profile_history AFTER INSERT OR UPDATE ON import_profile
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER import_profile_no_delete BEFORE DELETE ON import_profile
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Un profilo d''importazione non si cancella: si archivia');
--> statement-breakpoint
CREATE TRIGGER import_batch_history AFTER INSERT OR UPDATE ON import_batch
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER import_batch_no_delete BEFORE DELETE ON import_batch
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Un''importazione non si cancella: resta nella storia');
--> statement-breakpoint
CREATE TRIGGER import_origin_immutable BEFORE UPDATE OR DELETE ON import_origin
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('La provenienza di una riga importata non si modifica');
--> statement-breakpoint
CREATE TRIGGER import_origin_no_truncate BEFORE TRUNCATE ON import_origin
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('La provenienza delle righe importate non si cancella');
