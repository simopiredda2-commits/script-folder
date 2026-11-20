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
| Carattere OCR-A del promemoria | `apps/api/caratteri/ocr-a/`                                                                          | Pacchetto Debian `fonts-ocr-a` 1.0-10, file `OCRA.ttf` copiato senza cambiarlo; autore John Sauter, progetto «ocr-a-font» (`LEGGIMI.md` della cartella, D211)                                                           | Pubblico dominio, come dice il file `copyright` del pacchetto; incorporato nel PDF del promemoria                              | Impronta in `SHA256SUMS`, prova     |
| Schermate della documentazione | `docs/schermate/`                                                                                    | Fotografate dal programma, con pazienti inventati (`apps/api/test/e2e/schermate.ts`)                                                                                                                                    | Proprie                                                                                                                        | Provenienza, prova                  |
| Banche dati d'esempio          | `fixtures/banche-dati/`                                                                              | `genera.py`: estratti dei file AIFA veri (righe copiate senza cambiarle), una riga dell'elenco DPC della Regione Piemonte, intestazioni e due righe ISTAT; il resto inventato (`fixtures/banche-dati/LEGGIMI.md`, D148) | AIFA: CC BY 4.0, citare AIFA come fonte. Regione Piemonte: una riga di fatti trascritta. ISTAT: condizioni d'uso da verificare | Provenienza, prova                  |
| Pazienti inventati             | `fixtures/`                                                                                          | Generatore deterministico                                                                                                                                                                                               | Propri                                                                                                                         | —                                   |
| File ufficiali del Fascicolo   | `packages/integrations/fse-ufficiale/`                                                               | Repository del Ministero della Salute, commit 25b7b6b: schematron del PSS 4.0, 16 dizionari, estratto LOINC (`README.md` della cartella)                                                                                | Il repository del Ministero non indica una licenza: domanda per la fermata (D131). LOINC con il suo avviso                     | Impronte in `SHA256SUMS`, prova     |
| Dipendenze                     | `package.json`, `pnpm-lock.yaml`                                                                     | Registro npm                                                                                                                                                                                                            | Produzione al 20/11/2026: MIT (70), ISC (4), BSD-3-Clause (3), OFL-1.1 (3), Apache-2.0 (1), 0BSD (1), MIT e Zlib (1)           | Licenze ammesse, prova              |

### Da dove vengono gli estratti delle banche dati d'esempio

File interi letti il 18/11/2026; per la lista di trasparenza e i farmaci carenti il 19/11/2026; per due confezioni dell'anagrafica (ranitidina sospesa, D205; ENTRESTO, D206) e per l'elenco dei registri e piani attivi (D206) il 20/11/2026. Nel repository ci sono solo le righe scelte (D148, D202, D205, D206). Una verifica una tantum ha confrontato ogni riga degli estratti con il file intero da cui viene: tutte identiche, byte per byte.

| File                                                        | Indirizzo                                                    | Byte       | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------ | ---------- | ------------------------------------------------------------------ |
| AIFA, `confezioni_fornitura.csv`                            | `https://drive.aifa.gov.it/farmaci/confezioni_fornitura.csv` | 82.541.593 | `33fa577fe6b635507b8b757b94a7a8b342ed01784fee64f577d27883d1350fa9` |
| AIFA, `confezioni_fornitura.csv` (20/11/2026)               | `https://drive.aifa.gov.it/farmaci/confezioni_fornitura.csv` | 82.541.055 | `7c6f00ec461f0f67300b2607a4eff924a7156d20d51d5517c2dbc96122a97ff6` |
| AIFA, `Classe-A_per_principio-attivo_30-6-2026.csv`         | `https://www.aifa.gov.it/documents/20142/3815901/…`          | 1.520.349  | `d167ef333306be7d3e70ed5b7d13f840a35d00ee11fb320f6601981deefd3832` |
| AIFA, `Classe-H_per_principio-attivo_30-6-2026.csv`         | `https://www.aifa.gov.it/documents/20142/3815901/…`          | 396.740    | `8422e0a55e2cd5cd1bcdb053e9832fc69cc9b128e585925be135771fb1426bae` |
| AIFA, `Lista_farmaci_equivalenti.csv` (16 novembre 2026)    | `https://www.aifa.gov.it/documents/20142/825643/…`           | 1.764.425  | `f95aff340397114274f03eab5d3600d9607a1ade12baacdb7572fa74eff4a712` |
| AIFA, `elenco_medicinali_carenti.csv` (17/11/2026)          | `https://www.aifa.gov.it/documents/20142/847339/…`           | 900.804    | `a75dfb3d29ea282dcf6c48a9bdcb989b12bd3cdeaa6e3eeede19890dd0997092` |
| AIFA, `Elenco_Registri_PT_attivi_19.11.2026.csv`            | `https://www.aifa.gov.it/documents/20142/3258518/…`          | 297.634    | `7e860e1061889a81e9f03f75b2cc8367857b37683c91abde647d2e8b081273e4` |
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

