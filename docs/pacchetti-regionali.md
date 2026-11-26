# Pacchetti regionali

Il programma deve poter servire, un domani, tutte le regioni (richiesta di Simone del 26/11/2026, D288). Integrazioni, cataloghi, esenzioni, scadenze, regole e tutto ciò che è legato a una regione stanno nel pacchetto di quella regione, scelto dalla regione dello studio e dall'ASL del medico. Il nucleo tiene solo il nazionale. Questo documento descrive lo scheletro (D292); lo spostamento del primo pacchetto si fa un pezzo alla volta, in pull request sue.

## Come è fatto

- **Nucleo** (`packages/regions/src/`): le parti che un pacchetto può dare, il contratto di un pacchetto e la scelta. Non nomina nessuna regione.
- **Elenco dei pacchetti** (`packages/regions/src/registry.ts`): l'unico file del nucleo che nomina le regioni che hanno un pacchetto, come `packages/brand/brand.ts` per il nome del prodotto. Un pacchetto nuovo si aggiunge qui.
- **Un pacchetto** ha una chiave, il nome della sua cartella, e le sue cartelle in ogni livello del programma:
  - `packages/regions/<chiave>/`: il manifesto (`index.ts`), i dati, le integrazioni che non usano il database, i valori delle regole;
  - `apps/api/src/regions/<chiave>/`: i servizi che usano il database;
  - `apps/web/src/regions/<chiave>/`: pagine e testi;
  - `apps/demo/src/regions/<chiave>/`: i simulatori della dimostrazione;
  - le prove nelle cartelle `test/regions/<chiave>/` accanto.
- **Manifesto**: il codice della regione nell'elenco delle aziende sanitarie del Ministero (D267), le parti che la regione dà, con che cosa sono e dove stanno oggi (nel pacchetto, o ancora nel nucleo, da spostare), le varianti delle ASL (gli accordi aziendali) e le parole che nominano la regione, i suoi enti, servizi e atti.

## La scelta

- Il programma riconosce la regione dal nome scritto nei dati dello studio («Regione», Strumenti › Studio), con l'elenco delle aziende sanitarie del Ministero.
- Il pacchetto è quello con lo stesso codice di regione; la variante dell'ASL è quella del codice ASL del medico, se il pacchetto ne ha una.
- Per una regione senza pacchetto, o non riconosciuta, il programma usa solo le parti nazionali.
- Strumenti › Studio, riquadro «Pacchetto regionale»: la regione, il pacchetto, che cosa dà (con «nel programma, da spostare» per le parti ancora nel nucleo) e le parti che mancano.

Le parti che un pacchetto può dare:

| Parte                 | Nome nelle pagine                                         |
| --------------------- | --------------------------------------------------------- |
| `prescription`        | Ricetta elettronica con il servizio della Regione         |
| `registry`            | Anagrafe regionale degli assistiti                        |
| `health_record`       | Fascicolo sanitario elettronico della Regione             |
| `siap`                | Invio dei flussi del SIAP alla Regione                    |
| `additional_services` | Prestazioni aggiuntive dell'accordo integrativo regionale |
| `reporting`           | Rendicontazione dell'accordo integrativo regionale        |
| `catalog`             | Catalogo regionale delle prestazioni specialistiche       |
| `waiting_groups`      | Tabelle RAO della Regione                                 |
| `distribution`        | Farmaci in distribuzione per conto                        |
| `exemptions`          | Esenzioni regionali                                       |
| `deadlines`           | Scadenze regionali delle ricette                          |
| `rules`               | Valori regionali delle regole di prescrizione             |

## La prova dei nomi regionali

Come quella del nome del prodotto (regola 6), una prova (`packages/regions/test/nomi-regionali.test.ts`) legge `apps/`, `packages/`, `sync/`, `fixtures/` e `scripts/`, riga per riga e anche i percorsi. Le parole di un pacchetto, fuori dalle sue cartelle, possono stare solo nei file dell'inventario (`packages/regions/inventario.json`), con lo stesso numero di righe:

