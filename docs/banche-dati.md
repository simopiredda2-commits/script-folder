# Banche dati pubbliche (tappa 5)

Il servizio importa nel database ciò che `sync/` scarica e controlla. Lo script resta com'è: l'importazione legge la sua cartella (`--dest`), cioè `stato.json` e i file in `correnti/`, e non scarica nulla.

```
sync/banche_dati.py  →  dati-pubblici/correnti/…, stato.json  →  importazione  →  database  →  regole e ricerche
                                                       ↑
                              trascrizioni controllate dei PDF (A8)
```

## Che cosa si importa

| Tipo                    | Da dove                                            | Come            | Serve per                       |
| ----------------------- | -------------------------------------------------- | --------------- | ------------------------------- |
| `farmaci`               | AIFA, anagrafica delle confezioni (CSV)            | file di `sync/` | ricerca farmaci                 |
| `farmaci_classe`        | AIFA, classe A e H per principio attivo (CSV)      | file di `sync/` | R8, prezzo, equivalenti         |
| `farmaci_dpc`           | Regione Piemonte, farmaci PHT in DPC (PDF)         | trascrizione    | R5, R7, indicazione DPC         |
| `comuni`                | ISTAT, elenco dei comuni (XLSX)                    | file di `sync/` | anagrafica, codice fiscale, D12 |
| `prestazioni`           | Regione Piemonte, catalogo delle prestazioni (PDF) | trascrizione    | ricerca prestazioni, R14        |
| `esenzioni`             | DPCM LEA e atti regionali (PDF)                    | trascrizione    | R9                              |
| `esenzioni_prestazioni` | Regione Piemonte, D.D. 1167/2022 (PDF)             | trascrizione    | R17                             |

Non importati per ora: liste di trasparenza, farmaci carenti, registri e piani AIFA, ICD-9-CM e ICD-10-IM. Si aggiungono con un tipo e una mappatura nuovi.

## Lettura dei file

- **CSV**: come `sync/` (`ispeziona_csv`). Codifica utf-8 (con o senza BOM), poi cp1252, poi latin-1. Separatore: il più frequente nella prima riga tra `;` `,` tab `|`. Campi tra virgolette e virgolette raddoppiate come il modulo `csv` di Python. Una prova confronta, cella per cella, il lettore con Python sugli stessi file.
- **XLSX**: primo foglio, testi condivisi o in linea, celle mancanti come testo vuoto (lettore minimo su `fflate`).
- **Intestazioni**: confrontate senza date, senza maiuscole e con gli spazi compattati, con le stesse espressioni di `sync/` (`_norma_cella`). Così «Prezzo al 15/6/2026» e «Prezzo al 30/6/2026» sono la stessa colonna. Anche questo lo verifica una prova contro Python.
- L'intestazione si cerca nelle prime 20 righe: la prima che contiene tutte le colonne della mappatura.

## Mappature

`packages/reference/data/mappature.json` collega le colonne dei file ai campi dei tipi (D54). Per ogni mappatura:

- `fonte` e `chiave`: il file in `correnti/<fonte>/<chiave>`; `*` vale qualsiasi testo (la cartella AIFA davanti alla chiave può cambiare);
- `colonne`: campo → intestazione; `null` = **da completare**;
- `costanti`: campo → valore uguale per tutto il file (la classe di un elenco);
- `nessunValore`: campo facoltativo → espressioni (su tutta la cella) dei valori che nel file vogliono dire «nessun valore», per esempio «-» al posto di un prezzo. Solo quelli visti nei file veri, con il motivo nella nota; il rapporto d'importazione dice quante celle sono state lette così (D148);
- `vecchiaDopoGiorni`: soglia di A6; `null` = da completare (D62).

Stato al 18/11/2026:

