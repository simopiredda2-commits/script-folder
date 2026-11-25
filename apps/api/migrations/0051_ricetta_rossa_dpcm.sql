CREATE TYPE "public"."dpcm_status" AS ENUM('to_send', 'accepted', 'ok', 'warnings', 'discarded');--> statement-breakpoint
CREATE TABLE "dpcm_prescription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_id" uuid NOT NULL,
	"doctor_user_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"poligrafico" text NOT NULL,
	"nre" text NOT NULL,
	"nre_lot_id" uuid,
	"printed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content" jsonb NOT NULL,
	"status" "dpcm_status" DEFAULT 'to_send' NOT NULL,
	"protocol" text,
	"accepted_at" timestamp with time zone,
	"send_state" integer,
	"messages" jsonb,
	"checked_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"dm_nre" text,
	"dm_cancel_status" text,
	"dm_cancel_attempts" integer DEFAULT 0 NOT NULL,
	"dm_cancel_next_at" timestamp with time zone,
	"dm_cancel_error" text,
	"dm_cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dpcm_prescription" ADD CONSTRAINT "dpcm_prescription_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpcm_prescription" ADD CONSTRAINT "dpcm_prescription_doctor_user_id_app_user_id_fk" FOREIGN KEY ("doctor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpcm_prescription" ADD CONSTRAINT "dpcm_prescription_nre_lot_id_nre_lot_id_fk" FOREIGN KEY ("nre_lot_id") REFERENCES "public"."nre_lot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dpcm_prescription_prescription_key" ON "dpcm_prescription" USING btree ("prescription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dpcm_prescription_poligrafico_key" ON "dpcm_prescription" USING btree ("poligrafico");--> statement-breakpoint
CREATE UNIQUE INDEX "dpcm_prescription_nre_key" ON "dpcm_prescription" USING btree ("nre");--> statement-breakpoint
CREATE INDEX "dpcm_prescription_doctor_user_id_status_index" ON "dpcm_prescription" USING btree ("doctor_user_id","status");--> statement-breakpoint
-- Aggiunto a mano, come per le prestazioni aggiuntive (0040): storico e divieto di cancellazione delle ricette rosse.
CREATE TRIGGER dpcm_prescription_history AFTER INSERT OR UPDATE ON dpcm_prescription
  FOR EACH ROW EXECUTE FUNCTION mmg_record_change();
--> statement-breakpoint
CREATE TRIGGER dpcm_prescription_no_delete BEFORE DELETE ON dpcm_prescription
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('I dati dei pazienti non si cancellano: si annullano con un motivo');
--> statement-breakpoint
CREATE TRIGGER dpcm_prescription_no_truncate BEFORE TRUNCATE ON dpcm_prescription
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('I dati dei pazienti non si cancellano');
