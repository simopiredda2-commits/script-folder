-- Passaggio d'accesso fra password e codice (tappa 14, dopo la revisione dei poteri
-- dell'amministratore): conta i codici sbagliati, e arrivati ai tentativi dello studio il
-- passaggio si chiude. I passaggi già aperti partono da zero; durano 5 minuti (D19).
ALTER TABLE "auth_challenge" ADD COLUMN "failed_codes" integer DEFAULT 0 NOT NULL;