CREATE TABLE "aura_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"change" text NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"trigger" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aura_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"aura_id" text,
	"checked_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"message" text,
	"updated_at" timestamp with time zone,
	CONSTRAINT "aura_link_patientId_unique" UNIQUE("patient_id")
);
--> statement-breakpoint
CREATE TABLE "aura_sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"patients" integer DEFAULT 0 NOT NULL,
	"changed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"message" text
);
--> statement-breakpoint
ALTER TABLE "aura_change" ADD CONSTRAINT "aura_change_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aura_change" ADD CONSTRAINT "aura_change_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aura_link" ADD CONSTRAINT "aura_link_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aura_change_studio_id_at_index" ON "aura_change" USING btree ("studio_id","at");--> statement-breakpoint
CREATE INDEX "aura_change_patient_id_at_index" ON "aura_change" USING btree ("patient_id","at");--> statement-breakpoint
CREATE TRIGGER aura_change_immutable BEFORE UPDATE OR DELETE ON aura_change
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Le variazioni arrivate da AURA non si modificano e non si cancellano');
--> statement-breakpoint
CREATE TRIGGER aura_change_no_truncate BEFORE TRUNCATE ON aura_change
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Le variazioni arrivate da AURA non si cancellano');
