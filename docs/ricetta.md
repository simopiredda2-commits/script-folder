# Ciclo della ricetta

Da verificare con la Dr.ssa Rocca alla seconda fermata. Fonte: «Prescrizioni e ricette» in `docs/requisiti.md`. Regole in `packages/domain/src/prescription.ts`, servizio in `apps/api/src/prescriptions/service.ts`.

## Stati

```
          segreteria (ripetizione)
                  │
                  ▼
 Bozza ──────► Da firmare ──────► [In invio] ──► Inviata (NRE)
   ▲  ▲            │   medico firma     │
   │  └────────────┘                    ├──► Errore: rifiutata ── correggi ──► Bozza
   │                                    ├──► Errore: senza esito ──► Ricetta rossa in DPCM (D270)
   │                                    └──► (servizio fermo) dopo 15 minuti: ricetta rossa, o esito segnato dal medico
   │
 Annullata ◄── da Bozza, Da firmare, Errore (solo locale) o Inviata (tramite SAR)
```

«Senza esito» è il SAR non raggiungibile, il tempo scaduto, l'eccezione di sistema del SAR e l'invio interrotto: vale per la ricetta SSN farmaceutica e specialistica (D270, sotto). La ricetta bianca e i presidi restano come prima: con il sistema non raggiungibile si riprova o si stampa la ricetta rossa; con l'esito incerto si riprova l'invio.

