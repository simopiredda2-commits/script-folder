# CLAUDE.md – memoria del progetto

Questo file e `docs/avanzamento.md` bastano a una sessione nuova per ripartire. Leggili entrambi prima di fare qualsiasi cosa. Le scelte prese sono in `docs/decisioni.md`.

## Il progetto

Folder è una cartella clinica in cloud per medici di medicina generale (MMG). Si parte dal Piemonte e dallo studio della Dr.ssa Chiara Rocca. Si integrerà con SAR/SIRPED (CSI Piemonte), Sistema TS, AURA, INPS, FSE 2.0 e Farmadati. Il repository è indipendente: non dipende da altri repository.

- Fonte principale dei requisiti: `docs/requisiti.md` (copia della revisione 45 del 18/11/2026; la versione viva è su claude.ai, https://claude.ai/artifact/FN9ZLcPA6WXRFXeUwvdLYt).
- Schermate di riferimento, **solo per il layout**: `docs/prototipi/` (non riusare il codice; usano Google Fonts, che nel prodotto non si usano).
- Banche dati pubbliche: `sync/` (Python, sola libreria standard; prove con `python3 -m unittest -v test_banche_dati` dentro `sync/`).
- Marchio di SCRIPT: `packages/brand/assets/script/`, impronte in `SHA256SUMS`.
- I materiali sono arrivati dallo zip `materiali-script-folder.zip` sul Google Drive di Simone (id `1IRpMa2FYclplhoowgjkEHtZ6tdZsPxql`, 102557 byte, SHA-256 `28464b1d85ec30b4aeeacf9592d7fb102285b1120b114ab2f414f660b1375cb7`). Lo zip non entra nel repository.

## SCRIPT e marchio

SCRIPT è lo studio di innovazione digitale di Simone Piredda: software house, consulenza, marketing e comunicazione. Folder è uno dei suoi prodotti e si presenta come «Folder by SCRIPT»: nome del prodotto in evidenza, «by SCRIPT» piccolo (pagina di accesso, piede, Informazioni).

- Il marchio di SCRIPT si usa identico ai file ufficiali: non ridisegnarlo, non ricolorarlo, non descriverlo a parole nei testi.
- Colori di SCRIPT, come token in `packages/brand`: luce `#4D6BFE`, ombra `#1B237A`, testo `#0E1435`; su fondo scuro `#8FA0FF`, `#3B4DE0` e bianco.
- Palette dell'interfaccia (D69, confermata alla fermata finale): blu di SCRIPT per struttura e informazioni; evidenziatore giallo `#FFE45C` solo come sfondo con testo scuro (contatori, cartella attiva, selezioni); avvisi in arancio bruciato, errori in rosso, esiti in verde; ogni messaggio anche con simbolo e parola.
- Caratteri: Special Gothic Expanded One (nome del prodotto e titoli), IBM Plex Sans (testo), IBM Plex Mono (codici ed etichette: codice fiscale, NRE, AIC). Licenza OFL 1.1, dai pacchetti npm `@fontsource/special-gothic-expanded-one`, `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono`, serviti dal nostro dominio: mai da Google Fonts o da altre CDN.
- Testi dell'interfaccia: italiano, registro professionale, tecnico ma chiaro; niente tono colloquiale.

### Logo di Folder

Il segno di oggi (nei prototipi) è un tratto di ECG accanto al nome, nato quando il prodotto si chiamava Polso:
`<svg width="30" height="30" viewBox="0 0 30 30"><polyline points="2,16 9,16 12,7 16,23 19,16 28,16" fill="none" stroke="#1F3A9E" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`

- Proposte (2 o 3) in `packages/brand/assets/proposte-logo/`, insieme al segno di oggi, mostrate in `docs/logo.md` (affiancate, a varie misure, su fondo chiaro e scuro).
- Carattere del segno: linea continua, spessore costante, estremi arrotondati, ritmo piatto–su–giù–piatto riconoscibile. Marchio piatto, nessuna sfumatura. Leggibile a 16 e 32 px, su fondo chiaro e scuro. Nella versione col nome, il nome è in Special Gothic Expanded One convertito in tracciati, non testo.
- Il simbolo di SCRIPT non entra nel logo di Folder: resta separato, accanto a «by SCRIPT».
- **Logo scelto: B, linguetta a picco** (prima fermata). Segno in `packages/brand/mark.ts` (`productMark`), file in `packages/brand/assets/logo/`, nome sempre da `PRODUCT_NAME`. Il segno di oggi resta solo come riferimento (`previousMark`).
- **Su fondo scuro** (D214): icona gialla `#FFE45C` con il segno blu scuro `#1B237A` (`productMark.onDark`); sul chiaro il segno resta blu. La favicon passa all'icona gialla quando il browser è in tema scuro.

## Regole che non si discutono

1. **Nessun dato reale**: test, demo, fixture e log usano solo pazienti inventati.
2. **Sviluppo indipendente**: niente copie di schermate, documentazione o dati di altri software (in particolare Evolus Next²). Si parte dai requisiti, dalle specifiche pubbliche e da come lavora la dottoressa. Le schermate di Next² mandate da Simone o dalla Dr.ssa Rocca, che lo usano, possono suggerire campi e funzioni che loro chiedono perché servono (D89). I campi obbligatori si verificano sulle specifiche pubbliche. Non si copiano impaginazione, testi, codice, documentazione o dati di Next², e le schermate non entrano nel repository. Una prova controlla la provenienza di immagini, documenti e archivi e le licenze delle dipendenze; il registro è `docs/provenienze.md` (D142).
3. **Non diventare un dispositivo medico**: niente suggerimenti diagnostici o terapeutici. Le regole di prescrizione sono solo controlli formali.
4. **I dati sono del medico**: esportazione completa in formato aperto, sempre possibile.
5. **Ruoli e tracciamento**: la segreteria prepara, il medico firma e invia; ogni accesso a una cartella viene registrato.
6. **Il nome del prodotto sta solo in `packages/brand/brand.ts`** (`PRODUCT_NAME = "Folder"`, `COMPANY_BRAND = "SCRIPT"`). Altrove nel codice, nei test e nei testi dell'interfaccia non si scrive mai. Poiché la parola è anche inglese comune, nel codice non usarla nemmeno come termine tecnico: scrivi `directory` o `dir`. Un test lo controlla in `apps/`, `packages/` e `sync/`.
7. **Niente segreti nel repository e nessuna chiamata a servizi reali**: le integrazioni sono interfacce con simulatori.
8. **Nessuna risorsa da CDN esterne**, caratteri compresi: tutto servito dal nostro dominio, così nessun dato esce dall'UE.

## Come si lavora con Simone

- **Regola: con Simone si scrive sempre e solo in italiano.** Vale per ogni messaggio, compresi gli aggiornamenti intermedi, le domande e le descrizioni dei comandi, e per documenti, commit e PR. Codice in inglese, tranne i termini normativi senza equivalente (impegnativa, esenzione, DPC); interfaccia in italiano.
- Alle fermate le domande si fanno con il pulsante (AskUserQuestion): poche, ognuna con le opzioni e quella consigliata, mai «dimmi tu» in prosa. **Tra le fermate nessuna domanda**: si annotano in `docs/avanzamento.md`.
- **Regola: non chiedere a Simone ciò che puoi fare da te** (richiesta di Simone del 19/11/2026). Scaricare un file, cercare un atto o una fonte, estrarre o trascrivere dati, provare qualcosa: prima si prova, poi si dice che è fatto. A Simone si chiede solo ciò che da qui non si può fare: decisioni, verifiche cliniche, credenziali e atti amministrativi, file da siti che bloccano questo ambiente (dopo averli provati, dicendo quale sito e quale errore).
- Se un dettaglio non è deciso: scegli, scrivi scelta e motivo in `docs/decisioni.md`, vai avanti.
- Se qualcosa è irreversibile: non farlo, annotalo in `docs/avanzamento.md` e prosegui con il resto.
- Nessun valore inventato o ricostruito a memoria: si legge dal file o dalla fonte, e si dice sempre che cosa non è stato provato.
- Se una tappa richiede un valore che non c'è nei requisiti (una soglia, la fonte di una regola): costruisci il meccanismo, lascia il valore vuoto con la nota «da completare» e prosegui.
- Ogni controllo nuovo si prova con un **sabotaggio**: rompi apposta, verifica che diventi rosso, ripristina. Il registro dei sabotaggi è in `docs/avanzamento.md`.
- Se trovi un conflitto tra queste istruzioni e i requisiti, non scegliere da solo: è una domanda per la fermata.
- Workflow e lavorazioni pesanti (molti agenti) solo se strettamente necessari.

## Come si procede

- Un branch per blocco di tappe, ognuno con una pull request verso `main` (cosa c'è, come provarlo, scelte prese, che cosa non è stato provato). Primo giro: `tappe-0-2`, `tappe-3-4`, `tappe-5-6`, unite. Secondo giro (D90): `tappe-7-8`, `tappe-9-10`, unite. Terzo giro (D128): `tappe-11-12`, unita (#6, via del 19/11/2026). Quarto blocco (richieste del 19/11/2026): `tappe-14-15`, unito (#7, via del 19/11/2026). Correzione di una prova instabile con WebKit: unita (#8). Quinto blocco (via del 19/11/2026, D182): branch `ccr-9780f0fd-iyj18e`, tappe 16 e 17, unito (#9, via del 19/11/2026). Dopo l'unione lo stesso branch, ripartito da `main`, porta le modifiche che seguono dalle risposte della fermata (D191): pull request #10.
- Dopo ogni tappa: test e lint verdi, commit e push (la macchina in cloud può essere riciclata), poi aggiornare `docs/avanzamento.md` con fatto, non fatto, non provato e prossimo passo.
- **Fermate**: dopo la tappa 2 e dopo la tappa 4. Domande con il pulsante a Simone; spiegare in parole semplici cosa devono verificare lui e la Dr.ssa Rocca (dopo la 2: struttura, modello dei dati, ruoli e permessi; dopo la 4: ciclo della ricetta e regole di prescrizione con le loro fonti) e chiedere il via. Alla prima fermata chiedere anche quale proposta di logo preferisce, con il collegamento a `docs/logo.md` su GitHub, indicando quella consigliata. Se chiede modifiche: farle, aggiornare la PR, richiedere il via. Con il via: unire la PR e continuare. Simone non interviene su GitHub: le PR le unisce Claude.
- Dopo la tappa 6: stesso giro per l'ultima PR (fatto).
- **Secondo giro** (via di Simone del 18/11/2026: «fai tutto, nell'ordine che ritieni giusto»): fermata dopo la tappa 8 (promemoria e certificati, con i modelli e le fonti) e fermata finale dopo la tappa 10, con lo stesso giro (domande con il pulsante, via, unione), poi fermarsi.

## Struttura

| Percorso                | Contenuto                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `apps/web`              | Interfaccia per PC e tablet                                                                   |
| `apps/api`              | Servizio applicativo                                                                          |
| `apps/demo`             | Dimostrazione nel browser per l'artifact: interfaccia e servizio con PGlite (D221, D224)      |
| `packages/brand`        | Nome, marchi, colori e caratteri (unico posto con il nome del prodotto)                       |
| `packages/domain`       | Modello del dominio                                                                           |
| `packages/rules`        | Regole di prescrizione: valori e fonti versionati come dati, mai scritti nel codice           |
| `packages/integrations` | Interfacce e simulatori (SAR/SIRPED, Sistema TS, AURA, INPS, FSE)                             |
| `packages/reference`    | Lettura dei file di `sync/` (CSV, XLSX), tipi di banca dati, mappature e trascrizioni (D159)  |
| `sync/`                 | Banche dati pubbliche (Python)                                                                |
| `fixtures/`             | Pazienti inventati (generatore deterministico); `banche-dati/`: sito e trascrizioni d'esempio |
| `docs/`                 | Requisiti, prototipi, decisioni, avanzamento, logo                                            |
| `scripts/`              | `avvio-sessione.sh` (hook SessionStart) e utilità                                             |

## Stack (provvisorio)

TypeScript ovunque, Node 22, pnpm workspaces, Postgres 16 con migrazioni versionate; `sync/` resta in Python. Le scelte di framework, ORM e test runner sono in `docs/decisioni.md`.

## Ambiente

- `scripts/avvio-sessione.sh` è l'hook SessionStart (`.claude/settings.json`). Solo se `CLAUDE_CODE_REMOTE=true`: avvia Postgres 16, crea se mancano l'utente `mmg` (password locale `mmg`, con CREATEDB) e il database `mmg_dev`, scrive `DATABASE_URL` e `TZ=Europe/Rome` in `$CLAUDE_ENV_FILE`, installa le dipendenze solo se è cambiato un file che le decide (impronte in `node_modules/.avvio-sessione.sha256`).
- `DATABASE_URL=postgres://mmg:mmg@localhost:5432/mmg_dev` (valore locale, non un segreto; vedi `.env.example`).
- `APP_AMBIENTE`: «prova» (per difetto: solo pazienti inventati dove si controlla, seed ammesso) o «produzione» (seed vietato), D170.
- `APP_PROXY_FIDATI`: indirizzi o reti dei proxy inversi davanti al servizio (vuota per difetto: X-Forwarded-For si ignora), per l'indirizzo vero nel registro dei tentativi falliti (D179).
- `AURA_AGGIORNAMENTO`: ora del controllo di ogni notte su AURA, ora di Roma (per esempio `02:30`). Vuota per difetto: niente giro di notte; restano le notifiche, il pulsante e il controllo prima della ricetta (D197).
- La sessione in cloud usa l'ambiente «Folder»: raggiunge i registri dei pacchetti e alcuni siti pubblici, solo per leggere specifiche, decreti e dati aperti (Sistema TS, Gazzetta Ufficiale, Normattiva, INPS, AIFA anche `drive.aifa.gov.it`, Regione Piemonte, Ministero della Salute, due ASL; D92, D148). Gli altri siti istituzionali no; il prodotto non chiama nessuno di questi siti (regola 7).

## Comandi

| Comando                                                                                                                                                                    | Cosa fa                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                                                                                                                                                             | Dipendenze (in cloud lo fa l'hook, solo se cambiate)                                                                               |
| `pnpm dev`                                                                                                                                                                 | Applica le migrazioni e avvia servizio (porta 3001) e interfaccia (porta 5173)                                                     |
| `pnpm test`                                                                                                                                                                | Tutte le prove: TypeScript (Vitest, con database temporanei) e `sync/` (Python)                                                    |
| `pnpm lint`                                                                                                                                                                | ESLint, Prettier in controllo, tipi di ogni pacchetto                                                                              |
| `pnpm format`                                                                                                                                                              | Prettier in scrittura                                                                                                              |
| `pnpm db:migrate`                                                                                                                                                          | Applica le migrazioni a `DATABASE_URL`                                                                                             |
| `pnpm db:seed`                                                                                                                                                             | Dati dimostrativi inventati (idempotente; password casuali mostrate una volta)                                                     |
| `pnpm studio:crea -- --nome … --tipo singolo --regione … --amministratore … --nome-amministratore …`                                                                       | Primo avvio di uno studio vero: studio e primo amministratore, password temporanea mostrata una volta                              |
| `pnpm utente:ripristina -- --utente NOME --mostra`, poi `--conferma --richiesta-il DATA` o `--rifiuta`; anche `--sblocca`, `--secondo-fattore`, `--sospendi`, `--riattiva` | Dal server: legge e conferma o rifiuta chi è in attesa quando nessun titolare può farlo, sblocca, dà credenziali nuove (D179)      |
| `pnpm banche-dati:importa -- --dati DIR --trascrizioni DIR`                                                                                                                | Importa l'output di `sync/` e le trascrizioni dei PDF                                                                              |
| `pnpm banche-dati:importa -- --esempio`                                                                                                                                    | Lancia `sync/` sul sito d'esempio e importa (banche dati dimostrative)                                                             |
| `pnpm banche-dati:aggiorna -- --dati DIR --trascrizioni DIR`                                                                                                               | Aggiornamento completo: `sync/`, importazione, registro del giro (D156)                                                            |
| `pnpm --filter @mmg/api exec tsx test/e2e/schermate.ts`                                                                                                                    | Fotografa le schermate per `docs/interfaccia.md` (istruzioni nel file)                                                             |
| `pnpm --filter @mmg/demo build`                                                                                                                                            | Costruisce la dimostrazione nel browser in `apps/demo/dist/artifact` (D221)                                                        |
| `pnpm --filter @mmg/demo test:browser`                                                                                                                                     | Prova la dimostrazione costruita dentro una cornice come l’artifact; `DEMO_BROWSER=webkit` o `firefox` per gli altri motori (D224) |
| `pnpm --filter @mmg/domain docs:permessi`                                                                                                                                  | Rigenera la matrice di `docs/ruoli-permessi.md` dal codice                                                                         |
| `pnpm --filter @mmg/rules docs:regole`                                                                                                                                     | Rigenera la tabella di `docs/regole.md` dai dati delle regole                                                                      |
| `pnpm --filter @mmg/api db:generate`                                                                                                                                       | Genera una migrazione dallo schema Drizzle                                                                                         |
| `pnpm fixtures -- --seed 1 --count 20`                                                                                                                                     | Pazienti inventati in JSON (stesso seme, stessi pazienti)                                                                          |
| `pnpm --filter @mmg/brand tokens:css`                                                                                                                                      | Rigenera `tokens.css` da `tokens.ts`                                                                                               |
| `pnpm --filter @mmg/brand logo:proposte`                                                                                                                                   | Rigenera le proposte di logo e le tavole di `docs/logo.md`                                                                         |
| `scripts/sabotaggio.sh -f FILE -s 'GUASTO' -t 'PROVA'`                                                                                                                     | Prova un controllo: rosso col guasto, verde dopo il ripristino                                                                     |

Le prove del database vogliono `DATABASE_URL`: senza, falliscono (non si saltano). Il servizio vuole anche `APP_ENCRYPTION_KEY` (in cloud la imposta l'hook).

## Documenti per la revisione

- `docs/modello-dati.md`: entità, stato e scelte.
- `docs/ruoli-permessi.md`: ruoli, matrice generata dal codice, accesso.
- `docs/esportazione.md`: formato dell'esportazione.
- `docs/ricetta.md`: ciclo della ricetta e integrazioni simulate; promemoria secondo le specifiche di stampa del Sistema TS del 28/02/2024 (D217), su A5 per difetto (D222).
- `docs/regole.md`: regole di prescrizione, generate dai dati.
- `docs/logo.md`: proposte di logo.
- `docs/banche-dati.md`: importazione delle banche dati, mappature, trascrizioni, versioni; lista di trasparenza e farmaci carenti di AIFA (D202), stato delle confezioni (D205), registri e piani terapeutici AIFA (D206), nomenclatore dei presidi degli allegati 3 (D218) e 2 (D236) del DPCM LEA.
- `docs/catalogo-regionale.md`: catalogo regionale in vigore, trascritto dai PDF, e che cosa controllare (D159).
- `docs/icd9cm.md`: catalogo delle diagnosi ICD-9-CM (versione italiana 2007 e aggiunte COVID-19), che cosa è diverso dal PDF e che cosa controllare (D186).
- `docs/interfaccia.md`: schermate (in `docs/schermate/`), accessibilità, che cosa manca.
- `docs/credenziali.md`: credenziali dei servizi (Sistema TS, RUPAR) e secondo fattore.
- `docs/certificati.md`: certificati di malattia INPS, copia e attestato, consegne.
- `docs/fse.md`: Fascicolo Sanitario Elettronico 2.0 e Profilo Sanitario Sintetico, con le fonti (D110); apertura del Fascicolo regionale dalla cartella (D220).
- `docs/provenienze.md`: da dove viene ogni contenuto, a quali condizioni, chi lo controlla (D142).
- `docs/aft.md`: condivisione del riepilogo tra i medici dell'AFT, con il consenso del paziente (D161).
- `docs/amministrazione.md`: Strumenti e amministrazione per ruolo, primo avvio, utenti, studio, postazioni, stampa, elenchi (tappa 14, D163).
- `docs/importazione.md`: importazione da altri programmi con lo smistamento verso i menu, formati, destinazioni, sicurezza (tappa 15, D173).
- `docs/ppip.md`: prestazioni aggiuntive (PPIP). Catalogo versionato per livello (ACN, AIR, accordo dell'ASL); registrazione in cartella; distinta del mese con il CSV in un formato descritto come dato; invio predisposto con un simulatore; fonti e che cosa controllare (D212, D213).
- `docs/aura.md`: collegamento con AURA, oggi simulato: quando si controlla, che cosa si allinea, nuovi assistiti, cambio di medico dentro lo studio, registro, che cosa non è provato (D197–D200).

## Le tappe

0. Preparazione: README su `main`, materiali, questo file, hook di avvio, `.gitignore`, `.env.example`, `docs/decisioni.md`, `docs/avanzamento.md`.
1. Scheletro: monorepo, lint, formattazione, test e CI su GitHub Actions (comprese le prove di `sync/`); `packages/brand` con nome, token, caratteri e marchio di SCRIPT, con test sulle impronte di `SHA256SUMS`; test che fallisce se il nome del prodotto compare fuori da `packages/brand` in `apps/`, `packages/` o `sync/`; connessione a Postgres, prima migrazione e test che la esegue; un comando per avviare tutto e uno per i test; in `fixtures/` un generatore deterministico di pazienti inventati (stesso seme, stessi pazienti; mai codici fiscali di persone reali); proposte del logo.
2. Modello, ruoli e accesso: entità del dominio dai requisiti; ruoli titolare, segreteria, sostituto, medicina di gruppo, amministratore con i permessi dei requisiti; accesso come nei requisiti (altrimenti account e password con secondo fattore predisposto; SPID e CIE più avanti); registro degli accessi a ogni cartella, non modificabile; esportazione completa dei dati del medico in formato aperto. **Prima fermata.**
3. Ciclo della ricetta: bozza → da firmare → inviata → errore o annullata; la segreteria prepara, il medico firma e invia; integrazioni simulate (SAR/SIRPED, Sistema TS) con risposta positiva, errore e assenza di rete; ripiego sulla ricetta cartacea dei requisiti.
4. Regole di prescrizione: motore con le regole dei requisiti (quelle fuori perimetro restano fuori), valori e fonti versionati come dati; blocco per le regole normative, avviso con motivo registrato per quelle di buona pratica. **Seconda fermata.**
5. Banche dati pubbliche: importare nel database l'output di `sync/` (farmaci AIFA, DPC, catalogo delle prestazioni, esenzioni, comuni), provando con piccoli file d'esempio nel formato documentato in `sync/`.
6. Interfaccia per PC e tablet: oggi, elenco pazienti con ricerca, cartella (riepilogo e cronologia), ricetta, terapia, esami, specialistica, ricerca farmaco e coda «da firmare». WCAG 2.2 AA, bersagli di almeno 44 px.

Secondo giro (D90), con lo stesso metodo: requisiti, specifiche pubbliche, simulatori, prove e sabotaggi, schermate.

7. Promemoria e invio: promemoria sul modello ufficiale, per la ricetta SSN e per la ricetta bianca elettronica, completo o solo NRE; invio per email al paziente o al delegato registrato con un simulatore, secondo R15 e R16.
8. Certificati INPS: inizio, continuazione o ricaduta; visita ambulatoriale o domiciliare; prognosi; diagnosi ICD-9-CM e testo; reperibilità; invio con il simulatore del Sistema TS e numero di protocollo; copia al lavoratore; al datore di lavoro protocollo con nome e cognome, mai la diagnosi (D88, D108); rettifica e annullamento nei casi ammessi. **Terza fermata.**
9. Voci cliniche dall'interfaccia: problemi, allergie e reazioni, diario, parametri, anamnesi, stili di vita, esame obiettivo, privacy (consensi, deleghe, oscuramento), piani terapeutici.
10. Presidi e assistenza integrativa; seguito delle prestazioni (esecuzione, struttura, esito, referto, sedute); voci nuove solo dopo la verifica sulla fonte (D91). **Fermata finale del secondo giro.**

Dalla terza fermata: prima della tappa 9, secondo fattore con SPID o CIE dal programma (D109). Secondo giro chiuso con la fermata finale del 18/11/2026 (D125–D128).

Terzo giro (via del 18/11/2026, D128), branch `tappe-11-12`, stesso metodo:

11. Profilo Sanitario Sintetico per il Fascicolo con un simulatore del Gateway, dalle fonti di `docs/fse.md` (prima quelle ancora da leggere).
12. Condivisione tra i medici dell'AFT che usano il programma. **Fermata dopo la tappa 12**, con lo stesso giro (domande con il pulsante, via, unione), poi fermarsi.
13. Modelli dei certificati (richiesta diretta di Simone, D143): sportivo non agonistico, porto d'armi, anamnestico per la patente e altri; testi solo dagli atti ufficiali; si compilano i dati del paziente; menu «Modelli» negli strumenti; caratteri, intestazione e dimensioni scelti dal medico. Si fa dopo la 11 e prima della 12; la fermata della 12 copre anche questa.

Terzo giro chiuso: via dato in anticipo da Simone il 19/11/2026 («Do già adesso l'autorizzazione al via»), pull request #6 unita. Le domande di merito di quella fermata (catalogo, AFT, patente) si fanno alla fermata dopo la tappa 15, insieme alle nuove.

Richieste di Simone del 19/11/2026, branch `tappe-14-15`, stesso metodo:

14. Strumenti e amministrazione completi: tutte le impostazioni e i dati modificabili (dati dello studio, utenti e ruoli, password, postazioni e stampa, intestazioni, elenchi dello studio, autorizzazioni sull'archivio, registro delle azioni di amministrazione, avvisi sugli accessi anomali, stato del servizio).
15. Importazione da altri programmi in vari formati, con lo smistamento dei dati verso i menu (anagrafica e pannello amministrativo del paziente, storia clinica, patologie, farmaci in terapia e prescritti); i menu che mancavano si costruiscono. **Fermata dopo la tappa 15**, con lo stesso giro (domande con il pulsante, via, unione).

Fermata dopo la tappa 15 fatta (D181): via, pull request #7 unita. Le scelte da costruire sono in `docs/avanzamento.md` («Risposte della fermata dopo la tappa 15»): si fanno in un blocco nuovo, quando Simone dà il via.

Quinto blocco (via di Simone del 19/11/2026: «ok. Chiudi tutto ciò che puoi chiudere», D182), branch `ccr-9780f0fd-iyj18e`, stesso metodo:

16. Le scelte della fermata dopo la tappa 15 (D181): ripristino delle credenziali di medici e segreteria anche con SPID o CIE; segreteria confermata per archivio; ritardi crescenti dopo i tentativi falliti, blocco del conto oltre una soglia alta e avviso di ogni blocco; codice fiscale del medico corretto dall'amministratore, in sospeso finché il medico conferma; ricette di altri programmi contate in R11 e R6; scheda intera non riservata nell'AFT; elenchi dello studio scritti dai medici e dall'amministratore.
17. Diagnosi ICD-9-CM con la ricerca per descrizione (la tabella del Ministero si importa quando si può scaricare) e allegati del DPCM LEA (7, 8, 10, 4D) come trascrizioni controllate. **Fermata dopo la tappa 17**, con lo stesso giro (domande con il pulsante, via, unione).

Fermata dopo la tappa 17 fatta (D191): via, pull request #9 unita. Le verifiche di Simone e della Dr.ssa Rocca si fanno alla fine. Dopo l'unione, nello stesso branch: banche dati aggiornate da chi gestisce il servizio, con il pulsante «Aggiorna adesso» che resta all'amministratore dello studio (D192, D194), soglie dei tentativi confermate, motivo del ritorno da SPID o CIE scritto dal programma (D193). Dopo l'unione della #10: allegato 7 trascritto (D195); l'elenco esenzioni–prestazioni del SAR non si importa perché precedente al nuovo nomenclatore (D196). Fermata dopo l'unione della #10 fatta: via, pull request #11 unita; poi, nello stesso branch, AURA con un simulatore (D197). Fermata dopo l'unione della #11 fatta: via, pull request #12 unita; poi revoca automatica e anagrafica da AURA da confermare (D198). Fermata dopo l'unione della #12 fatta: via, pull request #13 unita; poi nuovi assistiti da AURA, paziente temporaneo in «Nuovo paziente» e stato del paziente alla ricetta (D199). Fermata dopo l'unione della #13 fatta: via, pull request #14 unita; poi la simulazione del deceduto nel browser e il cambio di medico dentro lo studio, con l'avviso in Oggi e lo spostamento confermato dal titolare di prima (D200). Fermata dopo l'unione della #14 fatta: via, pull request #15 unita; poi, nello stesso branch, i riepiloghi per periodo (D201) e le liste AIFA che mancano, con le carenze sui farmaci in terapia, la regola R21 e il collegamento alla farmacovigilanza (D202). Fermata dopo l'unione della #15 fatta: via, pull request #16 unita; poi, nello stesso branch, le prove indipendenti dalla mezzanotte (D203), i riepiloghi anche alla segreteria (D204), le variazioni AIFA sui farmaci in terapia (D205), i registri AIFA (D206), le connessioni inattive chiuse da Postgres, che non fermano più il servizio (D207), e «Aggiorna dalla banca dati» nella scheda della terapia (D208). Fermata dopo l'unione della #16 fatta: via, pull request #17 unita. Pausa fino al pomeriggio del 20/11/2026; alla ripresa, nello stesso branch ripartito da `main`, la R22 che informa sulla confezione sospesa (D210) e l'OCR-A per l'NRE del promemoria (D211), con l'elenco di che cosa resta aperto e per chi in `docs/avanzamento.md` («Che cosa resta aperto»). Fermata dopo la #18 fatta: via, pull request #18 unita. Poi, nello stesso branch ripartito da `main`, le PPIP predisposte per le istruzioni di Regione e ASL (D212, D213, `docs/ppip.md`) e il logo su fondo scuro (D214). Fermata fatta: via, pull request #19 unita (D215). Poi, nello stesso branch ripartito da `main`: modifiche del 2026 ai LEA verificate sulla Gazzetta (D216), promemoria secondo le specifiche di stampa del Sistema TS del 28/02/2024 (D217), allegato 3 dei LEA dalla Gazzetta del 2017 come nomenclatore dei presidi (D218). Fermata fatta: via, pull request #20 unita (D219). Poi, nello stesso branch ripartito da `main`, l'apertura del Fascicolo regionale dalla cartella con un simulatore, sul modulo del CSI del 2019, da confermare con il CSI (D220), la dimostrazione nel browser chiesta da Simone, pubblicata come artifact (D221), e il promemoria su carta A5 per difetto, con A4 come scelta di stampa (D222). Fermata fatta: via, pull request #21 unita (D223). Poi, nello stesso branch ripartito da `main`, la dimostrazione completa: tutto il programma provabile nell'artifact, con prove automatiche anche su Safari e Firefox (D223, D224). Fermata fatta: via, pull request #22 unita (D225). Poi, nello stesso branch ripartito da `main`: le transazioni del servizio («Registra» di AURA in una transazione sola e gli altri punti che scrivono fuori dalla transazione aperta) e, nella dimostrazione, AFT e cambio di medico dentro lo studio (D225): fatti (D226, D227). Fermata fatta: via, pull request #23 unita (D228). Poi, nello stesso branch ripartito da `main`, le prove che mancano: la lettura dei tipi come prova fissa, «Non spostare» e l'attività svolta nell'AFT nella dimostrazione, due registrazioni dello stesso codice fiscale insieme, altre prove instabili (D228): fatte (D229). Fermata fatta: via, pull request #24 unita (D230). Poi, nello stesso branch ripartito da `main`, ciò che resta: «Firma e invia» a controllo finito e le prove che restano (D230): fatti. Fermata fatta: via, pull request #25 unita (D231). Poi, nello stesso branch ripartito da `main`, una revisione indipendente del codice unito dalla #18 alla #25, come quella della #17 (D231): fatta, con le correzioni dei difetti veri (D232). Fermata fatta: via, pull request #26 unita (D233). Poi, nello stesso branch ripartito da `main`, la ricetta e il certificato di malattia fermi «in invio», chiusi come la distinta delle PPIP, anche nella dimostrazione (D233), con due prove instabili con WebKit corrette (D234). Fermata fatta: via, pull request #27 unita (D235). Pausa. Durante la pausa, nello stesso branch ripartito da `main`, i file dei LEA del 2026 mandati da Simone: l'allegato 2 dei presidi trascritto, da controllare, e gli allegati 7 e 8 confrontati con i decreti (D236), pull request #28. Le verifiche di Simone e della Dr.ssa Rocca si fanno alla fine: sono in `docs/avanzamento.md`, «Che cosa resta aperto».

## Come si chiude

Ogni tappa fatta o annotata in `docs/avanzamento.md`, test e lint verdi, pull request unite a `main` con il via di Simone. In `docs/avanzamento.md`: cosa c'è, come provarlo, le scelte prese e che cosa non è stato provato.
