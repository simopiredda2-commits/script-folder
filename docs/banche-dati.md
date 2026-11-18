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
| `farmaci_classe`        | AIFA, classe A e H per principio attivo (CSV)      | file di `sync/` | R8, prezzo, equivalenti, nota   |
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
- `vecchiaDopoGiorni`: soglia di A6; `null` = da completare (D62).

Stato al 18/11/2026:

| Mappatura         | Stato                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `istat-comuni`    | Completa. Intestazioni lette dal file ISTAT al 21/02/2026 tramite un'estrazione testuale: da confermare (D56) |
| `aifa-anagrafica` | **Da completare**: dal cloud i file AIFA non si leggono (D55)                                                 |
| `aifa-classe-a`   | **Da completare**                                                                                             |
| `aifa-classe-h`   | **Da completare**                                                                                             |
| `trascrizione-*`  | Complete: il formato è nostro (sotto)                                                                         |

**Come completare le mappature AIFA.** Lanciare `sync/` dal computer dello studio, poi `pnpm banche-dati:importa -- --dati ~/dati-pubblici`. Per ogni file AIFA il rapporto dice «mappatura da completare» e riporta l'intestazione vera, letta da `stato.json`. Si copiano i nomi delle colonne nella mappatura, si alza la `versione` del file e si rilancia l'importazione.

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

Le forme dei codici: AIC di 9 cifre (esempi letti: «012745016» nei dati AIFA citati da terzi, e i file di prova di `sync/`); codice catastale con una lettera e tre cifre (DM 23/12/1976 e file ISTAT); codice ISTAT di 6 cifre e sigla di due lettere (file ISTAT); ATC con la struttura a livelli lettera, due cifre, lettera, lettera, due cifre (struttura dell'OMS, verificata solo sull'esempio «N02BE01»).

## Versioni e date (A5, A6)

- Ogni importazione è una versione **immutabile** (`reference_dataset` e tabelle `ref_*`, con divieto di modifica, cancellazione e svuotamento nel database).
- Data d'inizio: per i file di `sync/` il giorno del download; per le trascrizioni la data dell'atto.
- **A5.** Alla data di una ricetta, per ogni serie vale la versione con la data d'inizio più recente non successiva; a parità di data, l'ultima importata. Esempio provato: il 29/10/2026 vale il catalogo precedente, dal 30/10/2026 quello nuovo.
- **A6.** `GET /api/banche-dati` e ogni ricerca restituiscono `versioni`: tipo, titolo, data d'inizio e su che cosa si basa, data del download, righe, atto. `stale` dice se la versione è più vecchia del previsto; è `null` finché la soglia è da completare. Non blocca nulla: il controllo finale resta del SAC.

## Che cosa ne ricavano le regole

Solo fatti che hanno una fonte; l'assenza da un elenco non diventa mai un «no» (D59).

| Fatto                                                              | Da dove                                        | Regola  |
| ------------------------------------------------------------------ | ---------------------------------------------- | ------- |
| A carico del SSN                                                   | il farmaco è nell'elenco di classe A in vigore | R8      |
| Nota AIFA                                                          | elenco di classe (se mappata) o DPC            | R7      |
| Piano terapeutico obbligatorio                                     | DPC, solo se dice `sì`                         | R5      |
| Esenzione esistente                                                | catalogo delle esenzioni                       | R9      |
| Prestazioni di un'esenzione                                        | elenco esenzione → prestazioni                 | R17     |
| Prescrivibile dal medico di medicina generale, regime di fornitura | **non noto**: serve una fonte strutturata      | R8      |
| Unità per confezione                                               | **non noto**                                   | R4, R11 |
| Antibiotico iniettabile o infusione                                | **non noto**                                   | R3      |

Con un fatto non noto le regole si comportano come senza banca dati (D42): non bloccano e lo dicono.

## Rotte

Servono una sessione; non sono dati dei pazienti, quindi niente registro degli accessi alla cartella. Parametro facoltativo `data=AAAA-MM-GG` per consultare le banche dati a una data (A5).

| Rotta                     | Risposta                                                          |
| ------------------------- | ----------------------------------------------------------------- |
| `GET /api/banche-dati`    | versioni in uso                                                   |
| `GET /api/farmaci?q=`     | farmaci per nome, principio attivo, AIC o ATC, con versioni       |
| `GET /api/farmaci/:aic`   | il farmaco e gli equivalenti del suo gruppo                       |
| `GET /api/prestazioni?q=` | prestazioni per descrizione, branca, codice regionale o nazionale |
| `GET /api/esenzioni?q=`   | esenzioni per codice o descrizione                                |
| `GET /api/comuni/:codice` | comune per codice catastale                                       |

Le banche dati pubbliche non sono dati del medico: non entrano nella sua esportazione.

## Comandi

```sh
pnpm banche-dati:importa -- --dati ~/dati-pubblici --trascrizioni ~/trascrizioni
pnpm banche-dati:importa -- --esempio      # sync sul sito d'esempio, poi importazione (dati dimostrativi)
```

Codici d'uscita come `sync/`: `0` tutto a posto, `1` almeno un errore, `2` qualcosa da completare o verificare.

## Esempi e prove

- `fixtures/banche-dati/sito/`: sito d'esempio con le stesse fonti di `sync/fonti.json` (`fonti-prova.json`). Contenuto inventato, tranne le intestazioni del file ISTAT e le righe di Agliè e Airasca.
- `fixtures/banche-dati/trascrizioni/`: trascrizioni d'esempio, con le impronte vere dei PDF d'esempio.
- `fixtures/banche-dati/mappature-prova.json`: mappature AIFA per le intestazioni **di prova** dei file d'esempio, non per quelle AIFA.
- `fixtures/banche-dati/genera.py`: rigenera gli esempi (serve `openpyxl`).
- Le prove (`apps/api/test/banche-dati.test.ts`) servono il sito in locale, lanciano `sync/banche_dati.py` vero e importano il suo output (D63).

## Che cosa non è stato provato

- Nessun file vero AIFA, né il file ISTAT completo: dal cloud i siti istituzionali non si raggiungono. Il primo giro vero va fatto dal computer dello studio.
- Le intestazioni ISTAT vengono da un'estrazione testuale, non dai byte del file: da confermare al primo giro.
- Un XLSX scritto da Excel: l'esempio lo scrive `openpyxl`, che usa testi in linea. I testi condivisi, tipici di Excel, sono provati con un file costruito nella prova.
- I tempi d'importazione del file ISTAT completo e dell'anagrafica AIFA, che supera i 50 MB: l'importazione procede a blocchi di 1000 righe, ma non è stata misurata su file così grandi.