- **Bozza**: la prepara il medico, oppure la segreteria per le terapie croniche richieste dal paziente.
- **Da firmare**: la coda del medico, raggruppata per paziente (`GET /api/ricette/da-firmare`). Le ripetizioni preparate dalla segreteria arrivano qui direttamente.
- **In invio**: stato tecnico di pochi istanti. Il passaggio è atomico, così la stessa ricetta non parte due volte anche con due clic contemporanei.
- **Invio rimasto senza risposta** (D233): se il servizio si ferma proprio mentre aspetta il SAR, la ricetta resta «in invio». È subito nella coda «Invii senza risposta» della pagina Ricette (`GET /api/ricette/senza-risposta`), con le sue righe e l'ora da cui si può segnare l'esito: prima di 15 minuti l'invio potrebbe essere ancora in corso, e la ricetta non va rifatta (D239). Dopo i 15 minuti Oggi ne dà il conto. Il medico chiede all'ente se la ricetta è arrivata e segna la risposta (`POST /api/ricette/:id/esito-invio`), dopo averla confermata, perché l'esito non si cambia dopo (D239):
  - «Non è arrivata»: la ricetta torna in errore come quando il SAR non risponde e la coda «Invii non riusciti» si ricarica; si rimanda o si stampa la ricetta rossa. Per la farmaceutica e la specialistica al SAR, al suo posto c'è «Stampa la ricetta rossa» (D270): come vuole la Regione la dematerializzata non si rimanda, e quella che può essere arrivata si annulla da sola;
  - «È arrivata»: con l'NRE dato dall'ente, senza spazi e in maiuscolo come lo vuole il codice a barre, e, per la ricetta SSN (farmaceutica e specialistica), il codice di autenticazione. **Il codice è obbligatorio** (D240, scelta di Simone del 21/11/2026): come nell'invio, senza il codice la ricetta SSN non è valida, quindi non si segna come arrivata. Si chiede all'ente il codice; se l'ente non lo dà, si segna «Non è arrivata». Con il codice il promemoria si stampa come sempre. Per i presidi il codice resta facoltativo, come nell'invio. Per la ricetta bianca servono NRBE e PIN dati dal Sistema TS: il promemoria del Sistema TS non c'è, e al paziente si dettano NRBE e PIN o gli si mandano per SMS. Per i riepiloghi la ricetta è inviata il giorno in cui era partita.
  - **Forma del numero** (audit D259), controllata nella pagina prima della domanda di conferma e di nuovo dal servizio. NRE: 15 caratteri, i primi 5 lettere o cifre, il sesto una cifra da 0 a 7, gli ultimi 9 cifre (Sistema TS, «Web services per la trasmissione delle ricette dematerializzate – parte 1: prescrizione», 05/12/2024, paragrafi 5 e 5.1: «AAA BB C DDDDDDD EE per un totale di 15 caratteri»). NRBE: 12 caratteri, una lettera, una lettera o una cifra, poi 10 cifre; per il paziente con il codice fiscale la prima è la lettera di controllo del codice fiscale mandato con la ricetta e la seconda una cifra (Disciplinare tecnico del DM 1/12/2022, paragrafo 2.4). Il codice di autenticazione e il PIN non hanno un formato nelle specifiche lette: lettere e cifre (l'esempio delle specifiche ha 30 cifre, ma non è una regola).

  **Alla firma la ricetta si fotografa** (D239): il messaggio che parte e il paziente com'è, in `sending_snapshot`. L'esito segnato a mano registra quel messaggio, e il promemoria ha i dati del paziente di quel momento, anche se nel frattempo un dato è stato corretto. Allo stesso modo il certificato di malattia scrive alla firma i dati di copia e attestato. L'esito resta in `external_submission` con l'ambiente «manuale». Se il servizio di prima, rimasto fermo, poi risponde, la sua risposta resta in `external_submission` e non cambia più la ricetta. Lo segnano solo i medici che possono firmare, non la segreteria.

- **Consegne del promemoria** (D239): il servizio dice che cosa si può consegnare (`disponibile` in `GET /api/ricette/:id/promemoria/consegne`): promemoria, solo NRE, email, SMS, con il motivo di ciò che manca. La pagina offre solo quello. Senza il codice di autenticazione la ricetta non è valida e non si consegna niente; senza i dati del promemoria fissati resta l'SMS con il numero; la bianca senza PIN non si manda per SMS.
- **Ricetta nuova mentre il paziente passa a un altro archivio** (D239): la bozza tiene fermo il paziente fino alla fine. «Sposta» che arriva insieme aspetta e trova la ricetta aperta; se lo spostamento è già fatto, la ricetta si ferma con «Il paziente è passato a un altro archivio nel frattempo».

- **Controlli prima dell'invio**: partono da sé quando la ricetta è pronta. «Firma e invia», e per la segreteria «Manda alla firma del medico», si accendono a controllo finito: chi firma vede sempre i controlli prima (D230). Se il controllo non riesce si può andare avanti, perché il servizio controlla di nuovo all'invio.
- **Inviata**: il SAR (o il Sistema TS per la ricetta bianca) ha accettato e ha dato l'NRE (l'NRBE per la bianca).
- **Errore**, con il motivo in chiaro e la coda «Invii non riusciti» (`GET /api/ricette/non-inviate`). Tre casi:
  - **rifiutata**: il sistema ha risposto di no. La ricetta si riporta in bozza, si corregge e si reinvia.
  - **sistema non raggiungibile**: la ricetta certamente non è arrivata. Si può riprovare oppure stampare la **ricetta rossa**, come dicono i requisiti («se SAR o Sistema TS non rispondono ma il programma sì, si stampa la ricetta rossa; senza rete resta il ricettario a mano»). Per la farmaceutica e la specialistica al SAR non si riprova: ricetta rossa in DPCM (D270).
  - **esito incerto**: nessuna risposta in tempo, non si sa se la ricetta è arrivata. Per la ricetta bianca e i presidi niente ricetta rossa (si rischierebbe un doppione); si riprova l'invio. Per la farmaceutica e la specialistica al SAR si fa come vuole la Regione (V06, 4.3.1): ricetta rossa in DPCM, e la dematerializzata si annulla da sola (D270).
- **Annullata**: prima dell'invio l'annullamento è solo nostro; dopo l'invio passa dal SAR, nei casi ammessi dalle specifiche. Se il SAR non risponde, la ricetta resta inviata. Serve sempre il motivo.

## Annullamento e stato di erogazione (D70)

