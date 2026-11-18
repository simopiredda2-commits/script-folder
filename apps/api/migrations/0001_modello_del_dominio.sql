CREATE TYPE "public"."challenge_purpose" AS ENUM('second_factor', 'enroll');--> statement-breakpoint
CREATE TYPE "public"."grant_kind" AS ENUM('substitution', 'group_colleague');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner_doctor', 'secretary', 'substitute_doctor', 'administrator');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('given', 'refused', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."data_source" AS ENUM('aura', 'manual');--> statement-breakpoint
CREATE TYPE "public"."patient_status" AS ENUM('active', 'revoked', 'deceased', 'temporary');--> statement-breakpoint
CREATE TYPE "public"."reminder_channel" AS ENUM('paper', 'email', 'pec', 'sms', 'messaging_app', 'phone', 'fse');--> statement-breakpoint
CREATE TYPE "public"."sex" AS ENUM('M', 'F');--> statement-breakpoint
CREATE TYPE "public"."anamnesis_section" AS ENUM('family', 'physiological', 'remote_pathological', 'pregnancies');--> statement-breakpoint
CREATE TYPE "public"."clinical_entry_kind" AS ENUM('problem', 'diary', 'measurement', 'anamnesis', 'allergy', 'risk_factor', 'examination', 'vaccination', 'lab_result', 'report');--> statement-breakpoint
CREATE TYPE "public"."contact_type" AS ENUM('office', 'home', 'phone', 'televisit');--> statement-breakpoint
CREATE TYPE "public"."entry_status" AS ENUM('active', 'annulled');--> statement-breakpoint
CREATE TYPE "public"."problem_state" AS ENUM('active', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."therapy_kind" AS ENUM('chronic', 'as_needed', 'cycle');--> statement-breakpoint
CREATE TYPE "public"."therapy_status" AS ENUM('active', 'suspended', 'ended');--> statement-breakpoint
CREATE TYPE "public"."appointment_kind" AS ENUM('office', 'home', 'televisit');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('booked', 'done', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."patient_request_kind" AS ENUM('therapy_repeat', 'certificate', 'appointment', 'other');--> statement-breakpoint
CREATE TYPE "public"."patient_request_status" AS ENUM('open', 'in_progress', 'done', 'rejected');--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"password_hash" text NOT NULL,
	"roles" "user_role"[] NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"totp_secret_enc" "bytea",
	"totp_enabled_at" timestamp with time zone,
	"totp_last_step" bigint,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "archive_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"archive_id" uuid NOT NULL,
	"grantee_user_id" uuid NOT NULL,
	"kind" "grant_kind" NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" "challenge_purpose" NOT NULL,
	"workstation" text NOT NULL,
	"pending_secret_enc" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "doctor_profile" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"regional_code" text,
	"asl" text,
	"header_text" text,
	"stamp_text" text,
	"external_credentials_enc" "bytea"
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"workstation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"locked_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" "consent_status" NOT NULL,
	"given_on" date,
	"revoked_on" date,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "delegation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"delegate_name" text NOT NULL,
	"delegate_fiscal_code" text,
	"delegate_phone" text,
	"delegate_email" text,
	"scope" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"revoked_on" date
);
--> statement-breakpoint
CREATE TABLE "exemption" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"code" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"prescription_code" text,
	"source" "data_source" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"label" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"archive_id" uuid NOT NULL,
	"family_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"sex" "sex" NOT NULL,
	"birth_date" date NOT NULL,
	"birth_place_code" text,
	"birth_place_name" text,
	"fiscal_code" text NOT NULL,
	"phone" text,
	"email" text,
	"residence_street" text,
	"residence_number" text,
	"residence_town" text,
	"residence_province" text,
	"residence_postal_code" text,
	"domicile" text,
	"asl" text,
	"district" text,
	"assistance_type" text,
	"status" "patient_status" DEFAULT 'active' NOT NULL,
	"deceased_on" date,
	"death_cause_icd" text,
	"foreign_health_card" text,
	"foreign_institution" text,
	"occupation" text,
	"employment_condition" text,
	"employer_email" text,
	"reminder_channel" "reminder_channel",
	"reminder_contact" text,
	"reminder_channel_chosen_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_choice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"doctor_user_id" uuid NOT NULL,
	"chosen_on" date NOT NULL,
	"expires_on" date,
	"ended_on" date,
	"end_reason" text,
	"source" "data_source" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allergy_detail" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"substance" text NOT NULL,
	"reaction" text,
	"drug_related" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anamnesis_detail" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"section" "anamnesis_section" NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinical_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" "clinical_entry_kind" NOT NULL,
	"occurred_on" date NOT NULL,
	"author_user_id" uuid NOT NULL,
	"notes" text,
	"reserved" boolean DEFAULT false NOT NULL,
	"obscured" boolean DEFAULT false NOT NULL,
	"reminder_on" date,
	"status" "entry_status" DEFAULT 'active' NOT NULL,
	"annulled_at" timestamp with time zone,
	"annulled_by" uuid,
	"annul_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diary_detail" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"contact_type" "contact_type" NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "examination_detail" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"scale" text,
	"score" text
);
--> statement-breakpoint
CREATE TABLE "lab_result_detail" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"analyte" text NOT NULL,
	"value" text NOT NULL,
	"unit" text,
	"reference_low" text,
	"reference_high" text,
	"reference_text" text,
	"service_code" text
);
--> statement-breakpoint
CREATE TABLE "measurement_detail" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"measure" text NOT NULL,
	"value" numeric NOT NULL,
	"unit" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problem_detail" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"icd_code" text,
	"icd_system" text DEFAULT 'ICD-9-CM' NOT NULL,
	"description" text NOT NULL,
	"state" "problem_state" DEFAULT 'active' NOT NULL,
	"onset_on" date,
	"resolved_on" date,
	"open_question" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_detail" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"facility" text
);
--> statement-breakpoint
CREATE TABLE "risk_factor_detail" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"factor" text NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vaccination_detail" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"vaccine" text NOT NULL,
	"lot" text,
	"dose_number" integer,
	"campaign" text
);
--> statement-breakpoint
CREATE TABLE "therapeutic_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"drug_aic" text,
	"drug_name" text NOT NULL,
	"active_ingredient" text,
	"granted_on" date NOT NULL,
	"expires_on" date NOT NULL,
	"center" text,
	"specialist" text,
	"packs_authorized" integer,
	"posology_text" text,
	"paper_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "therapy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"drug_aic" text,
	"drug_name" text NOT NULL,
	"active_ingredient" text,
	"atc" text,
	"drug_class" text,
	"equivalence_group" text,
	"dpc" boolean DEFAULT false NOT NULL,
	"dose" text,
	"dose_unit" text,
	"frequency" text,
	"time_of_day" text,
	"route" text,
	"units_per_day" text,
	"kind" "therapy_kind" NOT NULL,
	"start_on" date NOT NULL,
	"end_on" date,
	"packs_per_prescription" integer DEFAULT 1 NOT NULL,
	"indication_entry_id" uuid,
	"habitual_exemption_code" text,
	"aifa_note" text,
	"therapeutic_plan_id" uuid,
	"suggested_by_name" text,
	"suggested_by_facility" text,
	"suggested_on" date,
	"patient_instructions" text,
	"important" boolean DEFAULT false NOT NULL,
	"reserved" boolean DEFAULT false NOT NULL,
	"not_reimbursable" boolean DEFAULT false NOT NULL,
	"by_active_ingredient" boolean DEFAULT false NOT NULL,
	"not_substitutable" boolean DEFAULT false NOT NULL,
	"not_substitutable_reason" text,
	"multi_prescription" boolean DEFAULT false NOT NULL,
	"suggested_s" boolean DEFAULT false NOT NULL,
	"hospital_h" boolean DEFAULT false NOT NULL,
	"status" "therapy_status" DEFAULT 'active' NOT NULL,
	"suspended_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"patient_id" uuid,
	"doctor_user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"kind" "appointment_kind" NOT NULL,
	"status" "appointment_status" DEFAULT 'booked' NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" "patient_request_kind" NOT NULL,
	"text" text,
	"status" "patient_request_status" DEFAULT 'open' NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_by" uuid
);
--> statement-breakpoint
CREATE TABLE "access_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "access_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"seq" bigint DEFAULT 0 NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"studio_id" uuid,
	"user_id" uuid,
	"patient_id" uuid,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"workstation" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text DEFAULT '' NOT NULL,
	"hash" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "change_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"table_name" text NOT NULL,
	"row_id" text NOT NULL,
	"operation" text NOT NULL,
	"old_row" jsonb,
	"new_row" jsonb
);
--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "secretary_can_read_diary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "idle_lock_minutes" integer;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "max_failed_logins" integer;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "failed_login_lock_minutes" integer;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_grant" ADD CONSTRAINT "archive_grant_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_grant" ADD CONSTRAINT "archive_grant_grantee_user_id_app_user_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_grant" ADD CONSTRAINT "archive_grant_granted_by_app_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_challenge" ADD CONSTRAINT "auth_challenge_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_profile" ADD CONSTRAINT "doctor_profile_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegation" ADD CONSTRAINT "delegation_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exemption" ADD CONSTRAINT "exemption_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family" ADD CONSTRAINT "family_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_archive_id_archive_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."archive"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."family"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_choice" ADD CONSTRAINT "patient_choice_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_choice" ADD CONSTRAINT "patient_choice_doctor_user_id_app_user_id_fk" FOREIGN KEY ("doctor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allergy_detail" ADD CONSTRAINT "allergy_detail_entry_id_clinical_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anamnesis_detail" ADD CONSTRAINT "anamnesis_detail_entry_id_clinical_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_entry_id_clinical_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_entry" ADD CONSTRAINT "clinical_entry_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_entry" ADD CONSTRAINT "clinical_entry_author_user_id_app_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_entry" ADD CONSTRAINT "clinical_entry_annulled_by_app_user_id_fk" FOREIGN KEY ("annulled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_detail" ADD CONSTRAINT "diary_detail_entry_id_clinical_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_detail" ADD CONSTRAINT "examination_detail_entry_id_clinical_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_result_detail" ADD CONSTRAINT "lab_result_detail_entry_id_clinical_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_detail" ADD CONSTRAINT "measurement_detail_entry_id_clinical_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_detail" ADD CONSTRAINT "problem_detail_entry_id_clinical_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_detail" ADD CONSTRAINT "report_detail_entry_id_clinical_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_factor_detail" ADD CONSTRAINT "risk_factor_detail_entry_id_clinical_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaccination_detail" ADD CONSTRAINT "vaccination_detail_entry_id_clinical_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "therapeutic_plan" ADD CONSTRAINT "therapeutic_plan_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "therapy" ADD CONSTRAINT "therapy_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "therapy" ADD CONSTRAINT "therapy_indication_entry_id_clinical_entry_id_fk" FOREIGN KEY ("indication_entry_id") REFERENCES "public"."clinical_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "therapy" ADD CONSTRAINT "therapy_therapeutic_plan_id_therapeutic_plan_id_fk" FOREIGN KEY ("therapeutic_plan_id") REFERENCES "public"."therapeutic_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "therapy" ADD CONSTRAINT "therapy_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_doctor_user_id_app_user_id_fk" FOREIGN KEY ("doctor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_request" ADD CONSTRAINT "patient_request_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_request" ADD CONSTRAINT "patient_request_handled_by_app_user_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_log" ADD CONSTRAINT "access_log_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_log" ADD CONSTRAINT "access_log_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_log" ADD CONSTRAINT "access_log_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_username_key" ON "app_user" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_challenge_token_hash_key" ON "auth_challenge" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_hash_key" ON "session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "session_user_id_index" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_studio_fiscal_code_key" ON "patient" USING btree ("studio_id","fiscal_code");--> statement-breakpoint
CREATE INDEX "patient_archive_id_index" ON "patient" USING btree ("archive_id");--> statement-breakpoint
CREATE INDEX "patient_last_name_first_name_index" ON "patient" USING btree ("last_name","first_name");--> statement-breakpoint
CREATE INDEX "clinical_entry_patient_id_occurred_on_index" ON "clinical_entry" USING btree ("patient_id","occurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "access_log_seq_key" ON "access_log" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "access_log_patient_id_at_index" ON "access_log" USING btree ("patient_id","at");--> statement-breakpoint
CREATE INDEX "access_log_user_id_at_index" ON "access_log" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "change_history_table_name_row_id_index" ON "change_history" USING btree ("table_name","row_id");