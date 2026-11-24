# Collaudo finale

L'ultima verifica prima di usare il programma con pazienti veri (D247, D261). Raccoglie in un posto solo ciò che resta da guardare: le prove nella dimostrazione, i contenuti da controllare, le decisioni e i materiali di Simone, le risposte degli enti, le prove tecniche che restano. Le voci vengono da «Che cosa resta aperto» in `docs/avanzamento.md` e dai punti «da confermare» dei documenti.

**Come si segna l'esito.** Nella pagina del collaudo (https://claude.ai/artifact/X58AnakriJzqaApLjHa5kR), fatta da questo documento: per ogni voce «Va bene», «Da correggere» (con che cosa non va, nella nota) o «Non ancora» (con che cosa manca). Gli esiti si salvano subito, li vede chi apre la pagina e Claude li rilegge. Chi segna gli esiti ha bisogno della pagina condivisa da Simone come «Collaboratore»; in alternativa basta scrivere il codice della voce, per esempio «G4: da correggere, il promemoria esce su due pagine». Ogni «Da correggere» diventa una correzione, con la sua prova; ogni «Non ancora» resta qui con il motivo.

**Dove si prova.** Nella dimostrazione (https://claude.ai/artifact/Md4KFYrVagjLdnNewSMzCQ): programma, database e simulatori girano nel browser, con pazienti inventati. Utenti: `medico` (medico titolare), `segreteria`, `sostituto`, `amministratore`, `collega` (nello stesso studio), `medico.aft` (in un altro studio dell'AFT); la password e il codice del secondo fattore sono nel riquadro «Dimostrazione». «Ricomincia da capo» riparte dai dati di partenza. Non scrivere dati di persone vere.

## Parte 1 · Una giornata di lavoro nella dimostrazione

Per la Dr.ssa Rocca, con Simone. Si guarda se il lavoro di tutti i giorni si fa in modo chiaro e senza passaggi inutili, e se i testi sono giusti.

### G1 · Accesso

- **Chi**: Dr.ssa Rocca
- **Dove**: dimostrazione, utente `medico`
- **Che cosa guardare**: password, collegamento dell'app di autenticazione e codice del secondo fattore; poi dal nome in alto, «Credenziali»: accesso regionale con SPID simulato e codice di sessione del Sistema TS. I passaggi sono chiari? Che cosa succede dopo qualche minuto senza usare il programma?

### G2 · Oggi

- **Chi**: Dr.ssa Rocca
- **Dove**: pagina «Oggi»
- **Che cosa guardare**: ricette da firmare e invii senza risposta; le notizie di AURA simulata (esenzione nuova, ASL diversa, decesso da confermare, revoca, nuovo assistito da registrare, cambio di medico da decidere); variazioni AIFA e carenze sui farmaci in terapia. Si capisce che cosa fare per ciascuna?

### G3 · Pazienti e cartella

- **Chi**: Dr.ssa Rocca
- **Dove**: «Pazienti», poi una cartella
- **Che cosa guardare**: ricerca; fascia del paziente con le esenzioni in corso; menu della cartella; riepilogo e cronologia; dati amministrativi a sezioni; «Nuovo paziente», anche temporaneo. Manca qualcosa che serve ogni giorno?

### G4 · Ricetta SSN dei farmaci

- **Chi**: Dr.ssa Rocca
- **Dove**: cartella › «Nuova ricetta»
- **Che cosa guardare**: ripetere una terapia cronica; cercare un farmaco (amlodipina) e aggiungerlo con le confezioni; i controlli delle regole; il passo unico «Firma e invia» e quando si ferma; l'anteprima del promemoria prima della firma; il promemoria su A5 e su A4; la consegna per email al paziente o al delegato. I messaggi dei controlli sono comprensibili?

### G5 · Farmaci fuori dalle classi A e H

- **Chi**: Dr.ssa Rocca
- **Dove**: «Nuova ricetta» e «Farmaci e prestazioni»
- **Che cosa guardare**: l'alprazolam (classe C) su una ricetta SSN: la R8 informa che non è negli elenchi AIFA di classe A e H e che, se non è a carico del SSN, si prescrive su ricetta bianca (D261). Va bene un'informazione, o deve bloccare? La ricetta bianca dello stesso farmaco. In «Farmaci e prestazioni», l'ibuprofene da banco con il suo regime di fornitura.

### G6 · Ricetta specialistica

- **Chi**: Dr.ssa Rocca
- **Dove**: cartella › «Specialistica»
- **Che cosa guardare**: la ricerca nel catalogo regionale (D.D. 590/2026 con le modifiche della D.D. 710/2026, trascrizione ancora da controllare: K3); tipo di accesso, classe di priorità, quesito diagnostico; la validità di 60 giorni per il primo accesso e 180 per gli altri (D260); l'esenzione per patologia (R17).

### G7 · Certificato di malattia INPS

- **Chi**: Dr.ssa Rocca
- **Dove**: cartella › «Certificati»
- **Che cosa guardare**: inizio, continuazione o ricaduta; visita ambulatoriale o domiciliare; prognosi; diagnosi ICD-9-CM e testo; reperibilità; invio con il protocollo; copia al lavoratore; al datore di lavoro il protocollo con nome e cognome, mai la diagnosi; rettifica e annullamento.

### G8 · Presidi

- **Chi**: Dr.ssa Rocca
- **Dove**: cartella › «Presidi»
- **Che cosa guardare**: la scelta dal nomenclatore (allegati 2 e 3 del DPCM LEA, ancora da controllare: K4) con la quantità accanto alla voce; le medicazioni avanzate (K5).

### G9 · Voci cliniche, privacy e Profilo sanitario

- **Chi**: Dr.ssa Rocca
- **Dove**: cartella › «Voci cliniche», «Privacy», «Profilo sanitario»
- **Che cosa guardare**: problemi, allergie e reazioni, diario, parametri, anamnesi, stili di vita, esame obiettivo; consensi, deleghe e oscuramento; piani terapeutici; il Profilo sanitario sintetico preparato dalla cartella, validato, firmato e pubblicato.

### G10 · Segreteria

- **Chi**: Dr.ssa Rocca, con chi lavora in segreteria
- **Dove**: utente `segreteria`, poi di nuovo `medico`
- **Che cosa guardare**: la segreteria prepara le ripetizioni delle terapie croniche e stampa i promemoria, ma non firma e non invia; il medico convalida sempre le ricette preparate dalla segreteria. Che cosa altro dovrebbe poter fare la segreteria, o non fare?

### G11 · Invii senza risposta

- **Chi**: Dr.ssa Rocca
- **Dove**: «Ricette › Invii senza risposta» e, nella cartella del paziente indicato nel riquadro, «Certificati»
- **Che cosa guardare**: una ricetta e un certificato rimasti «in invio»: il medico segna l'esito chiesto all'ente, con il codice di autenticazione per la ricetta SSN (D240).

### G12 · Medici dell'AFT

- **Chi**: Dr.ssa Rocca
- **Dove**: «Strumenti › AFT»
- **Che cosa guardare**: la scheda del paziente di un collega che ha dato il consenso, con il motivo dell'accesso; l'utente `medico.aft` dall'altra parte.

### G13 · Prestazioni aggiuntive

- **Chi**: Dr.ssa Rocca
- **Dove**: cartella › «Prestazioni aggiuntive», poi la distinta del mese
- **Che cosa guardare**: registrazione con il compenso del catalogo; la distinta del mese e il CSV; il catalogo stesso è ancora da controllare (K6).

### G14 · Cambio di medico dentro lo studio

- **Chi**: Dr.ssa Rocca
- **Dove**: «Oggi», avviso del cambio di medico
- **Che cosa guardare**: «Sposta» e «Non spostare» per i pazienti che hanno scelto la collega dello studio.

### G15 · Strumenti e amministrazione

- **Chi**: Simone
- **Dove**: utente `amministratore`, poi `medico`
- **Che cosa guardare**: utenti e ruoli, con la conferma del titolare; dati dello studio, postazioni, preferenze di stampa, intestazioni, elenchi dello studio; registro delle azioni di amministrazione; stato del servizio e delle banche dati.

### G16 · Riepiloghi ed esportazione

- **Chi**: Dr.ssa Rocca e Simone
- **Dove**: «Riepiloghi» e «Archivio» (esportazione dei dati del medico)
- **Che cosa guardare**: visite, prescrizioni e vaccinazioni per periodo, con il CSV; l'esportazione completa in formato aperto: si apre e si capisce?

## Parte 2 · Contenuti da controllare

Per la Dr.ssa Rocca, o per chi lei indica. Una trascrizione entra nel programma solo quando una persona diversa da chi l'ha scritta l'ha confrontata con l'atto e ha scritto il suo nome in «controllato da» (A8).

### K1 · Regole di prescrizione

- **Chi**: Dr.ssa Rocca, con un consulente per i riferimenti normativi
- **Dove**: `docs/regole.md`
- **Che cosa guardare**: le 22 regole, con i valori e le fonti: oggi «Validata: no». In particolare le «Scelte da guardare»: come si contano i giorni di validità (R1), le confezioni per ricetta (R2–R4), la R8 fuori dalle classi A e H (D261), il principio attivo (R13), il delegato (R16), lo stato del paziente (R19, R20), carenze e confezioni sospese (R21, R22).

### K2 · Diagnosi ICD-9-CM

- **Chi**: Dr.ssa Rocca o chi lei indica
- **Dove**: `docs/icd9cm.md`
- **Che cosa guardare**: la trascrizione della versione italiana 2007 e delle aggiunte COVID-19, con ciò che è diverso dal PDF.

### K3 · Catalogo regionale delle prestazioni

- **Chi**: Dr.ssa Rocca, con l'ASL
- **Dove**: `docs/catalogo-regionale.md`
- **Che cosa guardare**: la D.D. 590/2026 e le modifiche della D.D. 710/2026 trascritte dai PDF.

### K4 · Allegati del DPCM LEA

- **Chi**: Dr.ssa Rocca o chi lei indica
- **Dove**: `docs/banche-dati.md`, sezioni sulle esenzioni e sui presidi del DPCM LEA
- **Che cosa guardare**: allegati 8 e 7 (esenzioni), con le due differenze di scrittura rispetto ai decreti del 2026 (D236); allegato 3 (30 voci di presidi, D218); allegato 2 (87 ausili monouso, con quantità e intestazioni, D238).

### K5 · Medicazioni avanzate

- **Chi**: Dr.ssa Rocca
- **Dove**: «Presidi», voci del gruppo 04.49 dell'allegato 2
- **Che cosa guardare**: quali voci la Dr.ssa Rocca considera medicazioni avanzate (D238). I 6 mesi del vademecum della Regione: per ogni prescrizione del medico di famiglia, come fa oggi il programma, o dalla prima dello specialista; Simone ha detto «Lo verifichiamo noi» (D240).

### K6 · Prestazioni aggiuntive

- **Chi**: Dr.ssa Rocca
- **Dove**: `docs/ppip.md`
- **Che cosa guardare**: le 17 voci trascritte dall'ACN e dall'AIR; come manda oggi la distinta all'ASL (con il CSV e poi «Consegnata all'ASL fuori dal programma», o in un altro modo, D232).