Una ricetta inviata si annulla solo se l'ente non l'ha ancora lavorata. Prima di chiedere l'annullamento il prodotto chiede all'ente lo stato di erogazione:

| Stato presso l'ente         | Si annulla?                                |
| --------------------------- | ------------------------------------------ |
| Non ancora presa in carico  | Sì, con il motivo                          |
| Presa in carico o prenotata | No: rifiuto immediato, con la spiegazione  |
| Erogata in parte o erogata  | No                                         |
| Già annullata               | No                                         |
| Non disponibile             | Decide l'ente all'annullamento, come prima |

- Ogni verifica dello stato va nel registro degli invii (`external_submission`, operazione `stato`); nella ricetta restano l'ultimo stato noto e quando è stato verificato.
- Nessuna ricetta si cancella: annullata, resta nello storico con chi, quando e perché, e si conta a parte («inviate e poi annullate»).
- Nello storico di un farmaco o di una prestazione, «Verifica lo stato presso l'ente» e, solo se si può, «Annulla la ricetta».
- Nella ricetta specialistica, aggiungere una prestazione già prescritta fa comparire subito un avviso con data, NRE e stato presso l'ente: è il caso del paziente che dice di non averla prenotata.
- I nomi dei cinque stati sono del prodotto. **Da verificare sulle specifiche del SAR e del Sistema TS**: che il servizio di stato esista e quali codici restituisce, da mappare sui cinque stati.
- **Stampata su ricetta rossa**: chiusa, non si invia più.

## Chi fa che cosa

- La segreteria prepara le ripetizioni di terapie croniche non riservate, nella coda «da firmare». Le ripetizioni sono **raggruppate** (scelta della seconda fermata): più terapie nella stessa ricetta se hanno lo stesso tipo di ricetta e la stessa esenzione, senza superare il limite di confezioni di R2 in vigore. Non firma, non invia, non prepara ricette nuove.
- Il medico prepara, firma e invia. Il sostituto e il collega autorizzato firmano **a nome loro**.
- Ogni operazione passa dalla guardia sui dati del paziente e finisce nel registro degli accessi (`ricetta_bozza`, `ricetta_ripetizione`, `ricetta_da_firmare`, `ricetta_firma_invio`, `ricetta_esito_invio`, `ricetta_annullamento`, `ricetta_cartacea`).

## Integrazioni

- `packages/integrations`: un'interfaccia comune (`PrescriptionGateway`) per SAR (ricette SSN, poi inoltrate al SAC del Sistema TS) e Sistema TS (ricetta bianca).
- In sviluppo e nelle prove c'è solo il **simulatore**, con cinque esiti: accettata, rifiutata, non raggiungibile, esito incerto ed eccezione di sistema del SAR (V06, 4.3.1, caso 4), che la ricetta tratta come l'esito incerto (D269); per la farmaceutica e la specialistica, ricetta rossa (D270). Lo stesso simulatore fa il SAR in DPCM. Una prova controlla che il pacchetto non contenga indirizzi di rete né richieste HTTP (regola 7).
- Ogni chiamata, riuscita o no, resta in `external_submission` con richiesta, risposta, esito e durata: non si modifica e non si cancella.

## Promemoria e invio (tappa 7)

Fonti lette sul portale del Sistema TS e della Regione (18/11/2026):

