CREATE TYPE "public"."siap_access_type" AS ENUM('scheduled', 'direct', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."siap_act_kind" AS ENUM('diary', 'pharma', 'specialist', 'devices', 'sick_leave', 'certificate', 'vaccination', 'ppip', 'choice');--> statement-breakpoint
CREATE TYPE "public"."siap_activity_regime" AS ENUM('choice', 'hourly', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."siap_contact_mode" AS ENUM('office', 'home', 'telemedicine', 'remote', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."siap_contact_status" AS ENUM('confirmed', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."siap_problem_state" AS ENUM('suspected', 'evolving', 'chronic', 'unknown');--> statement-breakpoint
CREATE TABLE "siap_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"occurred_on" date NOT NULL,
	"status" "siap_contact_status" NOT NULL,
	"day_sequence" integer,
	"structure_code" text,
	"structure_type" "structure_type",
	"mode" "siap_contact_mode",
	"regime" "siap_activity_regime",
	"access_type" "siap_access_type",
	"problem_code" text,
	"problem_state" "siap_problem_state",
	"problem_opened_on" date,
	"problem_entry_id" uuid,
	"discard_reason" text,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "siap_contact_day" UNIQUE("patient_id","doctor_id","occurred_on"),
	CONSTRAINT "siap_contact_decided" CHECK (("siap_contact"."status" = 'confirmed' and "siap_contact"."day_sequence" is not null and "siap_contact"."day_sequence" >= 1 and "siap_contact"."mode" is not null and "siap_contact"."regime" is not null and "siap_contact"."access_type" is not null and "siap_contact"."problem_code" is not null and "siap_contact"."problem_state" is not null and "siap_contact"."discard_reason" is null) or ("siap_contact"."status" = 'discarded' and "siap_contact"."day_sequence" is null and "siap_contact"."discard_reason" is not null and length(trim("siap_contact"."discard_reason")) > 0)),
	CONSTRAINT "siap_contact_structure_code" CHECK ("siap_contact"."structure_code" ~ '^[A-Z0-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "siap_contact_act" (
	"contact_id" uuid NOT NULL,
	"kind" "siap_act_kind" NOT NULL,
	"act_id" uuid NOT NULL,
	CONSTRAINT "siap_contact_act_contact_id_kind_act_id_pk" PRIMARY KEY("contact_id","kind","act_id")
);
--> statement-breakpoint
CREATE TABLE "siap_contact_service" (
	"contact_id" uuid NOT NULL,
	"typology" integer NOT NULL,
	"detail" integer NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "siap_contact_service_contact_id_typology_detail_pk" PRIMARY KEY("contact_id","typology","detail"),
	CONSTRAINT "siap_contact_service_quantity" CHECK ("siap_contact_service"."quantity" between 1 and 9)
);
--> statement-breakpoint
ALTER TABLE "siap_contact" ADD CONSTRAINT "siap_contact_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "siap_contact" ADD CONSTRAINT "siap_contact_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "siap_contact" ADD CONSTRAINT "siap_contact_doctor_id_app_user_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "siap_contact" ADD CONSTRAINT "siap_contact_problem_entry_id_clinical_entry_id_fk" FOREIGN KEY ("problem_entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "siap_contact" ADD CONSTRAINT "siap_contact_decided_by_app_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "siap_contact_act" ADD CONSTRAINT "siap_contact_act_contact_id_siap_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."siap_contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "siap_contact_service" ADD CONSTRAINT "siap_contact_service_contact_id_siap_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."siap_contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "siap_contact_sequence" ON "siap_contact" USING btree ("studio_id","occurred_on","day_sequence") WHERE "siap_contact"."day_sequence" is not null;--> statement-breakpoint
CREATE INDEX "siap_contact_doctor_id_occurred_on_index" ON "siap_contact" USING btree ("doctor_id","occurred_on");--> statement-breakpoint
CREATE INDEX "siap_contact_act_kind_act_id_index" ON "siap_contact_act" USING btree ("kind","act_id");--> statement-breakpoint
-- Aggiunto a mano, come per le ricette rosse (0051): storico e divieto di cancellazione dei contatti del SIAP (D291). Uno scartato si riconferma, non si cancella.
CREATE TRIGGER siap_contact_history AFTER INSERT OR UPDATE ON siap_contact
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER siap_contact_no_delete BEFORE DELETE ON siap_contact
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('I contatti del SIAP non si cancellano: si scartano con un motivo');
--> statement-breakpoint
CREATE TRIGGER siap_contact_no_truncate BEFORE TRUNCATE ON siap_contact
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('I contatti del SIAP non si cancellano');
