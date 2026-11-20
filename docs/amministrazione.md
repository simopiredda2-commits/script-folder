# Strumenti e amministrazione (tappa 14, D163)

Documento per la revisione della tappa 14. Richiesta di Simone del 19/11/2026: «nel pannello admin o strumenti ci devono essere tutte le varie opzioni di configurazione e impostazioni del programma: dati editabili …, impostazioni stampanti, e tutto ciò che ritieni possa rientrare tra le impostazioni».

Tutto sta in **Strumenti**, una scheda per area. Ognuno vede le schede del suo ruolo; chi può modificare lo decide il servizio, non la scheda. Ogni modifica va nel registro degli accessi come azione di amministrazione, con i nomi dei campi cambiati e mai password o segreti, anche quando è negata.

## Chi vede che cosa

| Scheda                      | Amministratore    | Titolare          | Sostituto                    | Segreteria |
| --------------------------- | ----------------- | ----------------- | ---------------------------- | ---------- |
| Dati dello studio           | Modifica          | Legge             | Legge                        | —          |
| Utenti e ruoli              | Modifica          | —                 | —                            | —          |
| Utenti da confermare        | —                 | Conferma          | —                            | —          |
| Postazioni e stampa         | Modifica          | La sua postazione | La sua postazione            | —          |
| Elenchi dello studio        | Modifica          | Modifica          | Modifica, mentre sostituisce | Legge      |
| Modelli dei certificati     | Modifica          | Modifica          | Modifica                     | —          |
| Impaginazione               | —                 | La sua            | La sua                       | —          |
| Fascicolo sanitario         | Modifica          | Legge             | Legge                        | —          |
| Banche dati                 | «Aggiorna adesso» | Legge             | Legge                        | —          |
| AFT                         | —                 | La sua            | —                            | —          |
| Importazione                | —                 | Nel suo archivio  | —                            | —          |
| Registro di amministrazione | Legge             | Legge             | —                            | —          |
| Stato del servizio          | Legge             | —                 | —                            | —          |

La segreteria vede in Strumenti solo gli elenchi dello studio, in sola lettura: le servono per preparare (D175, che aggiorna D146). La pagina della password è per tutti, dal menu dell'utente.

## Primo avvio (D167)

Fuori dai dati dimostrativi, uno studio vero nasce con un comando sul server:

```sh
pnpm studio:crea -- --nome "Studio medico …" --tipo singolo --regione PIEMONTE \
  --amministratore nome.cognome --nome-amministratore "Nome Cognome"
```

Il comando applica le migrazioni, crea lo studio e il primo amministratore (senza accesso clinico) e mostra una sola volta la password temporanea. Al primo accesso si attiva il secondo fattore e si cambia la password; poi l'amministratore crea gli altri utenti da Strumenti. In produzione (`APP_AMBIENTE=produzione`, D170) i dati dimostrativi non si possono creare.

Il primo medico titolare lo crea l'amministratore, ma resta in attesa: nello studio non c'è ancora un titolare che possa confermarlo. Lo conferma chi gestisce il servizio, sul server, in due passi, dopo aver controllato con il medico che nome, ruoli e dati siano i suoi; la password temporanea si vede solo lì, una volta, da consegnare al medico (D179):

```sh
pnpm utente:ripristina -- --utente nome.cognome --mostra
pnpm utente:ripristina -- --utente nome.cognome --conferma --richiesta-il DATA
```

Chi gestisce il servizio riconosce il medico di persona, con un documento e il codice regionale, e lo annota fuori dal programma (D181). Il primo comando stampa la richiesta senza cambiare nulla: ruoli (anche con i codici), dati del medico, chi l'ha fatta e la data esatta, che il secondo vuole uguale; se nel frattempo l'amministratore ha cambiato l'utente, il secondo rifiuta e rimanda al primo. Per non confermare: `--rifiuta`. Da lì in poi medici e segreteria li conferma un titolare, dal programma; con un titolare attivo e confermato il comando rifiuta e rimanda alla conferma dal programma.

In uno studio con un solo medico servono due utenti, l'amministratore e il medico: nessuno cambia i propri ruoli. Al medico confermato l'amministratore può poi aggiungere il ruolo di amministratore.