### Diagnosi ICD-9-CM (D186)

Le trascrizioni in `packages/reference/data/trascrizioni/icd9cm/` vengono dall'estrazione qui sotto (la versione italiana 2007 della ICD-9-CM, manuale del Ministero della salute, classificazione adottata con il DM 18/12/2008) e dalle pagine 31–35 della Gazzetta del DM 28/10/2020. Che cosa è diverso dal PDF: `docs/icd9cm.md`. Le pagine citate nella trascrizione tornano con il PDF del manuale qui sotto, scaricato il 19/11/2026: «001 Colera» a pagina 421, le legende E800–E845 alle pagine 845–852. Né il PDF del manuale né i file dell'estrazione sono nel repository. Il nome e l'impronta del PDF del manuale da cui Simone ha estratto i dati non sono annotati: vanno scritti qui. Le condizioni d'uso del manuale non sono scritte nei file: è la classificazione ufficiale adottata con un decreto (art. 5 della legge 633/1941, come per gli atti regionali), da confermare.

| Documento                                                                                                           | Indirizzo                                                                                                                                       | Byte       | SHA-256                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| Manuale del Ministero, versione italiana 2007 della ICD-9-CM (IPZS, Roma 2008), 1120 pagine: il PDF dell'estrazione | `https://www.sdb.unipd.it/sites/sdb.unipd.it/files/ICD-9_2008_volume_intero.pdf` (copia sul sito dell'Università di Padova, indicata da Simone) | 11.710.245 | `1091f6dc39806b2b84ae20af926d9a94e4cf39470d350ee748693847dd952a5d` |
| Estrazione di Simone, CSV delle diagnosi, dopo il controllo esterno (usata)                                         | Mandata da Simone il 19/11/2026 (file `ICD9-CM_2008_diagnosi.csv`)                                                                              | 3.632.899  | `d60f1582e9b23b36951174de09f3d049798cce6a9c8e50410a05d58fde10e4d6` |
| Estrazione di Simone, note dei capitoli e delle sezioni, con le legende (usata)                                     | Mandata da Simone il 19/11/2026 (file `ICD9-CM_2008.json`)                                                                                      | 7.349.487  | `b8d1a3ed4edeb579d62b470fac88ebbd47a7ccb377c8faa982837ecf38d54cf0` |
| Estrazione di Simone, foglio delle anomalie con le correzioni proposte                                              | Mandata da Simone il 19/11/2026 (file `ICD9-CM_2008_anomalie.csv`)                                                                              | 15.132     | `55833ab12447239c4cc080f9908f2bbd81f2027c4c6b4f68dead69d64414c06b` |
| Estrazione di Simone, tutto in un foglio di calcolo (stesso contenuto)                                              | Mandata da Simone il 19/11/2026 (file `ICD9-CM_2008_italiano.xlsx`)                                                                             | 1.442.836  | `6b21ab641049063b570ad7ee3dde209bd14d0f8871223816f6e55eac9aca89c7` |
| Estrazione di Simone, prima del controllo esterno (sostituita)                                                      | Mandata da Simone il 19/11/2026 (file `ICD9-CM_2008_diagnosi.csv`)                                                                              | 3.631.493  | `a50e92f3ca39db1dbdee7a431c9f475260a82cda3f482c30479af3101a0e0b0a` |
| DM 18/12/2008, GU n. 56 del 9/3/2009 (adozione della versione italiana 2007)                                        | `https://www.gazzettaufficiale.it/eli/gu/2009/03/09/56/sg/pdf`                                                                                  | 10.692.800 | `61286fab385669c786d7289ff7ec5af1a30bebd846da57c70cb12ed361ee8667` |
| DM 28/10/2020, GU n. 26 dell'1/2/2021 (integrazioni COVID-19, allegato 1)                                           | `https://www.gazzettaufficiale.it/eli/gu/2021/02/01/26/sg/pdf`                                                                                  | 4.328.707  | `085d5684d14c026275fe351e6eede95ef244e9b910959d58cfb2b5d62f5e4afb` |
| Elenco ICD-9-CM della CMS (Stati Uniti), versioni 23–32: solo per il confronto                                      | `https://raw.githubusercontent.com/jackwasey/icd9/master/data/icd9Billable.RData`                                                               | 316.872    | `a93e77f1f89835d4816c108e894c385a9fe1815bca0625a5ebfd728d1b85be5d` |

