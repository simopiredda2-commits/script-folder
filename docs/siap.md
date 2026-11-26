# SIAP, Sistema Informativo dell'Assistenza Primaria

Richiesta di Simone del 25/11/2026: documenti, confronto dei tracciati con i dati che il programma registra già, e una domanda per la fermata. **Niente è costruito**: questo documento serve a decidere se e quando fare il modulo.

## Che cos'è

Il SIAP raccoglie le attività dei medici di medicina generale e dei pediatri di libera scelta, con quelle della continuità assistenziale e dell'assistenza ai turisti. Lo istituisce il DM Salute del 4 agosto 2025 (GU n. 202 dell'1/9/2025, codice 25A04813, pagina 5). Sul decreto c'è un comunicato nella GU n. 226 del 29/9/2025 (25A05298).

- **Chi manda che cosa.** Le cartelle cliniche dei medici mandano i dati al CSI Piemonte (specifiche AP26_003, §2). La Regione li manda al Ministero (specifiche funzionali del Ministero, versione 1.3). Come la Regione riceve i dati dai medici lo decide la Regione (disciplinare tecnico, §3): in Piemonte valgono le specifiche del CSI.
- **Tre tracciati.** Sono collegati fra loro:
  - l'**assistito**, con i dati anagrafici e i fattori di rischio;
  - il **contatto** fra assistito e medico, con la modalità, il problema e le prestazioni;
  - l'**organizzazione**, cioè dove lavora il medico: struttura, AFT e UCCP.
- **Quando.** Nel 2026 ogni mese, entro il mese successivo; dal 1° gennaio 2027 ogni settimana, entro la settimana successiva, con le settimane ISO 8601 (disciplinare, §7; Ministero, §2.2.3; CSI, §2). Variazioni e cancellazioni si mandano rimandando tutto il record (campo «Tipo trasmissione»: I, V o C).
- **In Piemonte** (CSI, §2):
  - la cartella manda i tre insiemi di dati con le API REST del CSI, in messaggi JSON;
  - il canale è cifrato, con certificati digitali e un'autenticazione forte;
  - il CSI risponde con un ID di protocollo, che dice che ha preso in carico il flusso;
  - la cartella controlla da sé i dati prima dell'invio, «correttezza e completezza».
- **Chi può farlo.** L'indagine di mercato AP26_003 (avviso e specifiche, scadenza 8/6/2026) era rivolta ai fornitori di cartelle già certificate con SIRPED. Fissava lo sviluppo entro il 20/7/2026 e il collaudo del CSI entro il 24/7/2026. Al collaudo il fornitore consegnava:
  - il piano dei test e il rapporto delle prove fatte presso i medici;
  - un'autocertificazione sulla provenienza dei dati.

## Fonti

Link, byte e SHA-256 in `docs/provenienze.md`, «SIAP». I documenti restano fuori dal repository (D92).

| Documento                                                                 | Data       | Che cosa dice                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CSI Piemonte, AP26_003, avviso pubblico                                   | 2026       | L'indagine di mercato, chi può rispondere, la scadenza dell'8/6/2026                                                                                                           |
| CSI Piemonte, AP26_003, allegato 01, specifiche tecniche                  | 2026       | Che cosa fa il modulo, i tre insiemi di dati (DataSet 1–3), invio e collaudo; nelle pagine 7–11 il decreto come stampato in Gazzetta                                           |
| Ministero della Salute, «Specifiche funzionali» del SIAP, versione 1.3    | 11/02/2026 | I tracciati per l'invio dalla Regione al Ministero, campo per campo, con XSD, controlli e codici di errore                                                                     |
| DM Salute 4/8/2025, GU n. 202 dell'1/9/2025                               | 2025       | L'istituzione del SIAP (articoli 1–12)                                                                                                                                         |
| Comunicato, GU n. 226 del 29/9/2025 (25A05298)                            | 2025       | Nella GU n. 202 non fu stampato il disciplinare tecnico, allegato 1 del decreto: è sul portale del Ministero                                                                   |
| Ministero della Salute, disciplinare tecnico del SIAP (allegato 1 del DM) | 2025       | I tre insiemi di dati con la fonte di ogni campo (Regione, anagrafe regionale degli assistiti, medico), il codice dell'assistito, l'invio al Ministero, la sicurezza e i tempi |

