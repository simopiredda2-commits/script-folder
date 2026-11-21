# Prestazioni aggiuntive (PPIP)

Le prestazioni di particolare impegno professionale (PPIP) sono le prestazioni aggiuntive che il medico di medicina generale esegue in studio o a domicilio e che l'ASL paga una per una. Il programma le registra nella cartella del paziente e prepara la distinta mensile per l'ASL. L'invio della distinta oggi è un **simulatore**: il programma non chiama nessun servizio vero (regola 7).

Simone ha chiesto il 20/11/2026: «Ok adesso ma predisponiamo il tutto in modo che venga aggiornato dopo che regione e asl ci dicono come procedere» (D212). Per questo le tre parti che Regione e ASL possono cambiare sono dati o interfacce, non codice:

- l'elenco delle prestazioni con i compensi;
- il formato della distinta;
- il modo di mandarla.

Le scelte di dettaglio sono in D213.

## Fonti

- **ACN della medicina generale 2022-2024, allegato 6** («Prestazioni aggiuntive»). L'intesa è del 15/1/2026 (Rep. atti n. 1/CSR), pubblicata nella GU n. 24 del 30/1/2026, S.O. n. 5, alle pagine 146 e 147 del supplemento. L'accordo vale dalla data dell'intesa (art. 2, comma 4). L'allegato dice:
  - comma 2: le prestazioni si eseguono a domicilio o nello studio, «a seconda delle condizioni di salute del paziente»;
  - comma 4: entro il 15 di ogni mese il medico manda il riepilogo delle prestazioni del mese prima; per ciascuna, data di effettuazione, nome, cognome, indirizzo e codice fiscale dell'assistito;
  - comma 5: per le prestazioni soggette ad autorizzazione vanno con la distinta anche l'autorizzazione e il modulo regionale delle prestazioni multiple autorizzate;
  - il nomenclatore tariffario ha la sezione A (senza autorizzazione, 12 voci), la sezione B (con autorizzazione sanitaria, 4 voci) e la sezione C, che non elenca prestazioni e rimanda agli accordi regionali e aziendali.
- **ACN del 26/6/2026** (GU n. 149 del 30/6/2026). Cambia gli articoli 1, 31, 43 e 47; l'allegato 6 resta com'era.
- **Accordo integrativo regionale del Piemonte (AIR 2024)**: pre-intesa del 21/5/2024, recepita con la DGR 27/5/2024, n. 31-8647 (BU n. 22 del 30/5/2024). Vale dal 1/1/2025. Per le PPIP conta:
  - art. 35, comma 4: le prestazioni dell'allegato 6 eseguite in ADI si pagano in più dell'accesso; ogni trasfusione di sangue intero o dei suoi derivati, in ADI o in ADR, vale 55 €;
  - art. 30, comma 1, lettera c), n. 3 (medici ad attività oraria): rendicontazione delle prestazioni aggiuntive «attraverso portale regionale»;
  - art. 36, comma 6 (visite occasionali e assistenza ai turisti): per quella rendicontazione l'ASL predispone uno strumento di rilevazione su supporto digitale «come previsto per le prestazioni di cui all'Allegato 6».
- **Da avere da Regione e ASL**: come si manda la distinta (portale, formato, modulo delle prestazioni multiple), l'accordo aziendale se prevede prestazioni della sezione C, chi autorizza le prestazioni della sezione B e con quali estremi.

I tre PDF sono stati scaricati il 20/11/2026 e non sono nel repository: impronte in `docs/provenienze.md`.

## Che cosa fa il programma

### Catalogo

- **Tipo di banca dati** `prestazioni_aggiuntive`, con le trascrizioni in `packages/reference/data/trascrizioni/ppip/`: una serie per livello. Oggi sono due:
  - `acn-prestazioni-aggiuntive`: allegato 6, 16 voci;
  - `piemonte-prestazioni-aggiuntive`: AIR 2024, art. 35, comma 4, una voce.
