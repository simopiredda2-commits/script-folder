CREATE TABLE "aft_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aft_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"doctor_user_id" uuid NOT NULL,
	"performed_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aft_activity" ADD CONSTRAINT "aft_activity_aft_id_aft_id_fk" FOREIGN KEY ("aft_id") REFERENCES "public"."aft"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aft_activity" ADD CONSTRAINT "aft_activity_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aft_activity" ADD CONSTRAINT "aft_activity_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aft_activity" ADD CONSTRAINT "aft_activity_doctor_user_id_app_user_id_fk" FOREIGN KEY ("doctor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aft_activity_patient_id_performed_at_index" ON "aft_activity" USING btree ("patient_id","performed_at");--> statement-breakpoint
CREATE INDEX "aft_activity_owner_user_id_performed_at_index" ON "aft_activity" USING btree ("owner_user_id","performed_at");--> statement-breakpoint
-- Aggiunto a mano: il registro di AFT ha lo storico e non si modifica né si cancella.
CREATE TRIGGER aft_activity_history AFTER INSERT ON aft_activity
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER aft_activity_immutable BEFORE UPDATE OR DELETE ON aft_activity
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Il registro di AFT non si modifica: una correzione è una riga nuova');
--> statement-breakpoint
CREATE TRIGGER aft_activity_no_truncate BEFORE TRUNCATE ON aft_activity
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Non si cancella');