All'installazione, se davanti al servizio c'è un proxy inverso, il suo indirizzo va in `APP_PROXY_FIDATI` (indirizzi o reti separati da virgole): altrimenti nel registro dei tentativi falliti l'indirizzo sarebbe sempre quello del proxy. Vuota, l'intestazione X-Forwarded-For si ignora.

## Utenti e ruoli (D164) e password (D165)

- L'amministratore crea gli utenti con uno o più ruoli e, per i medici, nome, cognome, codice fiscale (controllato), codice regionale e ASL. La password temporanea si vede una volta e va consegnata di persona (per medici e segreteria la riceve il titolare che conferma, qui sotto); al primo accesso si cambia prima di ogni altra cosa.
- Il ruolo di titolare crea l'archivio del medico; togliere un ruolo non cancella nulla.
- Sospendere, riattivare, sbloccare dopo troppi tentativi: dall'elenco, con conferma (per medici e segreteria con i limiti qui sotto). Nessuno agisce su sé stesso e nessuno cambia i propri ruoli; l'ultimo amministratore attivo non si toglie.
- Password da 12 a 128 caratteri, diversa dalla precedente e dal nome utente; gli errori sulla password attuale contano come codici sbagliati (qui sotto, D188); il cambio chiude le altre sessioni.

### Ripristino con SPID o CIE (D189)

- Dalla pagina di accesso, «Ripristina con SPID o CIE»: nome utente e postazione, poi SPID o CIE. Se la persona riconosciuta ha il codice fiscale dell'utente, sceglie una password nuova e, se ha perso l'app, azzera il secondo fattore. Il conto si sblocca e tutte le sessioni si chiudono.
- Vale per medici e segreteria attivi, confermati e non sospesi dal server. Per il medico conta il codice fiscale del suo profilo; la segreteria collega prima la sua identità dal suo profilo («Cambia la password» › «SPID o CIE per il ripristino»), con il codice a 6 cifre di adesso. Gli amministratori no.
- Nel registro di amministrazione: «Ripristino delle credenziali, dall'utente stesso, con SPID o CIE», e i collegamenti dell'identità.
- Se il ripristino non riesce, la pagina dice che cosa fare con un testo del programma: nell'indirizzo del ritorno c'è solo un codice, mai un testo che altri potrebbero scrivere (D193). Il motivo vero è nel registro degli accessi.
- Oggi SPID e CIE sono simulati: in produzione il ripristino resta spento finché il programma non è accreditato come fornitore di servizi (da completare).

### Tentativi sbagliati e blocchi (D188)

- **Attese per provenienza.** Dopo 5 password sbagliate di seguito dalla stessa postazione (a quello stesso indirizzo), o 20 dallo stesso indirizzo, ogni password aspetta: 2 secondi, poi il doppio, fino a 15 minuti. Intanto da lì nessuna password si guarda e chi accede legge «riprova tra …». Una password giusta, o un giorno senza errori, fanno ricominciare da capo. Chi prova da un altro computer non aspetta: il medico entra anche mentre qualcuno, altrove, prova il suo nome utente. I valori, confermati da Simone (D191), sono nello stato del servizio.
- **Blocco del conto, due soglie dello studio.** Le password sbagliate bloccano il conto solo alla soglia alta (per difetto 50, da 20 a 100): le sbaglia anche chi conosce solo il nome utente. I codici a 6 cifre sbagliati, all'accesso e allo sblocco della sessione, e la password attuale sbagliata nel cambio bloccano alla soglia di prima (5, da 3 a 10): li sbaglia solo chi ha già la password o una sessione. Il blocco dura 15 minuti (al più 60).
- **Avviso di ogni blocco** all'utente bloccato e ai medici titolari dello studio, nella cornice, finché ognuno non lo segna come visto nella pagina «Blocchi del conto»: chi, quando, fino a quando, quanti tentativi, da quali indirizzi e postazioni, e che cosa può voler dire. Ogni lettura degli avvisi va nel registro.

### L'amministratore non si prende l'accesso clinico (D179)

Requisiti, «Utenti e ruoli»: l'amministratore non ha accesso clinico, a meno che non sia anche medico. Chi crea gli utenti e ne gestisce le credenziali, però, potrebbe creare un medico o una segreteria, o ripristinarne la password, ed entrare al suo posto. Per questo, con le correzioni di tre revisioni avversarie (dettagli in D179):

