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

| Contenuto                      | Dove                                                                                                 | Da dove viene                                                                                                                                                                                                           | Condizioni                                                                                                                     | Controllo                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Requisiti                      | `docs/requisiti.md`                                                                                  | Simone e la Dr.ssa Rocca: la pratica dello studio e le specifiche pubbliche                                                                                                                                             | Propri                                                                                                                         | Ogni requisito confermato da Chiara |
| Prototipi delle schermate      | `docs/prototipi/`                                                                                    | Materiali di Simone (`materiali-script-folder.zip`)                                                                                                                                                                     | Solo per l'impaginazione; il codice non si riusa                                                                               | —                                   |
| Marchio di SCRIPT              | `packages/brand/assets/script/`                                                                      | File ufficiali di SCRIPT                                                                                                                                                                                                | Di SCRIPT                                                                                                                      | Impronte in `SHA256SUMS`, prova     |
| Logo e proposte                | `packages/brand/assets/logo/`, `packages/brand/assets/proposte-logo/`, `apps/web/public/favicon.svg` | Disegnati qui (`packages/brand/scripts/genera-proposte-logo.ts`)                                                                                                                                                        | Propri                                                                                                                         | Provenienza, prova                  |
| Caratteri                      | Pacchetti npm `@fontsource/special-gothic-expanded-one`, `ibm-plex-sans`, `ibm-plex-mono` (5.3.0)    | Fontsource                                                                                                                                                                                                              | OFL 1.1, serviti dal nostro dominio                                                                                            | Licenze, prova                      |
| Schermate della documentazione | `docs/schermate/`                                                                                    | Fotografate dal programma, con pazienti inventati (`apps/api/test/e2e/schermate.ts`)                                                                                                                                    | Proprie                                                                                                                        | Provenienza, prova                  |
| Banche dati d'esempio          | `fixtures/banche-dati/`                                                                              | `genera.py`: estratti dei file AIFA veri (righe copiate senza cambiarle), una riga dell'elenco DPC della Regione Piemonte, intestazioni e due righe ISTAT; il resto inventato (`fixtures/banche-dati/LEGGIMI.md`, D148) | AIFA: CC BY 4.0, citare AIFA come fonte. Regione Piemonte: una riga di fatti trascritta. ISTAT: condizioni d'uso da verificare | Provenienza, prova                  |
| Pazienti inventati             | `fixtures/`                                                                                          | Generatore deterministico                                                                                                                                                                                               | Propri                                                                                                                         | —                                   |
| File ufficiali del Fascicolo   | `packages/integrations/fse-ufficiale/`                                                               | Repository del Ministero della Salute, commit 25b7b6b: schematron del PSS 4.0, 16 dizionari, estratto LOINC (`README.md` della cartella)                                                                                | Il repository del Ministero non indica una licenza: domanda per la fermata (D131). LOINC con il suo avviso                     | Impronte in `SHA256SUMS`, prova     |
| Dipendenze                     | `package.json`, `pnpm-lock.yaml`                                                                     | Registro npm                                                                                                                                                                                                            | Produzione al 18/11/2026: MIT (69), ISC (4), BSD-3-Clause (3), OFL-1.1 (3), Apache-2.0 (1), 0BSD (1), MIT e Zlib (1)           | Licenze ammesse, prova              |

### Da dove vengono gli estratti delle banche dati d'esempio

File interi letti il 18/11/2026; nel repository ci sono solo le righe scelte (D148). Una verifica una tantum ha confrontato ogni riga degli estratti con il file intero: tutte identiche, byte per byte.

