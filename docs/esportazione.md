# Esportazione dei dati del medico

«I dati sono del medico: esportazione completa in formato aperto, in qualsiasi momento.»

## Come si fa

Il medico titolare, dopo l'accesso, chiede `GET /api/esportazione` (nell'interfaccia arriverà un pulsante) e riceve un file `esportazione-AAAA-MM-GG.json` con **tutti** i dati del suo archivio. Con `GET /api/esportazione?formato=csv` riceve gli stessi dati in CSV, dentro un archivio ZIP (vedi sotto). L'esportazione entra nel registro degli accessi. Sostituti, colleghi, segreteria e amministratore non esportano: i dati sono del titolare.

## Il formato

JSON (RFC 8259), un solo documento:

| Campo                          | Contenuto                                                                                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formato`, `versione`          | `"mmg-esportazione"`, `1`                                                                                                                                                                                                                                                    |
| `generato_il`                  | Data e ora, ISO 8601 in UTC                                                                                                                                                                                                                                                  |
| `studio`, `archivio`, `medico` | Chi esporta e da dove                                                                                                                                                                                                                                                        |
| `tabelle`                      | Un elenco di righe per ogni tabella: `patient`, `family`, `patient_choice`, `exemption`, `consent`, `delegation`, `clinical_entry` con tutti i dettagli (`problem_detail`, `diary_detail`, …, `attachment`), `therapy`, `therapeutic_plan`, `appointment`, `patient_request` |
| `storico_modifiche`            | Ogni modifica delle righe esportate, con prima, dopo e utente                                                                                                                                                                                                                |
| `registro_accessi`             | Gli accessi ai pazienti dell'archivio e le azioni del titolare, in ordine, con le impronte della catena                                                                                                                                                                      |
| `conteggi`                     | Quante righe per sezione                                                                                                                                                                                                                                                     |
| `impronte`                     | SHA-256 di ogni sezione, per controllare che il file sia integro                                                                                                                                                                                                             |

Le righe sono quelle del database, con i nomi delle colonne (in inglese, `snake_case`): nessuna traduzione, quindi nessuna perdita. Il significato di ogni colonna è in `docs/modello-dati.md` e nei commenti dello schema (`apps/api/src/db/schema/`). Date come `AAAA-MM-GG`; istanti come li scrive il database, in UTC (`2026-11-18 01:57:01.227962+00`); numeri decimali come testo per non perdere precisione. C'è anche `colonne`: l'elenco delle colonne di ogni sezione, nell'ordine del database.

## CSV

Chiesto da Simone alla prima fermata. Un archivio `esportazione-AAAA-MM-GG-csv.zip` con:

- un file `.csv` per ogni sezione del JSON (`patient.csv`, `therapy.csv`, …, `storico_modifiche.csv`, `registro_accessi.csv`), con la riga di intestazione anche quando la tabella è vuota;
- `manifest.json`: formato, data, studio, archivio, medico, e per ogni file il numero di righe e l'impronta SHA-256;
- `LEGGIMI.txt`: come leggere i file.

Separatore **punto e virgola** e codifica **UTF-8 con BOM**, perché un foglio di calcolo in italiano li apra senza passaggi; virgolette secondo la RFC 4180; righe terminate da CRLF; valori composti in JSON; cella vuota = nessun valore.

## Che cosa non c'è, apposta

Password, segreti del secondo fattore e credenziali verso Sistema TS e Regione: sono dello studio, non dati dei pazienti, e una prova controlla che non escano. Gli allegati sono elencati con nome, tipo e impronta; i file stessi si aggiungeranno quando ci sarà l'archiviazione degli allegati. Le banche dati pubbliche (farmaci, cataloghi, comuni) non sono dati del medico: non entrano nell'esportazione e si riscaricano dalle fonti.

## Garanzie

Una prova controlla che **ogni** tabella del database con dati dei pazienti sia esportata: una tabella nuova dimenticata fa fallire le prove. Altre controllano che non escano pazienti di altri archivi, che il CSV abbia le stesse righe del JSON e che le impronte del manifesto siano giuste.
EOF
echo ok