- una riga regionale nuova nel nucleo fa rossa la prova: il codice nuovo regionale va nelle cartelle del pacchetto;
- una riga regionale tolta (un pezzo spostato) fa rossa la prova finché non si aggiorna l'inventario con `pnpm --filter @mmg/regions inventario`, che non lo fa crescere: con righe in più si ferma e le elenca. Solo per una decisione presa e scritta in `docs/decisioni.md` si fa crescere, con `--anche-in-piu`.

Le eccezioni hanno un motivo scritto nella prova: le migrazioni (storia del database), l'elenco nazionale delle aziende sanitarie (nomina tutte le regioni), l'elenco ICD-9-CM (il nome dell'anagrafe regionale vi compare come sintomo dell'emicrania), l'elenco dei pacchetti e l'inventario stesso.

## I dati di un pacchetto (D295)

I dati di una regione stanno in `packages/regions/<chiave>/data/`, divisi per tipo:

- `trascrizioni/`: le trascrizioni degli atti della regione (per il Piemonte il catalogo delle prestazioni e le prestazioni aggiuntive dell'AIR), nello stesso formato di quelle nazionali di `packages/reference/data/trascrizioni/`;
- `rao/`: le tabelle RAO della regione, accanto al manuale nazionale di AGENAS;
- `siap/`: le corrispondenze fra le prestazioni aggiuntive degli accordi della regione e i dettagli del SIAP.

Il nucleo le trova dall'elenco dei pacchetti (`regionalDataDirs` in `@mmg/regions`), senza nominare la regione:

- l'importazione legge le trascrizioni da tutte le cartelle, prima la nazionale e poi quelle dei pacchetti; lo stesso percorso in due cartelle non entra da nessuna delle due;
- una versione di una banca dati si riconosce dalla serie e dall'impronta del CSV, non dal percorso: spostare un file non crea una versione nuova;
- le tabelle RAO si leggono nell'ordine: prima AGENAS, poi i file di ogni pacchetto per nome;
- la dimostrazione porta nel suo disco virtuale le tabelle RAO e le corrispondenze di ogni pacchetto; le trascrizioni entrano già nel database di partenza.

## Le regole di un pacchetto (D296)

Le regole di prescrizione nazionali stanno in `packages/rules/data/`; quelle di una regione sono **aggiunte** alle nazionali, in `packages/regions/<chiave>/data/regole/`, versionate allo stesso modo (versione, data da cui valgono, fonte dei valori).

- Per ogni regola un'aggiunta può dare: un testo che prende il posto di quello nazionale, fonti, valori ed elenchi nuovi, cose da completare. Non cambia che cosa fa la regola (blocca, avvisa o informa).
- Un valore o un elenco che la versione nazionale ha già, o una regola che non ha, è un errore dei dati e il programma si ferma: si sistemano i dati.
- Un valore o un elenco della regione porta la sua fonte.
- Le regole in vigore alla data della ricetta sono la versione nazionale di quel giorno con le aggiunte della regione dello studio in vigore lo stesso giorno. La versione che resta con la ricetta le dice tutte e due, per esempio `2026-11-26.1+piemonte@2026-11-26.1`. Uno studio di una regione senza pacchetto ha solo le regole nazionali.
- Le fonti della regione vanno dopo quelle nazionali: il messaggio di una regola porta la prima fonte, quella nazionale. Per la ricetta specialistica R1 mostra la fonte della regione, che ha dato i giorni.
- Le versioni nazionali fino alla 2026-11-25.2 hanno dentro le parti del Piemonte: sono storia, come le migrazioni, e restano com'erano. Sono fra le eccezioni della prova dei nomi regionali.
- Il servizio prende la regione dallo studio dell'archivio della ricetta, per il controllo prima dell'invio e per i giorni di validità sul promemoria; la dimostrazione porta le aggiunte nel suo disco virtuale.

## Le integrazioni di un pacchetto (D297)

Le integrazioni con i servizi della regione che non usano il database stanno nel pacchetto, in `packages/regions/<chiave>/integrations/`. Attuano i **contratti nazionali** di `@mmg/integrations`. Il manifesto le offre in `integrations`, con i simulatori (regola 7); gli adattatori veri si aggiungono con l'ente.

- **Scelta**: il servizio le sceglie dalla regione dello studio, a ogni richiesta (`apps/api/src/regions/integrations.ts`, `regionalChoice`):
  - dello studio del medico per le sue azioni;
  - dello studio del medico autore per la coda del Fascicolo.
    Una regione senza pacchetto non ne ha, e la pagina lo dice. Date nella configurazione (le prove, o un adattatore vero), le stesse integrazioni valgono per ogni regione.
- **Dipendenze**: `@mmg/regions` usa `@mmg/integrations`, mai il contrario.
- **Chiamate di contesto** (`RegionalContextCall`): un meccanismo solo per aprire una pagina dei servizi della regione con il contesto del paziente.
  - Il pacchetto dà l'elenco delle destinazioni, ognuna di un tipo che il nucleo conosce, con il suo permesso, la sua voce nel registro e le sue credenziali.
  - Oggi c'è un tipo solo, «fascicolo»: per il Piemonte è il modulo di accesso LCCE V13 (D220).
  - Parametri, parole e credenziali sono della regione.
  - Un tipo nuovo si aggiunge nel nucleo, con il suo permesso, quando una regione lo chiede con le sue specifiche.
- **Pubblicazione del Profilo nel Fascicolo della regione** (`RegionalFsePublication`): documento nuovo, sostituzione, metadati, cancellazione, esito, ricerca, con:
  - i regimi ammessi e l'attività clinica fissata;
  - le politiche di invio: fermo notturno, intervallo, ripetizioni, giorni;
  - le parole: credenziali, a chi segnalare.
    La coda resta nel nucleo ed è nazionale: prende tutto questo dalla pubblicazione. Per il Piemonte è la V09 con le politiche FSE-INT-SRS-01-V02 (D280).
- **Certificati del Gateway** (D298): uno per regione, scelto dal codice della regione dello studio nell'elenco nazionale delle aziende sanitarie, non dal pacchetto: li danno i referenti della Regione. Con il simulatore, una coppia di prova per regione.
- **Prove**:
  - del meccanismo, con una regione inventata, nelle cartelle nazionali (`chiamate-di-contesto-scelta`, `pubblicazione-regionale-scelta`, `gateway-per-regione`);
  - del contenuto del Piemonte, in `packages/regions/piemonte/test/` e `apps/api/test/regions/piemonte/`.

Restano del pezzo 3: il SAR (ricetta, lotti di NRE, ricetta rossa in DPCM), l'accesso con SPID o CIE della Regione e le credenziali RUPAR. Poi i servizi con il database (AURA).

## La Lombardia: che cosa servirà al pacchetto

Dal confronto con la qualificazione della cartella in Lombardia del 26/11/2026 (`docs/lombardia.md`, paragrafo 5). Non è una richiesta di costruirla e per la Lombardia non c'è codice: le specifiche del SISS le manda ARIA durante la procedura. Nessuna chiamata al SISS o ad ARIA (regola 7). Il contratto delle integrazioni deve reggere anche questo modello, che è diverso da quello del Piemonte.

| Parte                | In Piemonte                                                     | In Lombardia                                                                                                                                                       | Che cosa servirà al pacchetto e al contratto                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ricetta              | Il programma la manda al SAR                                    | La fa il modulo regionale PRREG: la cartella la prepara, lo apre con una chiamata di contesto, riprende con un'API ricette, errori e PDF, annulla tramite il PRREG | Accanto all'«invio al SAR», un «prescrittore esterno» nel contratto della ricetta, da fissare nel pezzo del SAR. La chiamata di contesto del tipo «ricetta», con le righe preparate. Le regole R1–R25 forse come controllo della bozza: da decidere con le specifiche (ARIA-PRREG-SIAA@01) |
| Certificati          | Sistema TS (nazionale)                                          | Servizio regionale (GCM, INFOINAIL) o il tasto che apre la web application                                                                                         | Il servizio dei certificati dato dal pacchetto, oppure una destinazione delle chiamate di contesto; se basti il Sistema TS è una domanda per ARIA                                                                                                                                          |
| Fascicolo            | Validazione sul Gateway e pubblicazione con i servizi regionali | Firma con la Firma Remota del SISS e archiviazione nel repository del SISS; il Gateway è da chiarire con ARIA                                                      | Il contratto della pubblicazione regge il repository (documento nuovo, sostituzione, metadati, cancellazione, esito, ricerca). Servono due aggiunte, con le specifiche: la validazione sul Gateway facoltativa e la firma del servizio della regione al posto di quella del programma      |
| Anagrafe             | I servizi di AURA                                               | I servizi ICCE, più l'elenco degli assistiti scaricato ogni giorno da Medboard                                                                                     | Nel contratto dell'anagrafe (pezzo dei servizi con il database), anche un file giornaliero come fonte, letto con l'importazione (`docs/importazione.md`); il formato di Medboard è una domanda per ARIA                                                                                    |
| Accesso del medico   | SPID o CIE con OAuth2 della Regione                             | Le chiavi APIMANAGER del programma e l'autenticazione dell'operatore sulla pagina `operatori.siss`                                                                 | Nel pezzo del SAR, l'accesso regionale come contratto, non come OAuth2 del Piemonte                                                                                                                                                                                                        |
| SIAP                 | Il CSI riceve                                                   | ARIA riceve, con il Gestionale SIAP                                                                                                                                | Gli stessi tracciati nazionali (D284, D289, D291); l'invio nel pacchetto                                                                                                                                                                                                                   |
| Codifiche e consensi | Le tabelle del Piemonte                                         | Le tabelle del Dominio Centrale del SISS (DDC) e un consenso regionale in più (PIC)                                                                                | Dati del pacchetto (D295) e un tipo di consenso regionale                                                                                                                                                                                                                                  |
| Chiamate di contesto | Una: il Fascicolo (D220)                                        | Tante: PRREG, SGDT, ARVAX, Assistant-RL, GP++, PT Online, OPE, Deleghe FSE, SMI, SMP, GSM                                                                          | Il meccanismo unico c'è (D297): ogni destinazione è un tipo che il nucleo conosce, con il suo permesso, aggiunto con le specifiche                                                                                                                                                         |

Le domande per la fermata e per ARIA sono in `docs/avanzamento.md`; le lacune del nucleo che il confronto ha trovato sono proposte in «Che cosa resta aperto».

## Come si sposta un pezzo

1. Il codice o il dato passa nelle cartelle del pacchetto; il nucleo lo chiama attraverso il contratto, senza nominare la regione.
2. `pnpm --filter @mmg/regions inventario`: l'inventario cala.
3. Nel manifesto la parte passa a «nel pacchetto», se è tutta spostata.
4. Prove verdi, con un sabotaggio per il controllo nuovo; una pull request per pezzo.

## Come si aggiunge una regione

Quando c'è l'elenco di che cosa serve dalla regione e dai suoi enti:

1. la cartella `packages/regions/<chiave>/` con il manifesto: codice della regione dall'elenco del Ministero, parti, varianti delle ASL, parole;
2. il pacchetto nell'elenco di `packages/regions/src/registry.ts`;
3. le parti, ognuna con il suo simulatore (regola 7), nelle cartelle del pacchetto.

## Lo stato al 26/11/2026

Un pacchetto, quello del Piemonte (`packages/regions/piemonte/`), con nove parti.

- **Nel pacchetto**:
  - il Fascicolo regionale (D297): la pubblicazione V09 con le politiche di invio e l'accesso dalla cartella con il modulo LCCE, in `integrations/`;
  - le tabelle RAO regionali (`data/rao`, D295);
  - le aggiunte alle regole di prescrizione (`data/regole`, D296): i termini della ricetta specialistica in R1, le fonti della Regione per R5, R9 e R17, il SAR in R18;
  - le scadenze regionali delle ricette: la validità della ricetta specialistica, nelle stesse aggiunte (D296).
- **Nel nucleo, con i dati già nel pacchetto** (D295):
  - catalogo regionale: restano nel nucleo la fonte di `sync/` e i dati d'esempio;
  - prestazioni aggiuntive dell'AIR, con la corrispondenza per il SIAP: restano i testi delle pagine.
- **Nel nucleo**:
  - ricetta (SAR del CSI, ricetta rossa in DPCM, lotti di NRE, codice del gestionale);
  - anagrafe (AURA, con un simulatore);
  - distribuzione per conto: la fonte di `sync/` e i dati d'esempio; la mappatura della trascrizione è già senza nomi regionali.

Mancano, anche per il Piemonte: l'invio del SIAP (viene con il modulo del CSI), la rendicontazione dell'AIR (D287), le esenzioni regionali.

L'inventario: 190 file e 2063 righe fuori dal pacchetto (con lo scheletro erano 235 e 2298, dopo i dati 219 e 2250, dopo le regole 204 e 2160).

| Area                                        | File | Righe |
| ------------------------------------------- | ---: | ----: |
| `apps/api/src`                              |   43 |   577 |
| `apps/api/test`                             |   40 |   720 |
| `apps/api/modelli`                          |    1 |     1 |
| `apps/web/src`                              |   17 |   164 |
| `apps/web/test`                             |   11 |   129 |
| `apps/demo` (codice, prove e script)        |   11 |   100 |
| `packages/integrations` (codice e prove)    |   17 |   176 |
| `packages/domain` (codice, prove e script)  |   21 |    97 |
| `packages/reference` (dati, codice e prove) |    8 |    17 |
| `packages/rules` (dati, codice e prove)     |    0 |     0 |
| `fixtures`                                  |   19 |    61 |
| `sync`                                      |    2 |    21 |

## L'ordine dello spostamento (proposta)

Un pezzo per pull request, con le prove sempre verdi:

1. **dati** (fatto, D295): catalogo regionale, tabelle RAO regionali, prestazioni aggiuntive dell'AIR, corrispondenza per il SIAP; le mappature delle trascrizioni senza nomi regionali;
   - le **fonti di `sync/`** (catalogo e distribuzione per conto, in Python) restano per un pezzo a sé, che insegna a `sync/` a leggere le fonti dei pacchetti;
2. **regole** (fatto, D296): le aggiunte della regione alle regole nazionali, nel pacchetto, con la regione dello studio nel controllo e nel promemoria;
3. **integrazioni senza il database**: Fascicolo regionale (fatto, D297), con il meccanismo delle chiamate di contesto e i certificati del Gateway per regione (D298); poi SAR e il suo simulatore e l'accesso con il modulo della Regione;
4. **servizi con il database**: AURA e i suoi giri;
5. **pagine e testi**, poi la **dimostrazione** e le **prove**.

Dopo, nel pacchetto del Piemonte: il modulo del SIAP con il CSI, la rendicontazione dell'AIR (D287) e AURA vera (D268).

## Che cosa non è fatto, che cosa non è provato

- Spostati i dati (D295), le regole (D296) e il Fascicolo regionale (D297); il resto, nell'ordine qui sopra. Le prove regionali stanno ancora nelle cartelle nazionali: si spostano per ultime.
- Per una regione senza pacchetto il programma oggi non ha le parti nazionali al posto di quelle regionali: per esempio la ricetta SSN va solo con il SAR (la ricetta bianca va già al Sistema TS). Le alternative nazionali (per esempio l'invio al Sistema TS senza un servizio regionale) si scrivono quando servono.
- Le varianti delle ASL ci sono nel contratto, nessuna nel pacchetto del Piemonte.
- Le parole del pacchetto sono quelle di oggi; con lo spostamento se ne aggiungono, se servono.
