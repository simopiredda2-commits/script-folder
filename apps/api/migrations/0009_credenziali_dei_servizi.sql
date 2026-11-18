CREATE TYPE "public"."credential_service" AS ENUM('sistema_ts', 'rupar_piemonte');--> statement-breakpoint
ALTER TYPE "public"."send_error_kind" ADD VALUE 'auth';--> statement-breakpoint
CREATE TABLE "service_credential" (
	"user_id" uuid NOT NULL,
	"service" "credential_service" NOT NULL,
	"secret_enc" "bytea" NOT NULL,
	"username_hint" text NOT NULL,
	"password_changed_on" date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_credential_user_id_service_pk" PRIMARY KEY("user_id","service")
);
--> statement-breakpoint
CREATE TABLE "service_credential_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"service" "credential_service" NOT NULL,
	"event" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"workstation" text,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "service_session" (
	"user_id" uuid NOT NULL,
	"service" "credential_service" NOT NULL,
	"token_enc" "bytea" NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_session_user_id_service_pk" PRIMARY KEY("user_id","service")
);
--> statement-breakpoint
ALTER TABLE "service_credential" ADD CONSTRAINT "service_credential_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_credential_event" ADD CONSTRAINT "service_credential_event_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_session" ADD CONSTRAINT "service_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_credential_event_user_id_index" ON "service_credential_event" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "doctor_profile" DROP COLUMN "external_credentials_enc";--> statement-breakpoint
-- Aggiunto a mano: gli eventi sulle credenziali non si modificano, non si cancellano e non si svuotano.
CREATE TRIGGER service_credential_event_immutable BEFORE UPDATE OR DELETE ON service_credential_event
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Gli eventi sulle credenziali non si modificano e non si cancellano');--> statement-breakpoint
CREATE TRIGGER service_credential_event_no_truncate BEFORE TRUNCATE ON service_credential_event
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Gli eventi sulle credenziali non si svuotano');
