-- Scelte di Simone alla prima fermata (D29, D30): soglie di sicurezza e impostazioni della
-- segreteria per archivio. Generata da drizzle-kit, con l'aggiornamento degli studi esistenti in fondo.
ALTER TABLE "studio" ALTER COLUMN "idle_lock_minutes" SET DEFAULT 5;--> statement-breakpoint
ALTER TABLE "studio" ALTER COLUMN "max_failed_logins" SET DEFAULT 5;--> statement-breakpoint
ALTER TABLE "studio" ALTER COLUMN "failed_login_lock_minutes" SET DEFAULT 15;--> statement-breakpoint
ALTER TABLE "archive" ADD COLUMN "secretary_can_read_diary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "archive" ADD COLUMN "secretary_can_read_summary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "studio" DROP COLUMN "secretary_can_read_diary";--> statement-breakpoint
UPDATE "studio" SET "idle_lock_minutes" = 5 WHERE "idle_lock_minutes" IS NULL;--> statement-breakpoint
UPDATE "studio" SET "max_failed_logins" = 5 WHERE "max_failed_logins" IS NULL;--> statement-breakpoint
UPDATE "studio" SET "failed_login_lock_minutes" = 15 WHERE "failed_login_lock_minutes" IS NULL;