| File                                                        | Indirizzo                                                    | Byte       | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------ | ---------- | ------------------------------------------------------------------ |
| AIFA, `confezioni_fornitura.csv`                            | `https://drive.aifa.gov.it/farmaci/confezioni_fornitura.csv` | 82.541.593 | `33fa577fe6b635507b8b757b94a7a8b342ed01784fee64f577d27883d1350fa9` |
| AIFA, `Classe-A_per_principio-attivo_30-6-2026.csv`         | `https://www.aifa.gov.it/documents/20142/3815901/…`          | 1.520.349  | `d167ef333306be7d3e70ed5b7d13f840a35d00ee11fb320f6601981deefd3832` |
| AIFA, `Classe-H_per_principio-attivo_30-6-2026.csv`         | `https://www.aifa.gov.it/documents/20142/3815901/…`          | 396.740    | `8422e0a55e2cd5cd1bcdb053e9832fc69cc9b128e585925be135771fb1426bae` |
| Regione Piemonte, «Farmaci PHT – oggetto di DPC» (9/7/2026) | `https://www.regione.piemonte.it/web/media/57684/download`   | 530.105    | `8c7d006876a2b953cf09dd4738a1f7198cdc87d7b392eb55a05512c60d9e1fed` |

Licenza dei dati AIFA: CC BY 4.0 con l'obbligo di citare la fonte (https://www.aifa.gov.it/open-data). Il PDF della Regione non è nel repository: c'è solo la riga trascritta (principio attivo, ATC, nota, piano).

### Visite, esami e ricerca delle prestazioni (D152, D153)

Nelle prove e nei dati della ricerca ci sono descrizioni del catalogo copiate parola per parola, con il codice e la pagina, e i sinonimi verificati su quelle descrizioni. I PDF non sono nel repository.

| Documento                                                                                     | Indirizzo                                                                                            | Byte      | SHA-256                                                            |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| Regione Piemonte, D.D. 990/2024, catalogo regionale (allegato A)                              | `https://www.regione.piemonte.it/governo/bollettino/abbonati/2025/01/attach/dda1400000990_11200.pdf` | 1.674.366 | `769ec266a21d80c52c38cbea365aa7a56c2967bf7a53dc618d5922ee06ca4cbb` |
| Regione Piemonte, D.D. 868/2024, catalogo regionale                                           | `https://www.regione.piemonte.it/governo/bollettino/abbonati/2024/51/attach/dda1400000868_11200.pdf` | 1.497.881 | `3635722a288d16ca25613f36f0e4bacc0f71708fd7905635c45c09c9feaa48c3` |
| DM 22/7/1996, Gazzetta Ufficiale S.O. n. 150 del 14/9/1996 (legenda delle parentesi, p. 7)    | `https://www.gazzettaufficiale.it/eli/gu/1996/09/14/216/so/150/sg/pdf`                               | 3.828.019 | `9d9bc20dd34ec1df23bd2e6396408ac09314b464b2471f732a7742a31fe8f390` |
| Nomenclatore nazionale, allegato 4 del DPCM LEA (PDF in 5 parti)                              | Scaricato da Simone dalla pagina del Ministero della salute sul DPCM LEA e i suoi allegati           | —         | —                                                                  |
| Regione Piemonte, D.D. 710/2026 (BUR n. 44 del 5/11/2026), testo e allegati A, B, C, D (D157) | Mandato da Simone il 18/11/2026 (file `ddxst00000710_11200_261118_231625.pdf`, 23 pagine)            | 1.611.207 | `addd86847d5a7fbf2507a10bb2fed7979ec85957f87701079995e93d5a3d3954` |

Sigle dei materiali in `packages/reference/data/ricerca-prestazioni.json`: S, P, U e DU da Simone (18/11/2026); (SG)ER, SG, (SG), SA e LA da un elenco della Regione Campania delle prestazioni di laboratorio per settore di erogazione, che scrive per esteso i materiali degli stessi codici, letto solo negli estratti di una ricerca il 18/11/2026. [ALB] e [F] non sono sciolte: nessuna fonte trovata. L'interfaccia mostra le sigle per esteso senza la fonte, che resta qui e nel file.

### Catalogo regionale in vigore (D159)

Le trascrizioni in `packages/reference/data/trascrizioni/piemonte_catalogo/` sono estratte dai PDF qui sotto e dalla D.D. 710/2026 (tabella sopra). Sono atti pubblici della Regione: «Le disposizioni di questa legge non si applicano ai testi degli atti ufficiali dello stato e delle Amministrazioni pubbliche» (art. 5 della legge 633/1941, letto su Normattiva il 19/11/2026). I PDF restano fuori dal repository. Che cosa è diverso dal PDF: `docs/catalogo-regionale.md`.

