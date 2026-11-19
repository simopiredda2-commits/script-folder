ALTER TABLE "aura_link" ADD COLUMN "registry" jsonb;--> statement-breakpoint
ALTER TABLE "aura_link" ADD COLUMN "registry_dismissed" jsonb DEFAULT '{}'::jsonb NOT NULL;