### K7 · Modelli dei certificati

- **Chi**: Dr.ssa Rocca
- **Dove**: «Strumenti › Modelli dei certificati»
- **Che cosa guardare**: sportivo non agonistico e porto d'armi dagli atti ufficiali; il certificato anamnestico per la patente, proposto e segnato «da verificare» con la sua base di legge (D158, D160).

### K8 · Testi delle variazioni e dei registri AIFA

- **Chi**: Dr.ssa Rocca
- **Dove**: «Oggi», scheda della terapia, «Farmaci e prestazioni»
- **Che cosa guardare**: le frasi delle variazioni AIFA sui farmaci in terapia (confezione sospesa, classe cambiata, uscita dall'anagrafica) e dei registri e piani terapeutici: dicono il necessario, senza consigli clinici?

## Parte 3 · Decisioni e materiali di Simone

### M1 · Consulente privacy

- **Chi**: Simone
- **Dove**: `docs/certificati.md`, `docs/ruoli-permessi.md`, `docs/amministrazione.md`
- **Che cosa guardare**: l'email al datore di lavoro con nome e cognome (D108); ciò che vede la segreteria; le soglie degli avvisi sugli accessi anomali, oggi vuote (linee guida del Garante sul dossier sanitario).

### M2 · Consulente regolatorio

- **Chi**: Simone
- **Dove**: `docs/requisiti.md`
- **Che cosa guardare**: che il programma resti fuori dai dispositivi medici: controlli solo formali, nessun suggerimento; i valori fuori dall'intervallo del referto evidenziati.

### M3 · Avvocato

- **Chi**: Simone
- **Dove**: —
- **Che cosa guardare**: la revisione prima del lancio: contratti, condizioni d'uso, responsabilità.

### M4 · File d'esempio del programma di oggi

- **Chi**: Simone
- **Dove**: «Strumenti › Importazione»
- **Che cosa guardare**: un file d'esportazione del programma che lo studio usa oggi, senza dati veri, per provare l'importazione su un caso reale.

### M5 · Banca dati farmaci con licenza

- **Chi**: Simone
- **Dove**: `docs/banche-dati.md`
- **Che cosa guardare**: per esempio Farmadati: note AIFA per AIC e i fatti che oggi non sono noti (R3, R4, R8, R11).

### M6 · Servizi per il lancio

- **Chi**: Simone
- **Dove**: —
- **Che cosa guardare**: il fornitore vero di email e SMS; dove ospitare il servizio, nell'UE, con i salvataggi cifrati (D166).

### M7 · Versioni e prodotti

- **Chi**: Simone
- **Dove**: —
- **Che cosa guardare**: Ready! e la versione «Full» (D78), poi l'Agenda.

### M8 · Condizioni d'uso delle fonti

- **Chi**: Simone
- **Dove**: `docs/provenienze.md`
- **Che cosa guardare**: le condizioni d'uso di ogni banca dati pubblica, da scrivere prima del lancio; la licenza dei file ufficiali del Ministero per il Fascicolo (D131); le condizioni dell'ISTAT.

## Parte 4 · Dagli enti

Quando arrivano le risposte, ogni voce diventa lavoro da fare qui, con le sue prove. Contatto del CSI per le applicazioni sanitarie della Regione: 011 3168050, sanita.regione@csi.it.

### E1 · SAR (SIRPED) e Sistema TS

- **Chi**: Simone, con la Regione e il CSI
- **Dove**: `docs/ricetta.md`, «Da completare»
- **Che cosa guardare**: specifiche e credenziali di collaudo, piano di test della Regione; registrazione del programma e censimento dei medici (D103). Con queste: stato di erogazione, controlli formali (R10), formato dell'NRE, ricetta rossa, frasi e validità sul promemoria.

### E2 · AURA vera

- **Chi**: Simone, con il CSI
- **Dove**: `docs/aura.md`
- **Che cosa guardare**: servizio, campi, codici degli eventi e credenziali, chiesti con la PEC del 19/11/2026. Oggi AURA è un simulatore.

### E3 · Certificati INPS veri

- **Chi**: Simone
- **Dove**: `docs/certificati.md`, `docs/credenziali.md`
- **Che cosa guardare**: le credenziali del Sistema TS per l'invio vero (D100–D103).

### E4 · Fascicolo Sanitario Elettronico

- **Chi**: Simone, con la Regione e il CSI
- **Dove**: `docs/fse.md`
- **Che cosa guardare**: accreditamento del programma e valori delle tabelle (D133); il modulo di accesso semplificato del CSI con l'autenticazione forte (D220, D223).

### E5 · SPID e CIE

- **Chi**: Simone
- **Dove**: `docs/credenziali.md`
- **Che cosa guardare**: l'accreditamento come fornitore di servizi (D109). Fino ad allora SPID e CIE sono simulati e il ripristino delle credenziali con SPID o CIE resta spento.

### E6 · Prestazioni aggiuntive all'ASL

- **Chi**: Simone, con la Regione e l'ASL
- **Dove**: `docs/ppip.md`
- **Che cosa guardare**: canale e formato della distinta; il modulo regionale delle prestazioni multiple; l'eventuale accordo aziendale; come l'ASL tratta una prestazione eseguita dopo la nuova scelta del paziente e prima di «Sposta» (D240).

### E7 · Presidi all'ASL

- **Chi**: Simone, con l'ASL
- **Dove**: `docs/interfaccia.md`, «Che cosa manca»
- **Che cosa guardare**: il modulo da consegnare all'ASL e i percorsi dematerializzati (D123).

## Parte 5 · Prove tecniche che restano

Le fa Claude quando c'è il materiale, o insieme allo studio.

### T1 · Banche dati dal computer dello studio

- **Chi**: Simone, con Claude
- **Dove**: `sync/`
- **Che cosa guardare**: il primo giro di `sync/` dal computer dello studio, con le intestazioni ISTAT (D55, D56); due versioni vere dell'anagrafica AIFA una dopo l'altra.

### T2 · Stampa vera

- **Chi**: Dr.ssa Rocca, con Claude
- **Dove**: le stampanti dello studio
- **Che cosa guardare**: il promemoria con l'OCR-A su A5 e su A4, anche con una ricetta lunga; i codici a barre letti in farmacia (D211, D217); la ricetta rossa sui moduli veri.

### T3 · Browser, tablet e lettori di schermo veri

- **Chi**: Simone e lo studio
- **Dove**: i computer e i tablet dello studio
- **Che cosa guardare**: Safari e Firefox veri (qui girano i loro motori nelle prove automatiche, D241); un tablet; un lettore di schermo.

### T4 · Servizio vero

- **Chi**: Claude, quando c'è dove ospitarlo (M6)
- **Dove**: il server
- **Che cosa guardare**: un riavvio vero di Postgres con il servizio acceso (D207); salvataggi e ripristino.
