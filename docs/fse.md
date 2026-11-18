# Fascicolo Sanitario Elettronico 2.0 e Profilo Sanitario Sintetico

Documento preparato durante le tappe 9 e 10 (D110), per decidere alla fermata finale le tappe 11 (Profilo Sanitario Sintetico con un simulatore del Gateway) e 12 (condivisione tra i medici dell'AFT). Fonti lette il 18/11/2026; quello che non ho letto è scritto in fondo.

## In breve

- **Che cos'è il Profilo Sanitario Sintetico (PSS)**: il riassunto della storia clinica del paziente e della sua situazione attuale. Lo scrive e lo aggiorna il medico di famiglia. Serve a chi incontra il paziente per la prima volta, anche in emergenza (DM 7/9/2023, art. 4).
- **È già dovuto**: il decreto del 2025 sui contenuti voleva il PSS di tutti i medici di famiglia entro il 30 settembre 2025. Un programma per medici di famiglia che non lo produce non basta allo studio.
- **Che cosa contiene**: un elenco fissato dal decreto, con dati obbligatori e facoltativi. Obbligatori: allergie e reazioni avverse, patologie croniche, terapie croniche prescritte dal medico, anamnesi familiare, organi mancanti, trapianti, malformazioni. Facoltativi: peso, altezza, BMI, pressione, fattori di rischio. I dati anagrafici arrivano dall'Anagrafe nazionale degli assistiti. Tabella sotto.
- **Dati oscurati**: le voci che il paziente ha chiesto di oscurare non devono mai essere visibili ad altri tramite il PSS (art. 4, c. 3; art. 9). Il programma le segna già (D116) e le terrà fuori.
- **Come arriva nel Fascicolo**: il programma produce un documento nel formato nazionale (CDA2 di HL7 Italia), lo mette in un PDF firmato con firma PAdES, lo fa validare dal Gateway nazionale e poi lo pubblica. Il collegamento usa certificati rilasciati da Sogei.
- **Prima di usarlo con pazienti veri**: il programma va accreditato. Sono tre fasi con Sogei, Agenas e la Regione, e ci sono impegni del fornitore (SCRIPT). È una decisione di Simone, non una cosa che posso fare io.
- **Consensi**: per consultare il Fascicolo serve il consenso del paziente, dato separatamente per finalità; la verifica la fa il Fascicolo (art. 8, c. 11). In cartella resta quello che il paziente ha espresso in studio (D115).

## Fonti lette

| Fonte                                                                                                                                            | Che cosa ne ho preso                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DM 7 settembre 2023, «Fascicolo sanitario elettronico 2.0» (GU n. 249 del 24/10/2023), sulla Gazzetta Ufficiale                                  | Art. 4 (PSS), 6 (dati a maggiore tutela), 8 (consensi), 9 (oscuramento), 11, 12 (chi alimenta il Fascicolo, entro 5 giorni), 13 (validazione e firma), 16; allegato A, paragrafo 2.7 (contenuti del PSS) e 4.1 (profili di accesso)                         |
| DM 11 novembre 2025 (GU n. 286 del 10/12/2025)                                                                                                   | Modifica gli art. 22 (notifiche) e 27-bis (fasi: 30/6/2025, 31/12/2025, 31/3/2026) e l'allegato D; non tocca gli art. 4, 8 e 9                                                                                                                              |
| DM 27 giugno 2025, «Indicazioni attuative per la definizione dei contenuti informativi del Profilo sanitario sintetico» (GU n. 202 del 1/9/2025) | Allegato 1: per ogni dato, obbligatorio o facoltativo, da dove può arrivare, che cosa sarà compilabile solo con i servizi dell'Ecosistema dati sanitari (EDS). La tabella è stampata con un carattere codificato: l'ho decodificata e riletta riga per riga |
| Ministero della salute, repository pubblico `ministero-salute/it-fse-support` su GitHub: `README.md` e `doc/accreditamento/README.md`            | Gateway: certificati X.509 di autenticazione e di firma (Sogei), validazione dei CDA, pubblicazione; accreditamento in tre fasi                                                                                                                             |

## Che cosa contiene il PSS e dove sta nel programma

Obbligatorietà dall'allegato 1 del DM 27/6/2025. «EDS» vuol dire: compilabile solo quando ci saranno i servizi dell'Ecosistema dati sanitari, in alcuni casi anche dopo un aggiornamento del decreto del 2023.

| Contenuto                                                                                          | Nel decreto del 2025                                                   | Nel programma oggi                                                      |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Cognome, nome, codice fiscale del paziente                                                         | Obbligatori                                                            | Anagrafe                                                                |
| Sesso, nascita, domicilio, residenza, recapiti, ID ANPR                                            | Resi disponibili dall'Anagrafe nazionale assistiti, dal codice fiscale | Anagrafe (in parte); ANA non collegata                                  |
| Caregiver                                                                                          | Facoltativo                                                            | Non c'è (le deleghe sono un'altra cosa)                                 |
| Cognome, nome, codice fiscale, telefono, email e PEC del medico                                    | Obbligatori                                                            | Codice fiscale sì; telefono, email e PEC del medico da aggiungere       |
| Capacità motoria                                                                                   | Alla prima compilazione, poi se cambia                                 | Non c'è                                                                 |
| Attuale situazione clinica                                                                         | Obbligatoria, limitatamente alle patologie croniche                    | Problemi; manca l'indicazione «cronico»                                 |
| Organi mancanti, trapianti, rilevanti malformazioni                                                | Obbligatori                                                            | Non ci sono come voci a sé                                              |
| Reazioni avverse a farmaci o alimenti                                                              | Obbligatorie, alla prima compilazione e poi aggiornate                 | Allergie e reazioni (solo «da farmaco» sì o no)                         |
| Allergie cutanee, respiratorie o sistemiche                                                        | Obbligatorie                                                           | Allergie, senza il tipo                                                 |
| Allergie a veleno di imenotteri                                                                    | Obbligatorie                                                           | Allergie, senza il tipo                                                 |
| Protesi e impianti permanenti                                                                      | Alla prima compilazione, se osservati                                  | Non ci sono                                                             |
| Ausili                                                                                             | Facoltativi                                                            | Presidi (in parte)                                                      |
| Terapie croniche, con attenzione a TAO e insulina                                                  | Obbligatorie, limitatamente a quelle prescritte dal medico di famiglia | Terapie croniche                                                        |
| Anamnesi familiare                                                                                 | Obbligatoria                                                           | Anamnesi, sezione familiare                                             |
| Fattori di rischio (fumo, alcol, sostanze)                                                         | Facoltativi                                                            | Stili di vita                                                           |
| Patologie in atto, codificate                                                                      | Obbligatorie, limitatamente alle croniche                              | Problemi in ICD-9-CM; manca «cronico»                                   |
| Altezza, peso, BMI, ultima pressione                                                               | Facoltativi                                                            | Parametri                                                               |
| Esenzioni per patologia                                                                            | Dall'Anagrafe nazionale assistiti                                      | Esenzioni                                                               |
| Tutte le terapie in atto, vaccinazioni, gravidanze e parti                                         | EDS                                                                    | Terapie sì; vaccinazioni e gravidanze nel modello, non nell'interfaccia |
| Donazione degli organi, ADI, ADP, reti di patologia, piani di cura, trattamenti, visite e ricoveri | Aggiornamento del decreto ed EDS                                       | Non ci sono                                                             |

