CREATE TYPE "public"."account_lock_reason" AS ENUM('passwords', 'codes');--> statement-breakpoint
CREATE TYPE "public"."login_source_kind" AS ENUM('address', 'workstation');--> statement-breakpoint
CREATE TABLE "account_lock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"studio_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" "account_lock_reason" NOT NULL,
	"failures" integer NOT NULL,
	"locked_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"addresses" text[] NOT NULL,
	"workstations" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_lock_seen" (
	"lock_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_lock_seen_lock_id_user_id_pk" PRIMARY KEY("lock_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "login_source" (
	"kind" "login_source_kind" NOT NULL,
	"source_key" text NOT NULL,
	"failures" integer NOT NULL,
	"last_failure_at" timestamp with time zone NOT NULL,
	"wait_until" timestamp with time zone,
	CONSTRAINT "login_source_kind_source_key_pk" PRIMARY KEY("kind","source_key")
);
--> statement-breakpoint
ALTER TABLE "studio" ALTER COLUMN "max_failed_logins" SET DEFAULT 50;--> statement-breakpoint
ALTER TABLE "studio" ADD COLUMN "max_failed_codes" integer DEFAULT 5;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "failed_codes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_lock" ADD CONSTRAINT "account_lock_studio_id_studio_id_fk" FOREIGN KEY ("studio_id") REFERENCES "public"."studio"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_lock" ADD CONSTRAINT "account_lock_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_lock_seen" ADD CONSTRAINT "account_lock_seen_lock_id_account_lock_id_fk" FOREIGN KEY ("lock_id") REFERENCES "public"."account_lock"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_lock_seen" ADD CONSTRAINT "account_lock_seen_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_lock_studio_id_locked_at_index" ON "account_lock" USING btree ("studio_id","locked_at");--> statement-breakpoint
CREATE INDEX "account_lock_user_id_locked_at_index" ON "account_lock" USING btree ("user_id","locked_at");--> statement-breakpoint
CREATE INDEX "login_source_last_failure_at_index" ON "login_source" USING btree ("last_failure_at");--> statement-breakpoint
-- Aggiunto a mano (D188). La soglia di prima (da 3 a 10, per difetto 5) valeva per le password e per
-- i codici: resta, con il suo valore, per i codici sbagliati; le password sbagliate hanno la soglia
-- alta, 50 (provvisoria, da completare), e prima del blocco le attese per indirizzo e postazione.
-- Uno studio senza soglia (vuota) resta senza, per tutte e due.
UPDATE "studio" SET "max_failed_codes" = "max_failed_logins";
--> statement-breakpoint
UPDATE "studio" SET "max_failed_logins" = 50 WHERE "max_failed_logins" IS NOT NULL;
--> statement-breakpoint
-- Aggiunto a mano: i blocchi del conto e chi li ha visti non si modificano e non si cancellano.
CREATE TRIGGER account_lock_immutable BEFORE UPDATE OR DELETE ON account_lock
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('I blocchi del conto non si modificano e non si cancellano');
--> statement-breakpoint
CREATE TRIGGER account_lock_no_truncate BEFORE TRUNCATE ON account_lock
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('I blocchi del conto non si cancellano');
--> statement-breakpoint
CREATE TRIGGER account_lock_seen_immutable BEFORE UPDATE OR DELETE ON account_lock_seen
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Chi ha visto l''avviso di un blocco non si modifica e non si cancella');
--> statement-breakpoint
CREATE TRIGGER account_lock_seen_no_truncate BEFORE TRUNCATE ON account_lock_seen
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Chi ha visto l''avviso di un blocco non si cancella');
