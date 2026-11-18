# Decisioni

Le scelte prese senza Simone, ognuna con il motivo. Se una non va bene, si cambia: ognuna dice anche cosa toccare.

| # | Data | Tappa | Scelta | Motivo |
| --- | --- | --- | --- | --- |
| D1 | 18/11/2026 | 0 | Branch dei blocchi: `tappe-0-2`, `tappe-3-4`, `tappe-5-6`, ognuno con la sua pull request verso `main` | Nomi che dicono cosa contengono. Il branch di sessione assegnato dall'ambiente non aveva commit e non serve. |
| D2 | 18/11/2026 | 0 | Hook di avvio in `scripts/avvio-sessione.sh`, sincrono, impronte delle dipendenze in `node_modules/.avvio-sessione.sha256` | Percorso richiesto da Simone. Sincrono: la sessione parte solo con database e dipendenze pronti, niente corse. Le impronte dentro `node_modules` spariscono con i pacchetti, quindi non si salta mai un'installazione necessaria. |
| D3 | 18/11/2026 | 0 | Credenziali locali del database: utente `mmg`, password `mmg`, con permesso CREATEDB | Solo sviluppo su macchina locale o in cloud, non un segreto. CREATEDB serve ai test, che creano e cancellano database temporanei per provare le migrazioni da zero. |
| D4 | 18/11/2026 | 0 | Prefisso dei pacchetti interni: `@mmg/` (`@mmg/brand`, `@mmg/domain`, …) | Il nome del prodotto non può stare fuori da `packages/brand` (regola 6); `mmg` descrive il dominio ed è coerente con utente e database. |
| D5 | 18/11/2026 | 0 | TypeScript 6.0 e non 7.0 | typescript-eslint 8.73 (l'ultima) dichiara `typescript >=4.8.4 <6.1.0`: con la 7 il lint con controllo dei tipi non è supportato. Si passa alla 7 quando typescript-eslint la supporta. |
| D6 | 18/11/2026 | 0 | ESLint 9 (ramo di manutenzione 9.39) e non 10 | Più diffuso e stabile; i plugin per React e accessibilità sono provati sulla 9. |