Il BMI è tra i dati facoltativi del PSS: è un dato in più per la domanda della fermata su BMI scritto o calcolato (D113).

## Come arriva nel Fascicolo

1. **Compilazione**: il programma propone i dati dalla cartella, senza le voci oscurate; il medico li controlla e li completa. Il decreto del 2025 prevede anche un servizio nazionale di supporto alla compilazione (EDS), «previa verifica da parte del medico».
2. **Documento**: CDA2 secondo le specifiche HL7 Italia, controllato con gli schematron e i dizionari pubblicati dal Ministero; inserito in un PDF e firmato in formato PAdES.
3. **Validazione e pubblicazione al Gateway**: il servizio `/v1/documents/validation`, poi la pubblicazione. Si autentica con un token JWT e una firma del token, con certificati X.509 rilasciati da Sogei.
4. **Indicizzazione**: il documento è registrato tramite INI (art. 13, c. 3). La Regione o l'ASL è titolare della conservazione del PSS (art. 4, c. 5).
5. **Aggiornamenti**: il medico lo aggiorna quando cambia qualcosa. Se il paziente cambia medico, il nuovo ne scrive uno nuovo e i precedenti restano consultabili (art. 4, c. 6 e 7).

## Accreditamento del programma

Dal processo pubblicato dal Ministero (`doc/accreditamento/README.md`):