L'elenco della CMS è un dato pubblico del governo degli Stati Uniti, raccolto nel pacchetto R «icd9» (licenza GPL-3): è servito solo al confronto dei codici nella simulazione del controllo e non è nel repository. Il catalogo d'esempio in `fixtures/banche-dati/trascrizioni/icd9cm/` ha 72 righe della trascrizione e 9 righe del DM 28/10/2020.

### Esenzioni del DPCM LEA (D190)

Le trascrizioni in `packages/reference/data/trascrizioni/lea/` vengono dai PDF qui sotto, scaricati da Simone dalla pagina del Ministero della salute sui LEA (versione del 29/9/2026). Sono allegati di un decreto: testo di un atto ufficiale (art. 5 della legge 633/1941, come per gli atti regionali). I PDF restano fuori dal repository. Che cosa è diverso dal PDF: `docs/banche-dati.md`, «Esenzioni del DPCM LEA».

| Documento                                                                       | Indirizzo                                                                                                           | Byte    | SHA-256                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| DPCM 12/1/2017, allegato 8: elenco malattie e condizioni croniche e invalidanti | Mandato da Simone il 18/11/2026 (file `Allegato_8_Elenco_malattie_e_condizioni_croniche_ed_invalidanti.pdf`)        | 295.226 | `39c3434e4ed7aa11e15f0bdf673cfd49c678d83b450ccf3c10cbb6048c6065a7` |
| DPCM 12/1/2017, allegato 7: elenco delle malattie rare esentate                 | Mandato da Simone il 18/11/2026 (file `Allegato_7_Elenco_malattie_rare_esentate_dalla_partecipazione_al_costo.pdf`) | 455.682 | `7e622a1be4aae41739c5619bc77187ce34cd204f09fce9d8e1d65957b4694387` |

Gli altri allegati mandati da Simone (10, 4D) sono stati letti ma non trascritti (motivi in `docs/banche-dati.md`).

### Esenzioni e prestazioni del SAR (D196)

Letti, non trascritti: l'elenco è precedente al nuovo nomenclatore (`docs/banche-dati.md`). Atti ufficiali dal Bollettino della Regione Piemonte, scaricati il 19/11/2026.

| Documento                                                                                   | Indirizzo                                                                                            | Byte      | SHA-256                                                            |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| D.D. 30/6/2022, n. 1167 (BU 28 del 14/7/2022), con l'allegato 1                             | `https://www.regione.piemonte.it/governo/bollettino/abbonati/2022/28/attach/dda1410001167_10100.pdf` | 536.690   | `85edd72aa9a2400c82d2e49e79c562538087eb6e6c4a7eb90c88bbdf1390c7a2` |
| D.D. 6/7/2023, n. 1452 (BU 28 del 13/7/2023), con l'allegato C che sostituisce l'allegato 1 | `https://www.regione.piemonte.it/governo/bollettino/abbonati/2023/28/attach/dda1410001452_11200.pdf` | 1.365.280 | `817ae8f927c0d15c902ff57a013ab4e9b0d85796617e813018a7af0716c119b0` |

### Modelli ufficiali dei certificati (D158)

Il testo dei file in `apps/api/modelli/` è copiato dagli atti, con la fonte in ogni file. Le pagine della Gazzetta sono state lette il 18/11/2026 e i PDF restano fuori dal repository.