- **DM 2 novembre 2011, allegato 2** («Modello di promemoria» e «Descrizione dei campi del promemoria», GU n. 264 del 12/11/2011): i 20 campi del promemoria della ricetta SSN, il codice a barre 3-of-9 per NRE e codice fiscale, i caratteri OCR-A, «NON ESENTE», la dicitura per i dati oscurati, «Rilasciato ai sensi dell’art 11 comma 16 del DL 78 del 30 maggio 2010».
- **Specifiche del Sistema TS, prescrizione (5/12/2024)**: senza il codice di autenticazione del SAC la ricetta non è valida e il promemoria non si dà; il codice va su ogni documento consegnato al paziente; il SAC restituisce cognome e nome del medico; il paziente può chiedere l’oscuramento di nome e indirizzo (`oscuramDati`).
- **Regione Piemonte, SIRPED «Cartelle cliniche MMG e PLS», V06 del 10/04/2026 (4.3.3, 3.5.2)**: sotto il codice fiscale, senza etichetta, «codice regionale – nominativo del medico»; tempo massimo di attesa del codice di autenticazione «al momento definiti in 8 secondi», contati dalla richiesta di stampa del promemoria, poi ricetta cartacea (la V05 diceva «6-8 secondi»; D265).
- **Ricetta bianca, Disciplinare tecnico (1/12/2022)**: il SAC restituisce NRBE, PIN-NRBE e il PDF del promemoria; «l’unico promemoria della Ricetta Bianca Elettronica che il medico può rilasciare al paziente è quello prodotto dal SAC, non sono ammesse stampe prodotte in proprio dai gestionali dei medici o dai SAR»; ripetibilità con `numRipetibilita` e `validitaFarm`.
- **DM 30 dicembre 2020, art. 3**: email con il promemoria allegato, SMS con il numero di ricetta, Fascicolo.
- **Sistema TS, «Specifiche tecniche per la stampa del promemoria della ricetta dematerializzata (D.M. 2 novembre 2011)», versione 28/02/2024** (letta il 20/11/2026): il modello che sostituisce quello del DM, uguale in tutta Italia. Mezzo foglio A4, campi numerati da 1 a 28, NRE in due codici a barre alti 8 mm, valori tra asterischi, diciture e area delle prescrizioni fissa (D217).

Come funziona:

