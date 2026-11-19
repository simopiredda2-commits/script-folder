# Modelli dei certificati del programma

Un file per modello: `<chiave>.json`. Due tipi:

- **ufficiali** (`"official": true`): il testo viene solo dall'atto ufficiale indicato nella fonte (D142, D143);
- **proposti** (`"official": false` con `proposal`, D160): per un certificato che non ha un modello ufficiale. Il testo lo scrive il programma dai requisiti di legge della fonte, e `proposal` dice che cosa resta da verificare. Nell'interfaccia si vedono come «modello proposto, da verificare».

Le regole:

- non si riformula e non si completa a memoria;
- i dati del paziente e del medico sono segnaposto che il programma riempie;
- quello che il modello chiede di scrivere al medico è un campo.

Il servizio legge e controlla i file all'avvio (`apps/api/src/templates/catalog.ts`): un file sbagliato ferma l'avvio invece di dare un certificato sbagliato.

## Formato

| Chiave          | Che cosa                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `key`           | Chiave stabile, uguale al nome del file: minuscole, cifre e trattini                                            |
| `title`         | Titolo stampato                                                                                                 |
| `version`       | Data dell'atto da cui viene il testo (AAAA-MM-GG); per i proposti, la data in cui è stato scritto               |
| `official`      | `true` per i modelli ufficiali, `false` per i proposti                                                          |
| `proposal`      | Solo per i proposti: che cosa resta da verificare prima dell'uso                                                |
| `source`        | Fonte: `act` (atto e allegato), `publication` (GU o BUR), `url`, `checkedOn` (data del confronto), `note`       |
| `validityMonths`| Validità in mesi, se l'atto la fissa; altrimenti `null`                                                         |
| `forDoctor`     | Note per il medico, non stampate: che cosa chiede l'atto prima del rilascio                                     |
| `fields`        | Campi che il medico compila: `key`, `label`, `type` (`testo`, `testo_lungo`, `data`, `scelta`, `numero`), `required`, `options`, `help`, `max` |
| `body`          | Paragrafi del testo, con i segnaposto; dentro un paragrafo `\n` va a capo senza spazio in più                    |
| `signature`     | Riga sotto lo spazio della firma del medico                                                                     |
| `reference`     | Facoltativo: riferimento normativo sotto il titolo; per difetto l'atto e la pubblicazione della fonte           |
| `notes`         | Facoltativo: note del modello, stampate in fondo in corpo più piccolo, senza segnaposto                         |
| `placeDateLabel`| Facoltativo: parola davanti a luogo e data (per difetto «Luogo e data:»; vuota per non scriverla)               |
| `otherSignatures`| Facoltativo: altre firme, a sinistra di quella del medico (per esempio «In fede, il dichiarante»)              |

Una scelta con `"boxes": true` si stampa come nel modello cartaceo, una casella per valore con la X su quello scelto («[X] No   [ ] Pregressa   [ ] In atto»); sullo schermo è una riga di pulsanti.

## Struttura comune (D158)

Tutti i modelli si stampano con la stessa struttura: intestazione del medico, titolo, riferimento normativo, testo, luogo e data, firme, note in fondo. Se il testo scrive già luogo e data con i segnaposto `{{rilascio.…}}`, la riga comune non si ripete. Regole delle pagine: un paragrafo che sta in una pagina non si spezza; l'ultimo paragrafo resta sulla pagina di luogo, data e firme; le note restano insieme.

## Modelli ufficiali presenti

| File                            | Atto                                                    | Validità |
| ------------------------------- | ------------------------------------------------------- | -------- |
| `sportivo-non-agonistico.json`  | DM Salute 8 agosto 2014, allegato 2 (GU n. 243/2014)     | 12 mesi  |
| `porto-armi-anamnestico.json`   | DM Sanità 28 aprile 1998, allegato 1 (GU n. 143/1998)    | 3 mesi   |

## Modelli proposti presenti

| File                         | Base di legge                                                                         | Validità |
| ---------------------------- | ------------------------------------------------------------------------------------- | -------- |
| `patente-anamnestico.json`   | Art. 119, comma 3, del Codice della strada; allegato III del D.Lgs. 59/2011; artt. 320–323 del DPR 495/1992 | 3 mesi   |

## Segnaposto

- Paziente: `{{paziente.cognome}}`, `{{paziente.nome}}`, `{{paziente.sesso}}`, `{{paziente.nato_a}}`, `{{paziente.nato_il}}`, `{{paziente.codice_fiscale}}`, `{{paziente.residenza}}`.
- Medico: `{{medico.nome_cognome}}`, `{{medico.codice_fiscale}}`, `{{medico.codice_regionale}}`.
- Rilascio: `{{rilascio.luogo}}`, `{{rilascio.data}}`.
- Campi del modello: `{{campo.<key>}}`; le date si stampano come GG/MM/AAAA.
