# Confine con il dispositivo medico

**Stato: deciso il 26/11/2026, senza consulente esterno** (D293, D294). Il programma resta fuori dal dispositivo medico, con le scelte prudenti scritte qui sotto. La classe I fatta da noi non è fattibile per le funzioni che aiutano a decidere.

- Domanda di Simone del 26/11/2026, dopo la proposta di un governo clinico come MilleGPG: «Valuta fin dove possiamo spingerci senza che debba essere classificato in classe II. Finché possiamo fare noi tutto il lavoro ok. Valuta cosa offre quel tool e capiamo se è classificato come dispositivo medico» (D293).
- Poi: «valutiamo se possiamo arrivare in classe I […] facendo noi tutto il lavoro senza dover avvalerci di consulenti esterni e senza dover pagare somme inutili […] non voglio che questo resti da chiarire». Con il pulsante: «Valutiamo se fattibile in classe I, facendo noi tutto il lavoro come con Ponderis. Se non fattibile ok "Fuori dal DM, scelte prudenti"» (D294).

La regola 3 resta: il programma non diventa un dispositivo medico.

## Le fonti lette

Le due linee guida sono state lette il 26/11/2026, scaricate dal sito della Commissione europea; non entrano nel repository (D92), le impronte sono in `docs/provenienze.md`. Non sono vincolanti: le scrive il gruppo di coordinamento dei dispositivi medici (MDCG) e solo la Corte di giustizia dà l'interpretazione vincolante.

- **MDCG 2019-11 rev. 1**, giugno 2025: qualificazione e classificazione del software nei regolamenti (UE) 2017/745 e 2017/746.
- **Manuale sui casi di confine e sulla classificazione**, versione 5, aprile 2026.
- **EUDAMED**, la banca dati europea dei dispositivi medici: ricerca per nome commerciale, il 26/11/2026.
- Il testo del regolamento (UE) 2017/745 su EUR-Lex non si apre da questo ambiente: il sito risponde con una verifica per i programmi. La regola 11 è letta dove la linea guida la cita per intero. Le traduzioni qui sotto sono nostre.

## Che cosa dicono

### Quando un software è un dispositivo medico

La linea guida dà cinque passi; contano il terzo e il quarto.

- **Passo 3, che cosa fa sui dati.** Conservare, archiviare, comunicare, comprimere senza perdite e la «ricerca semplice» non bastano per farne un dispositivo medico. La ricerca semplice è il recupero dei record che corrispondono a criteri, come nelle biblioteche. Elaborare, analizzare, interpretare, calcolare, creare o modificare informazioni con uno scopo medico può bastare. Una ricerca non è più «semplice» se contribuisce a uno scopo medico.
- **Passo 4, per chi.** Lo scopo medico deve essere per il singolo paziente. Non lo è il software che soltanto «aggrega dati di popolazione», dà percorsi diagnostici o terapeutici generici, letteratura scientifica, atlanti e modelli, o serve solo a studi epidemiologici o registri.

### La cartella clinica e i suoi moduli

- **La cartella elettronica** che sostituisce quella di carta, per conservare e trasmettere i dati del paziente, non è un dispositivo medico.
- **Moduli non medici**, nell'elenco della linea guida:
  - dati amministrativi del paziente;
  - storia clinica;
  - fatturazione e contabilità;
  - collegamento ai sistemi di rimborso;
  - collegamento ai sistemi di prescrizione e dispensazione dei farmaci.
- **Moduli che sono dispositivi medici**, negli esempi della linea guida:
  - quelli che analizzano i dati del singolo paziente per suggerire aggiustamenti della dose o segnalare possibili interazioni;
  - quelli che danno raccomandazioni terapeutiche o avvisi di interazioni avverse, o che segnalano situazioni ad alto rischio perché si intervenga.
- **Chi fa il programma** deve dire con chiarezza quali moduli sono dispositivi medici e quali no.

### La classe

La regola 11, come la cita la linea guida: il software destinato a fornire informazioni usate per prendere decisioni a fini diagnostici o terapeutici è di **classe IIa**. È di classe IIb se quelle decisioni possono causare un grave peggioramento della salute o un intervento chirurgico, di classe III se possono causare la morte o un danno irreversibile. Il software che monitora processi fisiologici è IIa o IIb. «Tutto l'altro software è di classe I».

