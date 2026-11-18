> Copia del documento «Cartella clinica MMG – Requisiti funzionali (bozza)» su claude.ai (revisione 45, 18/11/2026). La versione viva è lì: se cambia, questa copia va riesportata.

# Cartella clinica MMG – Requisiti funzionali (bozza)

Nov 17, 2026 · @Simone

## Scopo e principi

Costruiamo una cartella clinica in cloud per medici di medicina generale, partendo dal Piemonte e dallo studio della Dr.ssa Chiara Rocca. Nome del prodotto: **Folder**.

**La promessa.** Le azioni di ogni giorno richiedono meno passaggi: ripetere una terapia, preparare una ricetta, inviare un certificato INPS. La cartella si legge a colpo d'occhio e funziona da PC e da tablet.

**Principi**

- **Sviluppo indipendente.** I requisiti nascono da come lavora Chiara e dalle specifiche pubbliche di Regione, Sistema TS, INPS e FSE. Mai da schermate, documentazione o dati di altri software.
- **Nessun dato reale in sviluppo.** Prototipi, test e demo usano solo pazienti inventati.
- **Niente IA al centro.** Il valore sta in velocità, chiarezza e integrazioni affidabili, non in funzioni costruite attorno all'intelligenza artificiale.
- **I dati sono del medico.** Esportazione completa in formato aperto, in qualsiasi momento.
- **Prima il Piemonte.** Le altre regioni dopo, ognuna con le sue integrazioni.

## Utenti e ruoli

Ogni azione clinica ha un responsabile chiaro: la segreteria prepara, il medico firma e invia. Ogni accesso a una cartella viene registrato.

| Ruolo | Cosa fa | Cosa non può fare |
| --- | --- | --- |
| Medico titolare | Tutto sui propri assistiti; firma e invia ricette e certificati | — |
| Segreteria | Anagrafiche, agenda, richieste dei pazienti, bozze di ricette ripetute, stampa dei promemoria | Firmare, inviare al SAR, leggere il diario clinico (configurabile) |
| Medico sostituto | Lavora sull'archivio del titolare per un periodo, con le proprie credenziali Sistema TS | Ricette e certificati restano a nome suo, non del titolare |
| Medicina di gruppo | Più titolari nello stesso studio, segreteria condivisa, archivi separati | Vedere i pazienti di un collega senza le condizioni previste (da definire) |
| Amministratore studio | Utenti, stampanti, intestazioni, modelli | Accesso clinico, se non è anche medico |
| Paziente (fase 2) | Richieste di ripetizione, promemoria, ritiro documenti | Tutto il resto |

## Cartella del paziente

La cartella apre su un riepilogo che si legge in pochi secondi: allergie, problemi attivi, terapia in corso, scadenze e ultimi eventi. Il resto è a un clic, e una cronologia unica mostra tutto in ordine di data.

**Contenuti**

- **Anagrafica e dati SSN:** identità, codice fiscale, residenza e domicilio, recapiti, nucleo familiare, ASL e distretto, medico titolare, tipo di assistenza, cittadini stranieri (tessera europea, ente estero), decesso con causa in ICD.
- **Dati sociali e lavoro:** professione e condizione professionale, email del datore di lavoro per i certificati INPS.
- **Scelte e revoche, esenzioni:** sincronizzate con l'anagrafe regionale (AURA); esenzione con codice, validità e codice da riportare in ricetta.
- **Privacy:** consensi (incluso il Fascicolo Sanitario Elettronico), deleghe, oscuramento di singoli dati.
- **Anamnesi:** familiare, fisiologica, patologica remota, gravidanze.
- **Allergie e reazioni avverse ai farmaci:** sempre visibili in testata.
- **Stili di vita e fattori di rischio:** fumo, alcol, attività fisica.
- **Problemi e diagnosi:** codificati in ICD-9-CM, attivi o risolti, con date; quesiti diagnostici aperti.
- **Diario clinico:** note datate per tipo di contatto (studio, domicilio, telefono, televisita), con dettatura vocale del browser.
- **Parametri e misure:** pressione, peso, altezza, BMI, glicemia, saturazione; andamento nel tempo in grafico.
- **Esame obiettivo e valutazioni:** comprese le schede di valutazione geriatrica (UVG).
- **Esami:** richieste e risultati di laboratorio come valori strutturati, esami strumentali con referto allegato.
- **Terapie:** in corso, croniche o al bisogno, storico; piani terapeutici con scadenza; presidi; terapia anticoagulante orale (TAO).
- **Prevenzione e percorsi:** vaccinazioni con lotto, campagne vaccinali, gestione integrata del diabete e altri percorsi regionali (BPCO, scompenso).
- **Allegati:** referti e documenti in PDF o immagine.

**Elenco pazienti.** Ricerca mentre si digita per nome, codice fiscale, data o anno di nascita, telefono, indirizzo e famiglia. Filtri per stato (attivi, revocati, deceduti, temporanei) e per patologia (diabetici, ipertesi, BPCO).

## Prescrizioni e ricette

La ricetta è l'azione più frequente, quindi deve essere la più veloce: la terapia cronica si ripete con un clic e i controlli avvengono prima dell'invio, non dopo un errore.

**Tipi di ricetta**

- Farmaceutica SSN dematerializzata, inviata al SAR del Piemonte che la inoltra al Sistema TS.
- Specialistica SSN dematerializzata, con prestazioni dal catalogo regionale, priorità (U, B, D, P) e quesito diagnostico.
- Ricetta bianca (non a carico del SSN), anch'essa dematerializzata tramite Sistema TS: obbligatoria dal 1° gennaio 2025, legge 207/2024 ([DBMedica](https://www.dbmedica.it/news/ricette-bianche-digitali-2026-cosa-devono-fare-gli-specialisti/)).
- Presidi e assistenza integrativa (es. dispositivi per diabetici).

**Ciclo di vita**

1. **Bozza:** la prepara il medico, oppure la segreteria per le terapie croniche richieste dal paziente.
2. **Da firmare:** compare nella coda del medico titolare, raggruppata per paziente.
3. **Inviata:** il medico conferma, il sistema invia al SAR e registra il numero di ricetta elettronica (NRE).
4. **Promemoria al paziente:** sul canale scelto dal paziente (vedi Consegna al paziente, R15 e R16).

