# Confine con il dispositivo medico

**Stato: lettura di Claude Code sulle linee guida europee, da confermare con il consulente regolatorio** (voce M2 di `docs/collaudo.md`). Domanda di Simone del 26/11/2026, dopo la proposta di un governo clinico come MilleGPG: «Valuta fin dove possiamo spingerci senza che debba essere classificato in classe II. Finché possiamo fare noi tutto il lavoro ok. Valuta cosa offre quel tool e capiamo se è classificato come dispositivo medico» (D293).

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
- Gli esempi di classe I sono pochi e lontani da noi: un'app per la fertilità con un algoritmo statistico validato, un'app che aiuta a parlare chi ha un disturbo della comunicazione.
- Il manuale sui casi di confine tratta i **calcolatori medici**: per esempio il punteggio CHA₂DS₂-VASc per il rischio di ictus nella fibrillazione atriale e la clearance della creatinina con Cockcroft-Gault. Sono dispositivi medici, «almeno di classe IIa». Un calcolo del rischio fatto su comportamenti e non su dati fisiologici, come strumento epidemiologico, invece no.

## Che cosa vuol dire per il programma

**Per l'aiuto alla decisione non c'è una classe I.** Un modulo che dà, sul singolo paziente, informazioni usate per decidere diagnosi o terapia è almeno di classe IIa. La classe IIa vuole un organismo notificato, che noi da soli non possiamo sostituire. Quindi il confine utile non è fra la classe I e la classe II: è fra «dispositivo medico» e «non dispositivo medico». Fin lì possiamo fare tutto da noi.

### Fuori dal dispositivo medico: si fa da noi

| Funzione                                                                                                                                | Perché                                                | Nel programma                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------- |
| Cartella, ricette, certificati, invii, dati amministrativi, fatturazione delle prestazioni aggiuntive                                   | Moduli non medici dell'elenco della linea guida       | C'è                             |
| Controlli formali della prescrizione: rimborsabilità, note AIFA, confezioni, esenzioni, piani terapeutici                               | Collegamento ai sistemi di prescrizione e di rimborso | C'è (`docs/regole.md`)          |
| Ricerca con i criteri scritti dal medico                                                                                                | Ricerca semplice                                      | Da fare                         |
| Indicatori di governo clinico come numeri e percentuali sui pazienti del medico; confronto nell'AFT con soli numeri aggregati; registri | Dati di popolazione aggregati, registri (passo 4)     | Da fare, con l'AIR (D287, D293) |
| Ricerca nelle linee guida e nelle schede tecniche senza i dati del paziente                                                             | Letteratura scientifica (passo 4)                     | Da fare (D290)                  |
| Valori dei referti con l'intervallo stampato dal laboratorio, senza giudizio                                                            | Conservazione e visualizzazione                       | C'è (D71)                       |

### Da confermare con il consulente regolatorio

| Funzione                                                                                                                                  | Il dubbio                                                                                                                         | Proposta                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Elenchi nominativi di un indicatore, per l'audit (per esempio, i diabetici senza emoglobina glicata registrata nell'anno)                 | Sono ricerche sui dati, ma servono ad agire sui singoli pazienti: una ricerca non è «semplice» se contribuisce a uno scopo medico | Non si costruiscono prima del parere. Intanto il medico ha la ricerca con i suoi criteri |
| R11, contatore delle confezioni                                                                                                           | Informa che una ricetta arriva prima della copertura delle precedenti                                                             | Resta com'è, già annotata per il consulente (`docs/regole.md`)                           |
| RAO: la classe di priorità dalla tabella ufficiale, per la condizione scelta dal medico                                                   | È organizzazione dell'accesso, ma la condizione è clinica                                                                         | Resta com'è: la condizione la sceglie il medico, la tabella è dell'atto (D285)           |
| Strumenti con l'intelligenza artificiale di D290: valori dei referti come dati strutturati da validare; codici ICD-9 dal testo del medico | Conversione e codifica, ma fatte con un modello                                                                                   | Il medico conferma sempre; nessuna interpretazione dei valori                            |
| Valori fuori dall'intervallo del referto evidenziati                                                                                      | Confronto con l'intervallo del laboratorio (requisiti)                                                                            | Resta escluso (D71)                                                                      |

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

## Che cosa si fa

- **Governo clinico che non decide**, con la rendicontazione dell'AIR (D287), perché l'AIR chiede già gli indicatori di AFT e l'estrazione dei dati (artt. 16–18 e 22):
  - nel nucleo il meccanismo: indicatori come dato, con fonte e versione (chi conta, su quali pazienti, in quale periodo); conteggi sui pazienti del medico; cruscotto; confronto nell'AFT con soli numeri aggregati; la ricerca con i criteri del medico;
  - nel pacchetto del Piemonte gli indicatori dell'AIR e dell'ASL, con i valori «da completare» finché Regione e ASL non li danno.
- **Niente** promemoria nella cartella, punteggi o calcolatori clinici, giudizi di appropriatezza sul singolo paziente.
- **Gli elenchi nominativi degli indicatori** aspettano il parere del consulente regolatorio.

## Che cosa non è provato

- È la lettura di Claude Code, non il parere di un esperto: le linee guida non sono vincolanti e la qualificazione dipende dallo scopo dichiarato dal fabbricante.
- La scheda EUDAMED di Millewin non è letta per intero; per MilleGPG non c'è documentazione di oggi.
- Il testo ufficiale italiano della regola 11 non è letto: le citazioni vengono dalla linea guida in inglese.
