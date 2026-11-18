# Provenienza dei contenuti

Da dove viene ogni contenuto del repository e del programma. Serve a mostrare due cose: lo sviluppo è indipendente (regola 2), e i contenuti di terzi si usano alle loro condizioni (D142). La prova `packages/brand/test/provenienza.test.ts` controlla due cose:

- immagini, documenti e archivi: ognuno deve avere una provenienza dichiarata;
- dipendenze di produzione: solo licenze permissive.

## Regole

- I requisiti nascono da come lavora la Dr.ssa Rocca e dalle specifiche pubbliche di Regione, Sistema TS, INPS e Fascicolo (requisiti, «Sviluppo indipendente»).
- Il contratto di licenza di Next² vieta il reverse engineering e ogni analisi finalizzata a riprodurne i contenuti (art. 7). Chiede anche di proteggerne contenuti e documentazione (art. 9). Fonte: requisiti, «Licenza del software attuale di Chiara».
- Da Next² non si prende niente: impaginazione, testi, codice, documentazione, elenchi di valori, dati.
- Una schermata mandata da Simone o dalla Dr.ssa Rocca vale solo come loro richiesta di una funzione (D89). La funzione si costruisce dai requisiti e dalle fonti pubbliche. I valori vengono dalla fonte pubblica, oppure li inserisce lo studio.
- Le schermate di altri programmi si leggono solo nella conversazione e non entrano nel repository: la prova lo controlla.
- Prima del lancio, revisione di un avvocato (requisiti, domande aperte).

## Nel repository

| Contenuto                      | Dove                                                                                                 | Da dove viene                                                                                                                                    | Condizioni                                                                                                           | Controllo                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Requisiti                      | `docs/requisiti.md`                                                                                  | Simone e la Dr.ssa Rocca: la pratica dello studio e le specifiche pubbliche                                                                      | Propri                                                                                                               | Ogni requisito confermato da Chiara |
| Prototipi delle schermate      | `docs/prototipi/`                                                                                    | Materiali di Simone (`materiali-script-folder.zip`)                                                                                              | Solo per l'impaginazione; il codice non si riusa                                                                     | —                                   |
| Marchio di SCRIPT              | `packages/brand/assets/script/`                                                                      | File ufficiali di SCRIPT                                                                                                                         | Di SCRIPT                                                                                                            | Impronte in `SHA256SUMS`, prova     |
| Logo e proposte                | `packages/brand/assets/logo/`, `packages/brand/assets/proposte-logo/`, `apps/web/public/favicon.svg` | Disegnati qui (`packages/brand/scripts/genera-proposte-logo.ts`)                                                                                 | Propri                                                                                                               | Provenienza, prova                  |
| Caratteri                      | Pacchetti npm `@fontsource/special-gothic-expanded-one`, `ibm-plex-sans`, `ibm-plex-mono` (5.3.0)    | Fontsource                                                                                                                                       | OFL 1.1, serviti dal nostro dominio                                                                                  | Licenze, prova                      |
| Schermate della documentazione | `docs/schermate/`                                                                                    | Fotografate dal programma, con pazienti inventati (`apps/api/test/e2e/schermate.ts`)                                                             | Proprie                                                                                                              | Provenienza, prova                  |
| Banche dati d'esempio          | `fixtures/banche-dati/`                                                                              | `genera.py`: tutto inventato, tranne le intestazioni del file ISTAT dei comuni e le righe di Agliè e Airasca (`fixtures/banche-dati/LEGGIMI.md`) | Condizioni d'uso dell'ISTAT da verificare                                                                            | Provenienza, prova                  |
| Pazienti inventati             | `fixtures/`                                                                                          | Generatore deterministico                                                                                                                        | Propri                                                                                                               | —                                   |
| File ufficiali del Fascicolo   | `packages/integrations/fse-ufficiale/`                                                               | Repository del Ministero della Salute, commit 25b7b6b: schematron del PSS 4.0, 16 dizionari, estratto LOINC (`README.md` della cartella)         | Il repository del Ministero non indica una licenza: domanda per la fermata (D131). LOINC con il suo avviso           | Impronte in `SHA256SUMS`, prova     |
| Dipendenze                     | `package.json`, `pnpm-lock.yaml`                                                                     | Registro npm                                                                                                                                     | Produzione al 18/11/2026: MIT (69), ISC (4), BSD-3-Clause (3), OFL-1.1 (3), Apache-2.0 (1), 0BSD (1), MIT e Zlib (1) | Licenze ammesse, prova              |

## Fuori dal repository

Le banche dati pubbliche non sono nel repository. Le scarica `sync/` nello studio e le importa il programma: AIFA, ISTAT, Regione Piemonte, DPCM LEA. Fonti e versioni sono in `sync/fonti.json` e in `docs/banche-dati.md`. Le condizioni d'uso di ciascuna fonte sono da verificare e scrivere qui prima del lancio.

## Cataloghi dello studio

Richiesta di Simone del 18/11/2026; non ancora costruiti (`docs/avanzamento.md`). La fonte di ogni catalogo:

| Catalogo                                                    | Fonte                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Diagnosi ICD-9-CM e ICD-10-IM                               | Ministero della Salute, DM 23/10/2025 (requisiti)                                        |
| Prestazioni                                                 | Catalogo regionale, già importato                                                        |
| Esami associati alle esenzioni                              | Regione Piemonte, D.D. 1167/2022, già importata (R17)                                    |
| Vaccini                                                     | Fonte pubblica da individuare                                                            |
| Problemi ICPC                                               | Classificazione della WONCA: si usa solo con la licenza verificata                       |
| Posologie, pacchetti di esami, medici suggeritori, contatti | Li inserisce lo studio; il programma parte vuoto o con gli elenchi delle fonti pubbliche |

Nessun elenco viene preso dalle schermate di altri programmi.

## Come si aggiunge un contenuto nuovo

- **Un file di terzi.** Va in una cartella sua, con un `README.md` o un `LEGGIMI.md` (fonte, data, condizioni) e le impronte in `SHA256SUMS`. Poi una riga in questo documento, e la sua provenienza nella prova.
- **Una dipendenza nuova.** La licenza deve essere tra quelle ammesse dalla prova. Altrimenti è una decisione da scrivere in `docs/decisioni.md`.