**Consegna al paziente.** Quando genera la ricetta, il medico consegna il promemoria cartaceo oppure, su richiesta dell'assistito, lo rende disponibile in modo alternativo ([DM 25 marzo 2020, richiamato dalla Regione Piemonte](https://www.regione.piemonte.it/governo/bollettino/abbonati/2020/52/attach/dgr_02525_1050_11122020.pdf)). I canali ammessi sono email o PEC, SMS o app di messaggistica, telefono e Fascicolo ([Agenda Digitale](https://www.agendadigitale.eu/?p=147121)). In farmacia bastano il numero di ricetta (NRE) e il codice fiscale ([Regione Piemonte](https://www.regione.piemonte.it/web/node/7777)).

- Ogni paziente ha un canale preferito, registrato in cartella con il recapito e la data della scelta; si può cambiare al momento.
- Per email e messaggi si propone di default il solo NRE con il codice fiscale: meno dati sanitari in circolazione.
- Stampa: promemoria completo, solo NRE, oppure su una stampante scelta.
- Ricetta bianca: stessa logica, con il numero NRBE.
- Invio a un'altra persona solo se è un delegato registrato in cartella (R16).
- Dopo l'invio: ristampa, reinvio e annullamento, quest'ultimo solo nei casi ammessi dalle specifiche.

Se il SAR rifiuta, la ricetta torna in **Errore** con il motivo in chiaro. Una ricetta inviata si può annullare nei casi ammessi dalle specifiche.

**Controlli prima dell'invio.** Sono elencati uno per uno, con fonte e comportamento, nella sezione Regole di prescrizione qui sotto.

**Banca dati farmaci.** Ricerca per nome commerciale, principio attivo, codice AIC e ATC. Mostra classe, nota AIFA, prezzo, equivalenti e farmaci in distribuzione per conto (DPC).

**Piani terapeutici.** Farmaco, data di concessione e scadenza, centro o specialista, confezioni autorizzate. Promemoria automatico 30 giorni prima della scadenza.

**Da verificare sulle specifiche:** se il SAR comunica al medico quando una ricetta viene erogata in farmacia, e come gestire i casi in cui il SAR non risponde.

## Regole di prescrizione

Le regole che discendono da una norma bloccano l'invio della ricetta SSN e non hanno deroghe. Quelle di buona pratica avvisano e chiedono un motivo, che resta registrato. I valori vengono dalla banca dati farmaci e dalle norme, versionati con la loro fonte, mai scritti a mano nel codice.

