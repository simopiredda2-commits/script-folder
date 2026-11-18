# Esportazione dei dati del medico

«I dati sono del medico: esportazione completa in formato aperto, in qualsiasi momento.»

## Come si fa

Il medico titolare, dopo l'accesso, chiede `GET /api/esportazione` (nell'interfaccia arriverà un pulsante). Riceve un file `esportazione-AAAA-MM-GG.json` con **tutti** i dati del suo archivio. L'esportazione entra nel registro degli accessi. Sostituti, colleghi, segreteria e amministratore non esportano: i dati sono del titolare.

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

Le righe sono quelle del database, con i nomi delle colonne (in inglese, `snake_case`): nessuna traduzione, quindi nessuna perdita. Il significato di ogni colonna è in `docs/modello-dati.md` e nei commenti dello schema (`apps/api/src/db/schema/`). Date come `AAAA-MM-GG`, istanti in ISO 8601, numeri decimali come testo per non perdere precisione.

## Che cosa non c'è, apposta

Password, segreti del secondo fattore e credenziali verso Sistema TS e Regione: sono dello studio, non dati dei pazienti, e una prova controlla che non escano. Gli allegati sono elencati con nome, tipo e impronta; i file stessi si aggiungeranno quando ci sarà l'archiviazione degli allegati.

## Garanzie

Una prova controlla che **ogni** tabella del database con dati dei pazienti sia esportata: una tabella nuova dimenticata fa fallire le prove. Un'altra controlla che non escano pazienti di altri archivi.
EOF
echo ok
