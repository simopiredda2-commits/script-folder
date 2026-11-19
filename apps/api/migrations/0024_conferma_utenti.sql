-- Conferma di un medico titolare (tappa 14): chi ha un ruolo che apre dati dei pazienti, creato
-- dall'amministratore o a cui l'amministratore aggiunge quel ruolo, non entra finché un titolare
-- attivo dello studio non lo conferma. Gli utenti di prima restano come sono (false). Niente
-- storico su app_user (impronta della password e segreto del secondo fattore): richieste, conferme
-- e rifiuti vanno nel registro delle azioni di amministrazione, senza segreti.
ALTER TABLE "app_user" ADD COLUMN "awaiting_confirmation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "confirmation_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "confirmation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "confirmation_issues_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_confirmation_requested_by_app_user_id_fk" FOREIGN KEY ("confirmation_requested_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_confirmed_by_app_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;