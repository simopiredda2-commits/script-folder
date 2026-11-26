# Lombardia, qualificazione della cartella (SSI) con ARIA: confronto con il programma

> Salvato nel repository il 26/11/2026, com'era stato preparato nella chat con Simone. Code non ha cambiato il testo dei paragrafi 1–8. Ha aggiunto il paragrafo 9, con gli esiti delle verifiche nel codice dei punti «Da verificare», e il paragrafo 10, con che cosa è già cambiato nel contratto delle integrazioni. Le domande del paragrafo 6 vanno alla prossima fermata; le lacune del nucleo sono proposte in `docs/avanzamento.md`, «Che cosa resta aperto». I documenti di ARIA sono registrati in `docs/provenienze.md` e non entrano nel repository (D92).

Documento per Claude Code, da leggere insieme a `CLAUDE.md`, `docs/avanzamento.md`, `docs/decisioni.md` e `docs/pacchetti-regionali.md`. Preparato il 26/11/2026 nella chat con Simone. Ho letto i sei documenti della qualificazione che Simone ha scaricato nella cartella «FOLDER Cartella Clinica/Lombardia» del suo Mac. Li ho confrontati con `main` al commit `f37e284` (pull request #47).

Non è una richiesta di costruire la Lombardia. Serve a tre cose:

1. il contratto delle integrazioni regionali, nel pezzo 3 dello spostamento, deve reggere anche il modello lombardo, che è diverso da quello del Piemonte (paragrafo 5);
2. le differenze che toccano decisioni già prese vanno alla fermata (paragrafo 6);
3. l'elenco di ciò che manca deve essere pronto per quando SCRIPT farà domanda ad ARIA.

Nel codice non ho cambiato niente. Le specifiche dei servizi del SISS non sono pubbliche: ARIA le manda durante la procedura (paragrafo 1).

Cito le Linee Guida (Allegato 2, PDF) per paragrafo e pagina del file. La checklist (Allegato 2.5) e la Procedura sono file Word: le cito per identificativo del requisito o per titolo del paragrafo.

## In breve

1. **Il cloud è ammesso e si lavora da internet.**
   - Le Linee Guida ammettono architetture «client-server, web-based o cloud-based» (§6.6, p. 39).
   - Il medico si autentica al SISS via internet: la cartella usa le chiavi APIMANAGER e richiama `operatori.siss` (§5.4, p. 21; F4.1).
   - Il «Programma di Semplificazione», in corso, prevede di togliere il software di postazione (PDL SISS) e di sostituire la carta operatore con la Firma Remota (cap. 3, p. 11).
   - È l'opposto della Puglia, dove il SIST vuole la VPN su ogni postazione.
2. **Le ricette le fa il modulo regionale (PRREG), non la cartella.**
   - Per la checklist (rev. 3 del 10/09/2026), con le Regole 2025-2026 il modulo prescrittivo regionale sostituisce la parte prescrittiva della cartella.
   - Alla cartella resta questo (F6.7.1–F6.7.5):
     - aprire il PRREG con il codice fiscale e i farmaci o le prestazioni;
     - riprendere con un'API le ricette fatte e gli errori;
     - conservare i PDF delle ricette;
     - annullare tramite il PRREG.
   - Il nostro invio al SAR in Lombardia non serve. Le regole R1–R25 potrebbero restare come controllo della bozza, prima di aprire il PRREG: da decidere quando arrivano le specifiche.
   - Le Linee Guida (v2.4 del 31/08/2026) hanno ancora i vecchi requisiti F6.7.1–F6.7.10 (p. 30): vale la checklist, che è più recente, ma va confermato con ARIA (paragrafo 7).
3. **Tutto il resto passa dal SISS**: anagrafe (NAR), consenso al Fascicolo, Fascicolo e PSS, codifiche, certificati di malattia e INAIL, SIAP (con il «Gestionale SIAP» di ARIA). Per il programma vuol dire un pacchetto della Lombardia con i suoi collegamenti, come quello del Piemonte (paragrafo 5).
4. **Tre requisiti obbligatori toccano il confine con il dispositivo medico** → fermata.
   - **F6.4.4**: calcolo automatico degli indici, «ad esempio BMI». Oggi il BMI è scritto a mano (D127).
   - **F6.4.3**: controllo dei valori inseriti con intervalli predefiniti e avviso. Oggi ci sono solo «maggiore di zero» e «saturazione fino a 100» (D113).
   - **F6.4.5**: scadenzario dei controlli successivi. Oggi D294 esclude i promemoria che segnalano un paziente da controllare.
   - Un requisito obbligatorio soddisfatto solo in parte dà «esito negativo della verifica» (cap. 4, p. 16).
5. **Lacune piccole nel nucleo nazionale**, utili in ogni regione:
   - pulsazione e respirazione fra i parametri;
   - anamnesi patologica prossima;
   - più stati del problema;
   - recapiti dei genitori per i minori;
   - certificati INAIL;
   - importazione del PSS in CDA2;
   - ICD-10 (ICD-10-IM dal 2027).
6. **Ogni versione nuova va comunicata ad ARIA (Allegato 3).**
   - Il prodotto può essere revocato se la versione distribuita è diversa da quella qualificata.
   - Per un prodotto in cloud, che si aggiorna spesso, serve una regola sulle versioni → fermata e domanda per ARIA.
7. **Fascicolo: forse in Lombardia non si parla col Gateway nazionale.**
   - Il PSS si firma, si archivia nel repository del SISS e poi alimenta il Fascicolo (cap. 3, p. 12; F7.4).
   - Se serva anche l'accreditamento nazionale è da chiedere ad ARIA.
   - Il lavoro sulla fase 1 resta utile per Piemonte, Puglia e Campania.
8. **Parte della sicurezza è organizzativa.** Servono procedure scritte di SCRIPT: emergenze, vulnerabilità, incidenti, backup con prove di ripristino, inventario dei componenti (NF4.4, NF4.10–NF4.14).
9. **I blocchi sono quelli di sempre.** Partita IVA, firma digitale del legale rappresentante, contratto con almeno un medico (Allegato 1).

## 1. La procedura

Fonti: «Procedura di qualificazione della Scheda Sanitaria Informatica SSI», Allegati 1 e 3.

- **Chi**: «soggetti titolari di Partita IVA» che sviluppano o distribuiscono cartelle per MMG e PLS lombardi («Generalità»).
- **Domanda** (Allegato 1):
  - firmata digitalmente dal legale rappresentante;
  - mandata per PEC a `protocollo@pec.ariaspa.it`, all'attenzione dell'ufficio ISAU; i chiarimenti a `isau_ssi@ariaspa.it`;
  - dichiara il prodotto con la release, se è per MMG o per pediatri, e il referente;
  - dichiara anche di «possedere un contratto di fornitura del prodotto in oggetto presso almeno un Medico di Medicina Generale o Pediatra Di Famiglia»;
  - impegna all'assistenza di secondo livello e alla formazione dell'assistenza regionale di primo livello.
- **Passi**:
  1. ARIA controlla la domanda e manda Linee Guida e checklist.
  2. La software house compila la checklist: per ogni requisito SI o NO, con note ed evidenze, soprattutto quando manca. ARIA la verifica.
  3. Se la verifica va bene, ARIA manda gli scenari SISS, le specifiche di interfaccia e le checklist dei test di interoperabilità.
  4. La software house scrive l'«Analisi degli Scenari di Integrazione per la Validazione» (ASIV), che ARIA verifica.
  5. La software house mette a disposizione l'ambiente di test e chiede la validazione. La sessione si fa insieme, e ARIA scrive il Report di Validazione (RPV) qualunque sia l'esito.
  6. Con non conformità si ripete una sola volta, entro tre mesi. Se va male anche la seconda, la procedura si chiude e si ripresenta domanda dopo sei mesi.
  7. Con esito positivo: verbale e iscrizione nell'Elenco. Di norma tutto entro sei mesi dall'avvio.
- **Dopo**:
  - adeguamenti nei tempi di ARIA;
  - ogni nuova release comunicata con l'Allegato 3, che elenca le aree toccate (anagrafica, prescrizione, PSS, interoperabilità…);
  - la release nuova entra nell'Elenco solo dopo le verifiche che ARIA decide.
- **Revoca**:
  - mancato adeguamento;
  - perdita dei requisiti;
  - «difformità accertata tra la versione distribuita e la versione qualificata»;
  - verifiche non superate nei tempi.
- **Checklist, «Generalità»**: un ambito è validato solo se tutti i suoi requisiti «Funzionalità minima richiesta» sono fatti. Gli «Ulteriore livello di evoluzione» contano a favore, ma non sono obbligatori.
- **Elenco dei prodotti** (versione 1.0 del 29/10/2026):
  - 22 prodotti qualificati;
  - 4 di questi senza PSS (Asclepius, MDB2000, Milleweb, MedicalLive).

## 2. Il modello architetturale

Fonte: Linee Guida, cap. 3 (p. 10–14) e cap. 7 (p. 41–52).

- La cartella si integra con i servizi web del SISS:
  - anagrafe sanitaria (NAR) con i metodi ICCE;
  - Fascicolo (alimentazione e consultazione);
  - dati codificati;
  - prescrizione;
  - verifica del consenso al Fascicolo;
  - certificati di malattia (GCM) e di infortunio (INAIL).
- Per il resto il medico ha web application nel menu SISS, che la cartella può aprire con una chiamata di contesto:
  - Medboard Bacheca;
  - ARVAX per le vaccinazioni;
  - Assistant-RL per la protesica;
  - SGDT per la presa in carico dei cronici e il PAI;
  - GP++ per le prenotazioni;
  - PT Online per i piani terapeutici;
  - OPE e Deleghe FSE;
  - SMI, SMP e GSM.
- Per la Tabella 2 (p. 48–52) queste integrazioni oggi sono facoltative. Se cambiano le regole tecniche, l'integrazione «potrebbe diventare obbligatoria» (p. 48).
- L'anagrafe locale si allinea con l'elenco degli assistiti che il medico scarica ogni giorno da Medboard, per lavorare anche senza SISS (Tabella 1, scenario ICCE, p. 42).

## 3. Requisiti funzionali obbligatori

Stati usati nelle tabelle:

- **C'è**: nel programma oggi.
- **In parte**: c'è qualcosa, il resto è in nota.
- **Da verificare**: non sono riuscito a confermarlo dal codice; lo controlla Code.
- **Nucleo**: manca, ed è una cosa nazionale.
- **Pacchetto**: integrazione con il SISS o con ARIA, nel pacchetto della Lombardia; le specifiche arrivano con la procedura.
- **Fermata**: tocca una decisione già presa.

### 3.1 Anagrafica, consenso, documentazione, autenticazione (§5.1–5.5, p. 17–22)

| ID   | Requisito (in breve)                                                                                                                                                                 | Stato         | Note                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1.1 | Anagrafica sempre allineata all'anagrafe regionale                                                                                                                                   | Pacchetto     | In Piemonte è AURA, oggi con un simulatore (D197–D200).                                                                                                                                                                                                                                                       |
| F1.2 | Identificazione con i servizi ICCE e allineamento con l'elenco assistiti di Medboard; senza SISS, l'anagrafica locale; nessun altro modo                                             | Pacchetto     | L'importazione da file c'è (`docs/importazione.md`); il formato di Medboard no.                                                                                                                                                                                                                               |
| F1.3 | Codice fiscale, nome, cognome, sesso, età e informazioni rilevanti (allergie, problemi) sempre nella schermata principale                                                            | Da verificare | La fascia del paziente ha allergie ed esenzioni (D244): sesso, età e problemi da controllare.                                                                                                                                                                                                                 |
| F1.4 | Email e telefono                                                                                                                                                                     | C'è           | `packages/domain/src/patient-registry.ts`.                                                                                                                                                                                                                                                                    |
| F1.5 | Per minori e tutelati, i familiari (per esempio padre e madre) con i recapiti                                                                                                        | In parte      | Nucleo familiare e deleghe ci sono; nome e recapiti dei genitori come dato a sé no.                                                                                                                                                                                                                           |
| F1.6 | Anamnesi familiare, fisiologica, patologica prossima e patologica remota                                                                                                             | Nucleo        | Manca la patologica prossima (`ANAMNESIS_SECTIONS` in `packages/domain/src/clinical.ts`).                                                                                                                                                                                                                     |
| F1.7 | Presa in carico del paziente cronico e sue rilevanze cliniche                                                                                                                        | In parte      | C'è la casella «cronica» sul problema. La presa in carico lombarda (PIC) e il PAI passano dal SGDT, con chiamata di contesto (Tabella 1, scenario GPC, p. 44).                                                                                                                                                |
| F2.1 | Tipi di consenso, con la stampa dell'informativa o del modulo: consultazione del Fascicolo e dati della PIC dei cronici                                                              | In parte      | I consensi del Fascicolo ci sono (`packages/domain/src/privacy.ts`). Il consenso PIC è regionale (pacchetto). La stampa dell'informativa è da verificare.                                                                                                                                                     |
| F2.2 | Verifica del consenso al Fascicolo con il servizio GCI o dal menu SISS, registrata in cartella                                                                                       | Pacchetto     |                                                                                                                                                                                                                                                                                                               |
| F3.1 | Episodi in cronologia o in elenco                                                                                                                                                    | C'è           | Cronologia unica della cartella.                                                                                                                                                                                                                                                                              |
| F3.2 | Ordinare e filtrare gli episodi per data, tipo, diagnosi, problema                                                                                                                   | In parte      | La cronologia ha dei filtri (`RecordPage.tsx`); per diagnosi e problema da verificare.                                                                                                                                                                                                                        |
| F3.3 | Esportare e importare un insieme minimo nel formato regionale DC-CDA2-PSS#02, per un assistito e per tutti: allergie, problemi, interventi, terapia continuativa, stato del paziente | In parte      | Ci sono l'esportazione completa in JSON e CSV (`docs/esportazione.md`) e il PSS in CDA2 per assistito (tappa 11). Mancano l'importazione del CDA2 («non letti, per ora», `docs/importazione.md`) e il CDA2 per tutti gli assistiti. DC-CDA2-PSS#02 è un documento del SISS, da confrontare con la guida v1.5. |
| F3.4 | Dati esportati con autore, data e ora                                                                                                                                                | C'è           | `clinical_entry`: autore, data della voce, istante di scrittura.                                                                                                                                                                                                                                              |
| F3.5 | Il medico sa quali dati vengono da altre cartelle                                                                                                                                    | C'è           | Segno della provenienza (D181).                                                                                                                                                                                                                                                                               |
| F3.6 | Consultazione dei documenti del Fascicolo, in PDF e in CDA2, con gli scenari SISS                                                                                                    | Pacchetto     | In Piemonte: apertura del Fascicolo dalla cartella (D220).                                                                                                                                                                                                                                                    |
| F4.1 | Autenticazione del medico al SISS via internet, con le chiavi APIMANAGER e la pagina `operatori.siss`                                                                                | Pacchetto     | Strumenti di livello 3: SPID3, CIE, Carta Operatore, Firma Remota (§5.4, p. 21). Somiglia all'accesso regionale del Piemonte (D109).                                                                                                                                                                          |
| F5.1 | Chiamata di contesto verso una web application di terzi                                                                                                                              | In parte      | Il meccanismo c'è per il Fascicolo del Piemonte (D220). In Lombardia serve per PRREG, SGDT, certificati e le altre web application.                                                                                                                                                                           |

### 3.2 Gestione clinica (§5.6, p. 22–33)

| ID     | Requisito (in breve)                                                                                                                             | Stato         | Note                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F6.1.1 | Note in un campo unico di testo formattabile e aggiornabile                                                                                      | Da verificare | Nello schema c'è `patient.notes`; interfaccia e formattazione da controllare.                                                                                       |
| F6.1.2 | Classificazione codificata di eventi e problemi (per esempio ICD-10, ICPC-2)                                                                     | C'è           | ICD-9-CM; vedi NF7.2.                                                                                                                                               |
| F6.1.3 | Almeno i campi del PSS                                                                                                                           | C'è           | Tappa 11, guida v1.5 (D281).                                                                                                                                        |
| F6.1.4 | Contenuti in ordine cronologico, con pregresso, terapie, problemi, intolleranze, farmaci, allergie                                               | C'è           |                                                                                                                                                                     |
| F6.1.5 | Unità di misura configurabili per peso, altezza, età, «secondo le Linee Guida europee»                                                           | Fermata       | Unità fisse (D113).                                                                                                                                                 |
| F6.1.6 | Controlli e avvisi in compilazione, su dati obbligatori e correttezza                                                                            | C'è           | Controlli formali (regola 3).                                                                                                                                       |
| F6.1.7 | Dati strutturati, per esportare e importare                                                                                                      | C'è           |                                                                                                                                                                     |
| F6.2.1 | Annotazioni in testo libero, in ordine cronologico                                                                                               | C'è           | Diario.                                                                                                                                                             |
| F6.2.2 | Annotare e inviare le prestazioni che l'ACN manda agli enti: PPIP, accessi ADI e ADP, bilanci di salute dei pediatri                             | In parte      | PPIP con la distinta del Piemonte (D212, D213). In Lombardia il canale è da chiedere: la Tabella 2 (p. 49) mette ADI, ADP, PSD e PPIP nel SGDT.                     |
| F6.2.3 | Allegati alle annotazioni (PDF, documenti acquisiti)                                                                                             | C'è           | D121.                                                                                                                                                               |
| F6.2.4 | Parti di testo messe in evidenza con colori o simboli                                                                                            | Da verificare | Evidenziatore (D69) e opzione «Importante» sulle terapie; sul testo del diario da controllare.                                                                      |
| F6.2.5 | Problemi classificati, ognuno con uno stato: per esempio sospetto, attivo, non attivo, cronico, risolto, ricorrente, intermittente               | In parte      | Oggi `attivo` o `risolto`, più la casella «cronica» (`packages/domain/src/clinical.ts`). L'elenco della checklist è un esempio: quanti stati servano è da decidere. |
| F6.3.1 | Storico dei piani terapeutici e scadenzario che avvisa al rinnovo                                                                                | C'è           | «Piani terapeutici in scadenza» in Oggi.                                                                                                                            |
| F6.4.1 | Peso, altezza, BMI, pressione, pulsazione, respirazione, in un'area strutturata a sezioni (vaccinazioni, screening, bilanci di salute), con note | In parte      | Mancano pulsazione e respirazione (`MEASURES` in `packages/domain/src/clinical.ts`). Le note sulla voce ci sono.                                                    |
| F6.4.2 | Andamento dei parametri in tabelle o grafici, con scelta dei parametri e dell'intervallo                                                         | In parte      | Grafico dell'andamento (`TrendChart.tsx`); la scelta dell'intervallo è da verificare.                                                                               |
| F6.4.3 | Controllo di inammissibilità parametrizzabile, con intervalli predefiniti e avviso sui dati anomali, anche all'importazione                      | Fermata       | D113: maggiore di zero, saturazione fino a 100, nessun intervallo. Vedi paragrafo 6, domanda 2.                                                                     |
| F6.4.4 | Calcolo automatico degli indici, per esempio il BMI                                                                                              | Fermata       | D127: il BMI resta scritto a mano. Vedi paragrafo 6, domanda 1.                                                                                                     |
| F6.4.5 | Scadenzario e appuntamenti per i controlli successivi                                                                                            | Fermata       | «Promemoria il» si scrive sulla voce (`ClinicalEntriesPage.tsx`), ma non torna in Oggi. L'agenda aspetta Ready! (D78). Vedi paragrafo 6, domanda 3.                 |
| F6.4.6 | Evidenza grafica di parti di testo                                                                                                               | Da verificare | Come F6.2.4.                                                                                                                                                        |
| F6.5.1 | Presidi, ausili e dispositivi applicati al cittadino                                                                                             | C'è           | Tappa 10 (D121–D124).                                                                                                                                               |
| F6.5.2 | Scadenzario con avviso per la periodicità delle prescrizioni di dispositivi, visibile anche al personale di studio                               | In parte      | C'è il periodo dal–al con lo stato «scaduta» (`packages/domain/src/supplies.ts`). L'avviso in Oggi e la visibilità per la segreteria sono da verificare.            |
| F6.6.1 | Andamento delle informazioni cliniche più rilevanti, con tabelle o grafici configurabili                                                         | In parte      | Parametri ed esami ripetuti; configurabilità come F6.4.2.                                                                                                           |
| F6.6.2 | Elementi grafici (colori, simboli)                                                                                                               | C'è           |                                                                                                                                                                     |
| F6.7.1 | Chiamata di contesto al PRREG, con codice fiscale e farmaci o prestazioni                                                                        | Pacchetto     | Checklist rev. 3; specifiche ARIA-PRREG-SIAA@01.                                                                                                                    |
| F6.7.2 | API per avere dal PRREG le ricette fatte e gli esiti degli errori                                                                                | Pacchetto     |                                                                                                                                                                     |
| F6.7.3 | Gestione degli errori restituiti dal PRREG                                                                                                       | Pacchetto     |                                                                                                                                                                     |
| F6.7.4 | Conservare in base64 i PDF delle ricette, per la stampa e lo storico                                                                             | Pacchetto     |                                                                                                                                                                     |
| F6.7.5 | Annullare la ricetta tramite il PRREG e nei propri archivi                                                                                       | Pacchetto     |                                                                                                                                                                     |
| F6.8.1 | Tutte le codifiche del Dominio Centrale del SISS (servizi DDC), tranne i farmaci, che vengono da altre fonti                                     | Pacchetto     | I farmaci dalla banca dati con licenza (NF7.4).                                                                                                                     |
| F6.8.2 | Codice e descrizione in chiaro                                                                                                                   | C'è           |                                                                                                                                                                     |
| F6.8.3 | Ricerca full text per parte della descrizione o del codice                                                                                       | C'è           | Ricerca mentre si digita.                                                                                                                                           |
| F6.9.1 | Certificati con i dati del paziente presi dall'anagrafica                                                                                        | C'è           | Certificati INPS (tappa 8).                                                                                                                                         |
| F6.9.2 | Certificati di malattia con gli scenari SISS (GCM): emissione, annullamento, rettifica, stampa, ricerca                                          | Pacchetto     | Oggi vanno al Sistema TS (tappa 8). Se in Lombardia basti il Sistema TS è da chiedere (paragrafo 7).                                                                |
| F6.9.3 | Certificati di infortunio INAIL                                                                                                                  | Nucleo        | Non ci sono. In Lombardia passano dal SISS (INFOINAIL).                                                                                                             |
| F6.9.4 | Senza integrazione: un tasto che apre le web application                                                                                         | Pacchetto     | È la strada più corta per F6.9.2 e F6.9.3.                                                                                                                          |

### 3.3 PSS, studio, SIAP (§5.7–5.8, p. 32–34; il SIAP è solo nella checklist)

| ID   | Requisito (in breve)                                                                                                                       | Stato     | Note                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------- |
| F7.1 | Tutti i dati per il PSS secondo la normativa                                                                                               | C'è       | Guida v1.5 (D281).                                                                                         |
| F7.2 | Codifiche del PSS                                                                                                                          | C'è       |                                                                                                            |
| F7.3 | Un modulo per produrre il PSS                                                                                                              | C'è       | Tappa 11.                                                                                                  |
| F7.4 | Firma digitale, stampa, archiviazione con il CDA2 nel repository del SISS, poi alimentazione del Fascicolo                                 | Pacchetto | In Lombardia si firma con la Firma Remota del SISS (§5.4, p. 21). Oggi firma e Gateway sono simulati.      |
| F8.1 | Prescrizioni ricorrenti preparate dal personale di studio e registrate dal medico; obbligatoria oltre i dieci medici che usano la cartella | C'è       | La segreteria prepara, il medico firma (coda «Da firmare»). In Lombardia la registrazione passa dal PRREG. |
| F9.1 | Integrazione con il Gestionale SIAP di ARIA (API REST) per il flusso NSIS del DM 4/8/2025                                                  | Pacchetto | La parte nazionale c'è (D284, D289, D291).                                                                 |
| F9.2 | Invio in JSON di un evento (SIAP-001.01) o di molti (SIAP-001), anche per gli arretrati                                                    | Pacchetto |                                                                                                            |
| F9.3 | Reinvio come variazione, e cancellazione                                                                                                   | Pacchetto |                                                                                                            |
| F9.4 | Gestione degli errori, con la correzione dell'operatore                                                                                    | Pacchetto |                                                                                                            |
| F9.5 | Esiti del Ministero consultabili: ACQUISITO, ACQUISITO CON ANOMALIE, PARZIALMENTE ACQUISITO, SCARTATO, IN_ELABORAZIONE                     | Pacchetto |                                                                                                            |

Il SIAP conferma la scelta di D288. La parte nazionale resta nel nucleo; chi la riceve cambia con la regione: il CSI in Piemonte, ARIA in Lombardia.

### 3.4 Ulteriori livelli (facoltativi)

Contano a favore e non bloccano. Il programma ne ha già alcuni:

- uso da tablet (F4.2);
- nucleo familiare (F1.9, in parte);
- modelli di certificati (F6.9.6);
- riepiloghi con esportazione CSV (F8.6, D201).

Mancano, fra gli altri:

- fotografia del paziente (F1.8);
- frasi standard (F6.1.8, F6.2.6);
- stampa di parti del diario (F6.2.8);
- importazione dei documenti e del PSS dal Fascicolo (F3.8, F7.5);
- agenda (F8.2);
- fatture (F8.5).

**F6.6.4** chiede avvisi su interazioni fra farmaci, allergie e linee guida. Resta fuori per il confine con il dispositivo medico (R12, D294): è facoltativo, quindi non blocca la qualificazione.

## 4. Requisiti non funzionali obbligatori (cap. 6, p. 35–40)

| ID        | Requisito (in breve)                                                                                                                   | Stato    | Note                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| NF1.1–1.2 | Ogni utente vede solo il suo ambito; profili con sola lettura o lettura e scrittura                                                    | C'è      | Matrice dei permessi (`docs/ruoli-permessi.md`).                                                                          |
| NF3.1     | Percorso clinico in cronologia sintetica, con il dettaglio di ogni evento                                                              | C'è      |                                                                                                                           |
| NF3.2–3.3 | Verifica automatica dei dati e della completezza dei dati obbligatori                                                                  | In parte | Controlli formali; vedi F6.4.3.                                                                                           |
| NF3.4     | Elaborazione veloce, poche finestre non necessarie                                                                                     | C'è      | Requisito di velocità in `docs/requisiti.md`.                                                                             |
| NF3.5     | Scalabilità, se è una web application                                                                                                  | Da fare  | Dipende da dove si ospita il servizio (`docs/avanzamento.md`, C6).                                                        |
| NF4.1     | Tracciamento di accessi e azioni, con autore, data e ora, ricostruibile nel tempo                                                      | C'è      | Registro degli accessi con la catena di impronte e storico delle modifiche (`docs/esportazione.md`).                      |
| NF4.2     | Memoria clinica immodificabile, salvo le bozze                                                                                         | C'è      | Le voci si annullano con un motivo, non si cancellano.                                                                    |
| NF4.3     | Backup automatico; lavoro anche senza collegamento al SISS; monitoraggio continuo, se web                                              | In parte | Senza SISS il programma lavora, con le code di invio. Backup e monitoraggio vengono con l'ospitalità (C6).                |
| NF4.4     | Procedure di emergenza documentate                                                                                                     | SCRIPT   | Documento da scrivere.                                                                                                    |
| NF4.5     | Protezione fisica dei dati; integrità, autenticità, non ripudio (firma digitale)                                                       | In parte | Ospitalità; firma come F7.4.                                                                                              |
| NF4.6     | Credenziali nominative; autenticazione forte per gli accessi amministrativi, remoti o da internet                                      | C'è      | Secondo fattore per tutti, SPID o CIE (D100–D103, D109).                                                                  |
| NF4.7     | Ruoli configurabili e tracciati: medico, sostituto, personale di studio, amministratore tecnico                                        | C'è      |                                                                                                                           |
| NF4.8     | Comunicazioni cifrate; dati sanitari memorizzati cifrati o con misure equivalenti                                                      | In parte | Credenziali dei servizi cifrate; il resto con l'ospitalità.                                                               |
| NF4.9     | Registro degli eventi di sicurezza (accessi, autenticazioni fallite, modifiche, esportazioni, cancellazioni, amministratori), protetto | C'è      | Tentativi sbagliati (`login-protection.ts`) ed esportazioni nel registro; da verificare che ci sia ogni voce dell'elenco. |
| NF4.10    | Procedura per vulnerabilità e aggiornamenti di sicurezza                                                                               | SCRIPT   |                                                                                                                           |
| NF4.11    | Backup automatico, ripristino documentato e provato periodicamente                                                                     | SCRIPT   | Con l'ospitalità.                                                                                                         |
| NF4.12    | Protezione da malware e ransomware: hardening, privilegi separati, backup protetti, aggiornamenti                                      | SCRIPT   |                                                                                                                           |
| NF4.13    | Procedura per gli incidenti di sicurezza                                                                                               | SCRIPT   |                                                                                                                           |
| NF4.14    | Inventario aggiornato dei componenti software, open source compresi                                                                    | In parte | C'è `pnpm-lock.yaml`. Un SBOM generato nella CI lo darebbe in forma standard e coprirebbe anche NF4.18, facoltativo.      |
| NF5.1–5.3 | Progetto modulare, API standard, aggiornamenti senza perdere sicurezza                                                                 | C'è      | Pacchetti regionali (D288), servizio con API.                                                                             |
| NF6.1     | Funziona con browser e sistemi operativi diversi, se web o cloud                                                                       | C'è      | Prove con Chromium, WebKit e Firefox (D241).                                                                              |
| NF7.1     | Codici nazionali e internazionali indicati da Regione o dalla normativa                                                                | C'è      |                                                                                                                           |
| NF7.2     | Classificazione delle malattie ICD-10 o ICPC-2                                                                                         | In parte | ICD-9-CM oggi. ICD-10-IM sostituisce ICD-9-CM dal 1/1/2027 (DM 23/10/2025); nel programma è un tipo da fare (D186).       |
| NF7.3     | Standard di interoperabilità (HL7 FHIR, CDA2)                                                                                          | C'è      | CDA2 del PSS.                                                                                                             |
| NF7.4     | Banche dati dei farmaci riconosciute a livello nazionale (per esempio Federfarma, Codifa)                                              | In parte | Oggi gli open data AIFA. In produzione Farmadati, che pubblica Codifa (`docs/avanzamento.md`, C5).                        |

**SCRIPT** vuol dire che non è codice: è una procedura scritta della società. Code può preparare le bozze tecniche, come ripristino, inventario e gestione delle vulnerabilità, con i dati del repository.

## 5. Che cosa cambia per i pacchetti regionali

Il pezzo 3 dello spostamento fissa le integrazioni senza il database: SAR, Fascicolo regionale, accesso con il modulo della Regione (`docs/pacchetti-regionali.md`). Il modello lombardo chiede che il contratto non dia per scontate le scelte del Piemonte.

1. **Ricetta.** In Piemonte il programma manda la ricetta al SAR. In Lombardia la ricetta la fa il PRREG:
   - la cartella la prepara;
   - apre il PRREG con una chiamata di contesto;
   - riprende ricette, errori e PDF;
   - annulla tramite il PRREG.

   Il contratto deve ammettere un «prescrittore esterno» accanto all'«invio al SAR».

2. **Certificati.** In Piemonte il Sistema TS. In Lombardia un servizio regionale (GCM, INFOINAIL), oppure il tasto che apre la web application.
3. **Fascicolo.**
   - In Piemonte: validazione sul Gateway e pubblicazione con i servizi regionali.
   - In Lombardia: firma con la Firma Remota del SISS e archiviazione nel repository del SISS. Il Gateway è da chiarire con ARIA.
4. **Anagrafe.**
   - In Piemonte i servizi di AURA.
   - In Lombardia i servizi ICCE, più un file scaricato ogni giorno da Medboard.
5. **Accesso del medico.**
   - In Piemonte: SPID o CIE con OAuth2 della Regione.
   - In Lombardia: le chiavi APIMANAGER del programma e l'autenticazione dell'operatore sulla pagina del SISS.
6. **SIAP.** Il CSI o ARIA ricevono: stessi tracciati nazionali, invio diverso.
7. **Codifiche e consensi.** Le tabelle del SISS (DDC) al posto di quelle piemontesi, e un consenso regionale in più (PIC).
8. **Chiamate di contesto.** In Lombardia sono tante (PRREG, SGDT, ARVAX, Assistant-RL, GP++, PT Online, OPE, Deleghe FSE, SMI, SMP, GSM). Conviene un meccanismo unico nel nucleo, con l'elenco delle destinazioni nel pacchetto, come oggi per il Fascicolo del Piemonte (D220).

Niente di tutto questo va costruito per la Lombardia adesso: le specifiche non le abbiamo. Va solo tenuto presente nella forma del contratto.

## 6. Domande per la fermata

1. **BMI calcolato (F6.4.4, obbligatorio) e D127.** Due strade, che non si escludono:
   - chiedere ad ARIA se basta il BMI scritto a mano;
   - riesaminare D127 per un BMI calcolato da peso e altezza e mostrato come numero, senza classi («sovrappeso», «obeso») e senza giudizio.

   Anche il SIAP vuole il BMI dalla cartella (`docs/siap.md`).

2. **Limiti di ammissibilità (F6.4.3, obbligatorio) e D113.** Il requisito parla di «inammissibilità» e di «segnalare l'errore»: è un controllo d'inserimento, come «saturazione fino a 100».
   - Proposta da valutare: limiti fisici per parametro, configurabili dallo studio (per esempio peso fino a 400 kg), con un messaggio sull'errore di battitura.
   - Niente «valori normali» e nessun giudizio clinico.
   - Resta fuori dal dispositivo medico come i controlli formali di oggi?
3. **Scadenzario dei controlli (F6.4.5, obbligatorio) e D294.**
   - La data «Promemoria il» la sceglie il medico sulla voce. Mostrarla in Oggi quando arriva è un'agenda del medico, non un promemoria del programma che segnala un paziente da controllare?
   - Il punto tocca anche l'agenda (Ready!, D78).
4. **Unità di misura configurabili (F6.1.5) e D113.** Per esempio grammi per i neonati, metri o centimetri.
5. **Stati del problema (F6.2.5).** Aggiungere sospetto, non attivo, ricorrente, intermittente ad attivo e risolto?
6. **Versioni del prodotto e Allegato 3.** Un prodotto in cloud si aggiorna spesso, ma in Lombardia ogni release va comunicata e la versione distribuita deve essere quella qualificata.
   - Serve una regola: release numerate, l'elenco delle aree toccate come nell'Allegato 3, forse una versione «qualificata» per la Lombardia.
   - Da decidere dopo la risposta di ARIA (paragrafo 7).
7. **Lacune del nucleo da colmare comunque**, con il via di Simone:
   - pulsazione e respirazione (F6.4.1);
   - anamnesi patologica prossima (F1.6);
   - recapiti dei genitori (F1.5);
   - certificati INAIL (F6.9.3);
   - importazione del PSS in CDA2 (F3.3);
   - ICD-10-IM per il 2027 (NF7.2).

## 7. Domande per ARIA

Da mandare a `isau_ssi@ariaspa.it` quando ARIA risponde alla mail del 26/11/2026 (registro, foglio «Registro», riga 10), con il via di Simone.

1. **Cloud.** Una cartella interamente in cloud, senza software sulla postazione, che accede al SISS via internet con le chiavi APIMANAGER, va bene? L'ambiente di test della validazione può essere un ambiente ospitato?
2. **Release.** Per un prodotto che si aggiorna spesso, l'Allegato 3 va mandato a ogni release o solo per quelle che toccano le aree elencate? Come si dimostra che la versione distribuita è quella qualificata?
3. **Ricetta.**
   - Vale la checklist rev. 3 (PRREG, F6.7.1–F6.7.5) o anche F6.7.1–F6.7.10 delle Linee Guida v2.4 (p. 30)?
   - La ricetta bianca va con il PRREG, con il metodo GSSC, che la Tabella 1 dice «obbligatoria» per le ricette bianche (p. 46), o con il Sistema TS?
4. **Certificati.** I certificati di malattia possono andare direttamente al Sistema TS, o solo con il GCM del SISS? Per l'INAIL basta aprire la web application (F6.9.4)?
5. **BMI e controlli.** Il BMI scritto dal medico soddisfa F6.4.4? Limiti di ammissibilità senza intervalli clinici soddisfano F6.4.3? Va spiegato perché lo chiediamo: il confine con il dispositivo medico.
6. **ICD.** ICD-9-CM fino al 31/12/2026 e ICD-10-IM dal 2027 vanno bene per F6.1.2 e NF7.2?
7. **Fascicolo e PSS.**
   - Basta l'archiviazione nel repository del SISS, o serve anche l'accreditamento nazionale al Gateway FSE 2.0?
   - Come si richiama la Firma Remota?
   - Il DC-CDA2-PSS#02 è allineato alla guida HL7 Italia v1.5?
8. **Medboard.** Formato dell'elenco assistiti. Per un prodotto in cloud c'è un servizio al posto del file scaricato a mano ogni giorno?
9. **SIAP.** Le specifiche del Gestionale SIAP (ARIA-SIAP_SIAA_01) si possono avere prima della domanda, visto l'invio mensile dal 2026?
10. **Contratto con un medico.** Al momento della domanda basta una lettera d'intenti o un accordo per la prova, se il prodotto non è ancora in uso?
11. **Prestazioni (F6.2.2).** Con quale canale si mandano PPIP, ADI e ADP in Lombardia: il SGDT?

## 8. Che cosa non ho controllato

- Gli stati «Da verificare» delle tabelle. Li ho guardati nel codice solo per nome di file e di campo, non nell'interfaccia.
- I documenti del SISS citati dalle Linee Guida (scenari DC-SCEN-*, specifiche SIAA, DC-CDA2-PSS#02, ARIA-PRREG-SIAA@01, ARIA-SIAP_SIAA_01): non sono pubblici, quindi non li ho letti.
- Le parti delle Linee Guida che ripetono la checklist con le stesse parole: §5 e §6 per ogni requisito, e il cap. 2 sul contesto normativo, letto in fretta.
- Il portale del SISS da cui Simone ha scaricato i file: non ho la pagina esatta. La mappa del sito la elenca sotto «Procedure di Verifica e Qualificazione» (`https://www.siss.regione.lombardia.it/wps/portal/site/siss/mappa-del-sito`).

## Documenti: link e impronte (per `docs/provenienze.md`)

Scaricati da Simone il 26/11/2026 dal portale del SISS, pagina «Procedura di Qualificazione Scheda Sanitaria Informatica (SSI)». Sono nella cartella «FOLDER Cartella Clinica/Lombardia» del suo Mac.

| Documento                                                                                            | File                                                                                                        | Byte      | SHA-256                                                            |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| ARIA, Procedura di qualificazione della SSI (Word)                                                   | `Procedura+di+qualificazione+della+Scheda+Sanitaria+Informatica+SSI.docx`                                   | 1.511.862 | `842f9a59d93f45ab7de60044bad0e2c99374421b50e5b8605bbacbbb1be78b3d` |
| Allegato 1, schema della domanda di qualifica                                                        | `Allegato+1+-+Schema+per+la+redazione+della+domanda+di+qualifica+SSI.docx`                                  | 1.506.708 | `336308bd4b98faf604147b208bcb0b6bb46d70d64d0c70aa43aec326217f5d06` |
| Allegato 2, Linee Guida Regionali per la SSI, CRS-LG-SSI#01, revisione 2.4 del 31/08/2026, 58 pagine | `Allegato+2+-+Linee+Guida+Regionali+per+la+Scheda+Sanitaria+Informatica.pdf`                                | 1.298.520 | `3ac7ba224136ebf66b86492aa5e9ec9fba342d9f4babc270a7c7fd816d2272cc` |
| Allegato 2.5, checklist dei requisiti funzionali e non funzionali, revisione 3 del 10/09/2026        | `Allegato+2.5+-+Schema+per+l’autodichiarazione+del+possesso+dei+requisiti+funzionali+e+non+funzionali.docx` | 1.591.691 | `56505af37bb32b0d358d4c5c74f6c251ab8d92c735c47889dc7f617643bf6de0` |
| Allegato 3, schema della richiesta di aggiornamento della versione qualificata                       | `Allegato+3+-+Schema+per+la+richiesta+di+aggiornamento+di+versione+qualificata.docx`                        | 1.500.894 | `1357d4900bf9e0919df10e439ad1b4fb685aaa15a0c6e52e0006a93a2f904559` |
| Elenco delle SSI e stato della qualificazione, versione 1.0 del 29/10/2026                           | `Stato+Qualificazione+SSI.pdf`                                                                              | 301.628   | `975b35f91a089fa41983113f25e3bf7286e2f42bb1956df9b705eb5448f2e73f` |

## 9. Verifiche nel codice dei punti «Da verificare» (Code, 26/11/2026)

Fatte sul branch del pezzo 3 dello spostamento, guardando il codice e non l'interfaccia aperta nel browser.

| ID              | Esito              | Che cosa c'è nel codice                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1.3            | In parte           | La fascia della cartella (`apps/web/src/components/PatientFacts.tsx`) ha nome, età, sesso, data di nascita, codice fiscale, stato se non attivo, allergie ed esenzioni in corso. Il codice fiscale è nascosto per difetto e si mostra con un pulsante: da confrontare con «sempre». I problemi attivi non sono nella fascia: sono nel riepilogo della cartella («Problemi attivi», `RecordPage.tsx`). |
| F2.1            | No                 | Consensi e deleghe si registrano (`apps/api/src/patients/privacy.ts`), ma non c'è la stampa dell'informativa né del modulo del consenso.                                                                                                                                                                                                                                                              |
| F3.2            | In parte           | La cronologia è in ordine di data e si filtra solo per tipo (Tutto, Visite, Ricette, Esami), nel servizio (`apps/api/src/patients/timeline.ts`) e nella pagina. Mancano i filtri per data, diagnosi e problema.                                                                                                                                                                                       |
| F6.1.1          | No                 | La scheda del paziente non ha un campo unico di note: il `notes` dello schema citato al paragrafo 3.2 è della tabella dei consensi. Le note in testo libero sono le voci del diario, in testo semplice, senza formattazione.                                                                                                                                                                          |
| F6.2.4 e F6.4.6 | In parte           | L'evidenza c'è sulle terapie («Importante») e nelle pillole della fascia (allergie, esenzioni). Nel testo del diario e delle altre voci no.                                                                                                                                                                                                                                                           |
| F6.4.2 e F6.6.1 | In parte           | Un grafico e una tabella per ogni parametro, con tutti i valori (`apps/web/src/pages/MeasurementsPage.tsx`). Non si scelgono né i parametri né l'intervallo.                                                                                                                                                                                                                                          |
| F6.4.5          | Come nel confronto | «Promemoria il» si scrive sulla voce e compare sulla voce (`ClinicalEntriesPage.tsx`); in Oggi non torna. Oggi ha i piani terapeutici in scadenza, i farmaci carenti e le variazioni AIFA.                                                                                                                                                                                                            |
| F6.5.2          | In parte           | Periodo dal–al e stato «scaduta» (`packages/domain/src/supplies.ts`). La segreteria vede i presidi: la pagina vuole il permesso «therapy.read», che la segreteria ha. In Oggi non c'è l'avviso dei presidi in scadenza.                                                                                                                                                                               |
| NF4.9           | C'è                | Il registro degli accessi non si modifica e ha la catena delle impronte (`apps/api/src/audit/access-log.ts`). Ha un'azione per ogni voce dell'elenco: accessi e uscite; autenticazioni e secondo fattore falliti, conti bloccati; modifiche; esportazioni; annullamenti, perché le voci non si cancellano; azioni degli amministratori.                                                               |

Le lacune del nucleo del punto 5 di «In breve» restano come nel confronto:

- pulsazione e respirazione fra i parametri;
- anamnesi patologica prossima;
- più stati del problema;
- recapiti dei genitori per i minori;
- certificati INAIL;
- importazione del PSS in CDA2;
- ICD-10.

A queste le verifiche aggiungono:

- i problemi attivi nella fascia;
- la stampa dell'informativa e del modulo del consenso;
- i filtri della cronologia per data, diagnosi e problema;
- un campo unico di note del paziente;
- l'evidenza nel testo del diario;
- la scelta di parametri e intervallo nei grafici;
- l'avviso dei presidi in scadenza in Oggi.

Sono tutte proposte da approvare alla fermata (`docs/avanzamento.md`, «Che cosa resta aperto»).

## 10. Che cosa è già cambiato nel contratto delle integrazioni (D297, D298, D300)

Il pezzo 3 dello spostamento ha tenuto conto del paragrafo 5 (`docs/pacchetti-regionali.md`, «Le integrazioni di un pacchetto» e «La Lombardia»):

- **chiamate di contesto**: un meccanismo solo nel nucleo, con le destinazioni date dal pacchetto, ognuna di un tipo che il nucleo conosce, con il suo permesso e la sua voce nel registro; oggi c'è solo il Fascicolo del Piemonte;
- **Fascicolo**: la pubblicazione è un contratto nazionale (documento nuovo, sostituzione, metadati, cancellazione, esito, ricerca) con le politiche e le parole della regione, adatto anche a un repository regionale; per la Lombardia gli servono due aggiunte, da fare con le specifiche: validazione sul Gateway facoltativa e firma del servizio della regione;
- **certificati del Gateway**: uno per regione, dalla regione dello studio (D298);
- **ricetta** (D300): la ricetta SSN della regione è un contratto nazionale con due vie. Il servizio della regione (in Piemonte il SAR, con lotti di NRE e ricetta rossa in DPCM) e il **prescrittore esterno**, la ricetta fatta da un modulo della regione come il PRREG. Il prescrittore esterno è dichiarato soltanto: il programma dice che non c'è ancora e non manda niente. La chiamata di contesto del tipo «ricetta», con le righe preparate, e la ripresa dell'esito si scrivono con le specifiche (ARIA-PRREG-SIAA@01). Le parole del servizio (nome, articolo e preposizioni) sono della regione, così le pagine non nominano il SAR.

Certificati con un servizio regionale, anagrafe da un file giornaliero e accesso con le chiavi del SISS si fissano nei pezzi che toccano certificati, anagrafe e accesso, senza codice per la Lombardia finché non ci sono le specifiche.
