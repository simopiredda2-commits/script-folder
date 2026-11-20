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

| Fonte                                                                                                                                                                                 | Che cosa ne ho preso                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DM 7 settembre 2023, «Fascicolo sanitario elettronico 2.0» (GU n. 249 del 24/10/2023), sulla Gazzetta Ufficiale                                                                       | Art. 4 (PSS), 6 (dati a maggiore tutela), 8 (consensi), 9 (oscuramento), 11, 12 (chi alimenta il Fascicolo, entro 5 giorni), 13 (validazione e firma), 16; allegato A, paragrafo 2.7 (contenuti del PSS) e 4.1 (profili di accesso)                                                                                                                                                                                                                                                                                                                           |
| DM 11 novembre 2025 (GU n. 286 del 10/12/2025)                                                                                                                                        | Modifica gli art. 22 (notifiche) e 27-bis (fasi: 30/6/2025, 31/12/2025, 31/3/2026) e l'allegato D; non tocca gli art. 4, 8 e 9                                                                                                                                                                                                                                                                                                                                                                                                                                |
| DM 27 giugno 2025, «Indicazioni attuative per la definizione dei contenuti informativi del Profilo sanitario sintetico» (GU n. 202 del 1/9/2025)                                      | Allegato 1: per ogni dato, obbligatorio o facoltativo, da dove può arrivare, che cosa sarà compilabile solo con i servizi dell'Ecosistema dati sanitari (EDS). La tabella è stampata con un carattere codificato: l'ho decodificata e riletta riga per riga                                                                                                                                                                                                                                                                                                   |
| Ministero della salute, repository pubblico `ministero-salute/it-fse-support` su GitHub: `README.md` e `doc/accreditamento/README.md`                                                 | Gateway: certificati X.509 di autenticazione e di firma (Sogei), validazione dei CDA, pubblicazione; accreditamento in tre fasi                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Stesso repository, `doc/integrazione-gateway/README.md`, versione 2.26 del 30/10/2026 (tappa 11)                                                                                      | Servizi del Gateway (validazione, pubblicazione, sostituzione, eliminazione, stato), i due token JWT e i loro campi, gli errori (RFC 7807), le tabelle dei valori (16.3) e la correlazione tra tipo di documento e classe (16.4)                                                                                                                                                                                                                                                                                                                              |
| Stesso repository, `doc/middleware-regionale`, `doc/faq`, `doc/esempi/CDA/PSS.xml` (tappa 11)                                                                                         | Una Regione può mettere un suo nodo tra il programma e il Gateway, con le stesse interfacce; si valida prima di firmare; documento PDF con il CDA dentro, firmato PAdES; esempio di PSS che passa la validazione                                                                                                                                                                                                                                                                                                                                              |
| Repository pubblico `ministero-salute/it-fse-catalogs`, commit `25b7b6b` (tappa 11)                                                                                                   | Lo schematron del PSS (versione 4.0) e i dizionari dei codici con cui il Gateway controlla i documenti. Copiati in `packages/integrations/fse-ufficiale/` (D131)                                                                                                                                                                                                                                                                                                                                                                                              |
| DGR Regione Piemonte 1 dicembre 2025, n. 19-1912 (BU 49S2 del 4/12/2025) (tappa 11)                                                                                                   | Il Piemonte usa il Gateway nazionale centralizzato (nota della Direzione sanità del 4/7/2025 al Dipartimento per la trasformazione digitale)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| DM 7 settembre 2023, art. 20 (tappa 11)                                                                                                                                               | Accesso in emergenza: chi cura un paziente che non può esprimere il consenso legge per primo il PSS, mai i dati oscurati                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| CSI Piemonte, «Modulo regionale di accesso semplificato dalle CCE – Specifiche di integrazione dei servizi di accesso», V03, settembre 2019 (sistemapiemonte.it), letto il 20/11/2026 | Per aprire il Fascicolo del paziente nella pagina regionale dei medici direttamente dalla cartella: servizio SOAP `getAuthentication` con le credenziali RUPAR del medico, il ruolo e il codice fiscale del paziente; controlla consenso e presenza nel Fascicolo e dà un token da usare una volta nell'indirizzo della pagina; TLS 1.2 con certificato X.509 del fornitore, accesso consentito su richiesta scritta. Non riguarda l'invio del PSS. Del 2019: con l'autenticazione forte di oggi (D102, D109) va chiesto al CSI se vale ancora. Non costruito |

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

## Che cosa si è chiarito per la tappa 11

- **In Piemonte**: la Regione usa il Gateway nazionale centralizzato (DGR 19-1912/2025). Le specifiche ammettono un nodo regionale tra il programma e il Gateway, con le stesse interfacce: l'indirizzo del servizio è un'impostazione, non un valore scritto nel codice.
- **Codifiche** (dallo schematron 4.0 e dai dizionari ufficiali):
  - problemi in ICD-9-CM;
  - organi mancanti con il dizionario ICD-10 «Organi mancanti»;
  - farmaci in AIC con l'ATC come traduzione;
  - allergeni non farmaci con il dizionario «Allergeni (No Farmaci)», dove ci sono anche i veleni di vespa e d'api;
  - parentela con RoleCode HL7;
  - capacità motoria con il suo dizionario (autonomo, assistito, allettato, su sedia a rotelle);
  - vie di somministrazione con HL7 RouteOfAdministration.
- **Sezioni obbligatorie del documento**: allergie e intolleranze, terapie farmacologiche, lista dei problemi, anamnesi familiare. Se una sezione non ha dati si scrive l'assenza con i codici ufficiali («nessuna allergia nota», «nessuna informazione»), mai una sezione vuota.
- **Oscuramento**: nel documento non entrano le voci oscurate (art. 4, c. 3). L'oscuramento di un documento intero si segnala con il codice P99 nei metadati della pubblicazione. Per il PSS ci sono anche il codice P81 («Versioni precedenti Profilo Sanitario Sintetico») e la riservatezza del documento (N, R o V).
- **Flusso**: si valida prima di firmare. Poi si firma PAdES e si pubblica; il Gateway risponde «preso in carico» e manda i dati a INI ed EDS. La pubblicazione è rifiutata se il documento ha più di 5 giorni.

## Che cosa è costruito (tappa 11)

Il Profilo si compone dalla cartella. Il medico lo controlla, lo valida, lo firma e lo pubblica nel simulatore del Gateway; poi lo stato della transazione conferma l'invio a INI. Le scelte sono in `docs/decisioni.md` (D130–D141); che cosa manca e che cosa non è stato provato, in `docs/avanzamento.md`.

## Ancora da leggere

- La guida HL7 Italia del PSS: il sito di HL7 Italia non si raggiunge da qui. Le regole da rispettare sono nello schematron ufficiale, che il simulatore applica (D132).
- Le note tecniche sul PSS del portale del Fascicolo: sito non raggiungibile da qui.
- Il DM 30/12/2024 (GU n. 33 del 10/2/2025) e il paragrafo 5.2 del DM 31/12/2024 sull'EDS: riguardano fasi e servizi dell'EDS, non servono a costruire la tappa 11.
- Con la Regione, durante l'accreditamento: gli identificativi (OID) dei documenti e del repository, il custode del documento, la struttura del medico nel formato XON e l'uso del codice P81.