| Mappatura         | Stato                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `istat-comuni`    | Completa. Intestazioni lette dal file ISTAT al 21/02/2026 tramite un'estrazione testuale: da confermare (D56)                                                                                                         |
| `aifa-anagrafica` | Completa (D148). Intestazioni lette il 18/11/2026 da `confezioni_fornitura.csv`: 160.101 righe, tutti gli AIC di 9 cifre e tutti gli ATC nella forma attesa. Con la ditta titolare dell'AIC (`RAGIONE_SOCIALE`, D151) |
| `aifa-classe-a`   | Completa (D148). File del 30/6/2026 in cp1252: 10.766 righe, AIC e prezzi tutti validi. **Non ha la colonna della nota AIFA**                                                                                         |
| `aifa-classe-h`   | Completa (D148). File del 30/6/2026: 2.487 righe; l'intestazione «Codice AIC» va a capo dentro le virgolette; 117 prezzi senza valore («-» e il prezzo dell'ossigeno a metro cubo, `nessunValore`)                    |
| `trascrizione-*`  | Complete: il formato è nostro (sotto)                                                                                                                                                                                 |

**Se AIFA cambia le colonne.** `sync/` mette il file nuovo «da verificare» (colonne cambiate). Dopo il controllo: si correggono i nomi delle colonne nella mappatura, si alza la `versione` del file e si rilancia l'importazione. Con una colonna nulla il rapporto dice «mappatura da completare» e riporta l'intestazione vera, letta da `stato.json`.

## Trascrizioni dei PDF (A8)

I PDF non si estraggono da soli. Una persona copia i dati in un CSV (UTF-8, separatore `;`) e compila una scheda JSON con lo stesso nome, accanto al CSV (D57):

```json
{
  "tipo": "farmaci_dpc",
  "serie": "piemonte-dpc",
  "fonte": "piemonte_dpc",
  "chiave": "farmaci_pht_dpc.pdf",
  "sha256_origine": "impronta SHA-256 del PDF, come in stato.json",
  "atto": "Elenco dei farmaci PHT in DPC, aggiornamento del …",
  "in_vigore_dal": "AAAA-MM-GG",
  "trascritto_da": "Nome e cognome",
  "trascritto_il": "AAAA-MM-GG",
  "controllato_da": "Nome e cognome"
}
```

- `fonte`, `chiave` e `sha256_origine` vanno indicati tutti e tre, oppure nessuno (atto che `sync/` non scarica: si importa con la nota «origine non verificabile»).
- Se il PDF in uso in `sync/` ha un'impronta diversa, la trascrizione è **superata** e non entra: va trascritta la versione nuova.
- `serie` (facoltativa) lega le versioni successive della stessa tabella, per esempio due determine sul catalogo.

Colonne dei CSV trascritti:

| Tipo                    | Colonne                                                                | Note                                        |
| ----------------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| `farmaci_dpc`           | `principio_attivo;atc;nota_aifa;piano_terapeutico`                     | `piano_terapeutico`: `sì` o `no`            |
| `prestazioni`           | `codice_regionale;codice_nomenclatore;descrizione;branca;tariffa;note` | tariffa scritta all'italiana (`20,66`)      |
| `esenzioni`             | `codice;descrizione`                                                   | il catalogo completo, non solo le patologie |
| `esenzioni_prestazioni` | `esenzione;prestazione`                                                | una riga per ogni prestazione associata     |

## Controlli all'importazione

| Controllo                                                                   | Esito                                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Il file in `correnti/` ha l'impronta scritta da `sync/` in `stato.json`     | altrimenti **errore**, non si importa                                                                     |
| La mappatura ha una colonna per ogni campo obbligatorio                     | altrimenti «da completare», con l'intestazione vera                                                       |
| Il file ha tutte le colonne della mappatura                                 | altrimenti «colonne mancanti», con quali                                                                  |
| Ogni valore ha la forma attesa (AIC 9 cifre, codice catastale, ATC, numeri) | altrimenti «righe non valide», con riga, campo e motivo; `--accetta-scarti` importa le righe valide (D61) |
| Stessa serie e stessa impronta già importate                                | «già importato»: un secondo giro non cambia nulla                                                         |
| Una versione nuova in attesa di verifica in `sync/`                         | segnalata; resta in uso quella precedente                                                                 |
| Comuni con un codice catastale che inizia con X                             | avviso: è la lettera dei luoghi inventati (D12, D64)                                                      |