Che cosa non si è potuto scaricare da qui (`docs/provenienze.md`):

- il PDF della GU n. 202: il collegamento con www.gazzettaufficiale.it si chiude a metà del trasferimento. Le pagine 5–9 con il decreto le ha mandate Simone il 26/11/2026, dalla notizia di regioni.it; il testo era anche nelle pagine 7–11 delle specifiche del CSI;
- dal portale del Ministero (www.salute.gov.it) il disciplinare tecnico e le specifiche funzionali: il servizio di protezione del sito (Gcore) risponde 403. Li ha mandati Simone il 26/11/2026; le specifiche sono le stesse lette prima come testo.

Le specifiche del CSI elencano i campi senza i valori ammessi. I valori sono presi dalle specifiche del Ministero, finché il CSI non dice il formato del suo JSON (domanda 12 per il CSI, `docs/avanzamento.md`).

## Che cosa aggiunge il disciplinare tecnico

Il disciplinare, mandato da Simone il 26/11/2026, conferma i tempi (§7, come nelle specifiche del Ministero e del CSI) e aggiunge tre cose al confronto.

- **Da dove viene ogni campo** (§6). La tabella di ogni insieme di dati ha la colonna «Fonte»:
  - dal medico vengono, nell'insieme 1, il codice del medico, il fumo, il BMI e le patologie croniche; nell'insieme 2 tutto, tranne regione, ASL e codice del record; l'insieme 3 per intero;
  - regione, ASL e codice del record degli insiemi 1 e 2 li mette la Regione;
  - il resto dell'insieme 1 viene dall'anagrafe regionale degli assistiti, finché non c'è l'Anagrafe Nazionale degli Assistiti: anno di nascita, genere, cittadinanza, comuni di residenza e di domicilio, stato civile, esenzioni, data di scelta e di revoca.

  Il DataSet 1 del CSI ha proprio i campi che vengono dal medico, con regione, ASL e ID del paziente. I DataSet 2 e 3 del CSI riprendono quasi tutte le descrizioni del disciplinare.

- **Il codice dell'assistito** (§4.3). La Regione verifica il codice fiscale con il Sistema TS; poi la Regione o l'ASL lo sostituisce con il CUNI, un codice che non si può invertire. Il Ministero ne fa il CUNA. La cartella non calcola codici: manda l'ID regionale del paziente (CSI, DataSet 1 e 2).
- **Invio e sicurezza** (§4). La Regione manda al Ministero documenti XML, cifrati con la chiave pubblica del Ministero, in uno di tre modi: cooperazione applicativa, caricamento dal sito, certificati fra sistemi. Gli utenti del SIAP sono Ministero, AGENAS, Regioni e ASL, e vedono dati aggregati. Le misure di sicurezza sono del sistema nazionale: per la cartella valgono il canale e i certificati del CSI.

Dove il disciplinare e le specifiche del Ministero non dicono la stessa cosa (le specifiche lo avvertono, §3.8):

- **progressivo del contatto**: per il disciplinare e per il CSI conta i contatti dell'assistito nella stessa giornata (insieme 2) e quelli dello stesso medico (insieme 3). Per il Ministero è il codice della struttura (6 caratteri) seguito dal numero dato al paziente all'accettazione, nella giornata (4 cifre);
- **data e progressivo del contatto nell'insieme 3**: li hanno il disciplinare e il CSI, il Ministero li ha tolti nella versione 1.2;
- **quantità erogata** (insieme 2): c'è nel disciplinare e nel Ministero, non nel DataSet 2 del CSI.

Quale versione vale in Piemonte è nella domanda 12 per il CSI. Nel testo c'è anche una svista: il §6.1 parla di «due tracciati distinti» e ne elenca tre.

## Confronto: tracciato 1, assistito

Campi delle specifiche del CSI (DataSet 1), con i valori del Ministero (tracciato 1).