- **Campi**: codice, sezione, descrizione, se serve l'autorizzazione, compenso in euro, note.
- **Quale catalogo vale**: quello in vigore il giorno dell'esecuzione, con tutte le serie insieme. Se lo stesso codice è in due serie, vale quella con la data di efficacia più recente.
- **Dove vale una serie** (D232): la trascrizione può dire il suo `ambito`, cioè la regione, l'ASL o tutte e due. Un accordo aziendale vale solo per gli archivi della sua ASL (quella scritta nel profilo del medico titolare), uno regionale solo per gli studi della sua regione; una serie senza ambito vale in tutta Italia. I nomi si confrontano senza maiuscole, accenti e segni («ASL TO3» e «Asl To 3» sono la stessa). Con la stessa data di efficacia vale l'atto più vicino: ASL, poi regione, poi Italia; a parità anche di questo, l'importazione più recente. L'AIR del Piemonte ha l'ambito `{"regione": "Piemonte"}`.
- **Il catalogo di un paziente** è quello del suo archivio: la regione dello studio e l'ASL del titolare. Senza archivio (per esempio la pagina aperta dall'amministratore) vale la regione dello studio.
- **Le trascrizioni vere hanno `controllato_da` vuoto**: non si usano finché una persona non le confronta con gli atti (A8, D159). Fino ad allora il modulo dice «Nessun catalogo delle prestazioni aggiuntive in vigore». Le trascrizioni d'esempio (`fixtures/banche-dati/trascrizioni/ppip/`) hanno le stesse righe e risultano controllate: servono alle prove e alla dimostrazione.

### In cartella

Pagina «Prestazioni aggiuntive» della cartella, `/pazienti/:id/prestazioni-aggiuntive`. Per registrare una prestazione si danno:

- data dell'esecuzione: non nel futuro, non dopo il decesso del paziente;
- voce del catalogo in vigore quel giorno: le voci sono per sezione, con il compenso;
- quantità, da 1 a 99;
- dove: in studio o a domicilio (comma 2);
- estremi dell'autorizzazione: obbligatori per la sezione B (comma 5);
- note, se servono.

Il servizio rifiuta una voce che non è nel catalogo di quel giorno. Le prestazioni non si cancellano: si annullano con un motivo, finché non sono partite con la distinta. Dopo l'invio la correzione si chiede all'ASL. Mentre la distinta sta partendo («in invio») una prestazione non si annulla: si annulla solo se l'invio non va a buon fine.

**Una prestazione è dell'archivio in cui è registrata** (D232), come le ricette e i certificati (D200). Se il paziente passa a un altro medico dello studio con «Sposta», le sue prestazioni restano nella distinta di chi le ha registrate. Nella cartella il nuovo medico le vede con il nome dell'archivio dove sono nate e senza «Annulla»: si annullano da quella distinta.

Chi può fare che cosa:

- il titolare dell'archivio e i medici con accesso all'archivio (sostituto, medicina di gruppo) registrano e annullano;
- la segreteria confermata per l'archivio (D185) prepara: registra e annulla;
- la distinta e il suo CSV li vedono il titolare e la segreteria (permesso `ppip.report`, D232), come i riepiloghi (D201, D204): non il sostituto né il collega di gruppo, perché la distinta riguarda i compensi del titolare;
- la distinta la manda solo il titolare (permesso `ppip.send`), come la firma.

Ogni lettura, registrazione e annullamento resta nel registro degli accessi del paziente, nella stessa transazione della scrittura.

### Distinta del mese

Pagina «Prestazioni aggiuntive» dell'archivio, `/archivio/prestazioni-aggiuntive`. Si apre dall'Archivio («Apri la distinta») e dai Riepiloghi. Per difetto mostra il mese scorso e il proprio archivio. Contiene:

