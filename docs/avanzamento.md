# Avanzamento

Stato del lavoro, tappa per tappa. Una sessione nuova riparte da qui e da `CLAUDE.md`.

## Dove siamo

- **Primo giro (tappe 0–6) chiuso.** Pull request #1, #2 e #3 su `main`, l'ultima con la terapia completa e i collegamenti pronti (D79–D88), unita con il via di Simone del 18/11/2026.
- **Secondo giro (tappe 7–10) avviato** con il via di Simone: «fai tutto, nell'ordine che ritieni giusto» (D90). Ordine: promemoria e invio, certificati INPS (terza fermata), voci cliniche, presidi e seguito delle prestazioni (fermata finale). Branch `tappe-7-8`, poi `tappe-9-10`.
- **Tappa 7 fatta** (promemoria e invio, D92–D99).
- **Tappa 8 fatta** (certificati INPS, D105–D107), con le credenziali dei servizi e il secondo fattore (D100–D103) chiesti dalla Dr.ssa Rocca.
- **Terza fermata fatta**: via di Simone, pull request #4 unita (D108–D110). Nel branch `tappe-9-10`:
  1. secondo fattore con SPID o CIE dal programma (D109): fatto;
  2. tappa 9 (voci cliniche): fatta (D112–D120);
  3. tappa 10 (presidi e seguito delle prestazioni): fatta (D121–D124);
  4. `docs/fse.md` (D110): fatto, con le fonti ufficiali sul Profilo Sanitario Sintetico;
  5. fermata finale fatta (D125–D128): via all'unione della pull request #5; dettatura fuori; BMI scritto a mano; via alle tappe 11 e 12.
