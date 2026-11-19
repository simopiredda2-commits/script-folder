# AURA, l'anagrafe regionale degli assistiti

Collegamento del programma con AURA, l'anagrafe regionale degli assistiti del Piemonte (CSI Piemonte), per le esenzioni e le scelte del medico (D197). Oggi è un **simulatore**: il programma non chiama AURA (regola 7).

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
2. Ogni notte, all'ora di `AURA_AGGIORNAMENTO`, se c'è: tutti i pazienti attivi del servizio.
3. Dal pannello dei dati amministrativi, con «Aggiorna da AURA». Il pulsante lo ha chi scrive nell'archivio, cioè medico e segreteria.
4. Prima dei controlli di una ricetta con esenzione, se l'ultimo allineamento ha più di dieci minuti. Si aspetta al massimo tre secondi: se AURA non risponde valgono i dati che ci sono, e il SAR controlla comunque all'invio.

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

**Risposte che non tornano.** Se AURA risponde con un profilo che ha un altro codice fiscale, nulla cambia: il collegamento si azzera e al controllo dopo il paziente si cerca di nuovo. Senza rete i dati restano quelli di prima, con il motivo.

**Variazioni.** Ogni variazione resta in parole, con quando e da dove è partito il controllo, e non si modifica né si cancella.

- Nel pannello del paziente si vedono le ultime venti.
- Nella pagina Oggi si vedono quelle degli ultimi sette giorni, dei pazienti che l'utente può vedere.

**Registro degli accessi.**

- Ci va ogni controllo chiesto da una persona, riuscito o negato.
- Ci va ogni variazione arrivata da AURA, anche dalla notifica o dal giro di notte.
- Ci va ogni lettura delle variazioni nella pagina Oggi, una riga per paziente mostrato.
- Non ci vanno i controlli senza variazioni della notte e delle notifiche: non leggono e non cambiano nulla, e sarebbero una riga per paziente ogni notte.

**Storico.** Il collegamento ha lo storico quando cambia lo stato (identificativo, esito, motivo), non a ogni controllo.

**Stato del servizio.** L'amministratore dello studio vede il prossimo giro e l'ultimo, con i numeri dei soli pazienti del suo studio: quanti controllati, quanti con variazioni, quanti non riusciti.

**In produzione con il simulatore AURA è spenta**, perché i dati del simulatore non sono veri. Il pannello lo dice, e esenzioni e scelte si inseriscono a mano.

## Modello dei dati

| Tabella                       | Contenuto                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `aura_link`                   | Una riga per paziente: identificativo AURA, ultimo controllo, esito e motivo, ultimo allineamento     |
| `aura_change`                 | Variazioni arrivate: esenzione o scelta, nuova, cambiata o tolta, in parole; non si modificano        |
| `aura_sync_run`               | Giri di controllo di tutti i pazienti: quando, quanti, con quale messaggio                            |
| `aura_sync_run_studio`        | Gli stessi giri, studio per studio: lo stato del servizio di uno studio mostra solo i suoi numeri     |
| `exemption`, `patient_choice` | In più: annullamento con data, autore e motivo (vincolo: data e motivo insieme), riga annullata ferma |

Migrazioni 0032 e 0033. `aura_link` e `aura_change` entrano nell'esportazione dei dati del medico.

## Configurazione

- `AURA_AGGIORNAMENTO=02:30`: ora del controllo di ogni notte, ora di Roma. Senza, nessun giro notturno: restano le notifiche, il pulsante e il controllo prima della ricetta.

## Il simulatore

- È un'anagrafe in memoria, con soli assistiti inventati.
- Le modifiche fatte con i suoi metodi (come le farebbe un'ASL) mandano una notifica.
- Si può rendere irraggiungibile, per provare il programma senza rete.
- Nel programma di prova parte vuoto: «Aggiorna da AURA» risponde «Non trovato in AURA». Le prove lo riempiono con assistiti inventati.

## Come provarlo

```sh
pnpm exec vitest run apps/api/test/aura.test.ts apps/web/test/aura.test.tsx
pnpm exec vitest run apps/api/test/e2e/interfaccia.test.ts   # nel browser, con l'accessibilità
```

## Che cosa non è provato

- **Il servizio vero**: nomi dei campi, formati, codici degli eventi, firma delle notifiche e rete RUPAR vengono dalle specifiche AURA--SER-01, ancora da avere.
- **Volumi**: un giro di notte su migliaia di pazienti, uno alla volta. I tempi vanno misurati con il servizio vero; il CSI potrebbe offrire una ricerca per molti assistiti insieme.
- **Anagrafica**: AURA la manda (indirizzo, ASL, decesso), ma il programma oggi allinea solo esenzioni e scelte. È una domanda per la fermata, come lo stato del paziente quando AURA dice che la scelta è cessata.
- **Scrittura**: il programma non scrive in AURA, perché scelte e revoche le registra l'ASL.
