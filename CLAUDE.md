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
- Caratteri: Special Gothic Expanded One (nome del prodotto e titoli), IBM Plex Sans (testo), IBM Plex Mono (codici ed etichette: codice fiscale, NRE, AIC). Licenza OFL 1.1, dai pacchetti npm `@fontsource/special-gothic-expanded-one`, `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-mono`, serviti dal nostro dominio: mai da Google Fonts o da altre CDN.
- Testi dell'interfaccia: italiano, registro professionale, tecnico ma chiaro; niente tono colloquiale.

### Logo di Folder

Il segno di oggi (nei prototipi) è un tratto di ECG accanto al nome, nato quando il prodotto si chiamava Polso:
`<svg width="30" height="30" viewBox="0 0 30 30"><polyline points="2,16 9,16 12,7 16,23 19,16 28,16" fill="none" stroke="#1F3A9E" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`

- Proposte (2 o 3) in `packages/brand/assets/proposte-logo/`, insieme al segno di oggi, mostrate in `docs/logo.md` (affiancate, a varie misure, su fondo chiaro e scuro).
- Carattere del segno: linea continua, spessore costante, estremi arrotondati, ritmo piatto–su–giù–piatto riconoscibile. Marchio piatto, nessuna sfumatura. Leggibile a 16 e 32 px, su fondo chiaro e scuro. Nella versione col nome, il nome è in Special Gothic Expanded One convertito in tracciati, non testo.
- Il simbolo di SCRIPT non entra nel logo di Folder: resta separato, accanto a «by SCRIPT».
- **Finché Simone non sceglie, nell'interfaccia resta il segno di oggi con il nome preso da `PRODUCT_NAME`.** Lo stato della scelta è in `docs/avanzamento.md`.

## Regole che non si discutono

1. **Nessun dato reale**: test, demo, fixture e log usano solo pazienti inventati.
2. **Sviluppo indipendente**: niente copie di schermate, documentazione o dati di altri software (in particolare Evolus Next²). Si parte dai requisiti, dalle specifiche pubbliche e da come lavora la dottoressa.
3. **Non diventare un dispositivo medico**: niente suggerimenti diagnostici o terapeutici. Le regole di prescrizione sono solo controlli formali.
4. **I dati sono del medico**: esportazione completa in formato aperto, sempre possibile.
5. **Ruoli e tracciamento**: la segreteria prepara, il medico firma e invia; ogni accesso a una cartella viene registrato.
6. **Il nome del prodotto sta solo in `packages/brand/brand.ts`** (`PRODUCT_NAME = "Folder"`, `COMPANY_BRAND = "SCRIPT"`). Altrove nel codice, nei test e nei testi dell'interfaccia non si scrive mai. Poiché la parola è anche inglese comune, nel codice non usarla nemmeno come termine tecnico: scrivi `directory` o `dir`. Un test lo controlla in `apps/`, `packages/` e `sync/`.
7. **Niente segreti nel repository e nessuna chiamata a servizi reali**: le integrazioni sono interfacce con simulatori.
8. **Nessuna risorsa da CDN esterne**, caratteri compresi: tutto servito dal nostro dominio, così nessun dato esce dall'UE.

## Come si lavora con Simone

- In italiano: documenti, commit e PR. Codice in inglese, tranne i termini normativi senza equivalente (impegnativa, esenzione, DPC); interfaccia in italiano.
- Alle fermate le domande si fanno con il pulsante (AskUserQuestion): poche, ognuna con le opzioni e quella consigliata, mai «dimmi tu» in prosa. **Tra le fermate nessuna domanda**: si annotano in `docs/avanzamento.md`.
- Se un dettaglio non è deciso: scegli, scrivi scelta e motivo in `docs/decisioni.md`, vai avanti.
- Se qualcosa è irreversibile: non farlo, annotalo in `docs/avanzamento.md` e prosegui con il resto.
- Nessun valore inventato o ricostruito a memoria: si legge dal file o dalla fonte, e si dice sempre che cosa non è stato provato.
- Se una tappa richiede un valore che non c'è nei requisiti (una soglia, la fonte di una regola): costruisci il meccanismo, lascia il valore vuoto con la nota «da completare» e prosegui.
- Ogni controllo nuovo si prova con un **sabotaggio**: rompi apposta, verifica che diventi rosso, ripristina. Il registro dei sabotaggi è in `docs/avanzamento.md`.
- Se trovi un conflitto tra queste istruzioni e i requisiti, non scegliere da solo: è una domanda per la fermata.
- Workflow e lavorazioni pesanti (molti agenti) solo se strettamente necessari.