- **una riga per prestazione**: data, assistito con codice fiscale e indirizzo di residenza, voce, quantità, luogo, importo, stato dell'invio;
- **i totali per voce** e la scadenza del 15 del mese dopo;
- **il CSV della distinta**, nei formati di `apps/api/distinte/ppip-formati.json`. Oggi ce n'è uno solo, `acn-allegato-6`, con i campi del comma 4 più codice, prestazione, quantità, luogo, autorizzazione e compenso. Il CSV usa punto e virgola, UTF-8 con BOM, date gg/mm/aaaa e decimali con la virgola.

Il titolare la manda dopo aver spuntato «Ho controllato la distinta». La distinta si può mandare solo dal primo giorno del mese dopo, e partono solo le prestazioni non ancora inviate. **Partono proprio quelle che il titolare ha visto** (D232): la pagina manda al servizio l'elenco delle prestazioni controllate e, se nel frattempo se n'è aggiunta o annullata una, il servizio risponde «La distinta è cambiata dopo il controllo: ricontrollala prima di mandarla».

L'invio va in tre passi (D232):

1. le prestazioni passano «in invio», tutte insieme: nessun altro invio le manda e nessuno le annulla. La distinta come parte si fissa nella tabella `ppip_sending` (D239), finché l'invio non ha un esito;
2. il programma manda la distinta al portale, fuori da ogni transazione, e aspetta al più il tempo massimo dello studio (D94, D239);
3. alla risposta, l'esito, il segno sulle prestazioni e il registro degli accessi si scrivono insieme.

L'esito dipende dalla risposta:

- accolta: le prestazioni sono «Inviata all'ASL» con il protocollo;
- non accolta, o ASL non raggiungibile: tornano da inviare;
- **nessuna risposta chiara** (il collegamento si interrompe, il servizio si ferma a metà): le prestazioni restano «in invio», perché la distinta potrebbe essere arrivata e rimandarla la farebbe arrivare due volte. Dopo 15 minuti la distinta lo dice e il titolare, dopo averlo chiesto all'ASL, segna l'esito: «È arrivata all'ASL», con il riferimento se l'ASL lo dà, e le prestazioni risultano partite; oppure «Non è arrivata: torna da inviare». Prima di segnarlo lo conferma, perché l'esito non si cambia dopo (D239). L'esito segnato registra la distinta come era partita, quella fissata al primo passo, non com'è adesso: un indirizzo corretto nel frattempo non cambia ciò che è partito. Lo stesso vale se il portale non risponde entro il tempo massimo.
- **risposta arrivata dopo l'esito segnato a mano**: chi aspettava riceve «Nel frattempo l'esito di questo invio è stato segnato a mano». La risposta resta fra gli invii della distinta, con l'ora in cui era partita e la frase «Risposta del portale arrivata dopo l'esito segnato a mano», e nel registro degli accessi come «fallito». Le prestazioni restano come le ha segnate il titolare: prima di mandarle di nuovo, chiede all'ASL (D233, D239).

**Consegnata all'ASL fuori dal programma** (D232): se la distinta arriva all'ASL in un altro modo, per esempio con il CSV sul portale regionale, il titolare spunta la conferma, scrive il riferimento della consegna se c'è e segna come partite le prestazioni controllate. Da lì non si annullano più, come quelle mandate dal programma.

Dalla distinta si annulla anche una prestazione da inviare, con il motivo, senza aprire la cartella. Un assistito passato nel frattempo a un altro medico resta nella distinta, senza il collegamento alla cartella e con «(ora assistito di un altro medico)». La distinta avvisa se manca l'indirizzo di residenza di qualche assistito, che il comma 4 chiede.

Ogni invio, consegna o esito segnato resta nella tabella `ppip_report`, con il contenuto mandato, e non si modifica. Gli esiti segnati dal titolare hanno l'ambiente «manuale».

**In produzione con il simulatore l'invio dal programma è spento** e la pagina lo dice: resta il CSV, che il medico carica dove l'ASL dice, e poi la consegna fuori dal programma.

