# Avanzamento

Stato del lavoro, tappa per tappa. Una sessione nuova riparte da qui e da `CLAUDE.md`.

## Dove siamo

- `main` contiene le tappe 0–2 (pull request #1 unita il 18/11/2026 con il via di Simone).
- Branch attivo: `tappe-3-4`, con le tappe 3 e 4 fatte e la pull request #2 per la **seconda fermata**.
- Seconda fermata: risposte annotate qui sotto, da applicare; poi richiedere il via, unire la #2 e partire con le tappe 5–6 su `tappe-5-6`.

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

### Tappa 3 – Ciclo della ricetta

**Fatto**

- Stati e transizioni in `packages/domain/src/prescription.ts`: bozza, da firmare, in invio, inviata, errore (rifiutata, non raggiungibile, esito incerto), annullata, stampata su ricetta rossa. Descritti in `docs/ricetta.md`.
- `packages/integrations`: interfaccia di invio per SAR e Sistema TS e simulatore con i quattro esiti.
- Migrazione 0004: ricette, righe, invii esterni (immutabili); storico e divieto di cancellazione per ricette e righe.
- Servizio e rotte: bozza del medico, ripetizione della segreteria (nella coda «da firmare»), firma e invio con presa in carico atomica, annullamento locale o tramite SAR, ripiego sulla ricetta rossa, code «da firmare» e «invii non riusciti», elenco delle ricette del paziente (senza quelle di terapie riservate per chi non le vede).
- Aggancio per i controlli prima dell'invio (`preSendChecks`): blocca l'invio e registra la versione delle regole. Lo riempie la tappa 4.
- Esportazione estesa a ricette, righe e invii esterni.

**Provato**

- Prova esaustiva delle transizioni (ogni stato per ogni evento e tipo di errore).
- Percorsi completi attraverso il servizio con il simulatore: invio riuscito, rifiuto e correzione, rete assente e ricetta rossa, esito incerto e nuovo invio, guasto dell'adattatore, annullamento con SAR non raggiungibile e poi riuscito, annullamento di una bozza, ricetta bianca al Sistema TS, due firme contemporanee con un solo invio, sostituto che firma a nome suo, segreteria che non firma e non ripete terapie riservate o al bisogno.

**Non provato**

- Adattatori veri per SAR e Sistema TS: non esistono ancora (servono specifiche e credenziali di collaudo).
- Stampa della ricetta rossa e del promemoria: c'è solo il contenuto da stampare.

### Tappa 4 – Regole di prescrizione

**Fatto**

- `packages/rules`: regole R1–R17 come dati versionati (`data/regole-2026-11-18.json`) con fonti, valori e cose da completare; motore che sceglie la versione in vigore alla data della ricetta; R12 fuori perimetro. Tabella generata in `docs/regole.md`.
- Integrazione nel servizio: controllo prima di ogni invio (blocco per le norme, motivo per R11, conferma per le note AIFA), registrato in `prescription_check` (migrazione 0005, immutabile); la ricetta inviata porta la versione delle regole; controllo di anteprima `POST /api/ricette/:id/controlla`.
- Canale e recapito del promemoria nella bozza (R15, R16).

**Provato**

- 46 prove delle regole, con i casi limite dei requisiti: 2 e 3 confezioni, piano che scade oggi, nota non confermata; l'esempio del contatore (21/10, 28 compresse, copre fino al 17/11 compreso; avviso al giorno 22, non al 23).
- 6 prove attraverso il servizio: blocco con dettagli e controllo registrato, nota AIFA confermata, specialistica senza quesito con anteprima, esenzione non registrata, canale e recapito, contatore con motivo.

**Non provato**

- Le regole con i dati veri della banca dati farmaci e dei cataloghi: arrivano alla tappa 5 (file d'esempio) e con la licenza Farmadati.
- I controlli formali completi del Sistema TS (R10): manca il documento ufficiale dei controlli.

## Risposte della seconda fermata (18/11/2026)

Simone ha risposto con il pulsante. Da applicare su `tappe-3-4`, poi aggiornare la pull request #2 e **richiedere il via** prima di unire.

- **Ciclo della ricetta**: ripetizioni raggruppate: la segreteria mette più terapie croniche nella stessa ricetta, entro il limite di confezioni.
- **Confezioni (R1–R4)**: va bene così.
- **Piani, note, classe ed esenzioni (R5–R9, R17)**: va bene così.
- **Contatore (R11)**: solo informativo, senza motivo obbligatorio.

## Risposte della prima fermata (18/11/2026)

Simone ha risposto con il pulsante. **Applicate** sul branch `tappe-0-2` (decisioni D29–D34); poi si prosegue con le tappe 3–4 senza fermarsi di nuovo (via già dato).

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

| Controllo                                                 | Sabotaggio                                         | Esito                                                                                                                                                                              |
| --------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Impronte del marchio di SCRIPT                            | Un colore cambiato in `script_simbolo.svg`         | Rosso, poi verde                                                                                                                                                                   |
| Nessun file estraneo nel marchio                          | Aggiunto `intruso.svg`                             | Rosso, poi verde                                                                                                                                                                   |
| Nome del prodotto nel codice                              | Parola scritta in un file di `apps/web`            | Rosso, poi verde                                                                                                                                                                   |
| Nome del prodotto nei percorsi                            | File con il nome in `sync/`                        | Rosso, poi verde                                                                                                                                                                   |
| `tokens.css` allineato                                    | Un colore cambiato a mano in `tokens.css`          | Rosso, poi verde                                                                                                                                                                   |
| Colori di SCRIPT come nei file ufficiali                  | Luce cambiata in `tokens.ts`                       | Rosso, poi verde                                                                                                                                                                   |
| Contrasti AA                                              | Testo secondario reso grigio chiaro                | Rosso, poi verde                                                                                                                                                                   |
| Caratteri senza CDN (`fonts.css`)                         | Aggiunto un `@import` da Google Fonts              | Rosso, poi verde                                                                                                                                                                   |
| Migrazioni da zero                                        | `CREATE TABLE` rinominato nella migrazione         | Rosso, poi verde                                                                                                                                                                   |
| Schema allineato alle migrazioni                          | Colonna aggiunta allo schema senza migrazione      | Rosso, poi verde                                                                                                                                                                   |
| Prove del database senza `DATABASE_URL`                   | Variabile tolta                                    | Rosso (le prove falliscono, non saltano)                                                                                                                                           |
| Migrazione modificata dopo l'applicazione                 | Controllo dell'impronta disattivato nell'esecutore | Rosso, poi verde                                                                                                                                                                   |
| Nessuna CDN nell'interfaccia compilata                    | `@import` da Google Fonts nel CSS dell'interfaccia | Rosso, poi verde                                                                                                                                                                   |
| Titolo della pagina da `brand.ts`                         | Titolo scritto a mano in `vite.config.ts`          | Rosso, poi verde                                                                                                                                                                   |
| Tabella dei caratteri dispari (art. 7)                    | Valore di A cambiato                               | **Rimasto verde la prima volta**: la prova non copriva A in posizione dispari. Aggiunto il confronto con il testo del decreto e il controllo di permutazione; poi rosso, poi verde |
| Valori dei caratteri pari (art. 7)                        | Spostamento di 1 nel calcolo                       | Rosso, poi verde                                                                                                                                                                   |
| Generatore deterministico                                 | `Math.random()` al posto del generatore con seme   | Rosso, poi verde                                                                                                                                                                   |
| Codici fiscali non reali                                  | Luogo di nascita con la L                          | Rosso, poi verde                                                                                                                                                                   |
| Email che non arrivano a nessuno                          | Dominio `gmail.com`                                | Rosso, poi verde                                                                                                                                                                   |
| Logo senza testo                                          | `<text>` aggiunto a un SVG                         | Rosso, poi verde                                                                                                                                                                   |
| Logo piatto                                               | Sfumatura aggiunta                                 | Rosso, poi verde                                                                                                                                                                   |
| Logo nei colori ammessi                                   | Colore rosso                                       | Rosso, poi verde                                                                                                                                                                   |
| Logo con estremi arrotondati                              | `stroke-linecap="butt"`                            | Rosso, poi verde                                                                                                                                                                   |
| Simbolo di SCRIPT fuori dal logo                          | Poligono aggiunto                                  | Rosso, poi verde                                                                                                                                                                   |
| Segreteria che firma                                      | Permesso di firma aggiunto alla segreteria         | Rosso, poi verde                                                                                                                                                                   |
| Periodo del sostituto                                     | Fine del periodo ignorata                          | Rosso, poi verde                                                                                                                                                                   |
| Amministratore senza accesso clinico                      | Amministratore trattato come medico                | **Rimasto verde la prima volta**: mancava il caso di un'autorizzazione data per errore a un amministratore. Aggiunta la prova; poi rosso, poi verde                                |
| Diario alla segreteria                                    | Impostazione dello studio ignorata                 | Rosso, poi verde                                                                                                                                                                   |
| Guardia che registra                                      | Scrittura del registro tolta dalla guardia         | Rosso, poi verde                                                                                                                                                                   |
| Rotte sui pazienti marcate                                | Marca tolta alla rotta del diario                  | Rosso, poi verde (prova rafforzata prima: ora controlla tutte le rotte, non solo quelle marcate)                                                                                   |
| Registro non modificabile                                 | Trigger tolto dalla migrazione                     | Rosso, poi verde                                                                                                                                                                   |
| Catena delle impronte                                     | Esito tolto dall'impronta                          | Rosso, poi verde                                                                                                                                                                   |
| Voci cliniche non cancellabili                            | `clinical_entry` tolta dall'elenco protetto        | Rosso, poi verde                                                                                                                                                                   |
| Storico con l'utente                                      | Utente non dichiarato nella transazione            | Rosso, poi verde                                                                                                                                                                   |
| Codice TOTP usato una volta                               | Ultimo intervallo ignorato                         | Rosso, poi verde                                                                                                                                                                   |
| Codice sbagliato rifiutato                                | Verifica del codice saltata                        | Rosso, poi verde                                                                                                                                                                   |
| Blocco per inattività                                     | Blocco mai applicato                               | Rosso, poi verde                                                                                                                                                                   |
| Blocco per tentativi falliti                              | Blocco mai applicato                               | **Sabotaggio non applicato la prima volta** (il testo cercato era su più righe); rifatto: rosso, poi verde. Lo script ora segnala i sabotaggi non applicati                        |
| Stesso messaggio per utente sconosciuto                   | Messaggio diverso                                  | Rosso, poi verde                                                                                                                                                                   |
| Esportazione completa                                     | `therapy` tolta dalle tabelle esportate            | Rosso, poi verde                                                                                                                                                                   |
| Niente segreti nell'esportazione                          | Impronta della password aggiunta                   | Rosso, poi verde                                                                                                                                                                   |
| Solo l'archivio del titolare                              | Pazienti di tutto lo studio                        | Rosso, poi verde                                                                                                                                                                   |
| Matrice dei permessi allineata                            | Riepilogo clinico dato alla segreteria nel codice  | Rosso, poi verde                                                                                                                                                                   |
| Riepilogo alla segreteria solo se il titolare lo abilita  | Riepilogo sempre consentito                        | Rosso, poi verde                                                                                                                                                                   |
| Impostazioni dell'archivio solo al titolare               | Impostazioni consentite al sostituto               | Rosso, poi verde                                                                                                                                                                   |
| Allergie riservate escluse dal riepilogo della segreteria | Filtro delle riservate tolto                       | Rosso, poi verde (prova aggiunta prima: mancava un'allergia riservata nei dati di prova)                                                                                           |
| Sblocco con il codice a 6 cifre                           | Verifica del codice saltata                        | Rosso, poi verde                                                                                                                                                                   |
| Soglia di inattività di 5 minuti                          | Valore per difetto 10 nella migrazione             | Rosso, poi verde                                                                                                                                                                   |
| CSV con tutte le sezioni                                  | Registro tolto dal CSV                             | Rosso, poi verde                                                                                                                                                                   |
| CSV con BOM                                               | BOM tolto                                          | Rosso, poi verde (il primo tentativo non era applicato: lo script l'ha segnalato)                                                                                                  |
| CSV con le virgolette giuste                              | Punto e virgola non più tra virgolette             | Rosso, poi verde                                                                                                                                                                   |
| Logo scelto nell'interfaccia                              | Geometria diversa nel segno del prodotto           | Rosso, poi verde                                                                                                                                                                   |
| Favicon dal logo scelto                                   | Colore cambiato nella favicon                      | Rosso, poi verde                                                                                                                                                                   |
| Ricetta rossa solo se il sistema non risponde             | Ricetta rossa ammessa anche con esito incerto      | Rosso, poi verde                                                                                                                                                                   |
| Un solo invio per ricetta                                 | Presa in carico senza controllo dello stato        | **Rimasto verde la prima volta**: le due richieste non erano davvero contemporanee. Prova riscritta con una barriera; poi rosso, poi verde                                         |
| Ogni invio esterno registrato                             | Registrazione dell'invio tolta                     | Rosso, poi verde                                                                                                                                                                   |
| Ripetizione della segreteria nella coda «da firmare»      | Ripetizione lasciata in bozza                      | Rosso, poi verde                                                                                                                                                                   |
| Ricetta a nome di chi firma                               | Messaggio a nome di chi l'ha preparata             | Rosso, poi verde                                                                                                                                                                   |
| Ricetta bianca al Sistema TS                              | Tutto al SAR                                       | Rosso, poi verde                                                                                                                                                                   |
| Firma solo con il permesso di firma                       | Guardia con il permesso di lettura                 | Rosso, poi verde                                                                                                                                                                   |
| Controlli bloccanti prima dell'invio                      | Blocchi ignorati                                   | Rosso, poi verde                                                                                                                                                                   |
| Guasto dell'adattatore come esito incerto                 | Guasto trattato come rete assente                  | Rosso, poi verde                                                                                                                                                                   |
| Nessun indirizzo di rete nelle integrazioni               | Indirizzo aggiunto al simulatore                   | Rosso, poi verde                                                                                                                                                                   |
| Valori presi dai dati                                     | maxPacks di R2 cambiato nel file                   | Rosso, poi verde                                                                                                                                                                   |
| Nessun numero nel codice delle regole                     | Limite scritto a mano                              | Rosso (lint), poi verde                                                                                                                                                            |
| R4: trattamento da almeno 6 mesi                          | Condizione tolta                                   | Rosso, poi verde                                                                                                                                                                   |
| R5: piano che scade oggi                                  | Scadenza esclusa                                   | Rosso, poi verde                                                                                                                                                                   |
| R7: conferma della nota                                   | Conferma ignorata                                  | Rosso, poi verde                                                                                                                                                                   |
| R11: soglia dell'80%                                      | Soglia ignorata                                    | Rosso, poi verde                                                                                                                                                                   |
| R13: motivazione della non sostituibilità                 | Motivazione vuota accettata                        | Rosso, poi verde                                                                                                                                                                   |
| R14: priorità per il primo accesso                        | Priorità ignorata                                  | Rosso, poi verde                                                                                                                                                                   |
| R16: delega revocata                                      | Revoca ignorata                                    | Rosso, poi verde                                                                                                                                                                   |
| R17: prestazioni dell'esenzione                           | Controllo tolto                                    | Rosso, poi verde                                                                                                                                                                   |
| Versione delle regole alla data                           | Versione scelta senza guardare la data             | Rosso, poi verde                                                                                                                                                                   |
| Controllo registrato                                      | Registrazione tolta                                | Rosso, poi verde                                                                                                                                                                   |
| Avviso senza motivo blocca                                | Solo i blocchi fermano l'invio                     | Rosso, poi verde                                                                                                                                                                   |
| Tabella di docs/regole.md allineata                       | Testo di una regola cambiato nei dati              | Rosso, poi verde                                                                                                                                                                   |
