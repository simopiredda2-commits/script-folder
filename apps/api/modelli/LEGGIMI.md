# Modelli ufficiali dei certificati

Un file per modello: `<chiave>.json`. Il testo viene solo dall'atto ufficiale indicato nella fonte (D142, D143). Le regole:

- non si riformula e non si completa a memoria;
- i dati del paziente e del medico sono segnaposto che il programma riempie;
- quello che il modello chiede di scrivere al medico è un campo.

Il servizio legge e controlla i file all'avvio (`apps/api/src/templates/catalog.ts`): un file sbagliato ferma l'avvio invece di dare un certificato sbagliato.

## Formato

| Chiave          | Che cosa                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `key`           | Chiave stabile, uguale al nome del file: minuscole, cifre e trattini                                            |
| `title`         | Titolo stampato                                                                                                 |
| `version`       | Data dell'atto da cui viene il testo (AAAA-MM-GG)                                                               |
| `official`      | Sempre `true`                                                                                                   |
| `source`        | Fonte: `act` (atto e allegato), `publication` (GU o BUR), `url`, `checkedOn` (data del confronto), `note`       |
| `validityMonths`| Validità in mesi, se l'atto la fissa; altrimenti `null`                                                         |
| `forDoctor`     | Note per il medico, non stampate: che cosa chiede l'atto prima del rilascio                                     |
| `fields`        | Campi che il medico compila: `key`, `label`, `type` (`testo`, `testo_lungo`, `data`, `scelta`, `numero`), `required`, `options`, `help`, `max` |
| `body`          | Paragrafi del testo, con i segnaposto                                                                           |
| `signature`     | Riga sotto lo spazio della firma                                                                                |

## Segnaposto

- Paziente: `{{paziente.cognome}}`, `{{paziente.nome}}`, `{{paziente.sesso}}`, `{{paziente.nato_a}}`, `{{paziente.nato_il}}`, `{{paziente.codice_fiscale}}`, `{{paziente.residenza}}`.
- Medico: `{{medico.nome_cognome}}`, `{{medico.codice_fiscale}}`, `{{medico.codice_regionale}}`.
- Rilascio: `{{rilascio.luogo}}`, `{{rilascio.data}}`.
- Campi del modello: `{{campo.<key>}}`; le date si stampano come GG/MM/AAAA.