- **Conferma di un titolare.** Chi ha un ruolo con i dati dei pazienti (medico titolare, medico sostituto, segreteria), creato dall'amministratore o con uno di quei ruoli aggiunto da lui, resta «in attesa di conferma» e non entra. Lo conferma o lo rifiuta un medico titolare attivo dello studio, in **Strumenti › Utenti da confermare**, dopo aver visto ruoli e dati; si conferma solo la richiesta letta. La password temporanea la riceve il titolare, una volta sola, e la consegna di persona: l'amministratore non la vede mai. Il rifiuto sospende l'utente.
- **Senza un titolare che possa confermare** (studio nuovo, titolari tutti sospesi o in attesa) decide chi gestisce il servizio, sul server, in due passi: `--mostra`, poi `--conferma --richiesta-il DATA` oppure `--rifiuta` (sopra, «Primo avvio»). Nessuna eccezione per il primo titolare.
- **Nomi e dati senza caratteri nascosti:** nei nomi, nei dati del medico e nei testi dello studio non entrano caratteri di controllo, a capo o invisibili, che sul terminale del server potrebbero far leggere una richiesta diversa da quella vera.
- **Credenziali di medici e segreteria dal server, o da loro stessi con SPID o CIE:** password temporanea, azzeramento del secondo fattore, sblocco dopo i tentativi falliti, con `pnpm utente:ripristina` (`--secondo-fattore`, `--sblocca`, `--sospendi`, `--riattiva`); ogni azione va nel registro con «tramite: comando del server». In più medici e segreteria ripristinano da soli password, secondo fattore e blocco con SPID o CIE (qui sotto, D189). Per gli amministratori si fa da Strumenti. Chi è sospeso o rifiutato dal server si riattiva solo dal server.
- **Titolari protetti:** l'amministratore non sospende e non toglie il ruolo a un titolare con pazienti, né all'ultimo titolare attivo e confermato, e non aggiunge segreteria o sostituto a un titolare con pazienti; un titolare con pazienti sospeso si riattiva solo dal server, e un titolare in attesa con pazienti non si rifiuta dal programma. Se nell'archivio del medico è in corso una scrittura (per esempio un'importazione), la sospensione risponde dopo al più 2 secondi «riprova tra qualche minuto».
- **Pazienti nuovi solo negli archivi aperti:** nell'archivio di un titolare sospeso, non più titolare o in attesa di conferma non entrano pazienti, né a mano né con l'importazione; quegli archivi non si propongono nel nuovo paziente, e un titolare in attesa non si sceglie come medico di famiglia.
- **Codici del medico corretti:** se l'amministratore corregge il codice regionale di un medico, la sessione del servizio regionale si chiude e la risposta lo dice. Il **codice fiscale** di un medico confermato invece resta quello di prima finché il medico non conferma la correzione dal programma (D181, D184): il medico vede l'avviso, la conferma o la rifiuta in «Recapiti di studio»; alla conferma il codice cambia e le sessioni dei servizi si chiudono. L'amministratore vede la correzione in attesa e la può ritirare. Per chi è ancora in attesa di conferma la correzione vale subito: chi conferma la vede nella richiesta.
- **Accesso:** il passaggio fra password e codice guarda al più tanti codici quanti i codici sbagliati ammessi dallo studio, giusti o sbagliati, anche con molte richieste insieme, e non vale per un utente bloccato; un passaggio di attivazione aperto prima non vale dopo l'attivazione; il blocco dura al più 60 minuti; ogni tentativo fallito registra anche l'indirizzo della richiesta (con il proxy in `APP_PROXY_FIDATI`). Con il servizio sovraccarico la risposta è «servizio occupato, riprova» invece di un'attesa senza fine.

## Dati e impostazioni dello studio (D166)

Nome, tipo, regione (obbligatoria: senza, nessuna ricetta SSN parte), indirizzo completo, telefono, email, PEC, intestazione dello studio, sicurezza dell'accesso, tempo di attesa degli invii, soglie degli avvisi sugli accessi anomali.