1. **Accreditamento** negli ambienti di test del fornitore, con certificati di test chiesti a Sogei, solo con i codici fiscali fittizi della lista del Ministero. Si controllano: CDA conformi a HL7 Italia, schematron e dizionari; firma PAdES; chiamata giusta del servizio di validazione. Richiesta con il modulo di Agenas e una dichiarazione di presa di responsabilità del fornitore; esiti in un repository del Ministero; valuta Sogei.
2. **Verifica tecnica** presso la Regione o l'Azienda, a loro discrezione.
3. **Produzione** con un periodo di monitoraggio.

Sono passi esterni e con impegni di SCRIPT come fornitore: li decide e li fa Simone.

## Che cosa farebbe la tappa 11 (proposta)

- Completare il modello dei dati per il PSS:
  - indicazione «cronico» sui problemi;
  - tipo dell'allergia;
  - organi mancanti, trapianti, malformazioni, protesi e impianti;
  - capacità motoria;
  - telefono, email e PEC del medico.
- Comporre il PSS dalla cartella, senza le voci oscurate, con la verifica del medico; versioni conservate.
- Produrre il CDA2 secondo la guida HL7 Italia e controllarlo in locale con gli schematron del Ministero (da leggere: licenza e versione), poi il PDF con il CDA e la firma PAdES (simulata nelle prove).
- Un simulatore del Gateway, per validazione e pubblicazione con JWT, con risposte positive, errori e assenza di rete, come per SAR e Sistema TS. Ogni invio registrato.
- Nessuna chiamata a servizi veri (regola 7) e nessun dato reale (regola 1); i codici fiscali delle prove restano inventati.

## Tappa 12: condivisione nell'AFT (da progettare)

Condividere la cartella tra i medici dell'AFT che usano il programma: le voci oscurate mai; le riservate solo al medico titolare; la base giuridica e le regole dell'AFT vanno lette sull'accordo collettivo nazionale e sugli atti regionali prima di costruire. Con gli altri programmi solo formati pubblici (D104).

## Da verificare prima della tappa 11

- **Non letti**:
  - il DM 30/12/2024 (art. 27-bis e allegato D: fasi e scadenze);
  - il DM 31/12/2024 sull'Ecosistema dati sanitari (GU n. 53 del 5/3/2025), paragrafo 5.2;
  - le note tecniche per la gestione del PSS pubblicate sul portale del Fascicolo;
  - la guida HL7 Italia del PSS;
  - le specifiche OpenAPI del Gateway;
  - l'art. 20 del DM 2023 (accesso in emergenza).
- **In Piemonte**: se i medici pubblicano dal Gateway nazionale o dal sistema regionale (CSI Piemonte), e con quali credenziali.
- **Codifiche**: quali sistemi di codici vuole il CDA del PSS per patologie, allergie e farmaci (oggi in cartella: ICD-9-CM e AIC).
- **Oscuramento e dati a maggiore tutela** (art. 6 e art. 12, c. 4): come si segnalano nel documento.
