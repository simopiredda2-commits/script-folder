CREATE TYPE "public"."studio_list_kind" AS ENUM('suggeritore', 'posologia', 'pacchetto', 'contatto');--> statement-breakpoint
CREATE TABLE "print_setting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"workstation_id" uuid,
	"document_kind" text NOT NULL,
	"printer_name" text,
	"paper" text,
	"copies" integer DEFAULT 1 NOT NULL,
	"reminder_variant" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "studio_list_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"kind" "studio_list_kind" NOT NULL,
	"label" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workstation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"name" text NOT NULL,
	"shared" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "municipality" text;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "province" text;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "pec" text;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "header_text" text;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "send_timeout_seconds" integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "alert_daily_records" integer;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "alert_night_from_hour" integer;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "alert_night_to_hour" integer;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "alert_aft_daily" integer;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_setting" ADD CONSTRAINT "print_setting_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_setting" ADD CONSTRAINT "print_setting_workstation_id_workstation_id_fk" FOREIGN KEY ("workstation_id") REFERENCES "public"."workstation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_setting" ADD CONSTRAINT "print_setting_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_list_item" ADD CONSTRAINT "studio_list_item_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_list_item" ADD CONSTRAINT "studio_list_item_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstation" ADD CONSTRAINT "workstation_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "print_setting_key" ON "print_setting" USING btree ("studio_id",coalesce("workstation_id", '00000000-0000-0000-0000-000000000000'::uuid),"document_kind");--> statement-breakpoint
CREATE INDEX "studio_list_item_studio_id_kind_index" ON "studio_list_item" USING btree ("studio_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "workstation_name_key" ON "workstation" USING btree ("studio_id",lower("name")) WHERE "workstation"."archived_at" is null;--> statement-breakpoint
-- Aggiunto a mano: storico delle modifiche dei dati dello studio, delle autorizzazioni sugli
-- archivi e delle tabelle nuove. Non su app_user: la riga contiene l'impronta della password e il
-- segreto del secondo fattore; le modifiche degli utenti vanno nel registro delle azioni di
-- amministrazione, senza segreti (tappa 14).
CREATE TRIGGER studio_history AFTER INSERT OR UPDATE ON studio
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER archive_grant_history AFTER INSERT OR UPDATE ON archive_grant
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER archive_grant_no_delete BEFORE DELETE ON archive_grant
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Un''autorizzazione non si cancella: si revoca');
--> statement-breakpoint
CREATE TRIGGER workstation_history AFTER INSERT OR UPDATE ON workstation
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER workstation_no_delete BEFORE DELETE ON workstation
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Una postazione non si cancella: si archivia');
--> statement-breakpoint
CREATE TRIGGER print_setting_history AFTER INSERT OR UPDATE ON print_setting
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER studio_list_item_history AFTER INSERT OR UPDATE ON studio_list_item
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER studio_list_item_no_delete BEFORE DELETE ON studio_list_item
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Una voce degli elenchi non si cancella: si archivia');