- **Intestazione dello studio:** vale nei certificati dai modelli quando il medico non ha la sua.
- **Indirizzo completo:** è il luogo della visita in studio sulla copia INPS.
- **Sicurezza:** 5 minuti di inattività, 50 password sbagliate o 5 codici sbagliati, 15 minuti di blocco (D29, D188); si cambiano qui, entro limiti di buon senso (le password da 20 a 100, i codici da 3 a 10, il blocco al più 60 minuti, perché non tenga fuori un medico per un giorno, D179). Le attese dopo le password sbagliate sono del servizio e si vedono nello stato del servizio.
- **Tempo di attesa degli invii:** 8 secondi per difetto; la Regione indica 6–8 (D94). Si legge a ogni invio di ricette e certificati.
- **Soglie degli avvisi sugli accessi anomali** (Garante, linee guida sul dossier sanitario, par. 7, lett. c): vuote, quindi avvisi spenti, finché qualcuno non dà i valori (da completare).

## Segreteria per archivio (D181, D185)

In medicina di gruppo ogni titolare conferma la segreteria per il suo archivio: finché non lo fa, la segreteria non vede i suoi pazienti, nemmeno l'anagrafica.

- Il titolare che conferma la segreteria come utente la conferma anche per il suo archivio. Gli altri titolari la trovano in **Strumenti › Utenti da confermare**, sotto «Segreteria sul tuo archivio»: «Conferma per il mio archivio» o «Non sul mio archivio». Lì vedono anche la segreteria che lavora già sul loro archivio, con «Togli dal mio archivio».
- Un archivio nuovo, di un titolare nuovo, parte senza segreteria: la conferma il nuovo titolare.
- Se l'amministratore toglie o ridà il ruolo di segreteria, le conferme di prima non valgono più: ogni titolare decide di nuovo.
- La conferma dal server (quando nessun titolare può confermare) non dà nessun archivio: lo dà ogni titolare per il suo.
- In **Utenti e ruoli** l'amministratore vede, per ogni segreteria, archivio per archivio: confermata dal titolare, non ci lavora, da confermare.
- Ogni decisione si aggiunge e non si cambia; vale l'ultima. Conferme e tolte vanno nel registro delle azioni di amministrazione e nell'esportazione completa dell'archivio.
- Le segreterie confermate prima di questa regola restano su tutti gli archivi dello studio, come lavoravano (migrazione 0028): ogni titolare le può togliere dal suo.

## Elenchi dello studio (D175)

Quattro elenchi comuni dello studio, in **Strumenti › Elenchi dello studio**: li scrivono i titolari, l'amministratore e il sostituto mentre ha un'autorizzazione attiva su un archivio dello studio (D181); li leggono tutti, segreteria compresa. Non contengono dati dei pazienti. Una voce non si cancella: si archivia, perché una terapia o una ricetta può averla usata.

| Elenco                   | Campi                                                                                        | Dove si usa                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Medici suggeritori       | Nome (obbligatorio), struttura, specialità, telefono                                         | Scheda della terapia › Medico suggeritore: riempie nome e struttura                 |
| Posologie                | Testo (obbligatorio); dose, unità, frequenza, momento, via (facoltativi)                     | Scheda della terapia › Come si prende (solo le parti); righe dei farmaci in ricetta |
| Pacchetti di prestazioni | Nome e da 1 a 30 prestazioni, scelte dal catalogo regionale in vigore (codice e descrizione) | Ricetta specialistica › «Aggiungi un pacchetto»                                     |
| Contatti utili           | Nome e tipo (struttura, specialista, laboratorio, altro); telefono, email, indirizzo, note   | Consultazione                                                                       |

- **Pacchetti dal catalogo.** Ogni codice si cerca nel catalogo in vigore alla data dello studio, con la descrizione del catalogo: un pacchetto non si inventa. Una prestazione uscita dal catalogo resta nel pacchetto finché non la si toglie, l'elenco la segnala e la ricetta non la aggiunge, e lo dice.
- **Doppioni** fra le voci attive dello stesso tipo: stesso medico nella stessa struttura, stesso testo di posologia, stesso nome di pacchetto, stesso contatto dello stesso tipo.
- **Registro:** ogni scrittura, con i campi cambiati, prima e dopo; i tentativi negati anche.
- **Esportazione completa:** gli elenchi ci sono, anche le voci archiviate (regola 4).

