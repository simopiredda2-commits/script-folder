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

Un pacchetto, quello del Piemonte (`packages/regions/piemonte/`), con otto parti.

- **Nel pacchetto**: le tabelle RAO regionali (`data/rao`, D295).
- **Nel nucleo, con i dati già nel pacchetto** (D295):
  - catalogo regionale: restano nel nucleo la fonte di `sync/` e i dati d'esempio;
  - prestazioni aggiuntive dell'AIR, con la corrispondenza per il SIAP: restano i testi delle pagine.
- **Nel nucleo**:
  - ricetta (SAR del CSI, ricetta rossa in DPCM, lotti di NRE, codice del gestionale);
  - anagrafe (AURA, con un simulatore);
  - Fascicolo regionale (pubblicazione V09, accesso LCCE);
  - distribuzione per conto: la fonte di `sync/` e i dati d'esempio; la mappatura della trascrizione è già senza nomi regionali;
  - valori regionali delle regole.

Mancano, anche per il Piemonte: l'invio del SIAP (viene con il modulo del CSI), la rendicontazione dell'AIR (D287), le esenzioni regionali, le scadenze regionali delle ricette.

L'inventario: 219 file e 2250 righe fuori dal pacchetto (con lo scheletro erano 235 e 2298).

| Area                                        | File | Righe |
| ------------------------------------------- | ---: | ----: |
| `apps/api/src`                              |   47 |   601 |
| `apps/api/test`                             |   42 |   742 |
| `apps/api/modelli`                          |    1 |     1 |
| `apps/web/src`                              |   19 |   174 |
| `apps/web/test`                             |   13 |   134 |
| `apps/demo` (codice, prove e script)        |   11 |   100 |
| `packages/integrations` (codice e prove)    |   22 |   216 |
| `packages/domain` (codice, prove e script)  |   21 |    97 |
| `packages/reference` (dati, codice e prove) |    8 |    17 |
| `packages/rules` (dati, codice e prove)     |   14 |    86 |
| `fixtures`                                  |   19 |    61 |
| `sync`                                      |    2 |    21 |

## L'ordine dello spostamento (proposta)

Un pezzo per pull request, con le prove sempre verdi:

1. **dati** (fatto, D295): catalogo regionale, tabelle RAO regionali, prestazioni aggiuntive dell'AIR, corrispondenza per il SIAP; le mappature delle trascrizioni senza nomi regionali;
   - le **fonti di `sync/`** (catalogo e distribuzione per conto, in Python) restano per un pezzo a sé, che insegna a `sync/` a leggere le fonti dei pacchetti;
2. **regole**: i valori regionali, separati da quelli nazionali, con la regione a cui valgono;
3. **integrazioni senza il database**: SAR e il suo simulatore, Fascicolo regionale, accesso con il modulo della Regione;
4. **servizi con il database**: AURA e i suoi giri;
5. **pagine e testi**, poi la **dimostrazione** e le **prove**.

Dopo, nel pacchetto del Piemonte: il modulo del SIAP con il CSI, la rendicontazione dell'AIR (D287) e AURA vera (D268).

## Che cosa non è fatto, che cosa non è provato

- Spostati i dati (D295); il resto, nell'ordine qui sopra. Le prove regionali stanno ancora nelle cartelle nazionali: si spostano per ultime.
- Per una regione senza pacchetto il programma oggi non ha le parti nazionali al posto di quelle regionali: per esempio la ricetta SSN va solo con il SAR (la ricetta bianca va già al Sistema TS). Le alternative nazionali (per esempio l'invio al Sistema TS senza un servizio regionale) si scrivono quando servono.
- Le varianti delle ASL ci sono nel contratto, nessuna nel pacchetto del Piemonte.
- Le parole del pacchetto sono quelle di oggi; con lo spostamento se ne aggiungono, se servono.