- La linea guida dice che la prima parte della regola descrive «in termini molto generali» il modo di agire di ogni software medico e quindi «si applica in generale a tutto il software dispositivo medico», tranne quello senza scopo medico.
- La tabella della linea guida per la regola 11 (allegato III) ha nove caselle: dalla situazione critica a quella non grave, e dall'informazione che «cura o diagnostica» a quella che soltanto «informa la gestione clinica». Anche l'ultima casella, un'informazione che soltanto informa in una situazione non grave, è di classe IIa: «IMDRF risk category II and IMDRF risk category I products are classified as MDR class IIa as per Rule 11». La classe I non c'è: «This table does not take into account MDSW which is Class I».
- La classe I resta al software medico che non serve a decidere diagnosi o terapia e non monitora (sottoregola 11c, «all other MDSW»). Gli esempi sono pochi e lontani da noi: un'app per la fertilità con un algoritmo statistico validato, un'app che aiuta a parlare chi ha un disturbo della comunicazione.
- Il manuale sui casi di confine tratta i **calcolatori medici**: per esempio il punteggio CHA₂DS₂-VASc per il rischio di ictus nella fibrillazione atriale e la clearance della creatinina con Cockcroft-Gault. Sono dispositivi medici, «almeno di classe IIa». Un calcolo del rischio fatto su comportamenti e non su dati fisiologici, come strumento epidemiologico, invece no.

## Che cosa vuol dire per il programma

**Per l'aiuto alla decisione non c'è una classe I.** Un modulo che dà, sul singolo paziente, informazioni usate per decidere diagnosi o terapia è almeno di classe IIa. La classe IIa vuole un organismo notificato, che noi da soli non possiamo sostituire. Quindi il confine utile non è fra la classe I e la classe II: è fra «dispositivo medico» e «non dispositivo medico». Fin lì possiamo fare tutto da noi.

### La classe I fatta da noi (D294)

La classe I si dichiara da soli, senza organismo notificato: per questo Simone ha chiesto se si può arrivare lì facendo noi tutto il lavoro, come per Ponderis. **Per questo programma non è fattibile.**