## Come si procede

- Un branch per blocco di tappe: `tappe-0-2`, `tappe-3-4`, `tappe-5-6`, ognuno con una pull request verso `main` (cosa c'è, come provarlo, scelte prese, che cosa non è stato provato).
- Dopo ogni tappa: test e lint verdi, commit e push (la macchina in cloud può essere riciclata), poi aggiornare `docs/avanzamento.md` con fatto, non fatto, non provato e prossimo passo.
- **Fermate**: dopo la tappa 2 e dopo la tappa 4. Domande con il pulsante a Simone; spiegare in parole semplici cosa devono verificare lui e la Dr.ssa Rocca (dopo la 2: struttura, modello dei dati, ruoli e permessi; dopo la 4: ciclo della ricetta e regole di prescrizione con le loro fonti) e chiedere il via. Alla prima fermata chiedere anche quale proposta di logo preferisce, con il collegamento a `docs/logo.md` su GitHub, indicando quella consigliata. Se chiede modifiche: farle, aggiornare la PR, richiedere il via. Con il via: unire la PR e continuare. Simone non interviene su GitHub: le PR le unisce Claude.
- Dopo la tappa 6: stesso giro per l'ultima PR, poi fermarsi.

## Struttura

| Percorso                | Contenuto                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `apps/web`              | Interfaccia per PC e tablet                                                         |
| `apps/api`              | Servizio applicativo                                                                |
| `packages/brand`        | Nome, marchi, colori e caratteri (unico posto con il nome del prodotto)             |
| `packages/domain`       | Modello del dominio                                                                 |
| `packages/rules`        | Regole di prescrizione: valori e fonti versionati come dati, mai scritti nel codice |
| `packages/integrations` | Interfacce e simulatori (SAR/SIRPED, Sistema TS, AURA, INPS, FSE)                   |
| `sync/`                 | Banche dati pubbliche (Python)                                                      |
| `fixtures/`             | Pazienti inventati (generatore deterministico)                                      |
| `docs/`                 | Requisiti, prototipi, decisioni, avanzamento, logo                                  |
| `scripts/`              | `avvio-sessione.sh` (hook SessionStart) e utilità                                   |

## Stack (provvisorio)

TypeScript ovunque, Node 22, pnpm workspaces, Postgres 16 con migrazioni versionate; `sync/` resta in Python. Le scelte di framework, ORM e test runner sono in `docs/decisioni.md`.

## Ambiente

- `scripts/avvio-sessione.sh` è l'hook SessionStart (`.claude/settings.json`). Solo se `CLAUDE_CODE_REMOTE=true`: avvia Postgres 16, crea se mancano l'utente `mmg` (password locale `mmg`, con CREATEDB) e il database `mmg_dev`, scrive `DATABASE_URL` e `TZ=Europe/Rome` in `$CLAUDE_ENV_FILE`, installa le dipendenze solo se è cambiato un file che le decide (impronte in `node_modules/.avvio-sessione.sha256`).
- `DATABASE_URL=postgres://mmg:mmg@localhost:5432/mmg_dev` (valore locale, non un segreto; vedi `.env.example`).
- Dal cloud i siti istituzionali non si raggiungono.

## Comandi

| Comando                                                | Cosa fa                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `pnpm install`                                         | Dipendenze (in cloud lo fa l'hook, solo se cambiate)                            |
| `pnpm dev`                                             | Applica le migrazioni e avvia servizio (porta 3001) e interfaccia (porta 5173)  |
| `pnpm test`                                            | Tutte le prove: TypeScript (Vitest, con database temporanei) e `sync/` (Python) |
| `pnpm lint`                                            | ESLint, Prettier in controllo, tipi di ogni pacchetto                           |
| `pnpm format`                                          | Prettier in scrittura                                                           |
| `pnpm db:migrate`                                      | Applica le migrazioni a `DATABASE_URL`                                          |
| `pnpm --filter @mmg/api db:generate`                   | Genera una migrazione dallo schema Drizzle                                      |
| `pnpm fixtures -- --seed 1 --count 20`                 | Pazienti inventati in JSON (stesso seme, stessi pazienti)                       |
| `pnpm --filter @mmg/brand tokens:css`                  | Rigenera `tokens.css` da `tokens.ts`                                            |
| `pnpm --filter @mmg/brand logo:proposte`               | Rigenera le proposte di logo e le tavole di `docs/logo.md`                      |
| `scripts/sabotaggio.sh -f FILE -s 'GUASTO' -t 'PROVA'` | Prova un controllo: rosso col guasto, verde dopo il ripristino                  |

Le prove del database vogliono `DATABASE_URL`: senza, falliscono (non si saltano).

## Le tappe

0. Preparazione: README su `main`, materiali, questo file, hook di avvio, `.gitignore`, `.env.example`, `docs/decisioni.md`, `docs/avanzamento.md`.
1. Scheletro: monorepo, lint, formattazione, test e CI su GitHub Actions (comprese le prove di `sync/`); `packages/brand` con nome, token, caratteri e marchio di SCRIPT, con test sulle impronte di `SHA256SUMS`; test che fallisce se il nome del prodotto compare fuori da `packages/brand` in `apps/`, `packages/` o `sync/`; connessione a Postgres, prima migrazione e test che la esegue; un comando per avviare tutto e uno per i test; in `fixtures/` un generatore deterministico di pazienti inventati (stesso seme, stessi pazienti; mai codici fiscali di persone reali); proposte del logo.
2. Modello, ruoli e accesso: entità del dominio dai requisiti; ruoli titolare, segreteria, sostituto, medicina di gruppo, amministratore con i permessi dei requisiti; accesso come nei requisiti (altrimenti account e password con secondo fattore predisposto; SPID e CIE più avanti); registro degli accessi a ogni cartella, non modificabile; esportazione completa dei dati del medico in formato aperto. **Prima fermata.**
3. Ciclo della ricetta: bozza → da firmare → inviata → errore o annullata; la segreteria prepara, il medico firma e invia; integrazioni simulate (SAR/SIRPED, Sistema TS) con risposta positiva, errore e assenza di rete; ripiego sulla ricetta cartacea dei requisiti.
4. Regole di prescrizione: motore con le regole dei requisiti (quelle fuori perimetro restano fuori), valori e fonti versionati come dati; blocco per le regole normative, avviso con motivo registrato per quelle di buona pratica. **Seconda fermata.**
5. Banche dati pubbliche: importare nel database l'output di `sync/` (farmaci AIFA, DPC, catalogo delle prestazioni, esenzioni, comuni), provando con piccoli file d'esempio nel formato documentato in `sync/`.
6. Interfaccia per PC e tablet: oggi, elenco pazienti con ricerca, cartella (riepilogo e cronologia), ricetta, terapia, esami, specialistica, ricerca farmaco e coda «da firmare». WCAG 2.2 AA, bersagli di almeno 44 px.

## Come si chiude

Ogni tappa fatta o annotata in `docs/avanzamento.md`, test e lint verdi, pull request unite a `main` con il via di Simone. In `docs/avanzamento.md`: cosa c'è, come provarlo, le scelte prese e che cosa non è stato provato.