Le forme dei codici: AIC di 9 cifre (tutti i 160.101 dell'anagrafica AIFA letta il 18/11/2026; la lista di trasparenza li scrive invece senza lo zero iniziale, a 8 cifre, e per questo non è ancora mappata); codice catastale con una lettera e tre cifre (DM 23/12/1976 e file ISTAT); codice ISTAT di 6 cifre e sigla di due lettere (file ISTAT); ATC con la struttura a livelli lettera, due cifre, lettera, lettera, due cifre (struttura dell'OMS; tutti gli ATC dell'anagrafica AIFA la rispettano).

## Versioni e date (A5, A6)

- Ogni importazione è una versione **immutabile** (`reference_dataset` e tabelle `ref_*`, con divieto di modifica, cancellazione e svuotamento nel database).
- Data d'inizio: per i file di `sync/` il giorno del download; per le trascrizioni la data dell'atto.
- **A5.** Alla data di una ricetta, per ogni serie vale la versione con la data d'inizio più recente non successiva; a parità di data, l'ultima importata. Esempio provato: il 29/10/2026 vale il catalogo precedente, dal 30/10/2026 quello nuovo.
- **A6.** `GET /api/banche-dati` e ogni ricerca restituiscono `versioni`: tipo, titolo, data d'inizio e su che cosa si basa, data del download, righe, atto, ultimo controllo della fonte (`checkedAt`). `stale` dice se la versione è più vecchia del previsto e `staleReasons` perché (D156, sotto). Non blocca nulla: il controllo finale resta del SAC.

## Aggiornamento continuo (D156)

Banche dati e tabelle di codici si aggiornano da sole ogni notte, e quando serve anche subito. Un solo giro fa tutto: `sync/` scarica dalle fonti solo ciò che è cambiato (A1), l'importazione controlla e mette in uso le versioni nuove (A3, A5), il giro resta nel registro (`reference_update_run`).

Il giro si avvia in tre modi:

- **ogni notte**, all'ora di `BANCHE_DATI_AGGIORNAMENTO` (per esempio `03:30`, ora dello studio). L'orologio tiene conto del cambio dell'ora. Se il servizio era spento all'ora prevista, il giro perso parte un minuto dopo l'avvio;
- **con il comando** `pnpm banche-dati:aggiorna`, anche da un'attività pianificata del server;
- **con il pulsante «Aggiorna adesso»**, solo per l'amministratore dello studio (`admin.reference_data`), in Strumenti › Banche dati.

Le regole del giro:

- **Uno alla volta.** Un secondo giro trova il primo in corso e non parte. Un giro rimasto «in corso» per più di 6 ore si chiude come interrotto. Alla chiusura del servizio il download si ferma e il giro resta interrotto.
- **Cadenza dei controlli.** Tutte le fonti, ogni notte (A1): le richieste condizionate rendono leggero un controllo che non trova nulla di nuovo.
- **Che cosa dice l'esito.** Le regole sono quelle di `sync/` e del comando d'importazione:
  - `ok`;
  - `da_verificare`: una versione nuova trattenuta, un PDF da trascrivere, un file sparito dalla pagina;
  - `errore`: una fonte che non risponde, un file non valido, un'impronta diversa;
  - `interrotto`.
- **Che cosa resta di ogni giro.**
  - Il rapporto JSON di `sync/` (`ultimo-rapporto.json`), il rapporto dell'importazione e le cose da controllare.
  - Per ogni serie in uso: l'ultimo controllo riuscito della sua fonte, se il controllo di quel giro è fallito, e se una versione più nuova aspetta qualcuno.

**Più vecchia del previsto** (A6), con il motivo accanto alla data della versione:

- l'ultimo aggiornamento non è riuscito a controllare la sua fonte;
- l'aggiornamento di ogni notte manca, cioè nessun giro è partito dopo l'ultima ora prevista;
- una versione più nuova aspetta la verifica in `sync/` (A3), oppure il file nuovo non è entrato in uso (colonne, righe non valide);
- per le trascrizioni: il PDF trascritto è cambiato alla fonte, oppure la stessa fonte ha documenti nuovi da trascrivere. È il caso del catalogo regionale quando la Regione pubblica una determina nuova;
- la versione supera la soglia d'età della sua fonte (`vecchiaDopoGiorni`). C'è solo dove la fonte dichiara una cadenza regolare. Oggi è il caso dell'ISTAT, che aggiorna l'elenco dei comuni «almeno ogni sei mesi»: 184 giorni più una notte, 185. AIFA pubblica l'anagrafica ogni giorno, ma il contenuto può restare uguale, quindi una soglia d'età darebbe avvisi falsi: vale il controllo di ogni notte. Le altre fonti non hanno una cadenza regolare.

Senza giri registrati e senza soglia, `stale` è `null`: non si sa, e non si avvisa.

**Configurazione** (variabili d'ambiente del servizio, `.env.example`):

| Variabile                   | Che cosa                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `BANCHE_DATI_DIR`           | cartella dei dati di `sync/`; senza, il servizio non aggiorna nulla (sviluppo e prove)      |
| `BANCHE_DATI_TRASCRIZIONI`  | cartella delle trascrizioni dei PDF                                                         |
| `BANCHE_DATI_FONTI`         | `pubbliche` (`sync/fonti.json`, per difetto), `esempio` (sito d'esempio) o un file di fonti |
| `BANCHE_DATI_AGGIORNAMENTO` | ora dell'aggiornamento di ogni notte, `HH:MM`; senza, solo comando e pulsante               |
| `SYNC_CONTATTO`             | email nello User-Agent di `sync/`, perché i gestori dei siti sappiano chi scarica           |

In sviluppo e nelle prove non c'è `BANCHE_DATI_DIR`, quindi il servizio non chiama nessun sito (regola 7). Le prove usano il sito d'esempio servito in locale.

## Che cosa ne ricavano le regole

Solo fatti che hanno una fonte; l'assenza da un elenco non diventa mai un «no» (D59).

| Fatto                                         | Da dove                                                        | Regola  |
| --------------------------------------------- | -------------------------------------------------------------- | ------- |
| A carico del SSN                              | il farmaco è nell'elenco di classe A in vigore                 | R8      |
| Nota AIFA                                     | DPC (le liste di classe non hanno la colonna)                  | R7      |
| Piano terapeutico obbligatorio                | DPC, solo se dice `sì`                                         | R5      |
| Esenzione esistente                           | catalogo delle esenzioni                                       | R9      |
| Prestazioni di un'esenzione                   | elenco esenzione → prestazioni                                 | R17     |
| Prescrivibile dal medico di medicina generale | **non noto**: serve una fonte strutturata                      | R8      |
| Regime di fornitura                           | anagrafica (`FORNITURA`): letto, non ancora usato dalle regole | —       |
| Unità per confezione                          | **non noto**                                                   | R4, R11 |
| Antibiotico iniettabile o infusione           | **non noto**                                                   | R3      |

Con un fatto non noto le regole si comportano come senza banca dati (D42): non bloccano e lo dicono.

## Rotte

Servono una sessione; non sono dati dei pazienti, quindi niente registro degli accessi alla cartella. Parametro facoltativo `data=AAAA-MM-GG` per consultare le banche dati a una data (A5).

| Rotta                                 | Risposta                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /api/banche-dati`                | versioni in uso                                                                                                     |
| `GET /api/farmaci?q=`                 | farmaci per nome, principio attivo, AIC o ATC, con versioni                                                         |
| `GET /api/farmaci/:aic`               | il farmaco e gli equivalenti del suo gruppo                                                                         |
| `GET /api/prestazioni?q=`             | prestazioni per descrizione, branca, codice regionale o nazionale                                                   |
| `GET /api/esenzioni?q=`               | esenzioni per codice o descrizione                                                                                  |
| `GET /api/comuni/:codice`             | comune per codice catastale                                                                                         |
| `GET /api/banche-dati/aggiornamenti`  | ora e prossimo aggiornamento, giro in corso, ultimo giro con le cose da controllare, ultimi dieci giri              |
| `POST /api/banche-dati/aggiornamenti` | avvia subito un giro (solo l'amministratore dello studio); 409 se uno è in corso o se il servizio non è configurato |

Le banche dati pubbliche non sono dati del medico: non entrano nella sua esportazione.

## Comandi

```sh
pnpm banche-dati:importa -- --dati ~/dati-pubblici --trascrizioni ~/trascrizioni
pnpm banche-dati:importa -- --esempio      # sync sul sito d'esempio, poi importazione (dati dimostrativi)
pnpm banche-dati:aggiorna -- --dati ~/dati-pubblici --trascrizioni ~/trascrizioni   # giro completo (D156)
pnpm banche-dati:aggiorna -- --esempio     # giro completo sul sito d'esempio
```

`banche-dati:aggiorna` prende la cartella, le trascrizioni e le fonti anche dalle variabili del servizio (`BANCHE_DATI_DIR`, `BANCHE_DATI_TRASCRIZIONI`, `BANCHE_DATI_FONTI`): un'attività pianificata del server lo può lanciare senza opzioni.

Codici d'uscita come `sync/`: `0` tutto a posto, `1` almeno un errore, `2` qualcosa da completare o verificare.

## Esempi e prove

- `fixtures/banche-dati/sito/`: sito d'esempio con le stesse fonti di `sync/fonti.json` (`fonti-prova.json`). I file AIFA sono estratti dei file veri, con le intestazioni vere: righe copiate senza cambiare un byte (D148; fonte AIFA, licenza CC BY 4.0). Valgono le mappature del repository: le mappature di prova non ci sono più.
- Gli estratti coprono i casi dei file veri: anagrafica in utf-8 con `\n`, liste di classe in cp1252 con `\r\n` e il simbolo dell'euro, l'intestazione della classe H che va a capo, due prezzi della classe H che non sono numeri, un farmaco (paracetamolo) fuori dalle liste di classe.
- `fixtures/banche-dati/trascrizioni/`: trascrizioni d'esempio, con le impronte vere dei PDF d'esempio. La riga DPC (dulaglutide, nota 100, piano terapeutico) è quella dell'elenco della Regione Piemonte del 9/7/2026; catalogo ed esenzioni sono inventati.
- `fixtures/banche-dati/genera.py`: rigenera gli esempi (serve `openpyxl`).
- Le prove (`apps/api/test/banche-dati.test.ts`) servono il sito in locale, lanciano `sync/banche_dati.py` vero e importano il suo output (D63).

## Che cosa non è stato provato

- L'aggiornamento di ogni notte sulle fonti vere: provato solo sul sito d'esempio, con un orologio finto per l'ora e per i due cambi dell'ora. Il primo giro sui siti veri va fatto da un computer dello studio (requisiti, «Ambiente di test»).
- Due istanze del servizio insieme: un giro solo alla volta è garantito dal database (vincolo sul giro in corso), provato con due avvii nello stesso servizio.
- I moduli dei certificati non sono ancora tra le fonti controllate: gli atti dei modelli ufficiali entreranno in `sync/fonti.json` con la tappa 13.

- L'importazione nel database dei file AIFA interi: le mappature sono state controllate sui file interi del 18/11/2026 (forme di AIC, ATC e prezzi), ma `sync/` sul sito vero e l'importazione completa non sono stati lanciati da qui. Il file ISTAT completo non si raggiunge dal cloud.
- Le intestazioni ISTAT vengono da un'estrazione testuale, non dai byte del file: da confermare al primo giro.
- Un XLSX scritto da Excel: l'esempio lo scrive `openpyxl`, che usa testi in linea. I testi condivisi, tipici di Excel, sono provati con un file costruito nella prova.
- I tempi d'importazione del file ISTAT completo e dell'anagrafica AIFA, che supera i 50 MB: l'importazione procede a blocchi di 1000 righe, ma non è stata misurata su file così grandi.
