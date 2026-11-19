# Strumenti e amministrazione (tappa 14, D163)

Documento per la revisione della tappa 14. Richiesta di Simone del 19/11/2026: «nel pannello admin o strumenti ci devono essere tutte le varie opzioni di configurazione e impostazioni del programma: dati editabili …, impostazioni stampanti, e tutto ciò che ritieni possa rientrare tra le impostazioni».

Tutto sta in **Strumenti**, una scheda per area. Ognuno vede le schede del suo ruolo; chi può modificare lo decide il servizio, non la scheda. Ogni modifica va nel registro degli accessi come azione di amministrazione, con i nomi dei campi cambiati e mai password o segreti, anche quando è negata.

## Chi vede che cosa

| Scheda                      | Amministratore    | Titolare         | Sostituto | Segreteria |
| --------------------------- | ----------------- | ---------------- | --------- | ---------- |
| Dati dello studio           | Modifica          | Legge            | Legge     | —          |
| Utenti e ruoli              | Modifica          | —                | —         | —          |
| Postazioni e stampa         | Modifica          | Legge            | Legge     | —          |
| Elenchi dello studio        | Modifica          | Modifica         | Modifica  | Legge      |
| Modelli dei certificati     | Modifica          | Modifica         | Modifica  | —          |
| Impaginazione               | —                 | La sua           | La sua    | —          |
| Fascicolo sanitario         | Modifica          | Legge            | Legge     | —          |
| Banche dati                 | «Aggiorna adesso» | Legge            | Legge     | —          |
| AFT                         | —                 | La sua           | —         | —          |
| Importazione                | —                 | Nel suo archivio | —         | —          |
| Registro di amministrazione | Legge             | Legge            | —         | —          |
| Stato del servizio          | Legge             | —                | —         | —          |

La segreteria vede in Strumenti solo gli elenchi dello studio, in sola lettura: le servono per preparare (D175, che aggiorna D146). La pagina della password è per tutti, dal menu dell'utente.

## Primo avvio (D167)

Fuori dai dati dimostrativi, uno studio vero nasce con un comando sul server:

```sh
pnpm studio:crea -- --nome "Studio medico …" --tipo singolo --regione PIEMONTE \
  --amministratore nome.cognome --nome-amministratore "Nome Cognome"
```

Il comando applica le migrazioni, crea lo studio e il primo amministratore (senza accesso clinico) e mostra una sola volta la password temporanea. Al primo accesso si attiva il secondo fattore e si cambia la password; poi l'amministratore crea gli altri utenti da Strumenti. In produzione (`APP_AMBIENTE=produzione`, D170) i dati dimostrativi non si possono creare.

## Utenti e ruoli (D164) e password (D165)

- L'amministratore crea gli utenti con uno o più ruoli e, per i medici, nome, cognome, codice fiscale (controllato), codice regionale e ASL. La password temporanea si vede una volta e va consegnata di persona; al primo accesso si cambia prima di ogni altra cosa.
- Il ruolo di titolare crea l'archivio del medico; togliere un ruolo non cancella nulla.
- Sospendere, riattivare, sbloccare dopo troppi tentativi: dall'elenco, con conferma. Nessuno agisce su sé stesso e nessuno cambia i propri ruoli; l'ultimo amministratore attivo non si toglie.
- Password da 12 a 128 caratteri, diversa dalla precedente e dal nome utente; gli errori sulla password attuale contano come tentativi falliti; il cambio chiude le altre sessioni.
- Limiti ai poteri dell'amministratore sull'accesso clinico: dopo la revisione (sezione in costruzione, decisione a parte).

## Dati e impostazioni dello studio (D166)

Nome, tipo, regione (obbligatoria: senza, nessuna ricetta SSN parte), indirizzo completo, telefono, email, PEC, intestazione dello studio, sicurezza dell'accesso, tempo di attesa degli invii, soglie degli avvisi sugli accessi anomali.

- **Intestazione dello studio:** vale nei certificati dai modelli quando il medico non ha la sua.
- **Indirizzo completo:** è il luogo della visita in studio sulla copia INPS.
- **Sicurezza:** 5 minuti di inattività, 5 tentativi, 15 minuti di blocco (D29); si cambiano qui, entro limiti di buon senso.
- **Tempo di attesa degli invii:** 8 secondi per difetto; la Regione indica 6–8 (D94). Si legge a ogni invio di ricette e certificati.
- **Soglie degli avvisi sugli accessi anomali** (Garante, linee guida sul dossier sanitario, par. 7, lett. c): vuote, quindi avvisi spenti, finché qualcuno non dà i valori (da completare).

## Elenchi dello studio (D175)

Quattro elenchi comuni dello studio, in **Strumenti › Elenchi dello studio**: li scrivono titolare, sostituto e amministratore, li leggono tutti, segreteria compresa. Non contengono dati dei pazienti. Una voce non si cancella: si archivia, perché una terapia o una ricetta può averla usata.

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
- **Avvisi sugli accessi anomali** degli ultimi 7, 30 o 90 giorni: cartelle diverse aperte da un utente in un giorno, accessi nella fascia oraria, consultazioni dell'AFT di un collega in un giorno. Con le soglie vuote la pagina dice quali completare e la fonte (Garante, linee guida sul dossier sanitario, par. 7, lett. c).

## Registro di amministrazione (D177)

In **Strumenti › Registro di amministrazione**, per i titolari e l'amministratore: quando, chi, postazione, area, azione con il dettaglio (nomi dei campi cambiati, mai i valori), esito a parole; a pagine, dalle più recenti. Ogni lettura è registrata.

## Postazioni

Il nome che ognuno scrive all'accesso, per ogni computer dello studio, condivisa o personale. Servono alle preferenze di stampa. Si archiviano, non si cancellano.

## Stato del servizio e ambiente (D170)

In sola lettura per l'amministratore:

- collegamenti con i servizi esterni (oggi tutti simulati, regola 7), con l'ultimo uso;
- durata massima della sessione;
- aggiornamento notturno delle banche dati;
- ambiente dell'installazione («prova» o «produzione»);
- l'avviso che i salvataggi non li fa il programma.

## Fuori dal pannello, per scelta (D163)

Regole di prescrizione (si cambiano con una versione nuova e la sua fonte: D41, D47), testi dei modelli ufficiali (D144), mappature e soglie di vecchiaia delle banche dati (D156), valori fissi del Fascicolo (D133), segreti e certificati del servizio (regola 7), credenziali dei medici (D100), registro degli accessi (non si modifica, D23).

## Domande per la fermata

- **Poteri dell'amministratore:** il ripristino delle credenziali dei medici e della segreteria, se dal server o con SPID o CIE (dopo la revisione).
- **Password:** 12 caratteri, nessuna scadenza, nessuna regola di composizione: c'è una regola da seguire (Garante, AgID, consulente privacy)? La password temporanea deve scadere?
- **Salvataggi:** i requisiti mettono i backup cifrati giornalieri nella versione 1; oggi il programma non li fa.
- **Blocco per inattività:** su tutte le postazioni o solo su quelle condivise, come dicono i requisiti?
- **Tempo di attesa:** libero da 1 a 60 secondi con un avviso, o fermo ai 6–8 della Regione?
- **Soglie degli avvisi:** chi le decide (la Dr.ssa Rocca con il consulente privacy)?

## Che cosa non è stato provato

- Stampa su stampanti vere.
- Lettori di schermo e tablet veri.
- Due amministratori che salvano insieme i dati dello studio.
