-- Le credenziali del medico per i servizi della regione si conservano con la chiave che dà il
-- pacchetto della regione (D301): il tipo enumerato, che nominava una regione, diventa testo con la
-- forma di una chiave. I valori restano come sono, così utente, password e PIN già cifrati con la
-- loro chiave si aprono ancora.
ALTER TABLE "service_credential" ALTER COLUMN "service" SET DATA TYPE text USING "service"::text;--> statement-breakpoint
ALTER TABLE "service_credential_event" ALTER COLUMN "service" SET DATA TYPE text USING "service"::text;--> statement-breakpoint
ALTER TABLE "service_session" ALTER COLUMN "service" SET DATA TYPE text USING "service"::text;--> statement-breakpoint
-- La richiesta di accesso con SPID o CIE dice di quale servizio è. Quelle di prima erano tutte
-- dell'unico accesso regionale che c'era, quello delle credenziali RUPAR.
ALTER TABLE "regional_authorization_request" ADD COLUMN "service" text NOT NULL DEFAULT 'rupar_piemonte';--> statement-breakpoint
ALTER TABLE "regional_authorization_request" ALTER COLUMN "service" DROP DEFAULT;--> statement-breakpoint
-- Il client_id per cui la regione ha dato il token: la revoca lo ripete.
ALTER TABLE "service_session" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "regional_authorization_request" ADD CONSTRAINT "regional_authorization_request_service" CHECK ("regional_authorization_request"."service" ~ '^[a-z][a-z0-9_]{1,39}$');--> statement-breakpoint
ALTER TABLE "service_credential" ADD CONSTRAINT "service_credential_service" CHECK ("service_credential"."service" ~ '^[a-z][a-z0-9_]{1,39}$');--> statement-breakpoint
ALTER TABLE "service_credential_event" ADD CONSTRAINT "service_credential_event_service" CHECK ("service_credential_event"."service" ~ '^[a-z][a-z0-9_]{1,39}$');--> statement-breakpoint
ALTER TABLE "service_session" ADD CONSTRAINT "service_session_service" CHECK ("service_session"."service" ~ '^[a-z][a-z0-9_]{1,39}$');--> statement-breakpoint
DROP TYPE "public"."credential_service";
