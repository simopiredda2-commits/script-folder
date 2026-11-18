# Avanzamento

Stato del lavoro, tappa per tappa. Una sessione nuova riparte da qui e da `CLAUDE.md`.

## Dove siamo

- Branch attivo: `tappe-0-2` (pull request verso `main` da aprire a fine tappa 2).
- Tappa in corso: 0, preparazione.
- Prossimo passo: tappa 1, scheletro.

## Tappe

### Tappa 0 – Preparazione

**Fatto**
- Primo commit su `main` con il solo README.
- Materiali scaricati dal Google Drive di Simone con il connettore Google Drive: 102557 byte, SHA-256 `28464b1d…5cb7`, uguale a quello atteso. Estratti nella radice; lo zip resta fuori dal repository (e `*.zip` è in `.gitignore`).
- Marchio di SCRIPT: `sha256sum -c SHA256SUMS` in `packages/brand/assets/script/` dà OK su tutte le 20 varianti.
- Prove di `sync/` eseguite: 5 prove, tutte verdi (`python3 -m unittest -v test_banche_dati`, Python 3.13).
- `CLAUDE.md`, `.gitignore`, `.env.example`, `docs/decisioni.md`, questo file.
- `scripts/avvio-sessione.sh` registrato come hook SessionStart in `.claude/settings.json`.

**Provato**
- Hook, prima esecuzione: avvia Postgres 16, crea utente `mmg` e database `mmg_dev`, scrive `DATABASE_URL` e `TZ` nel file d'ambiente (2,5 s).
- Hook, seconda esecuzione: nessuna azione, nessuna riga duplicata (0,15 s).
- Hook senza `CLAUDE_CODE_REMOTE=true`: esce subito senza fare nulla.
- Connessione come `mmg` a `mmg_dev` con password: funziona, l'utente ha CREATEDB.

**Non provato**
- La parte dell'hook che installa le dipendenze: alla tappa 0 non c'è ancora un `package.json`. Si prova alla tappa 1.
- L'hook in una sessione nuova vera (avviata da zero dall'ambiente): provato solo lanciandolo a mano.

## Domande per la prossima fermata

Nessuna per ora.

## Cose irreversibili non fatte

Nessuna per ora.

## Registro dei sabotaggi

Ogni controllo nuovo viene rotto apposta per vedere che diventa rosso, poi ripristinato.

| Controllo | Sabotaggio | Rosso? | Ripristinato |
| --- | --- | --- | --- |
