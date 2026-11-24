# Certificati di malattia INPS

Il medico prepara, controlla e invia il certificato all'INPS tramite il Sistema TS. Poi consegna al lavoratore la copia e l'attestato. Tappa 8; decisioni D100–D107; fonti lette il 18/11/2026.

## Fonti

- **Specifiche tecniche per la trasmissione all'INPS dei certificati di malattia**, Sistema TS, versione 3.2 del 17/09/2013:
  - servizi: invio, rettifica, annullamento;
  - schema XSD;
  - codici d'errore.
- **DM 26 febbraio 2010** e disciplinare tecnico (GU n. 65 del 19/3/2010):
  - rettifica (3.3) e annullamento (3.4);
  - attestato al datore di lavoro tramite l'INPS (3.5 e 3.6);
  - consegna per email e SMS (4.2);
  - stampe (6);
  - fac-simile della copia per il lavoratore (allegato A) e dell'attestato (allegato B).
- [INPS, normativa di riferimento per la certificazione telematica di malattia](https://www.inps.it/it/it/dettaglio-approfondimento.schede-informative.49909.normativa-di-riferimento-per-la-certificazione-telematica-di-malattia.html).

## Il certificato

| Campo                     | Valori                                                                      | Fonte                                 |
| ------------------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| Tipo                      | Inizio (I), continuazione (C), ricaduta (R)                                 | XSD, `tipoCertificato`                |
| Visita                    | Ambulatoriale (A), domiciliare (D), pronto soccorso (P)                     | XSD, `tipoVisita`                     |
| Ruolo del medico          | SSN (S) o libero professionista (P); per difetto SSN                        | XSD, `ruolo`                          |
| Date                      | Rilascio, inizio della malattia, fine della prognosi                        | XSD                                   |
| Diagnosi                  | Codice ICD-9-CM e/o descrizione (al più 200 caratteri)                      | XSD, `codiceDiagnosi`, `noteDiagnosi` |
| Giornata lavorata, trauma | Sì o no                                                                     | XSD                                   |
| Agevolazioni              | Terapia salvavita (T), causa di servizio (C), invalidità riconosciuta (I)   | XSD, `agevolazioni`                   |
| Residenza                 | Via, civico («SNC» se manca), CAP, comune e provincia (o codice catastale)  | XSD, `indirizzo`                      |
| Reperibilità              | Nominativo presso l'abitazione e indirizzo, solo se diversi dalla residenza | XSD, `reperibilita`; allegato A       |

Giornata lavorata, trauma e agevolazioni, che Simone e la Dr.ssa Rocca avevano chiesto, sono verificati sullo schema XSD (D91). Entrano nei requisiti con questa fonte.

## Controlli prima dell'invio

Il programma ripete i controlli formali dell'INPS, con i suoi codici. L'errore si vede subito, non dopo uno scarto:

| Codice  | Controllo                                                                           |
| ------- | ----------------------------------------------------------------------------------- |
| 26      | Data di rilascio: oggi o ieri                                                       |
| 23, 24  | Inizio non dopo il rilascio; fine non prima del rilascio                            |
| 25      | Fine entro tre mesi solari dal rilascio                                             |
| 1003    | Giornata lavorata: la malattia comincia il giorno della visita                      |
| 1004    | Giornata lavorata: la fine della prognosi va dopo il giorno della visita            |
| 1007    | Lavoratore di almeno 16 anni                                                        |
| 43      | Codice diagnosi nel formato ICD-9-CM dello schema                                   |
| 421–437 | Residenza: via, civico, comune, provincia o codice catastale, CAP                   |
| 461–491 | Reperibilità: gli stessi controlli, più il nominativo (2–24 lettere, senza accenti) |
| 233     | Codice fiscale del medico nel profilo                                               |

Restano dell'INPS le verifiche che richiedono i suoi archivi: codice fiscale del lavoratore e anagrafica, codice catastale, posizione del medico.

## Ciclo

`bozza → in invio → inviato`, oppure `errore`. Poi:

- **errore**:
  - rifiuto dell'INPS: si corregge e si rimanda;
  - INPS non raggiungibile o nessuna risposta in tempo: si riprova;
  - rifiuto per l'accesso: si sistemano le credenziali e si rimanda così com'è;
- **in invio, senza risposta** (D233): se il servizio si ferma proprio mentre aspetta l'INPS, il certificato resta «in invio». Dopo 15 minuti la sua scheda lo dice e il medico segna l'esito chiesto all'INPS (`POST /api/certificati/:id/esito-invio`). «Non è arrivato»: torna da inviare, come quando l'INPS non risponde. «È arrivato»: con il protocollo dato dall'INPS (lettere e cifre: nelle specifiche del Sistema TS, versione 3.2, `idCertificato` è una stringa senza formato, da completare con le specifiche di collaudo, D259); come data di ricezione vale l'ora in cui era partito l'invio, e copia e attestato si stampano come sempre. L'esito resta in `certificate_submission` con l'ambiente «manuale»; una risposta tardiva del servizio di prima resta lì e non cambia più il certificato;
- **inviato → annullato**, solo entro il giorno successivo alla data di rilascio (3.4). L'INPS restituisce l'identificativo dell'annullamento;
- **inviato → rettificato**, solo entro la fine della prognosi e solo per anticiparla (3.3). Nasce un certificato nuovo con un protocollo nuovo; la sua copia riporta «Rettifica del certificato protocollo …». Il vecchio non vale più e non si stampa;
- **continuazione** di un certificato inviato: una bozza nuova di tipo C, dal giorno dopo la fine della prognosi, con gli stessi dati.

Ogni chiamata all'INPS, riuscita o no, resta in `certificate_submission` con richiesta (senza credenziali), risposta ed esito. La tabella non si modifica.

## Copia e attestato

- **Copia per il lavoratore** (allegato A): tutti i dati inviati, compresi diagnosi, tipo di visita, giornata lavorata, trauma e agevolazioni, con «DataRicezione» e «IdCertificato» (disciplinare, 6).
- **Attestato** (allegato B): gli stessi dati senza diagnosi e senza tipo di visita.
- **Stessa copia a ogni stampa**: i dati del lavoratore e del medico si fissano all'invio, quindi la copia resta identica anche se poi cambia l'anagrafica.
- **Luogo** (D106): lo studio per la visita ambulatoriale, il comune della casa per la domiciliare.
- **Fac-simile del 2010**: ha due tipi di visita; le specifiche 3.2 aggiungono il pronto soccorso, che si stampa con gli altri. Nella GU la dicitura finale dell'allegato A ha uno spazio mancante («marzo2008»): si stampa corretta.
- **Solo i certificati inviati e validi** si stampano.

## Consegne

| Canale                    | Che cosa                                                                                                        | Fonte                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Stampa                    | Copia e attestato, da consegnare al lavoratore                                                                  | DM, art. 3.2; disciplinare, 6                         |
| Email al lavoratore       | Copia e attestato in PDF; nel testo nessun dato clinico                                                         | Disciplinare, 4.2                                     |
| SMS al lavoratore         | Protocollo, data di rilascio, durata della prognosi, nome e cognome del lavoratore e del medico                 | Disciplinare, 4.2                                     |
| Email al datore di lavoro | Protocollo con nome e cognome del lavoratore, come nell'attestato, se il lavoratore lo chiede; mai dati clinici | D88, D108; allegato B; l'attestato lo dà l'INPS (3.5) |

Ogni consegna resta in `certificate_delivery`, che non si modifica. Email e SMS passano dal simulatore (regola 7). Aprire il PDF di copia o attestato non è una consegna (audit D259): resta nel registro degli accessi (`stampa_certificato`), e la consegna su carta la segna chi ha dato il foglio al lavoratore, con «Consegnato su carta» (`POST /api/certificati/:id/consegna-carta`, esito «consegnato»). Le stampe registrate prima all'apertura del PDF restano con l'esito «stampato».

## Chi fa che cosa

- Solo il medico (titolare, sostituto, collega autorizzato) vede, prepara, invia e consegna i certificati, perché contengono la diagnosi. La segreteria no, e il tentativo resta nel registro degli accessi.
- Si usano le credenziali del Sistema TS del medico che firma (D100). Per i certificati non serve il codice di sessione: nelle fonti lette il secondo fattore non c'è (D102).

## Prove

- `apps/api/test/certificati.test.ts`, 17 prove:
  - solo il medico;
  - bozza dalla residenza;
  - controlli con i codici;
  - invio con protocollo;
  - credenziali e sostituto;
  - errori e nuovi invii;
  - contenuto della copia e dell'attestato, letto dal PDF;
  - copia identica dopo un cambio di anagrafica;
  - continuazione, rettifica, consegne, annullamento;
  - tabelle non modificabili.
- Dominio (`packages/domain/test/certificato-malattia.test.ts`): controlli, codici, indirizzo, ciclo con tutte le transizioni.
- Nel browser: compilazione, controllo, invio, copia in PDF, continuazione, con axe, bersagli di 44 px e tablet.

## Da completare, non provato

- **Adattatore vero** (SOAP, PIN cifrato), da costruire con il kit e le credenziali di collaudo del Sistema TS.
- **Esito incerto**: non si sa ancora se l'INPS rifiuta un certificato doppio. Il servizio di ricerca (RicercaMalattia) è da usare con l'adattatore vero (D107).
- **ICD-10-IM dal 1/1/2027**: da quando lo accetta l'INPS (domanda già nei requisiti).
- **Certificato cartaceo quando il sistema non risponde**: il decreto letto non lo prevede; da verificare nelle circolari INPS.
- **Email al datore di lavoro con nome e cognome** (D108): da confermare con il consulente privacy.
- **Prove dal vero**: stampa su carta e consegna reale di email e SMS non provate.