Il totale non c'è se una voce non ha il compenso nel catalogo. Il mese si sceglie con il campo del mese; dove il browser non ha il selettore e mostra un campo di testo, si scrive AAAA-MM o MM/AAAA, e un mese scritto male si dice.

## Modello dei dati

- **`ref_additional_service`**: le voci del catalogo, per versione della banca dati. Non si modifica.
- **`ppip_record`**: le prestazioni registrate. Ogni riga porta:
  - la voce com'era nel catalogo quel giorno: codice, sezione, descrizione, autorizzazione, compenso, versione della banca dati;
  - quantità, luogo, estremi dell'autorizzazione e note;
  - l'archivio in cui è registrata (`archive_id`, D232), che non cambia quando il paziente cambia medico;
  - lo stato (registrata o annullata), l'invio con cui è partita e, durante un invio, da quando e di chi (`sending_since`, `sending_by`).

  Lo storico delle modifiche è automatico. Le righe non si cancellano: si annullano con un motivo. Il database stesso tiene fermi i dati (migrazione 0042, D232): una prestazione registrata non cambia voce, data, quantità o luogo; una annullata o partita non cambia più; una «in invio» ha sempre chi la manda e non è partita né annullata.

- **`ppip_report`**: gli invii della distinta, con esito, protocollo, messaggio, ambiente (simulatore o servizio vero), numero di righe, totale e contenuto mandato. Non si modifica e non si cancella.
- **Esportazione completa** (`docs/esportazione.md`): `ppip_record` tra le tabelle dei pazienti, `ppip_report` tra quelle dell'archivio. Come per le ricette (D200), l'esportazione segue il paziente: le sue prestazioni vanno con l'archivio dove sta adesso, ognuna con l'archivio in cui è nata.

## Che cosa è diverso dagli atti

- **Codici**: lettera della sezione e numero della voce (A1–A12, B1–B4), scelti qui; l'allegato numera le voci dentro ogni sezione. La voce dell'AIR ha il codice `AIR35.4` (articolo e comma), scelto qui.
- **Note**: gli asterischi delle voci sono sostituiti dal testo della nota, nella colonna note.
- **Due letture ottiche corrette a vista**: «{solo su pazienti non ambulabili)» e «io studio medico». Sono diventate «(solo su pazienti non ambulabili)» e «lo studio medico».
- **Compensi**: in euro, come nella colonna dell'allegato, che non ha intestazione.
- **Sezione C**: nessuna voce, perché l'allegato non ne elenca.
- **Voce dell'AIR**: descrizione accorciata dal testo dell'articolo, con la condizione «in ADI o in ADR». La nota dice che si paga in più dell'accesso in ADI.

## Che cosa controllare

Una persona diversa da chi ha trascritto confronta le 17 righe con gli atti e scrive il suo nome in `controllato_da` dei due file JSON. Da controllare:

- **allegato 6**, pagine 146 e 147 del S.O. n. 5: descrizioni, compensi, sezione di ogni voce, note;
- **AIR 2024**, art. 35, comma 4: descrizione e compenso della trasfusione.

Senza il controllo il catalogo non si usa.

## Come si aggiorna quando Regione e ASL rispondono