## Archivio del titolare: autorizzazioni e avvisi (D177)

Nella pagina **Archivio**, solo per il titolare:

- **Autorizzazioni sull'archivio:** elenco con medico, tipo, periodo, motivo, chi l'ha data e lo stato (attiva, futura, scaduta, revocata); «Nuova autorizzazione» con tipo, medico, dal e al (giorni interi), motivo; «Revoca», con conferma, chiude subito. Sostituzione ai sostituti; medicina di gruppo agli altri titolari, solo in uno studio di gruppo.
- **Avvisi sugli accessi anomali** degli ultimi 7, 30 o 90 giorni: cartelle diverse aperte da un utente in un giorno, accessi nella fascia oraria, consultazioni dell'AFT di un collega in un giorno. Con le soglie vuote la pagina dice quali completare e la fonte (Garante, linee guida sul dossier sanitario, par. 7, lett. c). Le importazioni non contano: sono un'operazione massiva, nella storia delle importazioni.

## Registro di amministrazione (D177)

In **Strumenti › Registro di amministrazione**, per i titolari e l'amministratore: quando, chi, postazione, area, azione con il dettaglio (nomi dei campi cambiati, mai i valori), esito a parole; a pagine, dalle più recenti. Ogni lettura è registrata. In medicina di gruppo un titolare non vede le autorizzazioni e le impostazioni degli archivi dei colleghi, né le modifiche delle AFT di cui non fa parte; l'amministratore vede tutto lo studio.

## Postazioni e stampa (D166, D178, D180)

- **Postazioni:** il nome che ognuno scrive all'accesso, per ogni computer dello studio, condivisa o personale; il browser lo ricorda dopo una password giusta (D178). Si archiviano, non si cancellano.
- **Preferenze di stampa** per sei documenti: promemoria SSN, ricetta bianca, certificato INPS, certificati dai modelli, schema orario, Profilo sanitario. Per ognuno: stampante consigliata, copie (da 1 a 5), carta (A5 o A4 per il promemoria SSN, A5 per difetto, D222; A4 o A5 per i certificati dai modelli e lo schema orario), e per il promemoria che cosa proporre per primo (completo o solo NRE). Vale la postazione, poi lo studio, poi la predefinita, campo per campo.
- **Chi:** le imposta l'amministratore, per lo studio o per una postazione; medici e segreteria vedono che cosa vale sulla loro postazione e un suggerimento accanto a ogni pulsante di stampa.
- **Che cosa fa davvero il programma**, che sta nel browser: stampante e copie si suggeriscono e si confermano nella finestra di stampa; la carta del promemoria SSN e dei certificati dai modelli cambia il PDF, anche quello allegato all'email. Il promemoria è grande metà foglio A4 come vogliono le specifiche del 28/02/2024 (D217): su A5 riempie la pagina, su A4 ne occupa la metà alta. Gli altri formati ufficiali non si scelgono: INPS A4, Profilo A4, ricetta bianca il PDF del Sistema TS.

## Stato del servizio e ambiente (D170)

In sola lettura per l'amministratore:

- collegamenti con i servizi esterni (oggi tutti simulati, regola 7), con l'ultimo uso;
- durata massima della sessione;
- AURA (D197): prossimo giro e ultimo giro di tutti i pazienti, con i numeri dei soli pazienti dello studio; spenta in produzione finché c'è il simulatore;
- aggiornamento notturno delle banche dati, che fa chi gestisce il servizio per tutti gli studi; l'amministratore può avviarne uno subito, in Banche dati (D191, D194);
- ambiente dell'installazione («prova» o «produzione»);
- l'avviso che i salvataggi non li fa il programma.

## Fuori dal pannello, per scelta (D163)

Regole di prescrizione (si cambiano con una versione nuova e la sua fonte: D41, D47), testi dei modelli ufficiali (D144), mappature e soglie di vecchiaia delle banche dati (D156), valori fissi del Fascicolo (D133), segreti e certificati del servizio (regola 7), credenziali dei medici (D100), registro degli accessi (non si modifica, D23).

## Domande per la fermata

