# AURA, l'anagrafe regionale degli assistiti

Collegamento del programma con AURA, l'anagrafe regionale degli assistiti del Piemonte (CSI Piemonte), per le esenzioni, le scelte del medico (D197), lo stato del paziente e l'anagrafica (D198). Oggi è un **simulatore**: il programma non chiama AURA (regola 7).

## Fonti

- **Requisiti** (`docs/requisiti.md`): «Scelte e revoche, esenzioni: sincronizzate con l'anagrafe regionale (AURA)». Nella tabella dei collegamenti, AURA è un web service SOAP/XML, previsto nella prima versione. I servizi in tempo reale «si interrogano al momento».
- **Manuale pubblico dei servizi di cooperazione**, AURA--ORG-01-V08 ([servizi.regione.piemonte.it/media/786](https://servizi.regione.piemonte.it/media/786/download)). Descrive tre servizi:
  - ricerca «massiva» dei profili (FIND) per codice fiscale e altri dati, che dà gli identificativi AURA;
  - ricerca puntuale del profilo sanitario completo (GET) per identificativo AURA;
  - notifiche delle variazioni a un servizio dell'ente, per gli eventi sottoscritti presso il CSI. Nel servizio vero arrivano su un web service esposto sulla rete RUPAR, firmate con il certificato di AURA.
- **Da avere dal CSI**: le specifiche di dettaglio (documenti AURA--SER-01, con WSDL e XSD), l'ambiente di prova, l'accesso alla RUPAR e gli eventi da sottoscrivere. Simone le ha chieste con la PEC del 19/11/2026, mandata al CSI e in copia alla Regione.

## Che cosa fa il programma

**Collegamento.** Per ogni paziente il programma tiene l'identificativo AURA, trovato con il codice fiscale.

- Se AURA non trova nessuno, il motivo resta e al controllo dopo si cerca di nuovo.
- Se trova più persone con lo stesso codice fiscale, nulla cambia e il motivo dice di chiarire con l'ASL.

**Quando si controlla.**

1. A ogni notifica di variazione da AURA.
2. Ogni notte, all'ora di `AURA_AGGIORNAMENTO`, se c'è: tutti i pazienti in carico e i temporanei del servizio (D199), e i revocati già collegati ad AURA (così un ritorno si vede anche senza notifica).
3. Dal pannello dei dati amministrativi, con «Aggiorna da AURA». Il pulsante lo ha chi scrive nell'archivio, cioè medico e segreteria.
4. Prima dei controlli di una ricetta con esenzione, se l'ultimo allineamento ha più di dieci minuti. Si aspetta al massimo tre secondi: se AURA non risponde valgono i dati che ci sono, e il SAR controlla comunque all'invio.

Un controllo alla volta per paziente (D198): ogni controllo prende un blocco nel database e legge AURA dentro il blocco. Due notifiche vicine non registrano due volte la stessa variazione, e un profilo letto prima non annulla uno letto dopo.

**Allineamento.** AURA è la fonte delle sue righe:

| In AURA                                  | Nella cartella                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| Esenzione o scelta nuova                 | Riga nuova con la fonte «AURA»                                                               |
| Scadenza, cessazione o codice in ricetta | Riga aggiornata                                                                              |
| Esenzione o scelta tolta                 | Riga **annullata** con il motivo «Non c'è più in AURA»: non si cancella, resta nello storico |
| Righe inserite a mano                    | Non si toccano mai                                                                           |

- Le esenzioni si riconoscono per codice e data d'inizio, le scelte per medico e data.
- Le righe arrivate da AURA non si modificano dal pannello.
- Una riga annullata non si modifica più. Non vale per la regola R9 né per il pannello e l'importazione, ma resta nello storico e nell'esportazione.

**Scelte del medico.** Entrano solo quelle dei medici dello studio, riconosciuti dal codice fiscale del profilo medico. Le scelte di altri medici, anche di altri studi dello stesso servizio, non entrano.

**Stato del paziente** (D198), secondo le scelte del titolare dell'archivio arrivate da AURA:

- scelta cessata e nessuna in corso: il paziente passa a «revocato», da solo;
- di nuovo una scelta in corso: torna «in carico», da solo;
- scelte di altri medici o scritte a mano: lo stato non cambia;
- pazienti deceduti o temporanei: non si toccano.

Ogni cambio di stato è una variazione in parole.

**Anagrafica da confermare** (D198). AURA manda residenza (via, numero civico, CAP, comune, provincia), domicilio, ASL, distretto e decesso. Non entrano da soli nella cartella: il pannello di AURA mostra le differenze con la cartella.

- **Che cosa conta come differenza.** Maiuscole, minuscole e spazi non contano. Un campo vuoto in AURA non propone di svuotare quello della cartella.
- **Chi decide.** Medico o segreteria scelgono, per ogni differenza, se usare il dato di AURA o tenere quello della cartella. Il dato di AURA passa per gli stessi controlli del pannello amministrativo, e il registro scrive la fonte «AURA».
- **Un dato tenuto non si ripropone**, finché AURA non ne manda un altro.
- **Risposte su dati superati.** Si risponde solo alle differenze di adesso, con il valore visto: se AURA nel frattempo ha cambiato, il programma chiede di ricaricare.
- **Decesso.** Si segnala anche nella pagina Oggi, in evidenza, e si conferma dal pannello: una data nel futuro è rifiutata.
- **Identità.** Cognome, nome e nascita non arrivano da AURA: si correggono con un motivo, dal pannello.

**Nuovi assistiti** (D199). Chi ha scelto un medico dello studio e non è ancora nel suo archivio compare nella pagina Oggi, in «Nuovi assistiti in AURA».

- **Quando.** Alla notifica di una scelta, e a ogni notifica di chi è già fra i nuovi, il programma legge il profilo. Conta la scelta che vale oggi o più avanti, con un medico titolare di uno studio del servizio, riconosciuto dal codice fiscale.
- **Se il paziente c'è già** nello studio (stesso codice fiscale), si collega e si allinea, senza elenco.
- **Chi lo vede.** Chi può registrare pazienti nell'archivio del medico scelto: il titolare, il sostituto autorizzato, la segreteria. Il codice fiscale si vede mascherato.
- **«Registra».** Un clic crea il paziente nell'archivio del medico, con i controlli di «Nuovo paziente»:
  - cognome, nome e nascita da AURA; sesso e luogo di nascita dal codice fiscale, omocodia compresa;
  - residenza, domicilio, ASL e distretto di AURA che passano i controlli del pannello (gli altri si vedono dopo come differenze da confermare);
  - stato «temporaneo» se la scelta ha una scadenza.

  Subito dopo il collegamento con AURA porta esenzioni e scelte. Due clic insieme fanno un paziente solo; un paziente registrato a mano nel frattempo si dice, con il collegamento alla sua cartella.

- **«Non registrare».** L'assistito esce dall'elenco e non si ripropone finché AURA non manda una scelta nuova (altro medico o altra data).
- **Esce dall'elenco da solo** quando la scelta non vale più, o AURA dice il decesso.

**Cambio di medico dentro lo studio** (D200). Il paziente sceglie in AURA un altro medico dello studio, titolare di un altro archivio. Si prova anche nella dimostrazione, con la collega dello studio dimostrativo (D227).

- **Quando.** A ogni controllo con AURA, dopo l'allineamento dello stato: conta la scelta di AURA che vale oggi, la più recente. Nell'archivio di prima il paziente risulta revocato (D198) finché non si decide.
- **Chi decide.** Solo il titolare dell'archivio dove il paziente sta (permesso `archive.transfer`): non il sostituto né il collega di gruppo con l'autorizzazione, non la segreteria, non l'amministratore. Ogni no si registra.
- **In Oggi**, sezione «Cambi di medico nello studio»:
  - il titolare di prima vede il paziente, il medico scelto e da quando, con «Sposta» e «Non spostare»;
  - il medico scelto vede chi l'ha scelto e da quando, e chi decide; senza collegamento alla cartella, che non è nel suo archivio.
- **«Sposta».** Il paziente passa nell'archivio del medico scelto con la cartella intera e lo storico, e lo stato si riallinea con la scelta del nuovo titolare (di nuovo in carico). Si sposta solo il cambio visto: se AURA nel frattempo ha cambiato la scelta, si ricarica. Non si sposta:
  - con ricette in bozza, da firmare, in invio o con un errore d'invio, o certificati in bozza, in invio o con un errore d'invio: il programma li elenca, si chiudono prima;
  - mentre un controllo con AURA lavora sullo stesso paziente: chi clicca non aspetta, e lo si dice;
  - due volte.
- **«Non spostare».** Il paziente resta nell'archivio di prima e il cambio non si ripropone finché AURA non manda una scelta nuova (altro medico o altra data).
- **La proposta decade** quando la scelta non vale più, quando il paziente torna dal titolare di prima, o quando è deceduto.
- **Dopo lo spostamento** ricette e certificati di prima restano nello storico del paziente. Un'importazione fatta nell'archivio di prima non si annulla più per intero se ha scritto dati del paziente spostato.
- **Storico degli spostamenti** (D240): ogni «Sposta» resta nella tabella `patient_archive_move`, con il giorno, i due archivi, chi l'ha fatto e il cambio di AURA. Non si modifica e non si cancella. Dice chi aveva il paziente in un giorno: una prestazione aggiuntiva eseguita prima dello spostamento va nella distinta dell'archivio di prima, anche se la si registra dopo (`docs/ppip.md`).

**Risposte che non tornano.** Se AURA risponde con un profilo che ha un altro codice fiscale, nulla cambia: il collegamento si azzera e al controllo dopo il paziente si cerca di nuovo. Senza rete i dati restano quelli di prima, con il motivo.

**Variazioni.** Ogni variazione resta in parole, con quando e da dove è partito il controllo, e non si modifica né si cancella.

- Nel pannello del paziente si vedono le ultime venti.
- Nella pagina Oggi si vedono quelle degli ultimi sette giorni e le anagrafiche da confermare (il decesso per primo), dei pazienti che l'utente può vedere.

**Registro degli accessi.**

- Ci va ogni controllo chiesto da una persona, riuscito o negato.
- Ci va ogni variazione arrivata da AURA, anche dalla notifica o dal giro di notte.
- Ci va ogni lettura delle variazioni nella pagina Oggi, una riga per paziente mostrato.
- Ci va ogni scelta su una differenza di anagrafica: dato di AURA usato (con la fonte) o tenuto quello della cartella.
- Ci va ogni lettura dei nuovi assistiti, ogni registrazione (con la fonte «AURA») e ogni «Non registrare», e ogni tentativo negato (D199).
- Ci va ogni lettura dei cambi di medico in Oggi, una riga per paziente mostrato, ogni spostamento e ogni «Non spostare», e ogni tentativo negato (D200).
- Non ci vanno i controlli senza variazioni della notte e delle notifiche: non leggono e non cambiano nulla, e sarebbero una riga per paziente ogni notte.

**Storico.** Il collegamento ha lo storico quando cambia lo stato (identificativo, esito, motivo), non a ogni controllo.

**Stato del servizio.** L'amministratore dello studio vede il prossimo giro e l'ultimo, con i numeri dei soli pazienti del suo studio: quanti controllati, quanti con variazioni, quanti non riusciti.

**In produzione con il simulatore AURA è spenta**, perché i dati del simulatore non sono veri. Il pannello lo dice, e esenzioni e scelte si inseriscono a mano.

## Modello dei dati

| Tabella                       | Contenuto                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aura_link`                   | Una riga per paziente: identificativo AURA, ultimo controllo, esito e motivo, ultimo allineamento; anagrafica ricevuta e valori tenuti dalla cartella (D198)                                                                           |
| `aura_change`                 | Variazioni arrivate: esenzione, scelta, anagrafica o stato; nuova, cambiata o tolta, in parole; non si modificano                                                                                                                      |
| `aura_sync_run`               | Giri di controllo di tutti i pazienti: quando, quanti, con quale messaggio                                                                                                                                                             |
| `aura_sync_run_studio`        | Gli stessi giri, studio per studio: lo stato del servizio di uno studio mostra solo i suoi numeri                                                                                                                                      |
| `exemption`, `patient_choice` | In più: annullamento con data, autore e motivo (vincolo: data e motivo insieme), riga annullata ferma                                                                                                                                  |
| `aura_new_patient`            | Nuovi assistiti (D199): una riga per studio e assistito, con l'archivio del medico, la scelta, l'anagrafica di AURA e lo stato; storico, nessuna cancellazione                                                                         |
| `aura_doctor_change`          | Cambi di medico dentro lo studio (D200): una riga per paziente, con l'archivio di prima, quello del medico scelto, la scelta, lo stato (da decidere, spostato, non spostato, superato) e chi ha deciso; storico, nessuna cancellazione |

Migrazioni 0032, 0033, 0034, 0035 e 0036. `aura_link`, `aura_change` e `aura_doctor_change` entrano nell'esportazione dei dati del medico con i pazienti, `aura_new_patient` con l'archivio.

## Configurazione

- `AURA_AGGIORNAMENTO=02:30`: ora del controllo di ogni notte, ora di Roma. Senza, nessun giro notturno: restano le notifiche, il pulsante e il controllo prima della ricetta.

## Il simulatore

- È un'anagrafe in memoria, con soli assistiti inventati.
- Le modifiche fatte con i suoi metodi (come le farebbe un'ASL) mandano una notifica.
- Si può rendere irraggiungibile, per provare il programma senza rete.
- Nel programma di prova parte vuoto: «Aggiorna da AURA» risponde «Non trovato in AURA». Le prove lo riempiono con assistiti inventati.

## Come provarlo

```sh
pnpm exec vitest run apps/api/test/aura.test.ts apps/api/test/aura-anagrafica.test.ts apps/api/test/aura-nuovi-assistiti.test.ts apps/api/test/aura-cambio-medico.test.ts apps/web/test/aura.test.tsx
pnpm exec vitest run apps/api/test/e2e/interfaccia.test.ts   # nel browser, con l'accessibilità
```

## Che cosa non è provato

- **Il servizio vero**: nomi dei campi, formati, codici degli eventi, firma delle notifiche e rete RUPAR vengono dalle specifiche AURA--SER-01, ancora da avere.
- **Volumi**: un giro di notte su migliaia di pazienti, uno alla volta. I tempi vanno misurati con il servizio vero; il CSI potrebbe offrire una ricerca per molti assistiti insieme.
- **Scadenza delle scelte a tempo determinato**: lo stato del paziente segue solo la cessazione; la scadenza conta alla ricetta (R20, D199) e per i nuovi assistiti. Come AURA tratta la scadenza va letto nelle specifiche.
- **Nuovi assistiti senza notifica**: il giro di notte non li trova, perché servirebbe l'elenco degli assistiti di un medico, se le specifiche lo danno.
- **Cambio di medico dentro lo studio senza il titolare di prima**: lo spostamento lo decide il titolare (scelta di Simone, D200). Se il titolare non c'è (malattia, ferie) lo spostamento aspetta, perché il sostituto non può farlo; per Simone non è un problema, perché intanto il sostituto lavora sui pazienti con la sua utenza (fermata dopo l'unione della #14).
- **Scrittura**: il programma non scrive in AURA, perché scelte e revoche le registra l'ASL.