- **Un accordo nuovo** (ACN, AIR o accordo aziendale dell'ASL):
  1. si aggiunge una trascrizione in `packages/reference/data/trascrizioni/ppip/` con la sua serie (per esempio `asl-to3-prestazioni-aggiuntive`), l'atto e la data di efficacia;
  2. una seconda persona la controlla;
  3. si importa con le banche dati.

  Un codice già presente in un'altra serie vale dalla data della nuova. Le prestazioni già registrate tengono la voce e il compenso del giorno in cui sono state eseguite.

- **Il formato della distinta dell'ASL**: un formato nuovo in `apps/api/distinte/ppip-formati.json`, con le colonne scelte fra i campi di una riga della distinta. Compare da solo nella pagina. Una prova controlla che ogni colonna usi un campo che esiste.
- **L'invio vero**: un'implementazione dell'interfaccia `AdditionalServicesPortal` (`packages/integrations/src/additional-services-portal.ts`), al posto del simulatore in `apps/api/src/app.ts`. Il resto del ciclo non cambia: distinta, esito, protocollo, invii registrati.
- **Il modulo regionale delle prestazioni multiple autorizzate** (comma 5): non c'è, perché il modello non è pubblico; si aggiunge quando la Regione lo manda. Oggi la distinta porta gli estremi dell'autorizzazione di ogni prestazione.

## Come provarlo

- Servizio: `apps/api/test/ppip.test.ts`, 13 prove. Coprono:
  - catalogo per data, con un accordo aziendale inventato che cambia un compenso da una data e vale solo nella sua ASL; a parità di data vince l'atto più vicino, anche se una serie nazionale si importa dopo;
  - controlli della registrazione e ruoli;
  - distinta, totale e CSV;
  - invio accolto e rifiutato, annullamento, produzione con il simulatore;
  - esportazione, trigger e formati.
- Servizio, invio senza gare: `apps/api/test/ppip-invio.test.ts`, 12 prove (D232). Fermano il portale a metà o tengono bloccate le righe da una seconda connessione, così le gare si ripetono uguali:
  - due invii insieme: la distinta parte una volta;
  - annullamento durante l'invio, due annullamenti insieme, annullamento a metà di un invio;
  - una prestazione arrivata dopo il controllo fa ricontrollare la distinta;
  - invio senza risposta, poi «arrivata» o «non arrivata»; consegna fuori dal programma;
  - paziente spostato a un altro medico: la prestazione resta nella distinta di prima;
  - i dati fermi nel database; chi legge distinta e CSV; produzione con il simulatore.
- Interfaccia: `apps/web/test/ppip.test.tsx`, 9 prove.
- Browser: `apps/api/test/e2e/interfaccia.test.ts`, «prestazioni aggiuntive (D212)». La prova registra dalla cartella una B2 con l'autorizzazione, apre la distinta dall'Archivio, scarica il CSV e manda la distinta al simulatore; poi controlla in cartella lo stato «Inviata all'ASL». Controlla anche accessibilità, bersagli e tablet.
- Schermate: 72 (cartella) e 73 (distinta), in `docs/interfaccia.md`.

## Che cosa non è provato

- **L'invio vero, il formato dell'ASL e il modulo delle prestazioni multiple**: non si conoscono.
- **Il confronto della trascrizione con gli atti** da parte di una seconda persona: è il controllo qui sopra.
- **Le prestazioni della sezione C** di un accordo aziendale: oggi nessuna.
- **Le condizioni di una voce** (paziente in ADI, studio con il frigorifero o con gli impianti fissi, autorizzazione complessiva delle vaccinazioni): il programma non le controlla. Le note della voce le ricordano a chi registra.
- **Le vaccinazioni (B4) e la voce «vaccinazione» della cartella**: non sono collegate. Chi registra la prestazione scrive a parte la vaccinazione nella cartella.
- **Il pagamento dei compensi**: lo fa l'ASL, entro il secondo mese dopo l'invio (comma 7), e il programma non lo segue.
- **Due prestazioni uguali lo stesso giorno** per lo stesso paziente: il programma non avvisa, perché la stessa voce può servire più volte nello stesso giorno (per questo c'è la quantità). Chi controlla la distinta le vede una accanto all'altra (D232).
- **Il CSV è la distinta intera del mese**, anche con le prestazioni già partite, ognuna con il suo stato: si sceglie che cosa caricare quando l'ASL dirà come vuole il file.
- **I numeri del simulatore** ripartono da capo a ogni avvio del servizio: valgono solo nelle prove.
- **Il campo del mese come testo**: la prova dell'interfaccia controlla la lettura di AAAA-MM e MM/AAAA, non il campo in un browser senza il selettore del mese.