| ID | Regola | Fonte | Dato usato | Comportamento |
| --- | --- | --- | --- | --- |
| R1 | La ricetta SSN vale 30 giorni | [Tabella AIFA di classificazione dei medicinali](https://www.aifa.gov.it/documents/20142/0/tabella_classificazione_medicinali.pdf) | Data di compilazione | Scadenza indicata al paziente e usata dal contatore (R11) |
| R2 | Di regola al massimo 2 confezioni per ricetta | Tabella AIFA | Numero di confezioni | **Blocca** oltre il limite e propone di dividere in più ricette |
| R3 | Fino a 6 confezioni per antibiotici iniettabili e soluzioni per infusione | Tabella AIFA | Forma farmaceutica dalla banca dati | Alza il limite solo per questi farmaci |
| R4 | Fino a 6 confezioni per patologie croniche in trattamento da almeno 6 mesi, per non più di 180 giorni di terapia | Tabella AIFA; condizioni esatte da verificare sul testo di legge e sulle regole del Piemonte | Esenzione, inizio della terapia, posologia | Consente fino a 6 solo se ogni condizione risulta dai dati; altrimenti **blocca** a 2 |
| R5 | Farmaco con piano terapeutico obbligatorio | Determina AIFA del farmaco e [Note AIFA](https://www.aifa.gov.it/it/note-aifa), riportate dalla banca dati. In Piemonte alcuni piani sono ancora cartacei (es. Nota 85, [elenco regionale](https://www.regione.piemonte.it/web/node/964) dei farmaci PHT in DPC) | Piano terapeutico in cartella, con scadenza | **Blocca** la ricetta SSN se il piano manca o è scaduto alla data. La ricetta bianca, a carico del paziente, resta possibile solo se il regime di fornitura del farmaco la consente al medico di medicina generale (R8). Avviso 30 giorni prima della scadenza |
| R6 | Quantità entro quanto indicato nel piano terapeutico | Piano terapeutico dello specialista | Posologia, durata ed eventuali confezioni del piano; ricette già inviate | **Blocca** le quantità che lo superano e mostra il residuo |
| R7 | Nota AIFA | [Note AIFA](https://www.aifa.gov.it/it/note-aifa): il numero della nota in ricetta dichiara che ricorrono le condizioni di rimborsabilità | Nota collegata al farmaco | **Blocca** l'invio finché il medico non conferma che il paziente rientra nella nota; la conferma resta registrata |
| R8 | Classe e regime di fornitura | Classificazione AIFA, dalla banca dati | Classe e tipo di ricetta richiesto | **Blocca** su ricetta SSN i farmaci non a carico del SSN o non prescrivibili dal medico di medicina generale |
| R9 | Esenzione valida | Anagrafe regionale AURA e catalogo esenzioni | Codice e validità alla data | **Blocca** esenzioni scadute o inesistenti; la correlazione con la patologia la attesta il medico |
| R10 | Controlli formali del Sistema TS | [Specifiche tecniche della ricetta, prescrizione](https://sistemats1.sanita.finanze.it/portale/documents/20182/81804/20241205_Specifiche%20tecniche%20ricetta%20dematerializzata%20-%20prescrizione/7cfbbd34-e929-d051-d5b2-629232f3d79e) e documento dei controlli | Ogni campo del messaggio | Ripetuti in locale prima dell'invio, così l'errore si vede subito e non dopo un rifiuto |
| R11 | Contatore delle confezioni | Buona pratica, da validare con Chiara e con il consulente regolatorio (MDR) | Posologia, unità per confezione, ricette inviate | **Avvisa** se la nuova ricetta arriva troppo presto rispetto alla copertura delle precedenti; si procede solo con un motivo, registrato |
| R12 | Dose rispetto all'RCP, interazioni, linee guida cliniche | Dati clinici con licenza e percorso di dispositivo medico | — | **Non nella prima versione.** Si mostra la posologia dell'RCP come riferimento, senza giudizi automatici (vedi Vincoli legali) |
| R13 | Prima prescrizione con più equivalenti disponibili: in ricetta il principio attivo; il marchio vincola il farmacista solo con clausola di non sostituibilità e sintetica motivazione | DL 95/2012, art. 15, comma 11-bis (vedi Scheda della terapia) | Gruppo di equivalenza, opzione Non sostituibile, motivazione | Blocca la clausola di non sostituibilità senza motivazione; la ricetta riporta sempre il principio attivo |
| R14 | Ricetta specialistica: tipo di accesso sempre; classe di priorità per il primo accesso; quesito diagnostico | PNGLA e indicazioni regionali (vedi Specialistica, esami e accessi domiciliari) | Tipo di accesso, priorità, quesito | Blocca l'invio se uno dei tre manca |
| R15 | Promemoria cartaceo oppure, su richiesta del paziente, canale alternativo: email o PEC, SMS o messaggio, telefono, Fascicolo | DM MEF 25/03/2020 e norme successive (vedi Consegna al paziente) | Canale e recapito scelti dal paziente, con data | Blocca l'invio su un canale senza recapito o senza scelta registrata del paziente |
| R16 | Ricetta o NRE a una persona diversa dal paziente solo se è un delegato registrato | Privacy (GDPR) e deleghe in cartella; da validare con il consulente privacy | Deleghe del paziente | Blocca l'invio a recapiti che non sono del paziente né di un delegato |
| R17 | Esenzione per patologia su ricetta specialistica: ogni prestazione deve essere tra quelle associate a quell'esenzione | Allegato 8-bis del DPCM LEA e atti regionali; in Piemonte il SAR lo controlla e blocca dal 28/06/2022 (D.D. 1167/2022, vedi Banche dati e aggiornamento quotidiano) | Esenzione del paziente e associazioni esenzione–prestazioni dell'elenco regionale | Blocca l'invio se l'esenzione non copre una prestazione; propone di spostarla su una ricetta senza esenzione o di usare un'altra esenzione valida del paziente |

**Come si calcola il contatore (R11).** Copertura in giorni = unità per confezione × confezioni ÷ unità al giorno della posologia. Esempio: Ramipril 5 mg da 28 compresse, una al giorno, ricetta del 21/10: copre fino al 17/11 compreso. Proposta da decidere con Chiara: avviso se la nuova ricetta arriva prima dell'80% della copertura. Si contano le ricette inviate; se il SAR comunicherà le erogazioni, si conteranno quelle.

**Come garantiamo il rigore**

- Ogni regola è un dato versionato: identificativo, testo, fonte con data, valori, comportamento, data di efficacia.
- Ogni regola ha test automatici sui casi limite (es. 2 e 3 confezioni, piano che scade oggi, nota non confermata). Se un test fallisce, non si rilascia.
- Ogni ricetta conserva la versione delle regole con cui è stata controllata, così resta verificabile anche dopo un cambio di norma.
- Prima dell'uso con pazienti reali, Chiara valida ogni regola e un consulente verifica i riferimenti normativi.

**Norme in evoluzione.** L'art. 62 della legge 182/2025 prevede la ricetta ripetibile fino a 12 mesi per i cronici, ma a fine giugno 2026 il decreto attuativo non era ancora stato adottato ([Osservatorio Malattie Rare](https://www.osservatoriomalattierare.it/news/politiche-socio-sanitarie/23156-ricetta-annuale-per-i-pazienti-cronici-dopo-sei-mesi-il-decreto-attuativo-non-e-ancora-arrivato)); un articolo aggiornato a settembre 2026 la indicava ancora come non operativa ([DBMedica](https://www.dbmedica.it/news/ricette-bianche-digitali-2026-cosa-devono-fare-gli-specialisti/)). Il modello dati la prevede già; si attiva solo con il decreto e le specifiche del Sistema TS.

**Da verificare prima di scrivere il codice**

- [ ] Testo di legge vigente sulle confezioni per ricetta e condizioni esatte per arrivare a 6 (R4).
- [ ] Regole del Piemonte su esenzioni, ticket e farmaci in distribuzione per conto.
- [ ] Campi della banca dati farmaci per piano terapeutico, nota AIFA, classe e regime di fornitura.
- [ ] Se i piani terapeutici sono disponibili in formato elettronico, per non doverli trascrivere.
- [ ] Documento ufficiale dei controlli del Sistema TS sulla prescrizione (R10).

## Scheda della terapia

Ogni farmaco in terapia ha una scheda in tre parti: il farmaco, come si prende, come va in ricetta. Le opzioni sono interruttori con il loro nome e una riga di spiegazione, non icone da ricordare. Molte non sono scelte nostre: sono campi della ricetta o obblighi di legge.

**Campi**

| Campo | Contenuto | Da dove arriva |
| --- | --- | --- |
| Farmaco | Nome, confezione, AIC, ATC, principio attivo, classe, eventuale DPC | Banca dati farmaci |
| Gruppo di equivalenza | Codice del gruppo di medicinali equivalenti | Liste di trasparenza AIFA, tramite la banca dati |
| Posologia | Dose, unità, frequenza, momento della giornata, via | Medico; alimenta il contatore (R11) |
| Tipo di terapia | Cronica, al bisogno, ciclo con data di fine | Medico |
| Date | Inizio, fine, ultima ricetta, prossima ricetta possibile | Medico e calcolo del contatore (R11) |
| Confezioni per ricetta | Numero abituale | Medico, entro R2–R4 |
| Indicazione | Problema o diagnosi collegati | Medico; serve per esenzione (R9) e nota (R7) |
| Esenzione abituale | Codice proposto in ricetta | Medico, verificato con R9 |
| Nota AIFA e piano terapeutico | Nota del farmaco, piano collegato con scadenza | Banca dati e cartella (R5–R7) |
| Medico suggeritore | Nome, struttura, data | Quando la terapia viene da uno specialista o da una dimissione |
| Istruzioni per il paziente | Testo per promemoria e schema orario | Medico |
| Storico | Chi ha creato o modificato cosa, e quando | Sistema |

**Opzioni**

| Opzione | Effetto | Fonte |
| --- | --- | --- |
| Importante | Sempre visibile nella testata della cartella | Scelta dello studio |
| Riservata | Visibile solo al medico, esclusa da segreteria e portale paziente. Per il Fascicolo valgono le scelte di oscuramento del paziente (da verificare) | Privacy |
| Cronica | Attiva il contatore e la ripetizione rapida | R11 |
| Non rimborsabile SSN | Si prescrive solo su ricetta bianca dematerializzata | R8 |
| Per principio attivo | In ricetta va il principio attivo: il farmacista può dare un equivalente | DL 95/2012, art. 15, c. 11-bis ([AIFA](https://www.aifa.gov.it/en/-/tabelle-farmaci-di-classe-a-e-h-al-15-09-2015)) |
| Non sostituibile | Vincola il farmacista al medicinale indicato; senza una sintetica motivazione la ricetta non parte (R13) | DL 95/2012, art. 15, c. 11-bis ([AIFA](https://www.aifa.gov.it/en/-/tabelle-farmaci-di-classe-a-e-h-al-15-09-2015)) |
| Multiprescrizione | Consente fino a 6 confezioni, solo se valgono le condizioni di R3 o R4 | R3, R4 |
| Suggerita (S) | Tipologia S sulla ricetta; servono i dati del medico suggeritore | Modello di ricetta; regole d'uso per la farmaceutica da verificare sulle specifiche Sistema TS |
| Ricovero (H) | Tipologia H sulla ricetta | Modello di ricetta; se e come si applica alla farmaceutica, da verificare sulle specifiche Sistema TS |

**Funzioni in più che proponiamo**

- Sospensione con motivo; se il motivo è una reazione avversa, si aggiornano le reazioni da farmaci in anamnesi e si offre il collegamento alla segnalazione di farmacovigilanza.
- Schema orario stampabile per il paziente: cosa prendere, quando, fino a quando.
- Confezioni prescritte negli ultimi 12 mesi, visibili nella scheda.
- Riconciliazione alla dimissione: terapia di dimissione e terapia in corso a confronto, voce per voce (fase 2).
- Differenza di prezzo rispetto al prezzo di riferimento, quando il paziente chiede un marchio preciso (solo informativa).
- Ricetta ripetibile annuale (art. 62): campi già previsti, attivazione con il decreto.
- Per ruolo: la segreteria vede solo le terapie non riservate e prepara ripetizioni solo di terapie croniche.

Resta escluso tutto ciò che giudica dosi, interazioni o allergie (R12).

## Specialistica, esami e accessi domiciliari

La ricetta specialistica ha campi obbligatori suoi: tipo di accesso, classe di priorità, quesito diagnostico. Le prestazioni vengono dal catalogo regionale, che in Piemonte è stato rinnovato con il nuovo nomenclatore nazionale ed è in vigore dal 30 dicembre 2024 ([D.D. 990/2024](https://www.regione.piemonte.it/governo/bollettino/abbonati/2025/01/attach/dda1400000990_11200.pdf)). Dal 30 ottobre 2026 vale la versione aggiornata della [D.D. 710/2026](https://www.regione.piemonte.it/governo/bollettino/abbonati/2026/44/attach/ddxst00000710_11200.pdf): le ricette emesse fino al 29 ottobre con il catalogo precedente si possono ancora prendere in carico ed erogare.

**Prescrizione specialistica**

- Ricerca nel catalogo regionale come per i farmaci: descrizione, branca, codice regionale e codice del nomenclatore nazionale.
- Tipo di accesso sempre indicato: primo accesso o accesso successivo ([indicazioni operative PRGLA](https://salute.regione.emilia-romagna.it/siseps/sanita/asa/files/2019-07-indicazioni-operative-prgla.pdf/@@download/file/2019-07%20Indicazioni%20operative%20PRGLA.pdf)). Per il primo accesso la classe di priorità (U, B, D, P) è obbligatoria; per i controlli si indica dopo quanti mesi ([AUSL Modena](https://www.ausl.mo.it/media/Indicazioni-operative-FRONT-OFFICE-2024.pdf)).
- Quesito diagnostico obbligatorio, riferito a tutte le prestazioni della ricetta ([PNGLA](https://quotidianosanita.it/allegati/allegato9075224.PDF)).
- Sedute per i cicli (es. riabilitazione), tariffa a titolo informativo, condizioni di erogabilità e note del catalogo quando presenti (da verificare sul catalogo piemontese).
- Pacchetti: gruppi di prestazioni salvati dallo studio (es. controllo del diabete), prescritti insieme con un clic.
- Dopo la prescrizione: data di esecuzione, struttura, esito, referto allegato.
- Nuova regola R14 (tabella delle regole): l'invio è bloccato se mancano tipo di accesso, priorità per il primo accesso o quesito diagnostico.

**Esami di laboratorio**

- Risultati per data: esame, valore, unità, intervallo di riferimento del laboratorio, codice della prestazione.
- Andamento nel tempo per gli esami ripetuti (es. emoglobina glicata).
- Valori fuori dall'intervallo del referto evidenziati: da confermare con il consulente regolatorio, anche se è solo un confronto con l'intervallo del laboratorio.
- Inserimento manuale oppure, dove possibile, acquisizione dei referti strutturati dal Fascicolo Sanitario Elettronico (accesso e formato da verificare).
- Ripetizione con un clic della richiesta degli stessi esami.
- Calcoli clinici esclusi dalla prima versione (R12).

**Accessi domiciliari**

- Registro degli accessi a domicilio: data, ora di inizio e fine, tipo di assistenza, attività svolte, per la rendicontazione prevista dagli accordi con l'ASL. Tipi e regole da verificare con Chiara e con l'ASL.

**Certificati INPS, dettaglio**

- Tipo (inizio, continuazione, ricaduta), visita ambulatoriale o domiciliare, eventuali agevolazioni previste dal modello, giorni, protocollo, modalità di consegna al lavoratore ed esito dell'invio. Campi esatti da verificare sulle specifiche del Sistema TS.

## Certificati e moduli

Il certificato di malattia INPS si compila in meno di un minuto: i dati del paziente e del lavoro sono già in cartella, e una continuazione riparte dal certificato precedente.

- **Certificato di malattia INPS telematico:** inizio, continuazione o ricaduta; visita ambulatoriale o domiciliare; prognosi dal–al; diagnosi in ICD-9-CM e testo libero; indirizzo di reperibilità se diverso dalla residenza. Dopo l'invio tramite Sistema TS si registra il numero di protocollo. Copia al lavoratore via stampa o email; annullamento e rettifica nei casi ammessi.
- **Altri certificati e moduli:** modelli personalizzabili che si compilano da soli con i dati del paziente (es. idoneità sportiva non agonistica, certificati vari, modulistica regionale).
- **PPIP:** registrazione delle prestazioni di particolare impegno professionale e riepilogo mensile secondo le regole del Piemonte.
- **Prestazioni private:** onorari e fattura, poi invio delle spese al Sistema TS per la dichiarazione precompilata (fase 2).

## La giornata di lavoro

La schermata iniziale si chiama **Oggi**: agenda del giorno a sinistra, cose da fare a destra, ognuna con un'azione diretta. Niente da cercare nei menu.

**Code di lavoro** (calcolate in automatico, ognuna con un contatore)

- Ricette da firmare, preparate dalla segreteria.
- Richieste dei pazienti (ripetizione di terapie, certificati, appuntamenti).
- Invii non riusciti: ricette o certificati rifiutati, con il motivo.
- Piani terapeutici in scadenza nei prossimi 30 giorni.
- Esenzioni in scadenza.
- Richiami vaccinali e pazienti da contattare per le campagne.
- Controlli dei percorsi (es. diabete) scaduti o in arrivo.

**Agenda.** Visite in studio, domicili e televisite. La segreteria prenota; il medico vede la giornata e apre la cartella dall'appuntamento. Prenotazione online da parte dei pazienti in fase 2.

**Riepiloghi.** Visite, prescrizioni, vaccinazioni, PPIP e fatture per periodo, con esportazione. Invio dei flussi regionali (diabete, vaccinazioni) in fase 2.

**Ricerca globale.** Una barra in alto, sempre disponibile da tastiera, per aprire un paziente o lanciare un'azione (es. "ricetta Rossi").

## Integrazioni esterne

La prima versione dipende da quattro collegamenti: SAR, AURA, certificati INPS e banca dati farmaci. Ognuno richiede credenziali e un collaudo esterno, quindi le pratiche vanno avviate subito.

| Sistema | A cosa serve | Come si collega | Fase |
| --- | --- | --- | --- |
| SAR Piemonte (progetto SIRPED), verso il SAC del Sistema TS | Ricette farmaceutiche e specialistiche dematerializzate | Web service; requisiti per cartelle MMG/PLS e piano di test della Regione ([specifiche](https://servizi.regione.piemonte.it/media/1019/download)) | v1 |
| Sistema TS, autenticazione forte | Accesso del medico ai web service delle ricette | Id-Sessione come token autorizzativo ([documento](https://servizi.regione.piemonte.it/media/3354/download)) | v1 |
| AURA (CSI-Piemonte) | Anagrafica, scelte e revoche, esenzioni | Web service SOAP/XML ([manuale](https://servizi.regione.piemonte.it/media/786/download)); allineata all'Anagrafe Nazionale Assistiti dal 2026 ([notizia](https://www.regione.piemonte.it/web/node/22064)) | v1 |
| Sistema TS, certificati INPS | Certificati di malattia telematici | Web service del Sistema TS | v1 |
| Banca dati farmaci | Farmaci, classi, note AIFA, prezzi, equivalenti | Licenza commerciale (es. Farmadati), con aggiornamento quotidiano da prevedere nel contratto | v1 |
| Cataloghi | Prestazioni regionali, ICD-9-CM (dal 2027 ICD-10-IM), esenzioni, comuni e ASL | Tabelle importate e aggiornate ogni notte (vedi Banche dati e aggiornamento quotidiano) | v1 |
| Fascicolo Sanitario Elettronico 2.0 | Profilo Sanitario Sintetico e documenti clinici ([FSE in Piemonte](https://www.regione.piemonte.it/web/node/19984)) | Gateway FSE con documenti strutturati; accreditamento del software | v1 o subito dopo |
| Flussi regionali | Diabete, vaccinazioni, PPIP | Portali e flussi della Regione | v2 |
| Sistema TS, spese sanitarie | Dichiarazione dei redditi precompilata | Web service | v2 |

## Banche dati e aggiornamento quotidiano

Banche dati e tabelle di codici si aggiornano da sole ogni notte, senza interventi manuali. Un file nuovo entra in uso solo se passa i controlli; altrimenti resta in uso la versione precedente e il medico lo vede.

**Fonti**

| Banca dati | Chi la pubblica | Formato | Quanto cambia alla fonte | Accesso | Serve per |
| --- | --- | --- | --- | --- | --- |
| Anagrafica dei farmaci autorizzati: confezioni, principi attivi, ATC | [AIFA, open data](https://www.aifa.gov.it/liste-dei-farmaci) | CSV | Ogni giorno | Pubblico, CC BY 4.0. AIFA avverte che i dati sono provvisori e solo descrittivi | Ricerca farmaci in test |
| Farmaci di classe A e H per principio attivo e per nome commerciale, con prezzo e gruppo di equivalenza | AIFA | CSV | Quando AIFA li aggiorna: la versione al 30/06/2026 è uscita il 26/10/2026 | Pubblico, CC BY 4.0 | R8, R13, ricerca per gruppo di equivalenza |
| Liste di trasparenza: equivalenti e prezzo di riferimento | [AIFA](https://www.aifa.gov.it/documents/20142/241044/Comunicazione_AIFA_2.pdf) | CSV | Ogni mese, il 15 | Pubblico, CC BY 4.0 | Differenza di prezzo, R13 |
| Farmaci carenti | AIFA | CSV | Spesso: ultimo aggiornamento 17/11/2026 | Pubblico, CC BY 4.0 | Avviso di carenza sui farmaci in terapia |
| Registri e piani terapeutici AIFA, attivi e chiusi | AIFA | CSV | Quando cambiano: ultimo aggiornamento 06/11/2026 | Pubblico, CC BY 4.0 | R5, R6 |
| Note AIFA | [AIFA](https://www.aifa.gov.it/note-aifa) | PDF; non ho trovato un elenco aperto che associ farmaci e note | Quando AIFA cambia una nota | Pubblico | R7 |
| Farmaci PHT in DPC, con nota AIFA e obbligo di piano | [Regione Piemonte](https://www.regione.piemonte.it/web/node/964) | PDF | Quando la Regione lo aggiorna: ultimo aggiornamento 09/07/2026 | Pubblico | R5, R7, R8 |
| Catalogo regionale delle prestazioni di specialistica | [Regione Piemonte, D.D. 710/2026](https://www.regione.piemonte.it/governo/bollettino/abbonati/2026/44/attach/ddxst00000710_11200.pdf) | PDF allegati alla determina | Con ogni nuova determina: l'ultima vale dal 30/10/2026 | Pubblico | R14, ricerca prestazioni ed esami |
| Esenzioni e prestazioni associate | DPCM LEA (allegati 7, 8 e 8-bis) e [Regione Piemonte, D.D. 1167/2022](https://www.regione.piemonte.it/governo/bollettino/abbonati/2022/28/attach/dda1410001167_10100.pdf) | PDF | Con nuovi decreti: dal 30/10/2026 ci sono le esenzioni 068, 069 e 070 | Pubblico | R9, R17 |
| Diagnosi: ICD-9-CM 2007 e ICD-10-IM | Ministero della Salute, [DM 23/10/2025](https://www.mefop.it/cms/doc/29766/dm-salute-23-ottobre-2025.pdf) | XLSX: elenchi e tabelle di transcodifica | Dal 1/1/2027 ICD-10-IM sostituisce ICD-9-CM in tutti i sistemi informativi sanitari; poi aggiornamenti almeno ogni due anni | Pubblico | Problemi del paziente, certificati |
| Comuni e codici catastali | [ISTAT](https://www.istat.it/it/archivio/6789) | XLSX, link permanente | Almeno ogni sei mesi: l'ultimo file è aggiornato al 21/02/2026 | Pubblico | Anagrafica, controllo del codice fiscale |
| Banca dati farmaci completa | Farmadati Italia, che pubblica anche [Codifa](https://apps.apple.com/app/id6755812251) | Servizio | Da contratto: va chiesto l'aggiornamento quotidiano | A pagamento | In produzione, tutte le regole sui farmaci |
| Assistiti, ricette, fascicolo, certificati | AURA, SAR e SAC, FSE, INPS | Servizi in tempo reale | Sempre aggiornati: si interrogano al momento | Credenziali e accreditamento | R9, R10, invio |
| Dati dei medicinali, RCP, fogli illustrativi, carenze | [AIFA, 6 servizi sulla PDND](https://www.aifa.gov.it/-/aifa-nella-piattaforma-digitale-nazionale-dati) | API | Automatico | Per «soggetti autorizzati»: da verificare per una software house | Alternativa ai CSV |

**Regole di aggiornamento**

Sono proposte, da validare con Chiara.

| ID | Regola | Comportamento | Stato |
| --- | --- | --- | --- |
| A1 | Ogni notte si controllano tutte le fonti; si scarica solo ciò che è cambiato | Una fonte che non risponde va nel rapporto come errore; resta in uso la versione precedente | Nello script di test |
| A2 | Ogni versione resta in archivio con data, indirizzo di origine e impronta SHA-256; nessuna viene sovrascritta | Il registro dice da dove viene ogni dato in uso | Nello script di test |
| A3 | Una versione nuova entra in uso solo se ha il formato atteso, è completa, ha le stesse colonne e righe entro ±20% della precedente | Trattiene la versione finché una persona la controlla e la accetta | Nello script di test; soglia da validare |
| A4 | Un file sparito dalla pagina ufficiale non si cancella | Resta in uso; il rapporto chiede di verificare se è stato ritirato | Nello script di test |
| A5 | Le regole di prescrizione usano i dati in vigore alla data della ricetta, non quelli dell'ultimo download | Esempio: fino al 29/10/2026 il catalogo precedente, dal 30/10/2026 quello della D.D. 710/2026 | Da progettare |
| A6 | Ogni schermata che usa una banca dati mostra la data della versione in uso | Avvisa se la versione è più vecchia del previsto per quella fonte; non blocca, perché il controllo finale resta del SAC (R10) | Da progettare |
| A7 | Un aggiornamento che tocca un farmaco in terapia (carenza, nota, classe, piano, ritiro) arriva in Da fare, con i pazienti interessati | Avvisa | Da progettare |
| A8 | PDF e atti del Bollettino si scaricano e si segnalano, ma i loro dati non si estraggono da soli | Avvisa; prima dell'uso servono un controllo umano o una fonte strutturata (banca dati a licenza, file da Regione o CSI) | Segnalazione nello script di test |

**Ambiente di test.** Lo script sync/banche\_dati.py fa A1–A4 e segnala A8, con le sole fonti pubbliche e senza dati di pazienti. È provato solo su un server finto: il primo giro sui siti veri va fatto da un computer dello studio.

**Da verificare**

- [ ] CSI Piemonte: catalogo regionale ed elenco esenzioni–prestazioni esistono in formato strutturato per le software house?
- [ ] AIFA: esiste un elenco aperto che associ farmaci e note?
- [ ] AIFA sulla PDND: una software house privata può usare i 6 servizi?
- [ ] Farmadati: frequenza di aggiornamento, formato e condizioni d'uso in test.
- [ ] ICD-10-IM dal 1/1/2027: da quando lo accettano FSE e certificati INPS?

## Requisiti non funzionali

Sicurezza e continuità vengono prima di ogni funzione: un ambulatorio fermo o un dato perso costano più di qualunque ritardo nello sviluppo. I valori numerici sono proposte da confermare.

- **Accesso:** autenticazione a due fattori per tutti; sessione che si blocca dopo pochi minuti di inattività sulle postazioni condivise.
- **Separazione dei dati:** ogni studio vede solo i propri dati; dentro lo studio, permessi per ruolo e per archivio.
- **Cifratura:** in transito e a riposo; credenziali verso Sistema TS e Regione conservate cifrate.
- **Registro degli accessi:** chi ha aperto quale cartella, quando, e cosa ha cambiato. Ogni invio esterno conserva richiesta, risposta ed esito.
- **Hosting e backup:** server nell'Unione Europea, preferibilmente in Italia; backup cifrati giornalieri con prova di ripristino. Proposta: perdita massima di dati 1 ora, ripristino entro 4 ore.
- **Cloud qualificato:** fornitore con servizi cloud già qualificati dall'Agenzia per la cybersicurezza nazionale (ACN). La qualificazione serve per la Pubblica Amministrazione, non per lo studio: diventa necessaria se Regione o ASL acquistano Folder per i loro medici ([ACN, regolamento cloud](https://www.agendadigitale.eu/infrastrutture/data-center/regolamento-acn-per-infrastrutture-digitali-e-cloud-cosa-fare-per-diventare-fornitori-della-pa/)).
- **Se cade la rete:** connessione di riserva nello studio. Se SAR o Sistema TS non rispondono ma Folder sì, si stampa la ricetta rossa; senza rete resta il ricettario a mano. Una consultazione senza rete (copia cifrata di terapie, allergie ed esenzioni sul dispositivo) è da valutare dopo la prima versione, con il consulente privacy.
- **Disponibilità:** manutenzioni solo fuori dall'orario di ambulatorio.
- **Velocità:** cartella aperta in meno di 1 secondo; risultati di ricerca mentre si digita.
- **Dispositivi:** browser su PC e tablet, nessuna installazione; scorciatoie da tastiera per le azioni frequenti.
- **Stampa:** promemoria, certificati e moduli in PDF conformi alle specifiche, stampa diretta in studio.
- **Esportazione:** tutti i dati dello studio in formato aperto, su richiesta e in qualsiasi momento.
- **Leggibilità:** testo grande, contrasto alto, stati sempre scritti a parole e non solo a colori.

## Vincoli legali e di licenza

Quattro vincoli decidono cosa si può fare e in che ordine. Vanno verificati con professionisti prima del primo utilizzo con pazienti reali; questa sezione non è una consulenza legale.

- **Licenza del software attuale di Chiara.** Il contratto di licenza di Next² vieta il reverse engineering e qualsiasi analisi finalizzata a riprodurne contenuti (art. 7), impone di proteggerne contenuti e documentazione (art. 9) e prevede risoluzione e penale pari a tre volte il canone (art. 11). Regola: nessuna schermata, documentazione o dato di Next² come fonte di progetto. Le schermate già ricevute vanno cancellate, e ogni requisito di questo documento va confermato da Chiara in base alla sua pratica; ciò che non conferma, esce. Revisione di un avvocato prima del lancio.
- **Privacy (GDPR).** Il medico è titolare dei dati dei suoi pazienti; il fornitore del software è responsabile del trattamento (art. 28). Servono contratto di nomina, registro dei trattamenti, valutazione d'impatto, e va valutata la nomina di un responsabile della protezione dei dati.
- **Dispositivo medico (MDR).** Funzioni che aiutano la decisione clinica, come calcoli di rischio o avvisi su dosaggi e interazioni, possono rendere il software un dispositivo medico. Prima versione senza calcolatori clinici né avvisi decisionali; valutazione con un consulente regolatorio prima di aggiungerli.
- **Collaudi e accreditamenti.** Regione Piemonte (SAR e AURA), Sistema TS (ricette e certificati) e FSE 2.0 richiedono credenziali di test e il superamento di prove. Per firmare contratti con loro e con la banca dati farmaci serve una società o almeno una partita IVA.

## Bozza dello schema del database

Il cuore è un'unica entità **Voce clinica** con i campi comuni (paziente, data, autore, note, allegati, promemoria), più un dettaglio per ogni tipo. Tutto è separato per studio. Proposta tecnica: database relazionale (es. PostgreSQL) con storico delle modifiche.

| Entità | Campi principali | Collegata a |
| --- | --- | --- |
| Studio | nome, indirizzo, tipo (singolo o gruppo) | Utenti, Pazienti |
| Utente | nome, ruolo, secondo fattore, stato | Studio, Profilo medico |
| Profilo medico | codice regionale, ASL, intestazioni, timbro, credenziali esterne cifrate | Utente |
| Paziente | anagrafica, codice fiscale, recapiti, famiglia, ASL, stato (attivo, revocato, deceduto, temporaneo) | Studio |
| Scelta | data scelta, scadenza, cessazione, motivo, fonte (AURA o manuale) | Paziente, Profilo medico |
| Esenzione | codice, dal, al, codice in ricetta, fonte | Paziente, catalogo esenzioni |
| Consenso e delega | tipo, stato, date, delegato | Paziente |
| Voce clinica | tipo, data, autore, note, allegati, promemoria, stato | Paziente, dettaglio per tipo |
| Dettagli della voce | problema (ICD-9-CM), nota di diario, misura (tipo, valore, unità), anamnesi, allergia, vaccinazione (vaccino, lotto), esame (analita, valore, unità, intervallo), referto | Voce clinica |
| Terapia | farmaco, posologia, cronica o al bisogno, inizio, fine | Paziente, farmaco, Piano terapeutico |
| Piano terapeutico | farmaco, concesso il, scade il, centro, confezioni | Paziente, farmaco |
| Ricetta | tipo, stato, NRE, priorità, quesito, esenzione, preparata da, firmata da | Paziente, Utenti |
| Riga di ricetta | farmaco o prestazione, quantità, nota AIFA, non sostituibile | Ricetta, cataloghi |
| Certificato INPS | tipo, visita, dal, al, diagnosi, reperibilità, protocollo, stato | Paziente, Profilo medico |
| Appuntamento | inizio, fine, tipo (studio, domicilio, televisita), stato | Paziente, Profilo medico |
| Richiesta del paziente | tipo, testo, stato, esito | Paziente, Ricetta o Appuntamento generati |
| Invio esterno | sistema, operazione, richiesta, risposta, esito, data | Ricetta, Certificato, Paziente |
| Registro accessi | utente, paziente, azione, data, postazione | Utente, Paziente |
| Cataloghi | farmaci, prestazioni regionali, ICD-9-CM, esenzioni, vaccini, comuni e ASL | Aggiornati da fonti esterne |

Le code di lavoro non sono tabelle ma viste calcolate (es. piani terapeutici che scadono entro 30 giorni). I dati clinici non si cancellano mai: si annullano con motivo, e lo storico resta.

## Priorità

La prima versione è quella che permette a Chiara di lasciare il software attuale; tutto il resto viene dopo. I tempi dipendono soprattutto dai collaudi esterni, non dalla scrittura del codice.

**Prototipo (settimane)**

- Oggi, elenco pazienti, cartella, diario, terapie, ricette in bozza, agenda.
- Solo dati inventati; serve a validare l'uso con Chiara.

**Versione 1 (uso reale nello studio di Chiara)**

- Ricette farmaceutiche e specialistiche via SAR, con il flusso segreteria → firma del medico.
- AURA: anagrafica, scelte e revoche, esenzioni.
- Certificati di malattia INPS.
- Banca dati farmaci, piani terapeutici e tutte le regole di prescrizione R1–R11, compresi contatore delle confezioni e vincoli dei piani: il software attuale di Chiara le ha già, quindi sono il minimo.
- Ruoli, registro accessi, backup, stampa dei promemoria.
- Importazione dei dati dal software attuale.
- Fascicolo Sanitario Elettronico (Profilo Sanitario Sintetico), appena l'accreditamento lo permette.

**Fase 2**

- App o portale per i pazienti.
- Flussi regionali (diabete, vaccinazioni, PPIP) e spese sanitarie per la precompilata.
- Fatture per prestazioni private, statistiche avanzate.
- Medicina di gruppo con più archivi, altre regioni.

## Domande aperte

Le risposte di Chiara decidono le priorità; quelle di Regione e Sistema TS decidono i tempi.

**Per Chiara**

- [ ] Quali sono le 10 azioni che fai più spesso in una giornata, e quanto tempo ti prendono oggi?
- [ ] Cosa ti rallenta o ti irrita di più nel lavoro al computer?
- [ ] Cosa deve poter fare la segreteria, e cosa no?
- [ ] Lavori in medicina di gruppo o con sostituti? Con quali regole di accesso alle cartelle?
- [ ] Quali percorsi regionali segui (diabete, BPCO, scompenso)?
- [ ] Nelle visite a domicilio useresti un tablet?

**Per Regione Piemonte e CSI**

- [ ] Procedura e tempi per avere documentazione e ambiente di test del SAR e di AURA come software house.
- [ ] Il SAR comunica al medico quando una ricetta viene erogata in farmacia?
- [ ] Requisiti dei flussi regionali (diabete, vaccinazioni, PPIP).

**Per Sistema TS e Ministero**

- [ ] Kit di sviluppo e credenziali di test per ricette e certificati INPS.
- [ ] Percorso e tempi di accreditamento al Fascicolo Sanitario Elettronico 2.0.

**Per Evolus (la chiede Chiara, come cliente)**

- [ ] In che formato vengono consegnati i dati alla fine del contratto? Si può avere un'esportazione completa già adesso?

**Per fornitori e consulenti**

- [ ] Costo della licenza Farmadati per una software house, e alternative.
- [ ] Avvocato: perimetro della licenza attuale e regole di sviluppo indipendente.
- [ ] Consulente regolatorio: quali funzioni farebbero del software un dispositivo medico.
- [ ] Consulente privacy: contratto di nomina, valutazione d'impatto, eventuale responsabile della protezione dei dati.

## Fonti

- [Regione Piemonte – SIRPED, requisiti di integrazione SAR con le cartelle MMG/PLS](https://servizi.regione.piemonte.it/media/1019/download)
- [Regione Piemonte – Web service ad autenticazione forte per il SAC](https://servizi.regione.piemonte.it/media/3354/download)
- [AURA – Manuale dei servizi di cooperazione](https://servizi.regione.piemonte.it/media/786/download)
- [Regione Piemonte – Integrazione di AURA con l'Anagrafe Nazionale Assistiti](https://www.regione.piemonte.it/web/node/22064)
- [Regione Piemonte – Fascicolo Sanitario Elettronico 2.0](https://www.regione.piemonte.it/web/node/19984)
- [AIFA – Tabella di classificazione dei medicinali](https://www.aifa.gov.it/documents/20142/0/tabella_classificazione_medicinali.pdf)
- [AIFA – Note AIFA](https://www.aifa.gov.it/it/note-aifa)
- [Regione Piemonte – Farmaci PHT oggetto di DPC (aggiornamento 09/07/2026)](https://www.regione.piemonte.it/web/media/57684/download)
- [Sistema TS – Specifiche tecniche ricetta dematerializzata, prescrizione (5/12/2024)](https://sistemats1.sanita.finanze.it/portale/documents/20182/81804/20241205_Specifiche%20tecniche%20ricetta%20dematerializzata%20-%20prescrizione/7cfbbd34-e929-d051-d5b2-629232f3d79e)
- [Osservatorio Malattie Rare – Ricetta annuale per i cronici, decreto attuativo non ancora adottato (29/06/2026)](https://www.osservatoriomalattierare.it/news/politiche-socio-sanitarie/23156-ricetta-annuale-per-i-pazienti-cronici-dopo-sei-mesi-il-decreto-attuativo-non-e-ancora-arrivato)
- [DBMedica – Ricetta bianca dematerializzata nel 2026](https://www.dbmedica.it/news/ricette-bianche-digitali-2026-cosa-devono-fare-gli-specialisti/)
- [AIFA – Liste dei farmaci (open data)](https://www.aifa.gov.it/liste-dei-farmaci)
- [AIFA – Open data, licenza CC BY 4.0](https://www.aifa.gov.it/open-data)
- [AIFA – Liste di trasparenza pubblicate il 15 di ogni mese](https://www.aifa.gov.it/documents/20142/241044/Comunicazione_AIFA_2.pdf)
- [AIFA – Sei servizi digitali sulla Piattaforma Digitale Nazionale Dati (13/10/2026)](https://www.aifa.gov.it/-/aifa-nella-piattaforma-digitale-nazionale-dati)
- [Regione Piemonte – D.D. 710 del 30/10/2026: catalogo, nomenclatore e nuove esenzioni](https://www.regione.piemonte.it/governo/bollettino/abbonati/2026/44/attach/ddxst00000710_11200.pdf)
- [Regione Piemonte – D.D. 1167/2022: controllo bloccante del SAR fra esenzione e prestazioni](https://www.regione.piemonte.it/governo/bollettino/abbonati/2022/28/attach/dda1410001167_10100.pdf)
- [Regione Piemonte – Farmaci in distribuzione per conto (PHT)](https://www.regione.piemonte.it/web/node/964)
- [DM Salute 23/10/2025: adozione di ICD-10-IM e CIPI (GU n. 286 del 10/12/2025)](https://www.mefop.it/cms/doc/29766/dm-salute-23-ottobre-2025.pdf)
- [ISTAT – Codici statistici delle unità amministrative](https://www.istat.it/it/archivio/6789)
- [Farmadati Italia – Codifa (App Store)](https://apps.apple.com/app/id6755812251)
- Contratto di licenza d'uso di Next² (copia fornita dallo studio)