- **Terzo giro** (D128): tappa 11 (Profilo Sanitario Sintetico con un simulatore del Gateway), poi tappa 12 (condivisione nell'AFT), nel branch `tappe-11-12`, con una fermata dopo la tappa 12.

**Fuori dal secondo giro, da fare dopo** (nessuno avviato):

1. Primo giro di `sync/` dal computer dello studio; completare le mappature AIFA con le intestazioni vere e confermare quelle ISTAT (D55, D56).
2. Specifiche e credenziali di collaudo di SAR, Sistema TS e AURA: stato di erogazione (D70), controlli formali (R10), formato dell'NRE, modulo della ricetta rossa e del promemoria. Insieme: registrazione del programma presso la Regione (codice del gestionale, autocertificazione per i due fattori) e censimento dei medici nel configuratore regionale (D103).
3. Decisione su Ready! e sulla versione «Full» (D78).
4. Riepiloghi, agenda (dopo la decisione su Ready!), AURA e FSE, importazione dei dati dal software attuale (serve il formato dell'esportazione di Next² con un file d'esempio senza dati veri).
5. A7 e le altre liste AIFA (trasparenza, carenze, registri); soglie di vecchiaia (D62).
6. Collegamento alla segnalazione di farmacovigilanza (D82); dicitura del tipo di accesso nella versione viva dei requisiti (D79).
7. Prove con lettori di schermo e tablet veri, e una giornata di lavoro con la Dr.ssa Rocca.

## Come provarlo

```sh
pnpm install          # in cloud lo fa l'hook di avvio
pnpm test             # prove TypeScript e prove di sync/
pnpm lint             # ESLint, Prettier, tipi
pnpm dev              # migrazioni, servizio su :3001, interfaccia su :5173
pnpm db:seed          # dati dimostrativi inventati; stampa una volta le password
pnpm fixtures -- --seed 1 --count 5
pnpm banche-dati:importa -- --esempio   # banche dati dimostrative: sync sul sito d'esempio, poi importazione
```

Per provare l'accesso a mano: `pnpm db:seed`, poi `POST /api/accesso` con utente, password e postazione; la risposta dà il segreto da inserire in un'app di autenticazione; poi `POST /api/accesso/codice` con il codice. Dalla tappa 6 lo stesso si fa dall'interfaccia (`pnpm dev`, porta 5173).

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

### Tappa 5 – Banche dati pubbliche

**Fatto** (dettagli in `docs/banche-dati.md`, decisioni D54–D64)

- `packages/reference`: lettura dei CSV come `sync/` (codifica, separatore, virgolette), lettore XLSX minimo, intestazioni senza date come `sync/`, tipi di banca dati con i controlli dei valori, mappature come dati (`data/mappature.json`).
- Importazione (`apps/api/src/reference`): legge `stato.json` e `correnti/` di `sync/`, controlla l'impronta, mappature, colonne e valori; i PDF entrano solo da trascrizioni controllate legate all'impronta del PDF (A8). Ogni importazione è una versione immutabile (migrazione 0006).
- Consultazione alla data (A5): fatti per le regole (R5, R7, R8, R9, R17) collegati al controllo prima dell'invio; ricerche di farmaci (nome, principio attivo, AIC, ATC, equivalenti), prestazioni, esenzioni e comuni; versioni in uso con la loro data in ogni risposta (A6).
- Comando `pnpm banche-dati:importa`, con `--esempio` per i dati dimostrativi.
- Controllo della D12 sui comuni veri (lettera X).

**Provato**

- 18 prove di lettura e mappature, con il confronto cella per cella contro Python (`sync/`) su CSV veri d'esempio e casi difficili.
- 20 prove sul database: `sync/` vero lanciato su un sito d'esempio in locale, importazione, idempotenza, catalogo che cambia il 30/10/2026, fatti dei farmaci, ricerche, versioni e vecchiaia, immutabilità, impronta manomessa, trascrizione superata dopo un PDF nuovo, righe non valide e scarti accettati, schede incomplete, lettera X; via HTTP le ricerche e le regole R5, R7, R9 e R17 alimentate dalle banche dati.
- 9 sabotaggi (registro sotto).

**Non fatto / da completare**

- **Mappature AIFA da completare** (D55): dal cloud i file AIFA non si leggono. Al primo giro di `sync/` dal computer dello studio, l'importazione mostra le intestazioni vere da copiare in `packages/reference/data/mappature.json`.
- Intestazioni ISTAT da confermare sul file vero (D56).
- Soglie di vecchiaia (A6) da completare (D62).
- Non importati: liste di trasparenza, farmaci carenti, registri e piani AIFA, ICD-9-CM e ICD-10-IM. A7 (aggiornamento che tocca un farmaco in terapia → «Da fare») non fatto: richiede la coda «Da fare» dell'interfaccia e le carenze.
- Prescrivibilità dal medico di medicina generale, regime di fornitura, unità per confezione e antibiotici iniettabili restano non noti senza una fonte strutturata (D59).

**Non provato**

- File veri AIFA e ISTAT completi; XLSX scritto da Excel; tempi su file grandi (vedi `docs/banche-dati.md`).

### Tappa 6 – Interfaccia per PC e tablet

**Fatto** (dettagli in `docs/interfaccia.md`, schermate in `docs/schermate/`, decisioni D65–D75)

- Accesso con password e secondo fattore, sblocco con il codice a 6 cifre, uscita che svuota il browser.
- Oggi, Pazienti con ricerca, Cartella (testata, riepilogo, terapia con «Ripeti», prestazioni prescritte, cronologia filtrabile), Scheda della terapia con lo storico delle prescrizioni (D65), storico di ogni prestazione (D66), Esami senza giudizio (D71), Ricerca farmaci e prestazioni con equivalenti e data della banca dati (A6), Ricetta farmaceutica e specialistica con controlli, conferme, motivi, firma e invio, Ricette da firmare e invii non riusciti con ricetta rossa.
- Richieste di Simone durante la tappa: simboli accanto ai nomi (D67), fino a 20 cartelle aperte insieme con la ricetta in corso ricordata (D68), evidenziatore giallo con avvisi in arancio (D69), annullamento solo se l'ente non ha lavorato la ricetta, con lo storico che conserva tutto e l'avviso di prestazione già prescritta (D70).
- Rotte nuove: storico delle prescrizioni, cronologia, esami, oggi, stato di erogazione (migrazione 0007).
- Dati dimostrativi più ricchi e script delle schermate.

**Provato**

- 13 prove nel browser (Chromium): accesso con attivazione del secondo fattore, ogni schermata con axe-core (WCAG 2.2 A e AA), bersagli di almeno 44 px, tablet in verticale e in orizzontale, ricetta dalla banca dati fino all'NRE, segreteria che prepara e medico che firma, cartelle aperte e ricetta ricordata, verifica dello stato e annullamento, avviso di prestazione già prescritta, blocco e sblocco.
- Prove del servizio per storico, cronologia, esami, oggi e annullamento (D70); prove dell'interfaccia (jsdom) per accesso, blocco, menu, cartelle aperte e uscita.
- 13 sabotaggi (registro sotto): due non hanno fatto diventare rossa la prova al primo colpo e sono stati sistemati (prova rafforzata per D65; sabotaggio degli esami rifatto perché il primo non si era applicato davvero).

**Non fatto**

- Agenda (in attesa della decisione su Ready!), riepiloghi, certificati, nuove voci cliniche, stampe conformi, tema scuro. Nuova terapia, modifiche, anagrafica e impostazioni: fatte dopo la fermata finale (sezione sotto).
- A7 (aggiornamento delle banche dati che tocca un farmaco in terapia) e le altre liste AIFA (tappa 5).

**Non provato**

- Lettori di schermo veri, tablet veri, una giornata di lavoro con la Dr.ssa Rocca.
- Il servizio di stato di erogazione vero: esiste solo nel simulatore, finché non arrivano le specifiche.

### Dopo la fermata finale – Terapia completa e collegamenti pronti

Scelta di Simone con il pulsante: «Terapia + collegamenti pronti». Decisioni D79–D87.

**Fatto**

- Scheda della terapia: nuova, modifica (si salva la scheda intera), sospensione con motivo, reazione avversa che entra tra le allergie e va in testata, ripresa. Rotte `POST` e `PUT /api/pazienti/:id/terapie`, `…/sospendi`, `…/riprendi`.
- Nella scheda: farmaco dalla banca dati o scritto a mano, «come la legge il paziente», unità al giorno proposte per il contatore e correggibili, gli stessi controlli formali del servizio detti prima di salvare (D80, D81).
- Schema orario stampabile per momento della giornata, con le riservate fuori per difetto (D83).
- Cartella: «Nuova terapia», «Schema orario», terapie sospese con il motivo, anagrafica e recapiti modificabili (D86).
- Pagina **Archivio** per il titolare: che cosa vede la segreteria ed esportazione completa in JSON o CSV (D84).
- Tipo di accesso con le parole del Sistema TS (D79); messaggi di validazione in italiano (D85).

**Provato**

- Servizio: 8 prove nuove (`apps/api/test/terapie.test.ts`). Coprono creazione con indicazione, controlli formali, messaggi in italiano, segreteria rifiutata e registrata, modifica, sospensione con allergia e ripresa, terapia riservata, `/api/io` con l'archivio.
- La prova esistente «ogni rotta su un paziente scrive il registro» ha trovato un difetto delle rotte nuove: l'identificativo della terapia era validato prima della guardia, quindi una richiesta sbagliata non entrava nel registro. Corretto.
- Interfaccia (jsdom): calcoli della scheda, controlli, corpo per il servizio, recapiti.
- Browser: 6 prove nuove, 19 in tutto. Coprono nuova terapia con gli errori, modifica con le unità corrette a mano, sospensione con reazione avversa e ripresa, schema orario (riservate e stampa), recapiti con l'errore spiegato, archivio con impostazioni ed esportazione. Su ognuna: axe, bersagli di 44 px e tablet.
- Le schermate nuove hanno mostrato un difetto della tappa 6 (D68): sulle pagine corte la barra delle cartelle aperte si allungava fino a riempire lo schermo, perché la griglia della pagina dava la riga elastica al secondo elemento. Ora le righe hanno posti fissi, e una prova nel browser misura la barra sulla pagina Archivio.
- Nelle schermate i campi data ora si leggono gg/mm/aaaa: il browser delle schermate parte con la lingua italiana.
- La CI ha trovato una prova del menu (jsdom) che dipendeva dai tempi: cercava «Ricette» in tutta la pagina, e se «Oggi» aveva già caricato trovava anche «Ricette da firmare». Ora aspetta «Oggi» e cerca nel menu; un sabotaggio con la ricerca in tutta la pagina la fa diventare rossa ogni volta.
- 14 sabotaggi nuovi, tutti rossi e poi verdi (registro sotto).

**Non fatto**

- Collegamento alla segnalazione di farmacovigilanza: da completare (D82).
- Schema orario come PDF conforme a un modello: i requisiti non ne indicano uno.
- Piani terapeutici, allergie e problemi nuovi dall'interfaccia (voci cliniche).

**Non provato**

- Stampa su una stampante vera; lettori di schermo veri; la scheda con la Dr.ssa Rocca.

### Tappa 7 – Promemoria e invio

Fonti ufficiali lette il 18/11/2026 (sessione nell'ambiente «Folder», D92): DM 2/11/2011 allegato 2; specifiche del Sistema TS, prescrizione, 5/12/2024; Regione Piemonte, SIRPE «Cartelle cliniche MMG e PLS»; disciplinare tecnico della ricetta bianca, 1/12/2022; DM 30/12/2020. Dettagli in `docs/ricetta.md`, «Promemoria e invio».

**Fatto**

- **Promemoria della ricetta SSN** dal modello del decreto. Contiene il codice a barre 3-of-9 alle misure del decreto, il codice di autenticazione del SAC e la riga piemontese «codice regionale – nominativo». I dati si fissano all'invio, così ogni ristampa è identica. C'è anche il foglio «solo NRE».
- **Codice di autenticazione.** Senza, la ricetta va in errore e il promemoria non esce (D96). Prima dell'invio servono la regione dello studio e il codice fiscale del medico (D95).
- **Ricetta bianca.** Si consegna solo il PDF del SAC, conservato byte per byte. Nell'editor si indicano ripetibilità e validità (D93).
- **Oscuramento di nome e indirizzo** su richiesta del paziente, per le ricette SSN.
- **Invio per email** (promemoria allegato) **e SMS** (solo il numero), al paziente o a un delegato con delega valida oggi. Il servizio è simulato e ogni consegna è registrata in una tabella che non si modifica (D98).
- **Tempo massimo di attesa dell'invio**: 8 secondi, come indica la Regione (D94).
- **Interfaccia.** Pannello «Promemoria» dopo l'invio, nella coda delle ricette e nello storico. Schermate 17 e 18.
- **Migrazione 0008.** Campi `auth_code`, `sac_doctor_name`, `pin_nrbe`, `obscured`, ripetibilità delle righe, `studio.region_name`, `doctor_profile.fiscal_code`. Tabelle `prescription_document` e `reminder_delivery`, nell'esportazione.

**Provato**

- **Servizio**: 17 prove nuove (`apps/api/test/promemoria.test.ts`), che leggono il testo vero dei PDF con pdfjs-dist. Coprono campi del modello, riga del medico, codice di autenticazione, solo NRE, oscuramento, ristampa identica dopo un cambio di anagrafica, rifiuto senza codice, specialistica, ricetta bianca byte per byte, ripetibilità solo sulla bianca, email e SMS, deleghe valide e revocate e di un altro paziente, servizio di invio irraggiungibile, segreteria, prerequisiti prima dell'invio, tempo massimo.
- **Code 39**: ogni carattere disegna le stesse barre di bwip-js, che è un'implementazione indipendente (D99).
- **Browser**: 2 prove nuove, 21 in tutto, con axe, bersagli di 44 px e tablet.
- **Prove complete**: 598 TypeScript e 5 di `sync/`, verdi.
- **Sabotaggi**: 10 nuovi, tutti rossi e poi verdi (registro sotto).

**Non fatto**

- Posizioni di stampa, suddivisione dell'NRE nei codici a barre e dicitura delle specifiche di stampa del 1/3/2016: il documento non è sul portale. Carattere OCR-A per l'NRE in chiaro (D97).
- Fornitore vero di email e SMS; frase regionale nell'ultima riga del promemoria.

**Non provato**

- Lettura del codice a barre con un lettore vero; stampa su carta.
- Il promemoria con la Dr.ssa Rocca e con una farmacia.

### Tappa 8 – Certificati INPS

Fonti ufficiali lette il 18/11/2026: specifiche INPS del Sistema TS, versione 3.2; DM 26/2/2010 (GU n. 65 del 19/3/2010) con gli allegati A e B; per le credenziali, le fonti di D100–D103.

**Fatto**

- **Controlli formali del certificato** nel dominio (`packages/domain/src/sick-leave.ts`): tipi, visita, agevolazioni, schema ICD-9-CM, codici d'errore dell'INPS ripetuti prima dell'invio (23–26, 43, 1003, 1004, 1007), rettifica e annullamento nei casi ammessi. Interfaccia e simulatore dell'invio all'INPS.
- **Credenziali dei servizi e secondo fattore** (D100–D103, `docs/credenziali.md`), su domanda della Dr.ssa Rocca:
  - credenziali Sistema TS e RUPAR del medico, cifrate, mai rilette, solo sue;
  - avviso di scadenza della password RUPAR;
  - codice di sessione chiesto, attivato e revocato con il simulatore;
  - ogni invio prende credenziali e codice di chi firma prima di contattare il servizio;
  - un rifiuto per l'accesso porta la ricetta nell'errore «auth», che si rimanda così com'è.

  Pagina «Credenziali dei servizi», avvisi nella pagina «Oggi» e negli errori d'invio. Migrazione 0009.

**Provato**

- 12 prove del servizio sulle credenziali; prove del dominio e dei simulatori; 22 prove nel browser.
- Sabotaggi: 11 nuovi, rossi e poi verdi, uno nel browser (registro sotto).

- **Certificati di malattia** (`docs/certificati.md`, D105–D107):
  - bozza dalla residenza in anagrafica e continuazione dal giorno dopo;
  - controlli formali con i codici dell'INPS, compresi quelli dell'indirizzo dallo schema XSD;
  - invio al simulatore con le credenziali del Sistema TS di chi firma;
  - rettifica e annullamento nei tempi del decreto;
  - copia per il lavoratore (allegato A) e attestato (allegato B) in PDF dai fac-simile, fissati all'invio;
  - email e SMS al lavoratore; al datore di lavoro solo il protocollo, se lo chiede il lavoratore (D88).

  Pagina «Certificati» nella cartella, solo per il medico. Migrazione 0010; certificati, invii e consegne nell'esportazione.

**Provato (certificati)**

- 17 prove del servizio, prove del dominio (controlli, indirizzo, ciclo), prova nel browser (23 in tutto).
- Sabotaggi: 11 nuovi sul servizio e uno nel browser (registro sotto).

- Schermate 19–23 in `docs/interfaccia.md`.

**Non provato**

- Adattatori veri del Sistema TS e del SIRPED; stampa su carta; email e SMS reali.
- Il giro completo con la Dr.ssa Rocca (credenziali vere, codice di sessione vero).

**Da riportare nella versione viva dei requisiti** (verificato sulle fonti, D91). La copia in `docs/requisiti.md` resta quella della revisione 45:

- ricetta bianca ripetibile (D93);
- giornata lavorata, trauma e agevolazioni del certificato (schema XSD 3.2);
- copia e attestato dai fac-simile; consegna per email e SMS;
- credenziali RUPAR e Sistema TS, scadenza trimestrale della password RUPAR, secondo fattore e registrazione del programma presso la Regione (D100–D103).

### Dopo la terza fermata – Accesso regionale con SPID o CIE (D109, D111)

**Fatto**

- Modalità OAuth2 del SIRPED con PKCE: pagina regionale simulata, ritorno con controlli (state del medico, scadenza, identità, profilo), token cifrato senza rinnovo, uso come Bearer per le ricette SSN al posto delle credenziali RUPAR, revoca.
- Nella pagina «Credenziali dei servizi», scheda RUPAR: «Entra con SPID o CIE», con il codice via email come alternativa. Avvisi della pagina Oggi adeguati.
- Migrazione 0011 (modalità della sessione, richieste di accesso regionale).

**Provato**

- 10 prove del servizio, 4 delle integrazioni (compreso il PKCE con l'esempio della RFC 7636), la prova nel browser con la pagina simulata (axe e 44 px).
- 7 sabotaggi, tutti rossi e poi verdi.

**Non provato**

- Il servizio vero della Regione: firma del token (JWKS), durata vera, registrazione del programma (D103).

### Tappa 9 – Voci cliniche dall'interfaccia

Fonti lette il 18/11/2026: DM 7 settembre 2023 sul Fascicolo sanitario elettronico 2.0 (GU n. 249 del 24/10/2023), articoli 4, 6, 8, 9, 11, 12 e 16, e le modifiche dell'11/11/2025 (GU n. 286 del 10/12/2025), sulla Gazzetta Ufficiale. Per la dettatura, la documentazione MDN della Web Speech API.

**Fatto**

- **Voci cliniche** (D112–D114, `packages/domain/src/clinical.ts`, `apps/api/src/clinical/entries.ts`):
  - problemi e diagnosi con codice ICD-9-CM, stato attivo o risolto con le date, quesito aperto;
  - allergie e reazioni avverse, diario per tipo di contatto, anamnesi per sezione, stili di vita e fattori di rischio, esame obiettivo con scheda e punteggio;
  - parametri della stessa visita insieme, con l'andamento nel tempo;
  - riservata, oscurata, promemoria; annullamento con motivo.

  Le scrive il medico; tutto passa dalla guardia e dal registro degli accessi; lo storico registra chi scrive e chi annulla.

- **Privacy** (D115, D116): consensi alla consultazione del Fascicolo per finalità, con la fonte, revoca e nuovo consenso; altri consensi; deleghe con codice fiscale controllato e revoca (R16, anche per i promemoria). Li registra anche la segreteria.
- **Piani terapeutici** (D117): nuovo, modifica, annullamento con motivo, riservato. I piani annullati non valgono più per R5 e R6, né nel riepilogo né nella pagina Oggi.
- **Interfaccia**: pagine «Voci cliniche», «Parametri» (grafico e tabella, D118), «Privacy», «Piani terapeutici», collegate dalla cartella. Colori delle serie dei grafici nei token del marchio, con la prova del contrasto.
- Migrazione 0012 (consensi: descrizione, chi li esprime, chi li registra; piani: stato, annullamento, riservato, note, autore).

**Come provarlo**

- `pnpm test`: prove `voci-cliniche.test.ts` e `privacy-piani.test.ts` del servizio, prove del dominio, prova nel browser.
- `pnpm dev`, poi da una cartella: «Voci cliniche», «Parametri», «Piani terapeutici», «Privacy». Schermate 24–27 in `docs/interfaccia.md`.

**Provato**

- 21 prove nuove del servizio (11 voci cliniche, 10 privacy e piani), 7 del dominio, una prova nel browser (24 in tutto) con axe, bersagli di 44 px e tablet. Giro completo: 765 prove TypeScript e 5 di `sync/`, verdi; lint verde.
- Sabotaggi: 37 nuovi, tutti rossi e poi verdi (registro sotto).
- La pulizia dei database di prova falliva una volta su tre per la manutenzione automatica di Postgres: ora riprova (D120), 4 giri su 4 verdi.

**Non fatto**

- Dettatura vocale del diario (D119): domanda per la fermata finale.
- BMI calcolato (D113): domanda per la fermata finale.
- Catalogo ICD-9-CM per cercare i codici per descrizione (D114).
- Vaccinazioni, schede UVG regionali (da cercare sulla fonte), percorsi regionali; collegamento esplicito terapia–piano nella scheda (D117).
- Invio dei consensi all'Anagrafe consensi e revoche e dati a maggiore tutela (art. 6): con la tappa 11.

**Non provato**

- Lettori di schermo veri sul grafico (solo axe e la prova con la tastiera).
- Con la Dr.ssa Rocca: i tipi di voce, le sezioni dell'anamnesi e i parametri vanno visti con lei.

### Tappa 10 – Presidi e seguito delle prestazioni

Fonti lette il 18/11/2026: DPCM 12/1/2017 sui LEA, art. 10–14 (GU n. 65 del 18/3/2017, S.O. n. 15); vademecum per i malati cronici sul sito della Regione Piemonte (gennaio 2023), cap. 6.

**Fatto**

- **Seguito delle prestazioni** (D122): per ogni prestazione della ricetta specialistica inviata o stampata, data di esecuzione, struttura, esito, sedute dei cicli entro quelle prescritte, referto; annullamento con motivo, anche del referto. Il referto è una voce della cronologia.
- **Allegati** (D121): PDF, JPEG e PNG fino a 5 MB, tipo controllato dai primi byte, salvati nel database e serviti senza script; nell'esportazione JSON in base64 e nello ZIP come file.
- **Presidi e assistenza integrativa** (D123): categorie del decreto con la fonte, prodotto, codice, fabbisogno al mese, mesi, dal–al, chi prescrive, prima prescrizione dello specialista, indicazione, riservato; rinnovo e annullamento. Medicazioni avanzate: prima lo specialista, poi il medico per al massimo 6 mesi.
- **Interfaccia**: pagine «Seguito delle prestazioni» e «Presidi», collegate dalla cartella.
- Migrazione 0013.

**Come provarlo**

- `pnpm test`: `seguito-presidi.test.ts`, prove del dominio, prova nel browser.
- `pnpm dev`: da una cartella con una ricetta specialistica inviata, «Seguito delle prestazioni»; poi «Presidi». Schermate 28 e 29 in `docs/interfaccia.md`.

**Provato**

- 14 prove nuove del servizio, 5 del dominio, una prova nel browser (25 in tutto) con axe, bersagli di 44 px e tablet. Giro completo: 785 prove TypeScript e 5 di `sync/`, verdi; lint verde.
- 25 sabotaggi, tutti rossi e poi verdi (registro sotto).

**Non fatto**

- Stampa della prescrizione dei presidi: il modulo dipende dall'ASL (D123).
- Codici del nomenclatore dei presidi (allegati 2 e 3) come banca dati; percorsi dematerializzati dell'assistenza integrativa (nessuna specifica pubblica trovata).
- Referti strutturati dal Fascicolo.

**Non provato**

- Le modifiche del 2026 ai LEA (D124): da confrontare con il testo vigente.
- Referti grandi o scansionati veri: il limite di 5 MB è da vedere con la Dr.ssa Rocca.

### Dopo la fermata finale – Molte cartelle aperte (D129)

Domanda di Simone: «La schermata con più schede pazienti aperte l'hai testata?». Prima: provata nel browser con due schede; il limite di 20 solo senza browser; le pagine delle tappe 9 e 10 non dentro le schede.

**Fatto**

- Prova nel browser con 21 pazienti inventati. Controlla: 20 schede; la ventunesima chiude quella usata meno di recente, con l'avviso; la scheda attiva sempre in vista, anche su tablet; accessibilità, 44 px, tablet; il ritorno alle pagine nuove (voci cliniche, parametri) con quello che si stava scrivendo, separato per paziente e cancellato dopo la registrazione; le schede restano dopo il blocco per inattività.
- Due difetti trovati e corretti (D129): la scheda attiva poteva restare fuori vista; nelle pagine nuove e nel certificato quello che si scriveva si perdeva cambiando paziente.

**Non provato**

- Le bozze di piani, presidi, consensi, deleghe, seguito e certificato con la prova nel browser: usano lo stesso meccanismo delle voci e dei parametri, provati con i sabotaggi, ma non sono passate una per una.
- Su tablet veri e con lettori di schermo.

## Richieste di Simone tra le fermate (18/11/2026)

Annotate come decisioni per la tappa 6:

- **Storico delle prescrizioni di ogni farmaco** (D65): toccando un farmaco nella scheda delle terapie, tutte le sue ricette con data, confezioni, note, esenzione, autori, controlli.
- **Lo stesso per le prestazioni** (D66), per esempio «visita chirurgica – primo accesso».
- **Simboli nei menu** (D67): sì, accanto al nome e mai al suo posto.
- **Più cartelle aperte insieme, fino a 20** (D68).
- **Palette dei prototipi con il giallo** (D69): applicata in prova, da confermare.
- **Annullamento solo se la prestazione non è ancora lavorata dall'ente, e storico che conserva tutto** (D70).
- **Ready!**: prodotti nati separati, da rendere complementari (domanda 2 qui sotto).

Dopo la fermata finale:

- **«Terapia + collegamenti pronti»**: fatto (sezione sopra).
- **«Altra tipologia di accesso»**: verificato sulle specifiche del Sistema TS e applicato (D79).
- **Email al datore di lavoro**: facoltativa, e solo con il numero di protocollo, nessun dato clinico (D88).
- **Esempi di documenti veri** (promemoria di una ricetta SSN, promemoria di una ricetta bianca elettronica, email di conferma di un certificato INPS con il numero di protocollo). Sono dati veri di Simone: letti solo nella conversazione, per capire le voci; non entrano nel repository né nelle prove (regola 1). Confermano funzioni già nei requisiti: stampa del promemoria (completo o solo NRE) e invio per email; copia del certificato al lavoratore. Si faranno sui modelli pubblici, con pazienti inventati. Voce nuova da verificare sulla norma: ricetta bianca ripetibile (quante volte, fino a quando).
- **Sessione di Next² e schermate** (procedura diagnostica, procedura terapeutica, presidio, certificato INPS, menu). La sessione non è stata aperta; le schermate sono servite solo al confronto con i requisiti e non sono nel repository (D87). Il confronto:

| Nelle schermate                                 | Nei requisiti                                                                                                   | Stato                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Certificato INPS                                | «Certificati e moduli» e «Certificati INPS, dettaglio»                                                          | Non fatto                                         |
| «Giornata lavorata», «trauma», agevolazioni     | «Campi esatti da verificare sulle specifiche del Sistema TS»                                                    | Da verificare sulle specifiche pubbliche          |
| Procedure diagnostiche e terapeutiche           | Prestazioni dal catalogo regionale; dopo la prescrizione: data di esecuzione, struttura, esito, referto; sedute | Ricerca e prescrizione fatte; seguito e sedute no |
| «Segmento» (distretto anatomico)                | Assente                                                                                                         | Da capire se il catalogo piemontese lo prevede    |
| Presidi e assistenza integrativa                | «Terapie» e «Prescrizioni»                                                                                      | Non fatto; manca una fonte pubblica dei codici    |
| Privacy, anamnesi, stili di vita, esame clinico | «La cartella» (voce clinica con un dettaglio per tipo)                                                          | Nel modello; non nell'interfaccia                 |
| Agenda                                          | «Agenda»                                                                                                        | Proposta Ready! (D78)                             |
| Statistiche                                     | «Riepiloghi» per periodo; statistiche avanzate in fase 2                                                        | Non fatto                                         |
| Portale paziente                                | Fase 2                                                                                                          | Fuori dalla prima versione                        |
| Prontuario                                      | Banca dati farmaci                                                                                              | Fatto: «Farmaci e prestazioni»                    |
| Strumenti                                       | Amministratore: utenti, stampanti, intestazioni, modelli                                                        | Archivio fatto; il resto no                       |

Durante la tappa 8:

- **Credenziali del Sistema TS e RUPAR** (domanda della Dr.ssa Rocca). Nei requisiti c'erano, ma non erano costruite. Le fonti ufficiali aggiungono:
  - la scadenza trimestrale della password RUPAR;
  - il secondo fattore (Id-Sessione) per le ricette;
  - la registrazione del programma presso la Regione.

  Si costruiscono nella tappa 8, con i simulatori (D100–D103).

Durante la tappa 11 (terzo giro):

- **Modelli dei certificati** (richiesta di Simone, arrivata il 18/11/2026 tramite un'altra sessione). Le sue parole: «Devi anche prevedere la parte relativa ai vari certificati, medico sportivo non agonistico, porto d'armi, anamnestico patente e via dicendo. Dovranno essere dei template che si modificano solo per quanto riguarda la parte inerente i dati del paziente. Questi certificati solitamente si trovano nel pannello strumenti in un menu dedicato ai modelli, il professionista ovviamente ha la facoltà di impostare il layout di questi modelli sulla base di caratteri, intestazione, dimensione font e via dicendo, Ma ti chiederei di strutturare tu i template secondo le linee guida se per caso ce ne dovessero essere».
  - È già nei requisiti («Certificati e moduli»: «modelli personalizzabili che si compilano da soli con i dati del paziente»), e i «modelli» sono tra i compiti dell'amministratore dello studio. Non era ancora costruito.
  - Proposta: tappa 13, dopo la fermata della tappa 12, così la fermata resta dove era stata decisa (D130 e seguenti). Prima si leggono i modelli ufficiali dove ci sono: il certificato per l'attività sportiva non agonistica e i certificati anamnestici per il porto d'armi e per la patente. È una domanda per la fermata.

- **Cataloghi dello studio** (schermate dei cataloghi di Next² mandate da Simone il 18/11/2026, lette solo nella conversazione e non salvate). Domanda: «hai già previsto queste schermate o database?». Confronto con i requisiti, solo per funzione:

  | Catalogo                                       | Nei requisiti                                                          | Stato                                                                                                    |
  | ---------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
  | Medici suggeritori                             | Sì (dati del suggeritore, ricetta «Suggerita S»)                       | In parte: nella scheda della terapia, scritti a mano; manca l'elenco salvato                             |
  | Posologie                                      | Sì (posologia della terapia, contatore R11)                            | In parte: elenchi fissi della scheda e unità al giorno (D80); manca l'elenco dello studio                |
  | Patologie ICD                                  | Sì: catalogo ICD-9-CM, poi ICD-10-IM (prima versione)                  | Non fatto: solo il controllo del formato del codice; il catalogo non è importato (`docs/banche-dati.md`) |
  | Vaccini                                        | Sì: vaccinazioni con lotto, campagne, richiami, catalogo dei vaccini   | Non fatto: c'è il modello dei dati, mancano pagina e catalogo                                            |
  | Pacchetti di esami                             | Sì: gruppi di prestazioni salvati dallo studio, prescritti con un clic | Non fatto; quelli delle esenzioni si possono fare dalla D.D. 1167/2022, già importata                    |
  | Monitoraggi                                    | Come percorsi (diabete, BPCO, scompenso)                               | Non fatto                                                                                                |
  | Onorari                                        | Fase 2                                                                 | Non fatto                                                                                                |
  | Problemi ICPC, sintomi e segni, altri contatti | No                                                                     | —                                                                                                        |

  Delle altre schede: archivio, credenziali e dati del medico sono fatti. Timbro, intestazioni e stampanti sono nei requisiti ma non costruiti. Proposta: una tappa «Cataloghi dello studio» dopo la 12, insieme alla 13 o subito dopo. Ogni catalogo dalla sua fonte pubblica o inserito dallo studio (`docs/provenienze.md`). È una domanda per la fermata.

- **Copyright e reverse engineering** (richiesta di Simone, stesso giorno): «fai in modo che nessuno possa rivendicare violazione del copyright o reverse engineering». Fatto (D142): il registro `docs/provenienze.md` e una prova su tutto il repository (provenienza di immagini, documenti e archivi; licenze delle dipendenze), provata con due sabotaggi. Restano la revisione di un avvocato prima del lancio e una proposta per la fermata: le richieste a parole vostre, senza schermate di Next².

- **Net Medica Italia** (domanda della Dr.ssa Rocca): far comunicare medici con programmi diversi senza comprare quel servizio. Raccolte le informazioni pubbliche, fatta una proposta (D104). È una domanda della terza fermata; non è costruito nulla.

## Risposte della fermata finale del secondo giro (18/11/2026)

- **Via**: unire la pull request #5 (D125).
- **Dettatura vocale**: fuori per ora (D126).
- **BMI**: «se diventa dispositivo medico no; se ci sono gli estremi ok; altrimenti resta da compilare». Gli estremi non risultano dalle fonti trovate: resta scritto a mano (D127).
- **Fascicolo e AFT**: via alla tappa 11, poi alla 12 (D128).
- **Medicazioni avanzate**: resta il blocco (D123), non chiesto alla fermata per tenere poche domande.

## Domande della fermata finale del secondo giro (chiuse)

Annotate durante le tappe 9 e 10:

1. **Via** per unire la pull request delle tappe 9 e 10.
2. **Dettatura vocale del diario** (D119): fuori; dettatura del sistema operativo; riconoscimento solo nel browser da cercare.
3. **BMI** (D113): scritto a mano come oggi, oppure calcolato dal programma (calcolo clinico, R12 e regola 3).
4. **Fascicolo e AFT** (D110): via alle tappe 11 e 12 dopo aver letto `docs/fse.md`.
5. **Medicazioni avanzate** (D123): la regola dei 6 mesi viene da una guida per i cittadini; blocco come oggi, oppure solo avviso finché non si legge l'atto regionale.

## Risposte della terza fermata (18/11/2026)

Simone ha risposto con il pulsante:

- **Via**: unire la pull request #4 e continuare con le tappe 9 e 10.
- **Secondo fattore in Piemonte**: SPID o CIE dal programma (D109).
- **FSE e rete AFT**: dopo la tappa 10, prima il documento sulle fonti (D110).
- **Email al datore di lavoro**: «se indicare nome e cognome non viola la privacy, ok anche per nome e cognome». Verificato sull'allegato B del DM 26/2/2010, che contiene già nome e cognome; applicato prima dell'unione (D108).

## Domande della terza fermata (chiuse)

1. **Via per promemoria e certificati**: modelli e fonti (come da `CLAUDE.md`).
2. **Secondo fattore per le ricette in Piemonte** (D102). Le opzioni:
   - accesso con SPID o CIE dal programma (OAuth2), consigliato: non servono più password e PIN RUPAR per il SAR, e non c'è niente da copiare;
   - codice via email da copiare nel programma, già costruito nel simulatore.
3. **Rete tra medici dell'AFT** (D104). Le opzioni:
   - anticipare dalla fase 2 la condivisione tra chi usa il nostro programma, più l'importazione e l'esportazione del Profilo Sanitario Sintetico;
   - lasciarla in fase 2.

   Se serve leggere per intero le pagine di Net Medica Italia, va aggiunto all'ambiente il sito `www.netmedicaitalia.it`.

4. **Fascicolo Sanitario Elettronico 2.0** (domanda di Simone). Il Profilo Sanitario Sintetico è nei requisiti per la prima versione, «appena l'accreditamento lo permette», ma non è tra le tappe 7–10. Le opzioni:
   - aggiungerlo dopo la tappa 10, con il simulatore del Gateway;
   - lasciarlo per l'accreditamento.

   Prima della fermata: leggere le fonti ufficiali (norme, linee guida FSE 2.0, specifiche del Gateway, guida HL7 Italia del PSS) e scrivere `docs/fse.md` con come funziona: contenuto, aggiornamento, firma, invio, accreditamento. Per capirlo, Simone e la Dr.ssa Rocca possono anche guardare il proprio Fascicolo da pazienti, senza mandare i dati (regola 1), e dire come lo usa oggi la Dr.ssa Rocca.

## Risposte della seconda fermata (18/11/2026)

Simone ha risposto con il pulsante. **Applicate** su `tappe-3-4` (D49–D53) e via dato: la pull request #2 si unisce.

- **Ciclo della ricetta**: ripetizioni raggruppate: la segreteria mette più terapie croniche nella stessa ricetta, entro il limite di confezioni.
- **Confezioni (R1–R4)**: va bene così.
- **Piani, note, classe ed esenzioni (R5–R9, R17)**: va bene così.
- **Contatore (R11)**: solo informativo, senza motivo obbligatorio.
- **R13, R14**: va bene così.
- **R15, R16**: va bene, «prevedi comunque un alert con motivazione nel caso bloccasse». Applicato come avviso che spiega perché e che cosa fare (D52).
- **Via libera**: unire la #2 e proseguire con le tappe 5–6.

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

## Risposte della fermata finale (18/11/2026)

Simone ha risposto con il pulsante. Applicate prima dell'unione della #3 (D76–D78).

- **Colori**: giallo e avvisi in arancio, confermati.
- **R15, R16**: blocco spiegato, confermato.
- **Ready!**: Simone chiede se tutte le funzioni di Ready! possano entrare nel prodotto, in una versione «Full», e come gestire la palette. Proposta in D78 (integrazione, non riscrittura; palette con due pubblici e colori di stato comuni); decisione rimandata.
- **Via libera**: unire la #3 e fermarsi.

## Domande della fermata finale (chiuse)

1. **R15, R16 (D52)**: «alert con motivazione» letto come avviso che spiega il blocco. Se invece si voleva poter procedere scrivendo un motivo, è in conflitto con i requisiti (le regole da norma non hanno deroghe): da decidere.
2. **Appuntamenti da Ready!** (richiesta di Simone del 18/11/2026). I requisiti prevedono l'agenda dentro il prodotto («la segreteria prenota»); Simone propone di prendere gli appuntamenti da Ready!, il prodotto di prenotazione di SCRIPT. Dalla sessione «Ready! (prodotto)» (letta il 18/11/2026, solo come dati): installazione per studio su Aruba (per lo studio Rocca `prenota.studiomedicorocca.it`, prenotazioni dall'1/12/2026); l'elenco degli assistiti si importa dall'esportazione del gestionale con `src/Pazienti/ImportaCsv.php`, che riconosce le colonne per nome (codice fiscale, cognome, nome, email, cellulare) in CSV o Excel; il paziente si riconosce con codice fiscale e cognome; non ho visto un'esportazione o un'API degli appuntamenti. Proposta in due versi: (a) il prodotto esporta l'elenco degli assistiti nel formato di `ImportaCsv`, al posto di Next2; (b) Ready! espone gli appuntamenti (lavoro da fare in Ready!) e il prodotto li legge con un'interfaccia e un simulatore (regola 7), in copia con l'identificativo di Ready!, senza cambiare «Oggi». Da chiedere: conferma (cambia il perimetro dei requisiti), priorità di (a) e (b), nomi esatti delle colonne da verificare su `ImportaCsv.php`. Oggi non c'è nessuna agenda da rifare: «Oggi» legge la tabella degli appuntamenti e il seed ne mette alcuni dimostrativi.
   Ready! e il prodotto sono nati come prodotti separati (Simone, 18/11/2026): la separazione è data, resta da decidere come renderli **complementari**. Parere dato: buona idea, a tre condizioni. (1) Un solo proprietario per dato: pazienti e dati clinici al prodotto, appuntamenti e regole dell'agenda a Ready!, copie solo in un verso. (2) Collegamenti aperti e versionati, ognuno dei due usabile da solo. (3) Ready! senza dati clinici: una richiesta di ripetizione delle terapie fatta in Ready! va passata al prodotto senza conservarla in Ready!. Vantaggi: superficie esposta ai pazienti separata dalla cartella, mercati e tempi indipendenti (Ready! dall'1/12), fine della sovrapposizione con la «prenotazione online in fase 2» dei requisiti. Costo: doppia manutenzione, due informative e due contratti art. 28.

3. **Palette (D69)**: evidenziatore giallo dei prototipi per contatori, cartella attiva e selezioni, avvisi in arancio bruciato. Alternative: menta, pesca, azzurro. Da confermare con le schermate in `docs/schermate/`.
4. **Stato di erogazione (D70)**: i cinque stati sono del prodotto; vanno verificati sulle specifiche del SAR e del Sistema TS. Da chiedere solo come promemoria: chi può procurare le specifiche e le credenziali di collaudo.

## Risposte della fermata «terapia e collegamenti» (18/11/2026)

Simone ha risposto con il pulsante (D89–D91):

- **Via libera**: unire la #3.
- **Next²**: «prendi spunto anche dai campi»: lui e la Dr.ssa Rocca, utenti di Next², possono chiedere i campi che servono. Regola 2 aggiornata (D89).
- **Prossimo blocco**: «fai tutto! nell'ordine che ritieni giusto e opportuno». Ordine in D90.
- **Campi nuovi**: prima la verifica sulla fonte, poi i requisiti (D91).

## Domande per la fermata (terapia e collegamenti, chiuse)

1. **Via libera**: unire la #3 con la terapia completa e i collegamenti, e fermarsi.
2. **Next² e regola 2 (D87)**: le schermate servono solo al confronto con i requisiti, i campi vengono dalle specifiche pubbliche; oppure si usano anche per i campi (cambia la regola 2).
3. **Prossimo blocco**: priorità tra promemoria (stampa sul modello ufficiale e invio per email), certificati INPS, seguito delle prestazioni con le sedute, presidi e assistenza integrativa, voci cliniche (anamnesi, stili di vita, esame obiettivo, privacy e consensi), riepiloghi.
4. **Campi nuovi da verificare** prima di entrare nei requisiti: «segmento» nelle prestazioni; «giornata lavorata», «trauma» e agevolazioni nel certificato INPS; ricetta bianca ripetibile.

## Cose irreversibili non fatte

- Nessuna azione irreversibile è stata fatta.
- Da fare in produzione, non qui: utente del database per il servizio che non possiede le tabelle (così non può spegnere i trigger del registro); chiave di cifratura in un archivio di segreti.

## Registro dei sabotaggi

Ogni controllo nuovo viene rotto apposta (`scripts/sabotaggio.sh`), deve diventare rosso, poi viene ripristinato e deve tornare verde.

| Controllo                                                         | Sabotaggio                                                          | Esito                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Impronte del marchio di SCRIPT                                    | Un colore cambiato in `script_simbolo.svg`                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Nessun file estraneo nel marchio                                  | Aggiunto `intruso.svg`                                              | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Nome del prodotto nel codice                                      | Parola scritta in un file di `apps/web`                             | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Nome del prodotto nei percorsi                                    | File con il nome in `sync/`                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| `tokens.css` allineato                                            | Un colore cambiato a mano in `tokens.css`                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Colori di SCRIPT come nei file ufficiali                          | Luce cambiata in `tokens.ts`                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Contrasti AA                                                      | Testo secondario reso grigio chiaro                                 | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Caratteri senza CDN (`fonts.css`)                                 | Aggiunto un `@import` da Google Fonts                               | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Migrazioni da zero                                                | `CREATE TABLE` rinominato nella migrazione                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Schema allineato alle migrazioni                                  | Colonna aggiunta allo schema senza migrazione                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Prove del database senza `DATABASE_URL`                           | Variabile tolta                                                     | Rosso (le prove falliscono, non saltano)                                                                                                                                                                                                                                                                         |
| Migrazione modificata dopo l'applicazione                         | Controllo dell'impronta disattivato nell'esecutore                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Nessuna CDN nell'interfaccia compilata                            | `@import` da Google Fonts nel CSS dell'interfaccia                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Titolo della pagina da `brand.ts`                                 | Titolo scritto a mano in `vite.config.ts`                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Tabella dei caratteri dispari (art. 7)                            | Valore di A cambiato                                                | **Rimasto verde la prima volta**: la prova non copriva A in posizione dispari. Aggiunto il confronto con il testo del decreto e il controllo di permutazione; poi rosso, poi verde                                                                                                                               |
| Valori dei caratteri pari (art. 7)                                | Spostamento di 1 nel calcolo                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Generatore deterministico                                         | `Math.random()` al posto del generatore con seme                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Codici fiscali non reali                                          | Luogo di nascita con la L                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Email che non arrivano a nessuno                                  | Dominio `gmail.com`                                                 | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Logo senza testo                                                  | `<text>` aggiunto a un SVG                                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Logo piatto                                                       | Sfumatura aggiunta                                                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Logo nei colori ammessi                                           | Colore rosso                                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Logo con estremi arrotondati                                      | `stroke-linecap="butt"`                                             | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Simbolo di SCRIPT fuori dal logo                                  | Poligono aggiunto                                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Segreteria che firma                                              | Permesso di firma aggiunto alla segreteria                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Periodo del sostituto                                             | Fine del periodo ignorata                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Amministratore senza accesso clinico                              | Amministratore trattato come medico                                 | **Rimasto verde la prima volta**: mancava il caso di un'autorizzazione data per errore a un amministratore. Aggiunta la prova; poi rosso, poi verde                                                                                                                                                              |
| Diario alla segreteria                                            | Impostazione dello studio ignorata                                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Guardia che registra                                              | Scrittura del registro tolta dalla guardia                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Rotte sui pazienti marcate                                        | Marca tolta alla rotta del diario                                   | Rosso, poi verde (prova rafforzata prima: ora controlla tutte le rotte, non solo quelle marcate)                                                                                                                                                                                                                 |
| Registro non modificabile                                         | Trigger tolto dalla migrazione                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Catena delle impronte                                             | Esito tolto dall'impronta                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Voci cliniche non cancellabili                                    | `clinical_entry` tolta dall'elenco protetto                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Storico con l'utente                                              | Utente non dichiarato nella transazione                             | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Codice TOTP usato una volta                                       | Ultimo intervallo ignorato                                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Codice sbagliato rifiutato                                        | Verifica del codice saltata                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Blocco per inattività                                             | Blocco mai applicato                                                | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Blocco per tentativi falliti                                      | Blocco mai applicato                                                | **Sabotaggio non applicato la prima volta** (il testo cercato era su più righe); rifatto: rosso, poi verde. Lo script ora segnala i sabotaggi non applicati                                                                                                                                                      |
| Stesso messaggio per utente sconosciuto                           | Messaggio diverso                                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Esportazione completa                                             | `therapy` tolta dalle tabelle esportate                             | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Niente segreti nell'esportazione                                  | Impronta della password aggiunta                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Solo l'archivio del titolare                                      | Pazienti di tutto lo studio                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Matrice dei permessi allineata                                    | Riepilogo clinico dato alla segreteria nel codice                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Riepilogo alla segreteria solo se il titolare lo abilita          | Riepilogo sempre consentito                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Impostazioni dell'archivio solo al titolare                       | Impostazioni consentite al sostituto                                | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Allergie riservate escluse dal riepilogo della segreteria         | Filtro delle riservate tolto                                        | Rosso, poi verde (prova aggiunta prima: mancava un'allergia riservata nei dati di prova)                                                                                                                                                                                                                         |
| Sblocco con il codice a 6 cifre                                   | Verifica del codice saltata                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Soglia di inattività di 5 minuti                                  | Valore per difetto 10 nella migrazione                              | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| CSV con tutte le sezioni                                          | Registro tolto dal CSV                                              | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| CSV con BOM                                                       | BOM tolto                                                           | Rosso, poi verde (il primo tentativo non era applicato: lo script l'ha segnalato)                                                                                                                                                                                                                                |
| CSV con le virgolette giuste                                      | Punto e virgola non più tra virgolette                              | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Logo scelto nell'interfaccia                                      | Geometria diversa nel segno del prodotto                            | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Favicon dal logo scelto                                           | Colore cambiato nella favicon                                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Ricetta rossa solo se il sistema non risponde                     | Ricetta rossa ammessa anche con esito incerto                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Un solo invio per ricetta                                         | Presa in carico senza controllo dello stato                         | **Rimasto verde la prima volta**: le due richieste non erano davvero contemporanee. Prova riscritta con una barriera; poi rosso, poi verde                                                                                                                                                                       |
| Ogni invio esterno registrato                                     | Registrazione dell'invio tolta                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Ripetizione della segreteria nella coda «da firmare»              | Ripetizione lasciata in bozza                                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Ricetta a nome di chi firma                                       | Messaggio a nome di chi l'ha preparata                              | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Ricetta bianca al Sistema TS                                      | Tutto al SAR                                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Firma solo con il permesso di firma                               | Guardia con il permesso di lettura                                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Controlli bloccanti prima dell'invio                              | Blocchi ignorati                                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Guasto dell'adattatore come esito incerto                         | Guasto trattato come rete assente                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Nessun indirizzo di rete nelle integrazioni                       | Indirizzo aggiunto al simulatore                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Valori presi dai dati                                             | maxPacks di R2 cambiato nel file                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Nessun numero nel codice delle regole                             | Limite scritto a mano                                               | Rosso (lint), poi verde                                                                                                                                                                                                                                                                                          |
| R4: trattamento da almeno 6 mesi                                  | Condizione tolta                                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| R5: piano che scade oggi                                          | Scadenza esclusa                                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| R7: conferma della nota                                           | Conferma ignorata                                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| R11: soglia dell'80%                                              | Soglia ignorata                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| R13: motivazione della non sostituibilità                         | Motivazione vuota accettata                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| R14: priorità per il primo accesso                                | Priorità ignorata                                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| R16: delega revocata                                              | Revoca ignorata                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| R17: prestazioni dell'esenzione                                   | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Versione delle regole alla data                                   | Versione scelta senza guardare la data                              | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Controllo registrato                                              | Registrazione tolta                                                 | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Avviso senza motivo blocca                                        | Solo i blocchi fermano l'invio                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Tabella di docs/regole.md allineata                               | Testo di una regola cambiato nei dati                               | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Ripetizioni entro il limite di confezioni                         | Limite ignorato nel raggruppamento                                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Ripetizioni con la stessa esenzione                               | Esenzione ignorata nel raggruppamento                               | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| R11 informativo nella versione .2                                 | R11 di nuovo «avvisa» nella .2                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| A parità di data vale la versione più alta                        | Ordine delle versioni senza numero                                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Ogni blocco porta la fonte della regola                           | Fonte non aggiunta dal motore                                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| R15 spiega che cosa fare                                          | Rimedio tolto                                                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Date compatte tolte dalle intestazioni come in sync               | Date di 8 cifre lasciate                                            | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Virgolette raddoppiate nei CSV come Python                        | Virgolette doppie ignorate                                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Mappatura incompleta non si usa                                   | Nessun campo mancante mai                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Impronta del file in uso uguale a stato.json                      | Controllo dell'impronta saltato                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Trascrizione superata se il PDF cambia                            | Controllo dell'impronta del PDF saltato                             | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| A5: vale la versione più recente alla data                        | Ordine per data invertito                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Assenza dalla classe A non diventa «non a carico SSN»             | reimbursableSsn falso per assenza                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| D12: comuni veri con la lettera X segnalati                       | Lettera cercata sbagliata                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Banche dati importate immutabili                                  | Trigger di ref_drug tolto dalla migrazione                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| D70: ricetta già lavorata non annullabile                         | Rifiuto tolto                                                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| D70: presa in carico non annullabile                              | Presa in carico ammessa                                             | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| D70: le annullate restano nello storico                           | Annullate filtrate                                                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| D65: nello storico solo la terapia scelta                         | Righe di ogni terapia                                               | **Non rilevato la prima volta** (nello scenario nessuna altra terapia aveva ricette): prova rafforzata con un secondo farmaco; poi rosso, poi verde                                                                                                                                                              |
| Esami senza giudizio (D71)                                        | Campo «sopra» aggiunto                                              | **Non applicato la prima volta** (il comando non aveva inserito il campo); rifatto con un controllo che il campo ci sia: rosso, poi verde                                                                                                                                                                        |
| D67: simboli decorativi                                           | aria-hidden tolto                                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| D68: al massimo 20 cartelle                                       | Limite 21                                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Uscita che svuota il browser                                      | Pulizia tolta                                                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Bersagli di almeno 44 px                                          | Pulsanti alti 30 px                                                 | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Tablet senza scorrimento di lato                                  | Griglia della pagina senza limite                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Scheda: R13 nel servizio                                          | Motivazione non richiesta                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Sospensione per reazione avversa → allergia                       | Allergia non registrata                                             | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Indicazione: solo un problema del paziente                        | Controllo dell'indicazione tolto                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| La segreteria non scrive le terapie                               | Guardia con therapy.read                                            | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Si sospende solo una terapia in corso                             | Controllo dello stato tolto                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| D85: messaggi di validazione in italiano                          | Traduzione tolta                                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Registro anche con l'identificativo sbagliato                     | Identificativo validato prima della guardia                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| D80: una volta a settimana = ⅐                                    | Diviso per 5                                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| D80: al bisogno senza contatore                                   | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| R13 detto prima di salvare                                        | Controllo tolto nell'interfaccia                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Recapiti: provincia in maiuscolo                                  | Maiuscolo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| D83: riservate fuori dallo schema                                 | Filtro delle riservate tolto                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| D83: su carta solo il foglio                                      | Regola di stampa tolta                                              | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Barra delle cartelle corta sulle pagine corte                     | Righe della griglia come prima                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Prova del menu senza dipendere dai tempi                          | Ricerca in tutta la pagina                                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Senza codice di autenticazione la ricetta non vale                | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Ricetta bianca: solo il PDF del SAC                               | Ramo della bianca tolto                                             | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Oscuramento di nome e indirizzo                                   | Oscuramento ignorato                                                | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Delega revocata non vale                                          | Revoca ignorata                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Ristampa dai dati fissati all'invio                               | Dati ricostruiti dall'anagrafica di oggi                            | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Tempo massimo di attesa dell'invio                                | Attesa mille volte più lunga                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Prima dell'invio il promemoria si deve poter fare                 | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Documenti del promemoria immutabili                               | Trigger solo sulla cancellazione                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Code 39: largo 2,5 volte lo stretto                               | Rapporto 3                                                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Pannello del promemoria dopo l'invio (browser)                    | Pannello tolto dall'editor                                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Credenziali legate a medico e servizio (D100)                     | Legame tolto dalla cifratura                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Credenziali mai rilette (D100)                                    | Utente restituito per intero                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Credenziali: solo il medico (D100)                                | Controllo del ruolo tolto                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Invio fermato prima senza credenziali (D100)                      | Credenziali vuote mandate al servizio                               | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Codice di sessione scaduto: niente invio (D102)                   | Scadenza ignorata                                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Eventi sulle credenziali non modificabili                         | Trigger solo sulla cancellazione                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Rifiuto per l'accesso: la ricetta si rimanda così com'è           | Ripresa dell'invio tolta per l'errore «auth»                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Password RUPAR: tre mesi (D101)                                   | Quattro mesi                                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Simulatore: un codice nuovo annulla il precedente                 | Annullamento tolto                                                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Simulatore del SAR: Id-Sessione a ogni chiamata                   | Controllo della sessione tolto                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Avviso dei servizi nella pagina Oggi (browser)                    | Avvisi tolti dalla pagina                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Certificati: solo il medico                                       | Guardia con therapy.read                                            | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Controlli dell'INPS prima dell'invio                              | Controlli ignorati                                                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Civico «SNC» quando manca                                         | Civico vuoto mandato all'INPS                                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Attestato senza diagnosi né visita                                | Diagnosi e visita anche nell'attestato                              | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Copia fissata all'invio                                           | Cognome preso dall'anagrafica di oggi                               | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Rettifica solo per anticipare la fine                             | Controllo della rettifica tolto                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Annullamento entro il giorno dopo il rilascio                     | Controllo del tempo tolto                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Al datore di lavoro solo se lo chiede il lavoratore (D88)         | Richiesta del lavoratore ignorata                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Al datore di lavoro solo il protocollo (D88)                      | Nome del lavoratore nel testo                                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Certificati senza secondo fattore (D102)                          | Secondo fattore richiesto anche per l'INPS                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Invii all'INPS immutabili                                         | Trigger solo sulla cancellazione                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Certificati raggiungibili dalla cartella (browser)                | Collegamento rinominato                                             | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Pagina Oggi robusta a una risposta inattesa                       | Elenco dei servizi letto senza controllo                            | Rosso, poi verde. Trovato dal giro completo delle prove: la prova dell'uscita cadeva solo sotto carico, quando la risposta arrivava prima del clic                                                                                                                                                               |
| Al datore di lavoro mai la diagnosi (D108)                        | Diagnosi nel testo dell'email                                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Al datore di lavoro nome e cognome (D108)                         | Nome tolto dal testo                                                | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Prova D68: scheda trovata per cognome e nome esatti               | (correzione di una prova fragile, non un controllo nuovo)           | Caduta in CI: i nomi inventati cambiano a ogni giro e «Palma» era cognome di un paziente e nome di un altro. Ora l'etichetta si cerca dall'inizio, con cognome e nome interi                                                                                                                                     |
| Accesso regionale: richiesta legata al medico (D111)              | Medico della richiesta non controllato                              | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Accesso regionale: richiesta con scadenza                         | Scadenza ignorata                                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Accesso regionale: chi entra è il medico collegato                | Controllo dell'identità tolto                                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Accesso regionale: profilo di prescrizione                        | Controllo dello scope tolto                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Accesso regionale: token scaduto, niente invio                    | Scadenza del token ignorata                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Accesso regionale: token al posto delle credenziali RUPAR         | Token ignorato                                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Pagina regionale simulata: solo ritorni interni                   | Qualsiasi indirizzo di ritorno                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Voci cliniche: scrive solo il medico                              | Permesso di lettura dell'anagrafica al posto di quello di scrittura | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Voce con data non nel futuro                                      | Controllo della data tolto                                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Codice dei problemi nel formato ICD-9-CM                          | Controllo del formato tolto                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Problema risolto con la data di risoluzione                       | Controllo tolto nel dominio                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Saturazione non oltre 100                                         | Limite della percentuale tolto                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Parametri della visita in una sola transazione                    | Una transazione per parametro, senza controllo prima                | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Andamento dei parametri dalla data più vecchia                    | Ordine invertito                                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Annullamento con motivo obbligatorio                              | Motivo facoltativo                                                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Voce annullata una volta sola                                     | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Voce annullata non si modifica                                    | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Stato e risoluzione solo per i problemi                           | Controllo del tipo tolto                                            | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Problema di nuovo attivo senza data di risoluzione                | Data lasciata                                                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Promemoria non prima della voce, anche in modifica                | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Voci riservate solo a chi le legge (elenco)                       | Filtro delle riservate tolto                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Voce del paziente della cartella                                  | Paziente della voce non controllato                                 | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Consensi: anche la segreteria li registra                         | Permesso delle voci cliniche al posto di quello dell'anagrafica     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Consenso con data non nel futuro                                  | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| «Altro consenso» con la descrizione                               | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Si revoca solo un consenso dato                                   | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Revoca non prima del consenso                                     | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| In vigore l'ultima espressione del consenso                       | Ordine invertito                                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Codice fiscale del delegato valido                                | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Fine della delega non prima dell'inizio                           | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Delega revocata una volta sola                                    | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Delega revocata non più valida (R16)                              | Revoca ignorata nel dominio                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Piani: scrive chi modifica le terapie                             | Permesso di lettura delle terapie                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Scadenza del piano non prima del rilascio                         | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Piano riservato: fuori dall'elenco per la segreteria              | Filtro tolto                                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Piano riservato: fuori dal riepilogo per la segreteria            | Filtro tolto                                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Piano riservato: fuori dalla pagina Oggi per la segreteria        | Filtro tolto                                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Piano annullato fuori dalla pagina Oggi                           | Filtro dello stato tolto                                            | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Piano annullato fuori da R5 e R6                                  | Filtro dello stato tolto nei controlli delle regole                 | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Piano annullato fuori dal riepilogo                               | Filtro dello stato tolto                                            | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Piano annullato una volta sola                                    | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Piano annullato non si modifica                                   | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Contrasto della seconda serie dei grafici (≥ 3:1)                 | Magenta schiarito in `tokens.ts`                                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Grafico raggiungibile con la tastiera (browser)                   | Riquadro dei valori non aperto al fuoco                             | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Seguito: scrive solo il medico                                    | Permesso di lettura dell'anagrafica al posto di quello di scrittura | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Seguito: lo legge chi legge il diario                             | Permesso dell'anagrafica                                            | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Referti: li scarica chi legge il diario                           | Permesso dell'anagrafica                                            | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Referti serviti senza script                                      | Intestazione `sandbox` tolta                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Esecuzione non nel futuro                                         | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Esecuzione non prima della prescrizione                           | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Sedute entro quelle prescritte                                    | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Seduta registrata una volta                                       | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Tipo del file dai primi byte                                      | Controllo della firma tolto                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| File al più 5 MB                                                  | Limite tolto                                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Seguito solo della ricetta specialistica                          | Controllo del tipo di ricetta tolto                                 | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Riga del paziente della cartella                                  | Paziente della riga non controllato                                 | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Esecuzione annullata una volta                                    | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Con l'esecuzione si annulla il referto                            | Annullamento del referto tolto                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Referti nell'esportazione JSON                                    | Sezione degli allegati vuota                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Referti nello ZIP come file                                       | File non scritti nello ZIP                                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Presidi: scrive chi modifica le terapie                           | Permesso di lettura delle terapie                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Medicazioni avanzate: prima lo specialista                        | Controllo tolto nel dominio                                         | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Medicazioni avanzate: al massimo 6 mesi                           | Limite tolto nel dominio                                            | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Prima prescrizione dello specialista non dopo l'inizio            | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Rinnovo: la precedente si conclude                                | Stato della precedente lasciato                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Si rinnova solo una prescrizione in corso                         | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Presidi riservati solo a chi li legge                             | Filtro tolto                                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Presidio annullato una volta                                      | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Indicazione del paziente della cartella                           | Paziente dell'indicazione non controllato                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Scheda attiva in vista nella barra (D129)                         | Scorrimento della barra all'apertura tolto                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Scheda attiva in vista anche dopo il ridimensionamento            | Ascolto del ridimensionamento tolto                                 | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Al massimo 20 cartelle aperte (prova nel browser)                 | Limite portato a 21                                                 | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Nota in scrittura ricordata per paziente                          | Bozza tenuta solo nella pagina                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Bozza della nota separata per paziente                            | Paziente tolto dalla chiave della bozza                             | Prima rimasto verde: la prova guardava l'altro paziente solo dopo la registrazione; prova rafforzata (controllo con la nota ancora in sospeso), poi rosso e verde                                                                                                                                                |
| Registrata la nota, la bozza si cancella                          | Cancellazione della bozza tolta                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Parametri in scrittura ricordati per paziente                     | Bozza tenuta solo nella pagina                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Impronte dei file ufficiali del Fascicolo (tappa 11)              | Un carattere cambiato in un dizionario ufficiale                    | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Schematron: ogni nodo solo dalla prima regola del gruppo          | Controllo dei nodi già visti tolto                                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Schematron: confronto tra testi come in XPath 2                   | Riscrittura dei confronti tolta                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Documento: assenza di allergie con il modello ufficiale           | Modello dell'allergia al posto di quello dell'assenza               | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Documento: il testo del medico si scrive come testo XML           | `<` e `>` lasciati così                                             | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Vie di somministrazione nel dizionario ufficiale                  | Codice di «per bocca» cambiato                                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Simulatore: impronta del file nel token di firma                  | Confronto dell'impronta tolto                                       | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Simulatore: si pubblica solo il documento validato                | Confronto con il documento validato tolto                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Simulatore: niente pubblicazione dopo 5 giorni                    | Limite dei 5 giorni tolto                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Simulatore: paziente del token uguale a quello del documento      | Confronto tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Simulatore: si pubblica solo il PDF con la firma PAdES            | Basta che ci sia una firma qualsiasi                                | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Simulatore: certificato di collegamento rilasciato                | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Simulatore: certificato di firma dei token rilasciato             | Controllo tolto                                                     | Prima rimasto verde: nella prova il secondo programma aveva un altro orologio e il rifiuto arrivava per il token scaduto; prova corretta (stesso orologio, motivo esatto), poi rosso e verde                                                                                                                     |
| Firma PAdES sui byte giusti del file                              | Un byte in meno tra quelli firmati                                  | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Firma dei token controllata                                       | Verifica della firma sempre buona                                   | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Profilo: le voci oscurate non entrano                             | Filtro tolto                                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Profilo: le voci riservate non si propongono                      | Filtro tolto                                                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Il collega di gruppo non firma il Profilo                         | Divieto tolto nel dominio                                           | Prima non riconosciuto: la prova del dominio diventava rossa, ma il controllo cercava un altro titolo; nella prova del servizio il collega non aveva l'autorizzazione di gruppo, quindi il rifiuto era generico. Prova rafforzata (collega autorizzato che legge ma non firma, motivo esatto), poi rosso e verde |
| Il Profilo validato non cambia nel database                       | Guardia del trigger spenta                                          | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Rotte del Profilo: prima la guardia, poi l'identificativo         | Identificativo controllato prima della guardia                      | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Esportazione: il Profilo tra le tabelle esportate                 | `pss_document` tolto dall'elenco                                    | Prima non riconosciuto: l'esportazione si fermava prima delle prove e il controllo cercava solo le prove rosse, non la suite caduta; controllo corretto, poi rosso e verde                                                                                                                                       |
| Organi mancanti solo dal dizionario ufficiale                     | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Allergeni solo dal dizionario ufficiale                           | Controllo tolto                                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Recapiti di studio solo del medico                                | Controllo del ruolo tolto                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Pubblicato solo con l'invio a INI riuscito (tappa 11)             | Basta un evento qualsiasi nello stato                               | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Simulatore: lo stato resta in attesa finché INI non ha i dati     | Invio a INI completato a ogni richiesta                             | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Lo stato si controlla solo per il Profilo preso in carico         | Controllo dello stato del documento cambiato                        | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Impostazioni del Fascicolo: le cambia l'amministratore            | Controllo del ruolo tolto                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Impostazioni: nomi dalle tabelle della specifica                  | Nome di OBS cambiato                                                | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| «Strumenti» solo nel menu dell'amministratore (prova nel browser) | Voce mostrata a tutti                                               | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| La casella del Profilo cambia subito (prova nel browser)          | Scelta in attesa ignorata                                           | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Provenienza di immagini, documenti e archivi (D142)               | Un'immagine estranea in `docs/`                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
| Dipendenze solo con licenze permissive (D142)                     | MIT tolta dalle licenze ammesse                                     | Rosso, poi verde                                                                                                                                                                                                                                                                                                 |