| Documento                                                                                                 | Indirizzo                                                                                                | Byte      | SHA-256                                                            |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| Regione Piemonte, D.D. 590/2026 (BU n. 38 del 24/09/2026), parte 1 di 3: testo e allegato A, branche 1–10 | Mandato da Simone il 18/11/2026 (file `DD590-2026_parte1di3_atto_branche01-10.pdf`, 44 pagine)           | 940.152   | `e13329ac66e8d2c4a20ec69326d6247c8300aa773caa5dfd171b35cca858348a` |
| Regione Piemonte, D.D. 590/2026, parte 2 di 3: allegato A, laboratorio                                    | Mandato da Simone il 18/11/2026 (file `DD590-2026_parte2di3_laboratorio.pdf`, 87 pagine)                 | 1.286.532 | `0f44a555331e593b319c74f5b49a603c08ccd9153836fefe81aa33476a9401af` |
| Regione Piemonte, D.D. 590/2026, parte 3 di 3: allegato A, branche 12–26, e allegato B                    | Mandato da Simone il 18/11/2026 (file `DD590-2026_parte3di3_branche12-26_coda_AllegatoB.pdf`, 77 pagine) | 1.616.458 | `8ef8f8c872b9a8d5093b07facff117fa9b514242158a85ab302022fb78d0aa4d` |

### Modelli ufficiali dei certificati (D158)

Il testo dei file in `apps/api/modelli/` è copiato dagli atti, con la fonte in ogni file. Le pagine della Gazzetta sono state lette il 18/11/2026 e i PDF restano fuori dal repository.

| Modello                        | Atto                                                          | Confronto                                                                                 |
| ------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `sportivo-non-agonistico.json` | DM Salute 8 agosto 2014, allegato 2, GU n. 243 del 18/10/2014 | Pagina 26 del PDF della GU, solo immagine: trascrizione a mano confrontata con l'immagine |
| `porto-armi-anamnestico.json`  | DM Sanità 28 aprile 1998, allegato 1, GU n. 143 del 22/6/1998 | Testo della pagina HTML della GU confrontato con la scansione del fascicolo (pagina 16)   |

## Fuori dal repository

Le banche dati pubbliche non sono nel repository. Le scarica `sync/` nello studio e le importa il programma: AIFA, ISTAT, Regione Piemonte, DPCM LEA. Fonti e versioni sono in `sync/fonti.json` e in `docs/banche-dati.md`. Le condizioni d'uso di ciascuna fonte sono da verificare e scrivere qui prima del lancio.

## Cataloghi dello studio

Richiesta di Simone del 18/11/2026; non ancora costruiti (`docs/avanzamento.md`). La fonte di ogni catalogo:

| Catalogo                                                    | Fonte                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Diagnosi ICD-9-CM e ICD-10-IM                               | Ministero della Salute, DM 23/10/2025 (requisiti)                                           |
| Prestazioni                                                 | Catalogo regionale, già importato; ricerca per parole chiave con sinonimi verificati (D153) |
| Esami associati alle esenzioni                              | Regione Piemonte, D.D. 1167/2022, già importata (R17)                                       |
| Vaccini                                                     | Fonte pubblica da individuare                                                               |
| Problemi ICPC                                               | Classificazione della WONCA: si usa solo con la licenza verificata                          |
| Posologie, pacchetti di esami, medici suggeritori, contatti | Li inserisce lo studio; il programma parte vuoto o con gli elenchi delle fonti pubbliche    |

Nessun elenco viene preso dalle schermate di altri programmi.

## Come si aggiunge un contenuto nuovo

- **Un file di terzi.** Va in una cartella sua, con un `README.md` o un `LEGGIMI.md` (fonte, data, condizioni) e le impronte in `SHA256SUMS`. Poi una riga in questo documento, e la sua provenienza nella prova.
- **Una dipendenza nuova.** La licenza deve essere tra quelle ammesse dalla prova. Altrimenti è una decisione da scrivere in `docs/decisioni.md`.
