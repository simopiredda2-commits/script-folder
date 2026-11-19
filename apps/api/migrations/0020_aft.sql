CREATE TABLE "aft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"asl" text,
	"code" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aft_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aft_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"invited_by" uuid,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"sharing" boolean DEFAULT false NOT NULL,
	"sharing_changed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "aft" ADD CONSTRAINT "aft_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aft_member" ADD CONSTRAINT "aft_member_aft_id_aft_id_fk" FOREIGN KEY ("aft_id") REFERENCES "public"."aft"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aft_member" ADD CONSTRAINT "aft_member_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aft_member" ADD CONSTRAINT "aft_member_invited_by_app_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aft_member_open_key" ON "aft_member" USING btree ("aft_id","user_id") WHERE "aft_member"."left_at" is null and "aft_member"."declined_at" is null;--> statement-breakpoint
-- Aggiunto a mano: storico di ogni modifica e divieto di cancellazione per AFT e membri. Chi
-- esce dall'AFT resta nella storia con la data d'uscita; la condivisione si spegne, non si cancella.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['aft', 'aft_member'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION mmg_record_change()',
      t || '_history', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change(%L)',
      t || '_no_delete', t, 'Non si cancella: si esce dall''AFT con una data');
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change(%L)',
      t || '_no_truncate', t, 'Non si cancella');
  END LOOP;
END $$;