- **All’invio** di una ricetta SSN si salvano il codice di autenticazione e i dati del promemoria (`prescription_document`, tipo `promemoria_dati`): ogni ristampa esce identica, anche se poi cambia l’anagrafica. Una risposta senza codice di autenticazione vale come rifiuto. Prima di inviare si controlla che il promemoria si possa fare: regione dello studio e codice fiscale del medico; se mancano, nessun invio.
- **Se i dati del promemoria non si fissano** dopo che il SAR ha accettato la ricetta (un errore del servizio a quel punto), la ricetta risulta inviata lo stesso, con il suo NRE: il promemoria non si stampa e il pannello dell'invio lo dice. Al paziente bastano il numero di ricetta e il codice fiscale (D232).
- **Testi lunghi sul promemoria del 2024**: nell'area delle prescrizioni il carattere scende fino a 6 punti; se non basta, i testi più lunghi si accorciano con «…», e ogni prescrizione resta con il codice, la quantità e la nota. Il campo 22 (numero di confezioni o prestazioni) sta intero fino a tre cifre. Un quesito oltre le due righe del campo 21 e un codice di autenticazione troppo lungo per il campo 26 si tagliano con «…» (D232).
- **Ricetta bianca**: si conserva il PDF del SAC (`promemoria_sac`, in base64 con l’impronta SHA-256) e si consegna byte per byte; il foglio «solo NRE» non c’è.
- **Stampa**: `GET /api/ricette/:id/promemoria` (completo) e `?formato=nre` (numero, codice fiscale e codice di autenticazione). Aprire il PDF non è una consegna (audit D259): il programma non sa se il foglio è stato stampato e dato. L'apertura resta nel registro degli accessi (`stampa_promemoria`); la consegna su carta la segna chi ha dato il foglio, con «Consegnato su carta», che compare dopo l'apertura del PDF (`POST /api/ricette/:id/promemoria/consegna-carta`, esito «consegnato», solo per ciò che la ricetta permette di dare). Le stampe registrate prima all'apertura del PDF restano con l'esito «stampato». Dal 20/11/2026 il modello è quello delle specifiche del 28/02/2024 (D217): mezzo foglio A4, cioè una pagina A5 orizzontale per difetto, oppure la metà alta di una pagina A4 se lo studio o la postazione sceglie A4 in Strumenti › Stampa (D222). NRE in due codici a barre (i primi 5 caratteri e il resto) e codice fiscale, modulo 0,254 mm (minimo 0,240), largo 2,5 volte, barre alte 8 mm, valori tra asterischi in OCR-A. I promemoria fissati prima si ristampano con il modello di prima, uguali byte per byte (versione dei dati): uguali, cioè, a come li stampa il programma dal 20/11/2026, quando il testo in chiaro della versione 1 è passato dal Courier all'OCR-A (D211) e non c'erano ancora promemoria veri (D232).
- **Invio**: `POST /api/ricette/:id/promemoria/invio`, email con il PDF allegato o SMS con il solo numero, al paziente o a un delegato con delega valida oggi (R16). Nel testo dell’email nessun dato clinico. Simulatore, nessun invio vero.
- **Consegne**: ogni stampa e ogni invio entrano in `reminder_delivery`, che non si modifica; `GET /api/ricette/:id/promemoria/consegne`.
- **Anteprima prima della firma** (D253): `GET /api/ricette/:id/promemoria/anteprima`, per le ricette SSN non ancora inviate (bozza, da firmare, non riuscite). È il promemoria del modello del 2024 con «BOZZA – NON VALIDA» al posto dei due codici a barre dell'NRE e «—» al posto del codice di autenticazione; il codice fiscale a barre resta. Il medico è chi firmerà: il medico che la guarda, o il medico scelto dal paziente quando la guarda la segreteria. Non si salva e non è una consegna; l'accesso resta nel registro (`anteprima_promemoria`).
- **Confermate e archiviazione** (D254): `GET /api/ricette/confermate` dà le ricette inviate o stampate sulla ricetta rossa e non archiviate, per chi vede le code (medico e segreteria, D242), con stato, NRE e data. `POST /api/ricette/archivia-confermate` le toglie dall'elenco per tutto lo studio, solo quelle che chi lo chiede vede: scrive `archived_at` e `archived_by`, lo stato non cambia e la ricetta resta nello storico del paziente.
- **Ricetta del medico in un passo** (D255): nell'interfaccia «Firma e invia» crea la ricetta, chiama `POST /api/ricette/:id/controlla` e, se il controllo non ha problemi, `POST /api/ricette/:id/firma-e-invia`. Il servizio non cambia: rifà i controlli all'invio e vuole le credenziali di chi firma. Con un problema qualsiasi l'interfaccia si ferma sui controlli, e il medico procede solo con la conferma esplicita «Ho visto i controlli: firma e invia» (D256).
- **Tempo massimo di attesa** dell’invio al SAR: 8 secondi, come nella V06 delle specifiche regionali (3.5.2); oltre, esito incerto (D94, D265).

## Numeri di ricetta dal lotto del medico (D269)

La cartella numera da sé le ricette per il SAR (farmaceutica, specialistica e presidi): il SAR le dà lotti di 1000 NRE legati al codice fiscale del medico (SIRPED, «Cartelle cliniche MMG e PLS», V06 del 10/04/2026, 3.2 e 4.1).

