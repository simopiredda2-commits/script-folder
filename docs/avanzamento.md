# Avanzamento

Stato del lavoro, tappa per tappa. Una sessione nuova riparte da qui e da `CLAUDE.md`.

## Dove siamo

- Branch attivo: `tappe-0-2`, con la pull request verso `main` aperta per la prima fermata.
- Tappe fatte: 0, 1, 2.
- **Prima fermata fatta**: risposte qui sotto. Si applicano su `tappe-0-2`, si unisce la pull request #1 e si parte con la tappa 3 su `tappe-3-4`.

## Come provarlo

```sh
pnpm install          # in cloud lo fa l'hook di avvio
pnpm test             # prove TypeScript e prove di sync/
pnpm lint             # ESLint, Prettier, tipi
pnpm dev              # migrazioni, servizio su :3001, interfaccia su :5173
pnpm db:seed          # dati dimostrativi inventati; stampa una volta le password
pnpm fixtures -- --seed 1 --count 5
```

Per provare l'accesso a mano: `pnpm db:seed`, poi `POST /api/accesso` con utente, password e postazione; la risposta dà il segreto da inserire in un'app di autenticazione; poi `POST /api/accesso/codice` con il codice. L'interfaccia di accesso arriva alla tappa 6.

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

### Tappa 2 – Modello, ruoli e accesso

**Fatto**

- Modello dei dati completo per la cartella (30 tabelle nuove): studio, utenti con più ruoli, profilo medico, archivi, autorizzazioni (sostituzione e medicina di gruppo), sessioni, pazienti, famiglie, scelte, esenzioni, consensi, deleghe, voci cliniche con un dettaglio per tipo e allegati, terapie con tutte le opzioni della scheda, piani terapeutici, appuntamenti, richieste. Descritto in `docs/modello-dati.md`.
- Migrazione scritta a mano (`0002_registro_e_storico.sql`): registro degli accessi non modificabile con catena di impronte, storico delle modifiche con l'utente, divieto di cancellare i dati dei pazienti.
- Ruoli e permessi come regole in `packages/domain/src/permissions.ts`; matrice generata in `docs/ruoli-permessi.md`.
- Accesso: password (scrypt) e secondo fattore TOTP obbligatorio per tutti, attivato al primo accesso; segreti cifrati con AES-256-GCM; blocco per inattività e per tentativi falliti con soglie da completare; sblocco con password; uscita.
- Guardia unica sui dati dei pazienti: decide e registra prima di restituire dati, anche quando nega.
- Esportazione completa dell'archivio in JSON (`docs/esportazione.md`).
- Dati dimostrativi (`pnpm db:seed`) e chiave di cifratura di sviluppo creata dall'hook.

**Provato**

- 301 prove TypeScript verdi (17 file) e 5 Python; lint verde.
- Vettori ufficiali: TOTP dalla RFC 6238 (appendice B), Base32 dalla RFC 4648 (sezione 10).
- Ogni riga della tabella dei ruoli dei requisiti ha la sua prova, sia sulle regole sia attraverso il servizio.
- Ogni rotta `/api/pazienti/:id…` scrive il registro, anche quando l'accesso è negato.
- Alterazioni del registro fatte spegnendo i trigger: la catena le trova (riga modificata, riga tolta).
- `pnpm dev` con i dati dimostrativi: servizio vivo, rotte protette chiuse senza sessione, tentativo fallito nel registro, catena integra.

**Non provato**

- L'accesso con un'app di autenticazione vera su un telefono: provato solo calcolando i codici nelle prove.
- Il servizio collegato al database con un utente che non possiede le tabelle (vedi «Cose irreversibili non fatte»).
- Interfaccia di accesso e blocco schermo: arrivano alla tappa 6.

## Risposte della prima fermata (18/11/2026)

Simone ha risposto con il pulsante. Da applicare sul branch `tappe-0-2` prima di unire la pull request #1; poi si prosegue con le tappe 3–4 **senza fermarsi di nuovo** (via già dato).

