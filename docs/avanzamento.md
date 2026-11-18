# Avanzamento

Stato del lavoro, tappa per tappa. Una sessione nuova riparte da qui e da `CLAUDE.md`.

## Dove siamo

- Branch attivo: `tappe-0-2` (pull request verso `main` da aprire a fine tappa 2).
- Tappe fatte: 0, 1.
- Prossimo passo: tappa 2, modello, ruoli e accesso; poi la prima fermata.

## Come provarlo

```sh
pnpm install          # in cloud lo fa l'hook di avvio
pnpm test             # prove TypeScript e prove di sync/
pnpm lint             # ESLint, Prettier, tipi
pnpm dev              # migrazioni, servizio su :3001, interfaccia su :5173
pnpm fixtures -- --seed 1 --count 5
```

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
- Hook e dipendenze (provato alla tappa 1): installa se mancano le impronte, salta se nulla è cambiato (0,17 s), reinstalla quando cambia un `package.json`. Impronte su 9 file: lo script, i `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`.

**Non provato**

- L'hook in una sessione nuova vera, avviata da zero dall'ambiente: provato solo lanciandolo a mano.

### Tappa 1 – Scheletro

**Fatto**

- Monorepo pnpm: `apps/api`, `apps/web`, `packages/brand`, `packages/domain`, `fixtures`. `packages/rules` e `packages/integrations` arrivano con le tappe 3 e 4.
- Lint (ESLint 10 con controllo dei tipi), formattazione (Prettier), tipi (TypeScript 6), prove (Vitest 5), CI su GitHub Actions con Postgres 16 e prove di `sync/`.
- `packages/brand`: `brand.ts` con `PRODUCT_NAME` e `COMPANY_BRAND`; token di SCRIPT e dell'interfaccia (`tokens.ts`, `tokens.css` generato); caratteri da `@fontsource` (`fonts.css`); marchio di SCRIPT; segno di oggi (`mark.ts`).
- Guardia sul nome del prodotto: cerca in `apps/`, `packages/`, `sync/`, `fixtures/` e `scripts/`, nei percorsi e nei contenuti; unica eccezione `packages/brand`. Ha già trovato un caso vero (`migrationsFolder` di Drizzle, vedi D9).
- `apps/api`: Fastify, Postgres con Drizzle, prima migrazione (tabella `studio`), esecutore delle migrazioni con controllo delle impronte, stato di salute `/api/salute`.
- `apps/web`: React e Vite, segno di oggi con il nome da `PRODUCT_NAME`, «by SCRIPT» con il simbolo ufficiale, caratteri serviti dal nostro dominio.
- `packages/domain`: codice fiscale (costruzione e controllo formale) dal DM 23/12/1976, testo letto su def.finanze.it.
- `fixtures/`: generatore deterministico di pazienti inventati, con codici fiscali che non possono essere di persone reali (D12).
- Proposte di logo: tre proposte e il segno di oggi in `packages/brand/assets/proposte-logo/`, pagina `docs/logo.md`. Consigliata la B.
- `scripts/sabotaggio.sh` per provare i controlli.

**Provato**

- 170 prove verdi in TypeScript (10 file) e 5 in Python; `pnpm lint` verde.
- `pnpm dev`: migrazioni applicate a `mmg_dev`, `/api/salute` risponde `{"stato":"ok"}` direttamente e attraverso il proxy dell'interfaccia; la pagina ha il titolo preso da `brand.ts`.
- Proposte di logo guardate in Chromium alle misure reali (16, 32, 64 px) su fondo chiaro e scuro.

**Non provato**

- La CI su GitHub: si vede al primo push (questo).
- `sync/` con Python 3.12 (la versione della CI): provato in locale con la 3.13.
- La verifica della lettera X sul file ISTAT dei comuni: alla tappa 5, e comunque con un file d'esempio; il file vero si scarica solo da un computer dello studio.

## Domande per la prossima fermata