- **Richiesta del lotto**: codice della regione dello studio, tipo 1 (l'unico ammesso in Piemonte), codice fiscale del medico che firma. Solo utente, password e PIN RUPAR (3.1.1): anche chi entra con SPID o CIE deve averli in «Credenziali dei servizi».
- **Lotto restituito**: regione, raggruppamento, identificativo del lotto del SAR e codice di 6 cifre. Dall'esempio della V06 «010 A0 4 000000» la cartella genera gli NRE da «010A04000000000» a «010A04000000999», cambiando solo il progressivo.
- **Quando**: alla firma, se al medico restano meno di 100 numeri. Se il lotto non arriva e restano numeri, la ricetta parte con l'avviso. Se non ne restano, la ricetta non parte e il messaggio dice perché.
- **Numero della ricetta**: preso nella transazione che la porta «in invio», mai uguale per due ricette (lo vieta anche un indice del database). La ricetta lo tiene: dopo un rifiuto si corregge e si rimanda con lo stesso numero (4.3.1, caso 3). Per i presidi, anche dopo un esito incerto o un'eccezione di sistema del SAR si rimanda con lo stesso: se era arrivata, il SAR rifiuta il numero già usato. Per la farmaceutica e la specialistica senza esito non si rimanda: la ricetta rossa prende un NRE nuovo dal lotto (4.3.1, caso 4; D270). «È arrivata» vuole il numero partito con l'invio.
- **Registro**: ogni richiesta del lotto resta in `external_submission` (operazione `lotto_nre`), con la ricetta che l'ha fatta partire. I lotti stanno in `nre_lot`, con la ricevuta del SAR, ed entrano nell'esportazione.
- **Ricetta bianca**: il numero lo dà il Sistema TS, come prima.
- **Simulatore**: lotti con il raggruppamento «ZZ», riconoscibili come simulati; codici d'errore 02–06 della V06 (4.1); rifiuta un NRE fuori dai lotti, di un altro medico o già usato.

## Ricetta rossa in DPCM (D270)

Quando la ricetta SSN farmaceutica o specialistica non ha esito dal SAR, la Regione vuole la ricetta rossa (SIRPED, «Cartelle cliniche MMG e PLS», V06 del 10/04/2026, 3.5.1 e 4.3.1, casi 4 e 5). La cartella la stampa sul modulo del Poligrafico e poi la manda al SAR «in modalità DPCM» entro 24 ore (3.4.2), con le regole del Sistema TS («Collegamento telematico in rete dei medici», versione 11 del 1/3/2016) e gli schemi RicettaMIR.xsd 2.1 e TipiDatiMIR.xsd 1.0.7 del 5/9/2011.

- **Quando**: SAR non raggiungibile, tempo scaduto, eccezione di sistema del SAR, invio interrotto dopo 15 minuti (D233). La dematerializzata non si rimanda: il servizio rifiuta «Firma e invia» con «Il SAR non ha dato esito: si stampa la ricetta rossa…». Rifiuti e credenziali rifiutate restano come prima: si sistema e si rimanda. Lo fa solo il medico che può firmare.
- **Dove**: nel pannello dell'invio della ricetta e della pagina Ricette, «Stampa la ricetta rossa» prende il posto di «Firma e invia»; nella coda «Invii senza risposta» prende il posto di «Non è arrivata» (resta «È arrivata», per quando l'ente ha già dato numero e codice). Dopo la stampa il PDF resta in vista, anche quando la ricetta esce dalla coda, come il promemoria delle ricette inviate.
- **Il modulo**: il medico legge le 15 cifre del modulo nella stampante, con il lettore di codici a barre o a mano, e sceglie il tipo di visita (ambulatoriale o domiciliare). Il codice dell'ente dev'essere quello della regione dello studio (010 per il Piemonte; disciplinare tecnico del DM 17/3/2008, Allegato 11). La cifra di controllo non si calcola: le fonti non danno il calcolo e il Sistema TS non la usa (7.1). Un modulo non si usa due volte, e lo vieta anche il database. Prima di prendere l'NRE si controlla che il file DPCM si possa fare: un modulo non si spreca per un dato che manca.
- **L'NRE**: uno nuovo, dal lotto del medico (4.3.1, caso 4; D269), stampato in chiaro e con due codici 3-of-9 come il numero del Poligrafico (4.2.2).
- **Il PDF** (`GET /api/ricette/:id/ricetta-rossa.pdf`): modulo di 250 × 152,4 mm, caselle in OCR-A, «STAMPA PC» biffata, posizioni misurate sul facsimile dell'Allegato 2 del disciplinare. Va provato con un modulo vero e la stampante dello studio; la posizione dell'NRE è da confermare con il CSI.
- **Il file DPCM**: una ricetta per file, TipoInvio «RPS», Bar1 e Bar2 dal modulo, Ricetta1 con l'NRE, Ricetta2 con il codice fiscale del medico; PinCode e codice fiscale dell'assistito cifrati (il simulatore usa un prefisso riconoscibile: il certificato della Regione non c'è). Nome del file con «SCRIPT» dopo «_» (6.1.1). Per la specialistica, in Prescrizione2 il catalogo e il tipo di accesso (`CODCATPRESCR=…$TIPOACC=…$`).
- **La coda**: invio, esito e annullamento della dematerializzata si fanno da soli ogni minuto, e con «Invia adesso» (`POST /api/ricette-rosse/invia`). Utente, password e PIN RUPAR (3.1.1); al più un file ogni 2 secondi per medico; se il SAR non risponde si riprova dopo 1, 5, 15 e poi 60 minuti; l'esito si rilegge ogni 5 minuti finché il file è in attesa, con i messaggi dell'elenco analitico quando ci sono avvisi o errori. Stati: da mandare, mandata (in attesa dell'esito), accolta, accolta con avvisi, scartata.
- **Dove si seguono**: nella pagina Ricette, sezione «Ricette rosse in DPCM», solo per il medico (`GET /api/ricette-rosse`): paziente, modulo, NRE, stato con simbolo e parola, messaggi del SAR, annullamento della dematerializzata, il PDF da ristampare e «Invia adesso». Ci sono quelle in corso, e per 30 giorni quelle chiuse. Oggi conta quelle **da seguire**: un invio o una lettura dell'esito non riusciti, le 24 ore passate senza invio, un annullamento che non riesce e, per 30 giorni, le scartate e gli annullamenti rifiutati.
- **Annullamento della dematerializzata**: solo se può essere arrivata (tempo scaduto, eccezione, invio interrotto), a nome di chi l'aveva firmata e con le sue credenziali. Se il SAR non la annulla, il motivo si vede; se non era arrivata, non serve altro.
- **Registro ed esportazione**: ogni chiamata resta in `external_submission`; la ricetta rossa sta in `dpcm_prescription`, con storico e divieto di cancellazione, ed entra nell'esportazione. La stampa e il PDF finiscono nel registro degli accessi (`ricetta_cartacea`, `stampa_ricetta_rossa`).
- **Ricetta bianca e presidi**: come prima. La ricetta DPCM ha solo farmaceutica e specialistica; per i presidi è una domanda per il CSI.

## Parti nazionali della ricetta farmaceutica (D272, D273)

- **Stupefacenti (R23, D272)**: la sezione A della tabella dei medicinali va sul ricettario ministeriale a ricalco e la ricetta si ferma; l'allegato III-bis va solo con il codice della terapia del dolore (TDL o TDL01), con posologia e telefono del medico nelle note, che vanno al SAR e sul promemoria.
- **Non sostituibilità (R13, D273)**: con la clausola serve il codice della motivazione delle linee guida del Sistema TS per il principio attivo (versione 2.1 del 25/10/2013). I codici sono:
  - 1, 2 e 3 per la sintetica motivazione;
  - 4 per la non applicabilità dell'art. 15, comma 11-bis, del DL 95/2012, cioè la prosecuzione di una terapia in corso.

  Vale per un farmaco indicato con il codice AIC, non per principio attivo. Il codice si sceglie nella scheda della terapia e nella riga della ricetta, e il testo resta come precisazione facoltativa.
  - Va al SAR in `codMotivazione`, con `nonSost`.
  - Nella ricetta rossa va in Prescrizione1.
  - Sul promemoria si stampa «NON SOSTITUIBILE - motivazione N».

- **Principio attivo**: nella ricetta rossa una riga per principio attivo porta solo il gruppo di equivalenza (caso A1). Senza il gruppo nella lista di trasparenza in vigore va l'AIC, come per l'unico farmaco autorizzato (caso D).
- **Tipologia S o H** (`indicazionePrescr`, IndicazionePrescr nella ricetta rossa): c'è solo se tutte le righe vengono da terapie con la stessa tipologia, come il campo 14 del promemoria (D217).

## Note del nomenclatore, sedute e tariffa nella ricetta specialistica (D276)

- **Nota del nomenclatore (R24)**: una prestazione con una nota dell'allegato 4D del DPCM LEA la porta sulla riga, con il numero preso dall'elenco in uso (`docs/banche-dati.md`, «Note del nomenclatore»). Sulla riga si leggono il tipo e il testo della nota, e il medico può scegliere la lettera della condizione, se la nota ne ha.
  - Con una condizione di erogabilità il numero della nota è obbligatorio: R24 ferma l'invio senza.
  - Con un'indicazione di appropriatezza prescrittiva il numero va con la riga, ma basta il quesito diagnostico.
  - Va al SAR in `numeroNota`, con la lettera in `condErogabilita` o in `approprPrescrittiva`, secondo il tipo della nota.
  - Nella ricetta rossa va in Prescrizione1: «#99-B-\*-\*#».
  - Sul promemoria va nel campo 20: «99 B». Senza nota il campo stampa «---».
- **Sedute dei cicli (R10)**: per le 52 voci a ciclo del catalogo il medico può scrivere le sedute, fino al massimo del catalogo; un ciclo per riga, con quantità 1. Le sedute vanno al SAR in `numsedute` e sul promemoria nel campo 18A, dopo il tipo di accesso: «PRIMO ACCESSO-N.SEDUTE:10». La ricetta rossa non ha un campo per le sedute.
- **Al più otto prestazioni della stessa branca (R25)**: contando le quantità, come dice la legenda dell'allegato 4. Una voce che sta in più branche non si conta.
- **Tariffa**: quella indicativa del catalogo, nella ricerca e sulla riga, a titolo informativo. Non va nel messaggio né sul promemoria.

## Da completare (servono le specifiche e le credenziali di collaudo)

- Numeri del simulatore: gli NRE dei lotti simulati hanno la forma delle specifiche, con il raggruppamento «ZZ» (D269); NRBE e NRE dei simulatori senza lotti sono di fantasia e cominciano con `SIM`, non nella forma delle specifiche (che si controlla solo quando il medico scrive il numero a mano, D259). Formato del codice di autenticazione e del PIN-NRBE: da prendere dalle specifiche di collaudo.
- Lotti di NRE con il SAR vero (D269): se il lotto si possa chiedere prima che finisca, quanti lotti aperti possa avere un medico, con quale codice il SAR rifiuti un NRE già usato. Domande per il CSI.
- Adattatori veri per SAR e Sistema TS, con l'autenticazione forte (Id-Sessione) del Sistema TS.
- Casi in cui l'annullamento è ammesso.
- Ricetta rossa (D270): la prova su un modulo vero e la taratura della stampante; la posizione dell'NRE, da confermare con il CSI; la cifratura con il certificato della Regione; variazione e cancellazione di una ricetta DPCM già mandata (RicettaV e RicettaC); l'archivio dei ricettari del medico (7.3 e 7.4); i presidi in DPCM; le caselle S e H e il principio attivo con il gruppo di equivalenza sul modulo stampato (D273).
- Promemoria (D217): la frase regionale (campo 28) e la frase sui farmaci in DPC come le restituisce il SAC vero; la validità della specialistica, che oggi viene dalla regola R1 (60 giorni per il primo accesso, 180 per gli altri, D.D. 710/2026; D260), come la riceve il Sistema TS dal Piemonte; i tipi di ricetta diversi da «Assist. SSN»; il codice regionale davanti al nome del medico, da confermare al collaudo. Stampa vera e lettura dei codici in farmacia.
- Fornitore vero di email e SMS, con le garanzie sul trattamento dei dati.
- Se il SAR comunica l'erogazione in farmacia; lo stato «sospesa» (6) delle specifiche del Sistema TS nella tavola degli stati di processo, oggi non tra gli stati del prodotto (D70).