| Campo                               | Valori (Ministero)                                          | Nel programma                                                                                     | Che cosa manca                                                             |
| ----------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Codice Regione                      | tre caratteri (DM 17/9/1986), per il Piemonte 010           | Regione dello studio, con i codici dell'elenco delle ASL del Ministero (`asl-elenco.ts`)          | Niente                                                                     |
| Codice ASL                          | tre caratteri (DM 5/12/2006)                                | Codice ASL del medico nel suo profilo (D267) e ASL del paziente                                   | Niente                                                                     |
| Codice MMG/PLS                      | codice regionale del medico, 10 caratteri                   | Codice regionale nel profilo del medico                                                           | Niente; 999999999 per un paziente senza scelta                             |
| ID paziente (CSI); CUNI (Ministero) | ID regionale o dell'anagrafe; il CUNI lo calcola la Regione | Identificativo AURA del paziente, quando AURA lo trova (D197)                                     | Con AURA vero. Validità e tipo del codice li dà il Sistema TS alla Regione |
| Fumo                                | 1 sì, 2 no, 9 non noto                                      | Fattore «fumo» negli stili di vita, con il valore scritto a mano                                  | Un valore codificato (sì, no, non noto), al posto del testo                |
| BMI                                 | numero con due decimali, per esempio 27,99                  | Parametro BMI, oppure peso e altezza                                                              | Quale misura mandare: l'ultima, o l'ultima del periodo                     |
| Patologie croniche                  | codici ICD-9-CM con il punto, fino a 11                     | Problemi con il codice ICD-9-CM e la casella «cronica» (anche per il Profilo Sanitario Sintetico) | Niente; i problemi senza codice non si mandano                             |

Il tracciato del Ministero ha anche anno di nascita, genere, cittadinanza, comuni di residenza e di domicilio, stato civile, esenzioni, data di scelta e di revoca. Le specifiche del CSI non li chiedono alla cartella, e il disciplinare li fa venire dall'anagrafe regionale degli assistiti (§6.2). Se un giorno servissero anche dalla cartella, nel programma:

