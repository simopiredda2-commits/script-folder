-- Sospensione decisa sul server (tappa 14, seconda revisione dei poteri dell'amministratore,
-- problema 7): chi è sospeso da chi gestisce il servizio (pnpm utente:ripristina --sospendi o
-- --rifiuta) non si riattiva dal programma, solo dal server (--riattiva, che toglie il segno).
-- Gli utenti di prima restano come sono (false).
ALTER TABLE "app_user" ADD COLUMN "suspended_by_service" boolean DEFAULT false NOT NULL;