Risposte di Simone alla fermata dopo la tappa 15 in D181: quelle sui poteri dell'amministratore, sul blocco, sul codice fiscale del medico e sugli elenchi cambiano il programma e si costruiscono in un blocco nuovo; le altre restano con la scelta di oggi.

- **Elenchi dello studio** (dalla revisione del piano): posologie e pacchetti sono contenuto clinico. Risposta di Simone (D181): «solo i medici e l'amministratore». Fatto nella tappa 16: li scrivono i titolari, l'amministratore e il sostituto solo con un'autorizzazione attiva su un archivio dello studio; senza, li legge e il tentativo di scrivere resta nel registro.
- **Stampa diretta**, senza la finestra di stampa (requisiti, «stampa diretta in studio»): consigliata un'impostazione del browser sulla postazione (modalità chiosco), da provare su un computer dello studio; l'alternativa è un programma da installare, contro «nessuna installazione».
- **Formato del promemoria:** chiusa. Le specifiche di stampa del 28/02/2024 vogliono mezzo foglio A4 (D217); per richiesta di Simone A5 per difetto, A4 come scelta (D222).
- **Copie dentro il PDF** (per esempio due copie per il lavoratore) invece del solo suggerimento?
- **Poteri dell'amministratore** (D179, dalle revisioni avversarie):
  - in medicina di gruppo una segreteria confermata da un solo titolare leggeva gli archivi di tutti: risposta di Simone, la conferma per archivio; fatto nella tappa 16 (D185, problema 3);
  - chi conosce il nome utente di un medico lo tiene fuori un'ora alla volta, ripetendo i tentativi sbagliati: risposta di Simone, attese crescenti per indirizzo e postazione, blocco del conto solo oltre una soglia alta e un avviso di ogni blocco al medico e ai titolari; fatto nella tappa 16 (D188, problema 4);
  - codice fiscale del medico corretto dall'amministratore: risposta di Simone, la correzione resta in sospeso finché il medico non la conferma; fatto nella tappa 16 (D184, problema 12);
  - conferma dal server: come chi gestisce il servizio riconosce il medico. Consigliato di persona, con un documento e il codice regionale, annotato fuori dal programma; l'alternativa è il primo accesso con SPID o CIE, dove c'è l'accesso regionale;
  - `--rifiuta` anche per un utente già confermato (torna in attesa, sospeso dal server, con credenziali nuove alla conferma successiva): consigliato sì;
  - ripristino delle credenziali di medici e segreteria: risposta di Simone, anche in autonomia con SPID o CIE; fatto nella tappa 16 (D189), con SPID e CIE simulati;
  - utenti con i dati dei pazienti creati, o sospesi dal server, prima di questa versione, solo negli ambienti di prova: nessuno è in attesa né segnato (problema 10); consigliato lasciarli come sono;
  - un avviso al titolare quando c'è un utente da confermare, per esempio in «Oggi».
- **Password:** 12 caratteri, nessuna scadenza, nessuna regola di composizione: c'è una regola da seguire (Garante, AgID, consulente privacy)? La password temporanea deve scadere?
- **Salvataggi:** i requisiti mettono i backup cifrati giornalieri nella versione 1; oggi il programma non li fa.
- **Blocco per inattività:** su tutte le postazioni o solo su quelle condivise, come dicono i requisiti?
- **Tempo di attesa:** libero da 1 a 60 secondi con un avviso, o fermo ai 6–8 della Regione?
- **Soglie degli avvisi:** chi le decide (la Dr.ssa Rocca con il consulente privacy)?

## Che cosa non è stato provato

- Stampa su stampanti vere, carta A5 vera, stampa senza finestra.
- Lettori di schermo e tablet veri.
- Due amministratori che salvano insieme i dati dello studio.
- Il comando del server (`utente:ripristina`) in un ambiente vero: provato come funzione e come processo, su database temporanei.
- Un proxy inverso vero e più istanze del servizio: le richieste insieme sono provate nello stesso processo, anche su connessioni diverse.
- La catena del registro alla fine di un'importazione di decine di migliaia di pazienti: le righe ora si scrivono in un comando solo, ma il tempo non è misurato.
- La revoca presso i servizi delle sessioni chiuse quando cambiano i codici del medico: si chiudono solo nel programma.
