# File ufficiali del Fascicolo Sanitario Elettronico 2.0

Copie dei file con cui il Gateway nazionale controlla i documenti CDA2. Servono al simulatore del Gateway e alle prove (tappa 11, D131): il Profilo Sanitario Sintetico prodotto dal programma si controlla con le regole ufficiali, non con una nostra copia scritta a mano. Il programma non chiama i servizi del Ministero (regola 7).

## Provenienza

Repository pubblico del Ministero della salute `ministero-salute/it-fse-catalogs` su GitHub, commit `25b7b6b2fb297540f76ddb89bf047a34fbb93c22` (letto il 18/11/2026). Il README del repository dice che contiene «i file schematron» e «i dizionari» «utilizzati in fase di verifica dei CDA2 dal gateway FSE2.0».

| Qui                                  | Nel repository del Ministero            | Che cos'è                                                       |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------------- |
| `schematron/schematron_PSS_v4.0.sch` | `schematron/schematron_PSS_v4.0.sch`    | Regole del Profilo Sanitario Sintetico (schematron 4.0)         |
| `dizionari/<OID>.csv`                | `terminology/<OID>.csv`                 | Dizionari dei codici usati dal Profilo, copiati senza modifiche |
| `loinc/estratto.csv`                 | `terminology/2.16.840.1.113883.6.1.csv` | Solo le righe dei codici LOINC che il programma scrive          |
| `loinc/LOINC_short_license.txt`      | `LOINC_short_license.txt`               | Avviso di licenza di LOINC                                      |

I dizionari copiati:

| OID                               | Contenuto                                           |
| --------------------------------- | --------------------------------------------------- |
| 2.16.840.1.113883.5.112           | Vie di somministrazione (HL7 RouteOfAdministration) |
| 2.16.840.1.113883.11.22.9         | Allergie assenti o non note                         |
| 2.16.840.1.113883.11.22.15        | Terapie assenti o non note                          |
| 2.16.840.1.113883.11.22.17        | Problemi assenti o non noti                         |
| 2.16.840.1.113883.2.9.77.22.11.2  | Allergeni (non farmaci)                             |
| 2.16.840.1.113883.2.9.77.22.11.9  | Codici delle osservazioni dell'anamnesi familiare   |
| 2.16.840.1.113883.2.9.77.22.11.10 | Cronicità del problema                              |
| 2.16.840.1.113883.2.9.77.22.11.11 | Stato clinico del problema e dell'allergia          |
| 2.16.840.1.113883.2.9.77.22.11.13 | Codice dell'autore del Profilo (MMG, PLS)           |
| 2.16.840.1.113883.2.9.77.22.11.15 | Capacità motoria                                    |
| 2.16.840.1.113883.2.9.77.22.11.17 | Organi mancanti (ICD-10)                            |
| 2.16.840.1.113883.5.4             | ActCode (tipi di allergia e intolleranza, gravità)  |
| 2.16.840.1.113883.5.1063          | ObservationValue (criticità)                        |
| 2.16.840.1.113883.5.111           | RoleCode (parentela)                                |
| 2.16.840.1.113883.5.1             | Sesso amministrativo                                |
| 2.16.840.1.113883.5.25            | Riservatezza del documento                          |

Le impronte SHA-256 sono in `SHA256SUMS`; una prova le controlla, così un file cambiato a mano si vede.

## Licenza

Il repository del Ministero non indica una licenza. I file sono pubblicati perché i produttori di software li usino per controllare i documenti prima dell'accreditamento; se tenerli nel repository va bene è una domanda per la fermata (D131). LOINC si usa con l'avviso di `loinc/LOINC_short_license.txt`.

## Aggiornare

Quando il Ministero pubblica una versione nuova dello schematron o dei dizionari: copiare il file, aggiornare questa pagina e `SHA256SUMS`, e rifare le prove. Le prove dicono se il Profilo prodotto dal programma rispetta ancora le regole.