1. **Logo**: quale proposta (A, B, C) o nessuna; consigliata la B. Pagina: `docs/logo.md`.

## Cose irreversibili non fatte

Nessuna per ora.

## Registro dei sabotaggi

Ogni controllo nuovo viene rotto apposta (`scripts/sabotaggio.sh`), deve diventare rosso, poi viene ripristinato e deve tornare verde.

| Controllo                                 | Sabotaggio                                         | Esito                                                                                                                                                                              |
| ----------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Impronte del marchio di SCRIPT            | Un colore cambiato in `script_simbolo.svg`         | Rosso, poi verde                                                                                                                                                                   |
| Nessun file estraneo nel marchio          | Aggiunto `intruso.svg`                             | Rosso, poi verde                                                                                                                                                                   |
| Nome del prodotto nel codice              | Parola scritta in un file di `apps/web`            | Rosso, poi verde                                                                                                                                                                   |
| Nome del prodotto nei percorsi            | File con il nome in `sync/`                        | Rosso, poi verde                                                                                                                                                                   |
| `tokens.css` allineato                    | Un colore cambiato a mano in `tokens.css`          | Rosso, poi verde                                                                                                                                                                   |
| Colori di SCRIPT come nei file ufficiali  | Luce cambiata in `tokens.ts`                       | Rosso, poi verde                                                                                                                                                                   |
| Contrasti AA                              | Testo secondario reso grigio chiaro                | Rosso, poi verde                                                                                                                                                                   |
| Caratteri senza CDN (`fonts.css`)         | Aggiunto un `@import` da Google Fonts              | Rosso, poi verde                                                                                                                                                                   |
| Migrazioni da zero                        | `CREATE TABLE` rinominato nella migrazione         | Rosso, poi verde                                                                                                                                                                   |
| Schema allineato alle migrazioni          | Colonna aggiunta allo schema senza migrazione      | Rosso, poi verde                                                                                                                                                                   |
| Prove del database senza `DATABASE_URL`   | Variabile tolta                                    | Rosso (le prove falliscono, non saltano)                                                                                                                                           |
| Migrazione modificata dopo l'applicazione | Controllo dell'impronta disattivato nell'esecutore | Rosso, poi verde                                                                                                                                                                   |
| Nessuna CDN nell'interfaccia compilata    | `@import` da Google Fonts nel CSS dell'interfaccia | Rosso, poi verde                                                                                                                                                                   |
| Titolo della pagina da `brand.ts`         | Titolo scritto a mano in `vite.config.ts`          | Rosso, poi verde                                                                                                                                                                   |
| Tabella dei caratteri dispari (art. 7)    | Valore di A cambiato                               | **Rimasto verde la prima volta**: la prova non copriva A in posizione dispari. Aggiunto il confronto con il testo del decreto e il controllo di permutazione; poi rosso, poi verde |
| Valori dei caratteri pari (art. 7)        | Spostamento di 1 nel calcolo                       | Rosso, poi verde                                                                                                                                                                   |
| Generatore deterministico                 | `Math.random()` al posto del generatore con seme   | Rosso, poi verde                                                                                                                                                                   |
| Codici fiscali non reali                  | Luogo di nascita con la L                          | Rosso, poi verde                                                                                                                                                                   |
| Email che non arrivano a nessuno          | Dominio `gmail.com`                                | Rosso, poi verde                                                                                                                                                                   |
| Logo senza testo                          | `<text>` aggiunto a un SVG                         | Rosso, poi verde                                                                                                                                                                   |
| Logo piatto                               | Sfumatura aggiunta                                 | Rosso, poi verde                                                                                                                                                                   |
| Logo nei colori ammessi                   | Colore rosso                                       | Rosso, poi verde                                                                                                                                                                   |
| Logo con estremi arrotondati              | `stroke-linecap="butt"`                            | Rosso, poi verde                                                                                                                                                                   |
| Simbolo di SCRIPT fuori dal logo          | Poligono aggiunto                                  | Rosso, poi verde                                                                                                                                                                   |
