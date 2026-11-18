CREATE TABLE "prescription_check" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "prescription_check_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"prescription_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rules_version" text NOT NULL,
	"outcome" text NOT NULL,
	"issues" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"confirmed_aifa_notes" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prescription_check" ADD CONSTRAINT "prescription_check_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_check" ADD CONSTRAINT "prescription_check_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prescription_check_prescription_id_index" ON "prescription_check" USING btree ("prescription_id");--> statement-breakpoint
-- Aggiunto a mano: i controlli delle ricette non si modificano e non si cancellano.
CREATE TRIGGER prescription_check_immutable BEFORE UPDATE OR DELETE ON prescription_check
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('I controlli delle ricette non si modificano e non si cancellano');
--> statement-breakpoint
CREATE TRIGGER prescription_check_no_truncate BEFORE TRUNCATE ON prescription_check
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('I controlli delle ricette non si svuotano');