- **ci sono**: anno di nascita e genere (dal paziente); esenzioni con le date (anche da AURA); data di scelta e di revoca (scelte del medico);
- **ci sono in parte**: il comune di residenza è scritto per nome, senza il codice ISTAT (si ricava dall'elenco dei comuni); il domicilio è un testo libero; l'ambito dell'esenzione (reddito, malattie croniche, rare…) si ricava dalla famiglia del codice, ma non per tutte;
- **mancano**: cittadinanza e stato civile.

## Confronto: tracciato 2, contatto

Campi delle specifiche del CSI (DataSet 2), con i valori del Ministero (tracciato 2).

| Campo                                               | Valori (Ministero)                                                                                                                                                                                                                                     | Nel programma                                                                                                      | Che cosa manca                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Regione, ASL, codice MMG/PLS, paziente              | come nel tracciato 1                                                                                                                                                                                                                                   | Come sopra                                                                                                         | Niente                                                                                                                                           |
| Data del contatto                                   | data                                                                                                                                                                                                                                                   | Data delle voci del diario, delle ricette, dei certificati, delle vaccinazioni e delle prestazioni aggiuntive      | Il **contatto** come cosa a sé: oggi si ricava da ciò che si è fatto quel giorno. Va deciso se il medico lo registra o se il programma lo ricava |
| Progressivo del contatto                            | codice della struttura (6) + progressivo del giorno (4)                                                                                                                                                                                                | No                                                                                                                 | Il codice della struttura (tracciato 3) e un contatore per giorno                                                                                |
| Modalità del contatto                               | 1 studio, 2 domicilio, 3 telemedicina, 4 online o telefono, 9 non noto                                                                                                                                                                                 | Tipo di contatto del diario: studio, domicilio, telefono, televisita                                               | Niente per il diario; per una ricetta fatta senza nota nel diario la modalità non si sa                                                          |
| Regime dell'attività                                | 1 ciclo di scelta, 2 attività oraria, 9 non noto                                                                                                                                                                                                       | Il medico di famiglia con la scelta: sempre 1                                                                      | Il caso della continuità assistenziale, che il programma non ha                                                                                  |
| Tipologia di accesso                                | 1 programmato, 2 diretto, 9 non noto                                                                                                                                                                                                                   | Agenda con gli appuntamenti dello studio                                                                           | La regola: un contatto con un appuntamento del giorno è programmato, gli altri diretti; da decidere                                              |
| Problema                                            | ICD-9-CM o ICD-10-IM; senza un problema, un codice generico come V70.0 (esame medico generale)                                                                                                                                                         | Problemi con il codice ICD-9-CM                                                                                    | Il **problema del contatto**: oggi una nota del diario o una ricetta non dicono per quale problema                                               |
| Stato del problema                                  | 1 sospetto, 2 in evoluzione, 3 associato alla patologia cronica, 9 non noto                                                                                                                                                                            | Problema attivo o risolto, «quesito aperto», «cronica»                                                             | La corrispondenza: quesito aperto → sospetto, cronica → associato, gli altri → in evoluzione; da confermare con la Dr.ssa Rocca                  |
| Data di apertura del problema                       | data, facoltativa                                                                                                                                                                                                                                      | Data di inizio del problema                                                                                        | Niente                                                                                                                                           |
| Tipologia di prestazione                            | 1 visite, 2 bilanci, 3 terapia, 4 monitoraggi e screening, 5 PIPP, 6 certificati, 7 vaccinazioni, 8 prescrizioni farmaceutiche, 9 specialistica, 10 ricovero, 11 educazione sanitaria, 12 medicina di iniziativa, 13 attività amministrativa, 99 altro | Ricette farmaceutiche e specialistiche, certificati (INPS e modelli), vaccinazioni, prestazioni aggiuntive, diario | La tabella che lega ogni azione del programma alla tipologia e al dettaglio (allegato 2 delle specifiche del Ministero)                          |
| Dettaglio della prestazione; quantità (non nel CSI) | codici dell'allegato 2 del Ministero                                                                                                                                                                                                                   | No                                                                                                                 | Come sopra                                                                                                                                       |

## Confronto: tracciato 3, organizzazione

Campi delle specifiche del CSI (DataSet 3) e del Ministero (tracciato 3). Il DataSet 3 del CSI ha anche data e progressivo del contatto, come il disciplinare (§6.4); il Ministero li ha tolti dal tracciato 3 nella versione 1.2 del 10/12/2025. Quale versione vale in Piemonte è nella domanda 12 per il CSI.

| Campo                       | Valori (Ministero)                                                                                                                          | Nel programma                                       | Che cosa manca                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| Regione, ASL, codice medico | come sopra                                                                                                                                  | Come sopra                                          | Niente                                                             |
| Codice della struttura      | codice STS.11, 6 caratteri                                                                                                                  | No: lo studio ha nome, indirizzo e regione          | Il codice STS.11 dello studio, in Strumenti › Studio               |
| Tipo di struttura           | 1 studio MMG, 2 studio PLS, 3 AFT, 4 UCCP, 5 Casa della Comunità, 6 guardia medica, 7 guardia turistica, 8 semiresidenziale, 9 residenziale | Studio singolo o di gruppo                          | Il tipo, per lo studio e per le altre sedi in cui lavora il medico |
| AFT                         | codice STS.11 dell'AFT                                                                                                                      | AFT con il codice dato dall'ASL, facoltativo (D161) | Che il codice sia quello STS.11                                    |
| UCCP                        | codice STS.11 dell'UCCP                                                                                                                     | No                                                  | L'UCCP a cui afferisce l'AFT                                       |

## In breve

- **C'è già** la maggior parte dei dati clinici: problemi con l'ICD-9-CM e la casella «cronica», BMI, tipo di contatto del diario, ricette, certificati, vaccinazioni, prestazioni aggiuntive, esenzioni, scelte, agenda, AFT, codici di regione, ASL e medico.
- **Manca** soprattutto il **contatto** come registrazione a sé: data, progressivo, problema per cui è avvenuto, che cosa si è fatto. Oggi queste cose sono sparse nelle voci di quel giorno.
- **Mancano** poi:
  - il fumo codificato;
  - il codice STS.11 dello studio e il tipo di struttura;
  - l'UCCP;
  - la tabella delle tipologie e dei dettagli di prestazione.
- **Non servono dalla cartella** cittadinanza, stato civile e gli altri dati anagrafici: vengono dall'anagrafe regionale degli assistiti (disciplinare, §6.2).
- **Dal CSI** servono il formato JSON, i servizi REST, i certificati del canale, l'ambiente di prova e il collaudo (domande 11 e 12 per il CSI).

Che cosa si propone alla fermata: `docs/avanzamento.md`, «Domande per la prossima fermata».