| Modello                                     | Atto                                                                                                                                                                                                                    | Confronto                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `sportivo-non-agonistico.json`              | DM Salute 8 agosto 2014, allegato 2, GU n. 243 del 18/10/2014                                                                                                                                                           | Pagina 26 del PDF della GU, solo immagine: trascrizione a mano confrontata con l'immagine                      |
| `porto-armi-anamnestico.json`               | DM Sanità 28 aprile 1998, allegato 1, GU n. 143 del 22/6/1998                                                                                                                                                           | Testo della pagina HTML della GU confrontato con la scansione del fascicolo (pagina 16)                        |
| `patente-anamnestico.json` (proposto, D160) | Art. 119, comma 3, del Codice della strada (GU multivigente, versione 14); D.Lgs. 59/2011, allegato III, testo in vigore dal 1/1/2018, e titoli degli artt. 320–323 del DPR 495/1992, letti su Normattiva il 19/11/2026 | Nessun modello ufficiale: testo scritto da noi. Dei moduli in uso si è presa solo la struttura (tabella sotto) |

Moduli dell'anamnestico per la patente mandati da Simone il 18/11/2026, usati solo per la struttura (un gruppo di malattie per riga, «sì/no» con le note, dichiarazione del richiedente, firme). Non dicono chi li ha pubblicati; non sono nel repository e non se ne copia il testo.

| File                                           | Pagine | Byte    | SHA-256                                                            |
| ---------------------------------------------- | ------ | ------- | ------------------------------------------------------------------ |
| `Certificato-anamnestico-patente-di-guida.pdf` | 2      | 24.032  | `017663a2708da1ffce4c0dbe95fc93cbdf28126a98fd622ae5fec578a561a268` |
| `ANAMNESTICO_web.pdf` (solo immagini)          | 3      | 226.831 | `d559c4ef5031c99cd929768499c845a199634ddfd7d2977d289248790c056cf3` |
| `anamnestico-MMG.pdf`                          | 1      | 14.646  | `d3a6cdd70003b63d15a9beaa3678f4e488890fd8ae0eb70f828379a785e72e61` |

### Condivisione nell'AFT (D161)

Le regole della condivisione vengono da atti ufficiali, letti il 19/11/2026 sui testi pubblicati: D.Lgs. 502/1992, art. 8, e D.L. 158/2012, art. 1 (Normattiva); ACN della medicina generale 2022-2024, G.U. n. 24 del 30/1/2026, s.o. n. 5; Garante, linee guida sul dossier sanitario, provv. n. 331 del 4/6/2015, G.U. n. 164 del 17/7/2015; Regione Piemonte, D.G.R. 27/5/2024, n. 31-8647, B.U. n. 22 del 30/5/2024. Nel repository ci sono solo brevi citazioni, in `docs/aft.md` e nei commenti del codice, con la fonte accanto: sono testi di atti ufficiali (art. 5 della legge 633/1941). I PDF restano fuori dal repository.

## Fuori dal repository

Le banche dati pubbliche non sono nel repository. Le scarica `sync/` nello studio e le importa il programma: AIFA, ISTAT, Regione Piemonte, DPCM LEA. Fonti e versioni sono in `sync/fonti.json` e in `docs/banche-dati.md`. Le condizioni d'uso di ciascuna fonte sono da verificare e scrivere qui prima del lancio.

## Cataloghi dello studio

Richiesta di Simone del 18/11/2026; non ancora costruiti (`docs/avanzamento.md`). La fonte di ogni catalogo:

| Catalogo                                                    | Fonte                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Diagnosi ICD-9-CM e ICD-10-IM                               | Ministero della Salute, DM 23/10/2025 (requisiti)                                           |
| Prestazioni                                                 | Catalogo regionale, già importato; ricerca per parole chiave con sinonimi verificati (D153) |
| Esami associati alle esenzioni                              | Regione Piemonte, D.D. 1167/2022 e allegato C della D.D. 1452/2023: non importato (D196)    |
| Vaccini                                                     | Fonte pubblica da individuare                                                               |
| Problemi ICPC                                               | Classificazione della WONCA: si usa solo con la licenza verificata                          |
| Posologie, pacchetti di esami, medici suggeritori, contatti | Li inserisce lo studio; il programma parte vuoto o con gli elenchi delle fonti pubbliche    |

Nessun elenco viene preso dalle schermate di altri programmi.

## Come si aggiunge un contenuto nuovo

- **Un file di terzi.** Va in una cartella sua, con un `README.md` o un `LEGGIMI.md` (fonte, data, condizioni) e le impronte in `SHA256SUMS`. Poi una riga in questo documento, e la sua provenienza nella prova.
- **Una dipendenza nuova.** La licenza deve essere tra quelle ammesse dalla prova. Altrimenti è una decisione da scrivere in `docs/decisioni.md`.