- **Logo**: B, linguetta a picco. Va nell'interfaccia al posto del segno di oggi.
- **Segreteria**: aggiungere ciò che si può se la normativa lo consente, altrimenti filtro del medico. Applicato come: riepilogo clinico e diario alla segreteria solo se il titolare li abilita per il suo archivio, spenti per difetto; da confermare con il consulente privacy.
- **Sostituto**: va bene così.
- **Accesso**: va bene, ma lo sblocco dopo l'inattività si fa con il codice a 6 cifre, non con la password.
- **Soglie**: blocco dopo 5 minuti di inattività; 5 password sbagliate bloccano l'utente per 15 minuti.
- **Medicina di gruppo**: autorizzazione del titolare con periodo e motivo, com'è ora.
- **Dati clinici e storico**: va bene così.
- **Registro degli accessi**: va bene così.
- **Esportazione**: aggiungere anche il CSV (una tabella per file).

## Cose irreversibili non fatte

- Nessuna azione irreversibile è stata fatta.
- Da fare in produzione, non qui: utente del database per il servizio che non possiede le tabelle (così non può spegnere i trigger del registro); chiave di cifratura in un archivio di segreti.

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
| Segreteria che firma                      | Permesso di firma aggiunto alla segreteria         | Rosso, poi verde                                                                                                                                                                   |
| Periodo del sostituto                     | Fine del periodo ignorata                          | Rosso, poi verde                                                                                                                                                                   |
| Amministratore senza accesso clinico      | Amministratore trattato come medico                | **Rimasto verde la prima volta**: mancava il caso di un'autorizzazione data per errore a un amministratore. Aggiunta la prova; poi rosso, poi verde                                |
| Diario alla segreteria                    | Impostazione dello studio ignorata                 | Rosso, poi verde                                                                                                                                                                   |
| Guardia che registra                      | Scrittura del registro tolta dalla guardia         | Rosso, poi verde                                                                                                                                                                   |
| Rotte sui pazienti marcate                | Marca tolta alla rotta del diario                  | Rosso, poi verde (prova rafforzata prima: ora controlla tutte le rotte, non solo quelle marcate)                                                                                   |
| Registro non modificabile                 | Trigger tolto dalla migrazione                     | Rosso, poi verde                                                                                                                                                                   |
| Catena delle impronte                     | Esito tolto dall'impronta                          | Rosso, poi verde                                                                                                                                                                   |
| Voci cliniche non cancellabili            | `clinical_entry` tolta dall'elenco protetto        | Rosso, poi verde                                                                                                                                                                   |
| Storico con l'utente                      | Utente non dichiarato nella transazione            | Rosso, poi verde                                                                                                                                                                   |
| Codice TOTP usato una volta               | Ultimo intervallo ignorato                         | Rosso, poi verde                                                                                                                                                                   |
| Codice sbagliato rifiutato                | Verifica del codice saltata                        | Rosso, poi verde                                                                                                                                                                   |
| Blocco per inattività                     | Blocco mai applicato                               | Rosso, poi verde                                                                                                                                                                   |
| Blocco per tentativi falliti              | Blocco mai applicato                               | **Sabotaggio non applicato la prima volta** (il testo cercato era su più righe); rifatto: rosso, poi verde. Lo script ora segnala i sabotaggi non applicati                        |
| Stesso messaggio per utente sconosciuto   | Messaggio diverso                                  | Rosso, poi verde                                                                                                                                                                   |
| Esportazione completa                     | `therapy` tolta dalle tabelle esportate            | Rosso, poi verde                                                                                                                                                                   |
| Niente segreti nell'esportazione          | Impronta della password aggiunta                   | Rosso, poi verde                                                                                                                                                                   |
| Solo l'archivio del titolare              | Pazienti di tutto lo studio                        | Rosso, poi verde                                                                                                                                                                   |
| Matrice dei permessi allineata            | Riepilogo clinico dato alla segreteria nel codice  | Rosso, poi verde                                                                                                                                                                   |
