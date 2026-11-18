ALTER TABLE "prescription" ADD COLUMN "dispensing_state" text;--> statement-breakpoint
ALTER TABLE "prescription" ADD COLUMN "dispensing_checked_at" timestamp with time zone;--> statement-breakpoint
-- Aggiunto a mano: solo gli stati di erogazione previsti (packages/domain, DISPENSING_STATES).
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_dispensing_state_check" CHECK ("dispensing_state" IN ('non_erogata', 'presa_in_carico', 'erogata_in_parte', 'erogata', 'annullata'));