- Le funzioni che lo farebbero diventare dispositivo medico sono interazioni, dosi, carte del rischio, appropriatezza e promemoria sul singolo paziente. Tutte danno informazioni usate per decidere diagnosi o terapia: sono almeno di classe IIa (sottoregola 11a e tabella dell'allegato III).
- Nessuna funzione utile alla cartella del medico di famiglia è del tipo della classe I.
- Diventare dispositivo medico di classe I non darebbe quindi nessuna funzione in più. Porterebbe invece gli obblighi di un fabbricante di dispositivi medici, che valgono anche in classe I.
- Per Ponderis decide il suo scopo dichiarato: non è in questo repository.

### Fuori dal dispositivo medico: si fa da noi

| Funzione                                                                                                                                | Perché                                                | Nel programma                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------- |
| Cartella, ricette, certificati, invii, dati amministrativi, fatturazione delle prestazioni aggiuntive                                   | Moduli non medici dell'elenco della linea guida       | C'è                             |
| Controlli formali della prescrizione: rimborsabilità, note AIFA, confezioni, esenzioni, piani terapeutici                               | Collegamento ai sistemi di prescrizione e di rimborso | C'è (`docs/regole.md`)          |
| Ricerca con i criteri scritti dal medico                                                                                                | Ricerca semplice                                      | Da fare                         |
| Indicatori di governo clinico come numeri e percentuali sui pazienti del medico; confronto nell'AFT con soli numeri aggregati; registri | Dati di popolazione aggregati, registri (passo 4)     | Da fare, con l'AIR (D287, D293) |
| Ricerca nelle linee guida e nelle schede tecniche senza i dati del paziente                                                             | Letteratura scientifica (passo 4)                     | Da fare (D290)                  |
| Valori dei referti con l'intervallo stampato dal laboratorio, senza giudizio                                                            | Conservazione e visualizzazione                       | C'è (D71)                       |

### Le scelte prudenti (D294)

La zona di confine si chiude qui, con la lettura più prudente delle linee guida, senza consulente esterno.

| Funzione                                                                                                                                                                                              | Scelta                                                        | Perché                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Elenchi di pazienti da richiamare: quelli dietro un indicatore (per esempio, i diabetici senza emoglobina glicata registrata nell'anno), per un controllo, una cura, una vaccinazione o uno screening | Non si costruiscono                                           | Servono ad agire sul singolo paziente, e una ricerca che contribuisce a uno scopo medico non è più «semplice»                                                                                                                                                                                                                           |
| Elenchi di atti già fatti, per rendicontare: vaccinati, inviati allo screening, prestazioni eseguite                                                                                                  | Si fanno                                                      | Sono registri (passo 4)                                                                                                                                                                                                                                                                                                                 |
| Ricerca con i criteri scritti dal medico                                                                                                                                                              | Si fa, senza criteri clinici già pronti forniti dal programma | È la ricerca semplice: i criteri sono del medico                                                                                                                                                                                                                                                                                        |
| R11, contatore delle confezioni                                                                                                                                                                       | Resta com'è                                                   | Conta date e quantità delle ricette, come i controlli di rimborsabilità, e non usa dati clinici (diagnosi, valori, dosi rispetto alla scheda tecnica): è il collegamento alla prescrizione, un modulo non medico. Il testo della sua fonte («da validare … con il consulente regolatorio») cambia con la prossima versione delle regole |
| RAO: la classe di priorità per la condizione scelta dal medico                                                                                                                                        | Resta com'è (D285)                                            | La condizione la sceglie il medico dall'elenco dell'atto regionale; il programma riporta la classe che l'atto lega a quella condizione, un dato della ricetta come il tipo di accesso (R14)                                                                                                                                             |
| Strumenti con l'intelligenza artificiale di D290: valori dei referti da validare, codici ICD-9 dal testo del medico, ricerca nelle linee guida                                                        | Restano come deciso, con la conferma del medico               | Convertono e codificano senza interpretare; la ricerca nelle linee guida non usa i dati del paziente (passo 4)                                                                                                                                                                                                                          |
| Valori fuori dall'intervallo del referto evidenziati                                                                                                                                                  | Restano esclusi (D71)                                         | Sarebbe un giudizio del programma su un dato del singolo paziente: si mostra l'intervallo stampato dal laboratorio, senza giudizio                                                                                                                                                                                                      |

### Dentro il dispositivo medico: almeno classe IIa, quindi fuori (regola 3)

- Avvisi su interazioni, dosi e allergie quando si prescrive (R12, già fuori dai requisiti).
- Punteggi e calcolatori clinici, come CHA₂DS₂-VASc e Cockcroft-Gault. Anche il BMI resta scritto a mano (D127).
- Raccomandazioni terapeutiche, terapie messe in ordine di preferenza, giudizi di appropriatezza dei farmaci sul singolo paziente.
- Promemoria nella cartella che segnalano un paziente da controllare o da trattare.
- Rischio clinico del singolo paziente.

Per l'Unione europea c'è anche il regolamento sullo spazio europeo dei dati sanitari (EHDS), che la linea guida richiama per le cartelle elettroniche. È un regime diverso dal dispositivo medico, da guardare a parte.

## MilleGPG

### Che cosa offre

Le fonti pubbliche trovate sono del 2010–2013: articoli della rivista della SIMG e un articolo su Primary Health Care Research & Development (2013, [doi:10.1017/S1463423613000042](https://doi.org/10.1017/S1463423613000042)). La documentazione di oggi non l'abbiamo trovata.

- È un modulo aggiuntivo della cartella Millewin, fatto da Genomedics e Millennium su indicazione della SIMG, nato con la banca dati Health Search.
- Estrae i dati della cartella e ne ricava indicatori di processo e di esito intermedio. Nel 2010 erano 81; uno studio successivo ne conta 216, in tre aree: audit clinico, appropriatezza farmacologica, rischio clinico.
- Un cruscotto mostra gli indicatori e li confronta con Health Search e con la mediana del gruppo; il coordinatore vede i valori dei medici del suo gruppo. Serve anche agli audit di gruppo.
- L'articolo del 2013 parla anche di promemoria e avvisi nella cartella, per riconoscere i problemi clinici e agire.

### È un dispositivo medico?

- In EUDAMED, il 26/11/2026, non c'è un dispositivo con il nome commerciale «MilleGPG» o «Mille GPG». Con «GPG» ce ne sono 32; i dieci letti sono impianti dentali di un altro fabbricante.
- C'è invece **«MILLEWIN» di Millennium S.p.A., di classe I**.
- Il resto della scheda di Millewin (lo scopo dichiarato, la regola applicata, se è un dispositivo della direttiva di prima) non l'abbiamo letto: il controllo dei permessi di questa sessione ha fermato le altre interrogazioni a EUDAMED.
- Non sappiamo quindi se MilleGPG sia compreso nella registrazione di Millewin o se non sia registrato. La sola assenza dalla banca dati non prova che non sia un dispositivo medico.

### Letto con la linea guida

- Il cruscotto e il confronto aggregato sono dati di popolazione: fuori dal dispositivo medico.
- Appropriatezza farmacologica, rischio clinico e promemoria sul singolo paziente corrispondono agli esempi di moduli medici della linea guida: sarebbero almeno di classe IIa.
- Gli indicatori di MilleGPG e di Health Search non si usano (regola 2): le definizioni vengono da atti pubblici (AIR, ASL, percorsi diagnostico-terapeutici regionali) o le scrive il medico.

### La schermata di GPG

Simone ha mandato la pagina iniziale di GPG, versione «7.0.0 CE» (26/11/2026). È letta solo nella conversazione e non entra nel repository: suggerisce funzioni, non impaginazione, testi o nomi (regola 2, D89).

- **Funzioni che restano fuori dal dispositivo medico**: i conteggi per area (malattie croniche, vaccinazioni, screening) con il dettaglio e la fonte; il confronto con i colleghi dell'AFT con soli numeri aggregati; un indice di completezza dei dati della cartella; gli obiettivi dell'AFT e degli accordi aziendali; la data dell'ultimo calcolo.
- **Funzioni dentro**: le carte del rischio (calcolatori), l'appropriatezza sul singolo paziente, il rischio clinico, le estrazioni di pazienti con l'intelligenza artificiale.
- «CE» accanto alla versione può essere la marcatura di dispositivo medico, coerente con le carte del rischio; può anche voler dire altro. Non è verificato.

## Che cosa si fa

- **Governo clinico che non decide**, con la rendicontazione dell'AIR (D287), perché l'AIR chiede già gli indicatori di AFT e l'estrazione dei dati (artt. 16–18 e 22):
  - nel nucleo il meccanismo: indicatori come dato, con fonte e versione (chi conta, su quali pazienti, in quale periodo); conteggi sui pazienti del medico; cruscotto; confronto nell'AFT con soli numeri aggregati; la ricerca con i criteri del medico;
  - nel pacchetto del Piemonte gli indicatori dell'AIR e dell'ASL, con i valori «da completare» finché Regione e ASL non li danno.
- **Niente** promemoria nella cartella, punteggi o calcolatori clinici, giudizi di appropriatezza sul singolo paziente.
- **Niente elenchi di pazienti da richiamare** dietro gli indicatori; sì agli elenchi di atti già fatti, per rendicontare (D294).
- **La pagina**: un cruscotto nuovo, con i colori e i caratteri del programma. Prima di costruirla, una bozza con dati inventati da guardare, quando si arriva all'AIR (risposta di Simone).

## Che cosa non è provato

- È la lettura di Claude Code delle linee guida, scelta da Simone senza consulente esterno (D294): le linee guida non sono vincolanti e la qualificazione dipende dallo scopo dichiarato dal fabbricante. Per questo le scelte sono le più prudenti.
- La scheda EUDAMED di Millewin non è letta per intero; per MilleGPG non c'è documentazione di oggi.
- Il testo ufficiale italiano della regola 11 non è letto: le citazioni vengono dalla linea guida in inglese.
