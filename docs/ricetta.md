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
   │                                    ├──► Errore: SAR non raggiungibile ──► Ricetta rossa
   │                                    ├──► Errore: esito incerto ── riprova l'invio
   │                                    └──► (servizio fermo) esito segnato dal medico dopo 15 minuti
   │
 Annullata ◄── da Bozza, Da firmare, Errore (solo locale) o Inviata (tramite SAR)
```

- **Bozza**: la prepara il medico, oppure la segreteria per le terapie croniche richieste dal paziente.
- **Da firmare**: la coda del medico, raggruppata per paziente (`GET /api/ricette/da-firmare`). Le ripetizioni preparate dalla segreteria arrivano qui direttamente.
- **In invio**: stato tecnico di pochi istanti. Il passaggio è atomico, così la stessa ricetta non parte due volte anche con due clic contemporanei.
- **Invio rimasto senza risposta** (D233): se il servizio si ferma proprio mentre aspetta il SAR, la ricetta resta «in invio». È subito nella coda «Invii senza risposta» della pagina Ricette (`GET /api/ricette/senza-risposta`), con le sue righe e l'ora da cui si può segnare l'esito: prima di 15 minuti l'invio potrebbe essere ancora in corso, e la ricetta non va rifatta (D239). Dopo i 15 minuti Oggi ne dà il conto. Il medico chiede all'ente se la ricetta è arrivata e segna la risposta (`POST /api/ricette/:id/esito-invio`), dopo averla confermata, perché l'esito non si cambia dopo (D239):
  - «Non è arrivata»: la ricetta torna in errore come quando il SAR non risponde e la coda «Invii non riusciti» si ricarica; si rimanda o si stampa la ricetta rossa;
  - «È arrivata»: con l'NRE dato dall'ente (lettere e cifre, in maiuscolo come lo vuole il codice a barre) e, per la ricetta SSN (farmaceutica e specialistica), il codice di autenticazione. **Il codice è obbligatorio** (D240, scelta di Simone del 21/11/2026): come nell'invio, senza il codice la ricetta SSN non è valida, quindi non si segna come arrivata. Si chiede all'ente il codice; se l'ente non lo dà, si segna «Non è arrivata». Con il codice il promemoria si stampa come sempre. Per i presidi il codice resta facoltativo, come nell'invio. Per la ricetta bianca servono NRBE e PIN dati dal Sistema TS: il promemoria del Sistema TS non c'è, e al paziente si dettano NRBE e PIN o gli si mandano per SMS. Per i riepiloghi la ricetta è inviata il giorno in cui era partita.

  **Alla firma la ricetta si fotografa** (D239): il messaggio che parte e il paziente com'è, in `sending_snapshot`. L'esito segnato a mano registra quel messaggio, e il promemoria ha i dati del paziente di quel momento, anche se nel frattempo un dato è stato corretto. Allo stesso modo il certificato di malattia scrive alla firma i dati di copia e attestato. L'esito resta in `external_submission` con l'ambiente «manuale». Se il servizio di prima, rimasto fermo, poi risponde, la sua risposta resta in `external_submission` e non cambia più la ricetta. Lo segnano solo i medici che possono firmare, non la segreteria.

- **Consegne del promemoria** (D239): il servizio dice che cosa si può consegnare (`disponibile` in `GET /api/ricette/:id/promemoria/consegne`): promemoria, solo NRE, email, SMS, con il motivo di ciò che manca. La pagina offre solo quello. Senza il codice di autenticazione la ricetta non è valida e non si consegna niente; senza i dati del promemoria fissati resta l'SMS con il numero; la bianca senza PIN non si manda per SMS.
- **Ricetta nuova mentre il paziente passa a un altro archivio** (D239): la bozza tiene fermo il paziente fino alla fine. «Sposta» che arriva insieme aspetta e trova la ricetta aperta; se lo spostamento è già fatto, la ricetta si ferma con «Il paziente è passato a un altro archivio nel frattempo».

- **Controlli prima dell'invio**: partono da sé quando la ricetta è pronta. «Firma e invia», e per la segreteria «Manda alla firma del medico», si accendono a controllo finito: chi firma vede sempre i controlli prima (D230). Se il controllo non riesce si può andare avanti, perché il servizio controlla di nuovo all'invio.
- **Inviata**: il SAR (o il Sistema TS per la ricetta bianca) ha accettato e ha dato l'NRE (l'NRBE per la bianca).
- **Errore**, con il motivo in chiaro e la coda «Invii non riusciti» (`GET /api/ricette/non-inviate`). Tre casi:
  - **rifiutata**: il sistema ha risposto di no. La ricetta si riporta in bozza, si corregge e si reinvia.
  - **sistema non raggiungibile**: la ricetta certamente non è arrivata. Si può riprovare oppure stampare la **ricetta rossa**, come dicono i requisiti («se SAR o Sistema TS non rispondono ma il programma sì, si stampa la ricetta rossa; senza rete resta il ricettario a mano»).
  - **esito incerto**: nessuna risposta in tempo, non si sa se la ricetta è arrivata. Niente ricetta rossa (si rischierebbe un doppione); si riprova l'invio. Come gestire questo caso va verificato sulle specifiche del SAR: i requisiti lo segnano «da verificare».
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
- In sviluppo e nelle prove c'è solo il **simulatore**, con quattro esiti: accettata, rifiutata, non raggiungibile, esito incerto. Una prova controlla che il pacchetto non contenga indirizzi di rete né richieste HTTP (regola 7).
- Ogni chiamata, riuscita o no, resta in `external_submission` con richiesta, risposta, esito e durata: non si modifica e non si cancella.

## Promemoria e invio (tappa 7)

Fonti lette sul portale del Sistema TS e della Regione (18/11/2026):

- **DM 2 novembre 2011, allegato 2** («Modello di promemoria» e «Descrizione dei campi del promemoria», GU n. 264 del 12/11/2011): i 20 campi del promemoria della ricetta SSN, il codice a barre 3-of-9 per NRE e codice fiscale, i caratteri OCR-A, «NON ESENTE», la dicitura per i dati oscurati, «Rilasciato ai sensi dell’art 11 comma 16 del DL 78 del 30 maggio 2010».
- **Specifiche del Sistema TS, prescrizione (5/12/2024)**: senza il codice di autenticazione del SAC la ricetta non è valida e il promemoria non si dà; il codice va su ogni documento consegnato al paziente; il SAC restituisce cognome e nome del medico; il paziente può chiedere l’oscuramento di nome e indirizzo (`oscuramDati`).
- **Regione Piemonte, SIRPE «Cartelle cliniche MMG e PLS» (4.4.3, 4.4.7)**: sotto il codice fiscale, senza etichetta, «codice regionale – nominativo del medico»; tempo massimo di attesa del codice di autenticazione «al momento definiti in 6-8 secondi», poi ricetta cartacea.
- **Ricetta bianca, Disciplinare tecnico (1/12/2022)**: il SAC restituisce NRBE, PIN-NRBE e il PDF del promemoria; «l’unico promemoria della Ricetta Bianca Elettronica che il medico può rilasciare al paziente è quello prodotto dal SAC, non sono ammesse stampe prodotte in proprio dai gestionali dei medici o dai SAR»; ripetibilità con `numRipetibilita` e `validitaFarm`.
- **DM 30 dicembre 2020, art. 3**: email con il promemoria allegato, SMS con il numero di ricetta, Fascicolo.
- **Sistema TS, «Specifiche tecniche per la stampa del promemoria della ricetta dematerializzata (D.M. 2 novembre 2011)», versione 28/02/2024** (letta il 20/11/2026): il modello che sostituisce quello del DM, uguale in tutta Italia. Mezzo foglio A4, campi numerati da 1 a 28, NRE in due codici a barre alti 8 mm, valori tra asterischi, diciture e area delle prescrizioni fissa (D217).

Come funziona:

- **All’invio** di una ricetta SSN si salvano il codice di autenticazione e i dati del promemoria (`prescription_document`, tipo `promemoria_dati`): ogni ristampa esce identica, anche se poi cambia l’anagrafica. Una risposta senza codice di autenticazione vale come rifiuto. Prima di inviare si controlla che il promemoria si possa fare: regione dello studio e codice fiscale del medico; se mancano, nessun invio.
- **Se i dati del promemoria non si fissano** dopo che il SAR ha accettato la ricetta (un errore del servizio a quel punto), la ricetta risulta inviata lo stesso, con il suo NRE: il promemoria non si stampa e il pannello dell'invio lo dice. Al paziente bastano il numero di ricetta e il codice fiscale (D232).
- **Testi lunghi sul promemoria del 2024**: nell'area delle prescrizioni il carattere scende fino a 6 punti; se non basta, i testi più lunghi si accorciano con «…», e ogni prescrizione resta con il codice, la quantità e la nota. Il campo 22 (numero di confezioni o prestazioni) sta intero fino a tre cifre. Un quesito oltre le due righe del campo 21 e un codice di autenticazione troppo lungo per il campo 26 si tagliano con «…» (D232).
- **Ricetta bianca**: si conserva il PDF del SAC (`promemoria_sac`, in base64 con l’impronta SHA-256) e si consegna byte per byte; il foglio «solo NRE» non c’è.
- **Stampa**: `GET /api/ricette/:id/promemoria` (completo) e `?formato=nre` (numero, codice fiscale e codice di autenticazione). Dal 20/11/2026 il modello è quello delle specifiche del 28/02/2024 (D217): mezzo foglio A4, cioè una pagina A5 orizzontale per difetto, oppure la metà alta di una pagina A4 se lo studio o la postazione sceglie A4 in Strumenti › Stampa (D222). NRE in due codici a barre (i primi 5 caratteri e il resto) e codice fiscale, modulo 0,254 mm (minimo 0,240), largo 2,5 volte, barre alte 8 mm, valori tra asterischi in OCR-A. I promemoria fissati prima si ristampano con il modello di prima, uguali byte per byte (versione dei dati): uguali, cioè, a come li stampa il programma dal 20/11/2026, quando il testo in chiaro della versione 1 è passato dal Courier all'OCR-A (D211) e non c'erano ancora promemoria veri (D232).
- **Invio**: `POST /api/ricette/:id/promemoria/invio`, email con il PDF allegato o SMS con il solo numero, al paziente o a un delegato con delega valida oggi (R16). Nel testo dell’email nessun dato clinico. Simulatore, nessun invio vero.
- **Consegne**: ogni stampa e ogni invio entrano in `reminder_delivery`, che non si modifica; `GET /api/ricette/:id/promemoria/consegne`.
- **Anteprima prima della firma** (D253): `GET /api/ricette/:id/promemoria/anteprima`, per le ricette SSN non ancora inviate (bozza, da firmare, non riuscite). È il promemoria del modello del 2024 con «BOZZA – NON VALIDA» al posto dei due codici a barre dell'NRE e «—» al posto del codice di autenticazione; il codice fiscale a barre resta. Il medico è chi firmerà: il medico che la guarda, o il medico scelto dal paziente quando la guarda la segreteria. Non si salva e non è una consegna; l'accesso resta nel registro (`anteprima_promemoria`).
- **Confermate e archiviazione** (D254): `GET /api/ricette/confermate` dà le ricette inviate o stampate sulla ricetta rossa e non archiviate, per chi vede le code (medico e segreteria, D242), con stato, NRE e data. `POST /api/ricette/archivia-confermate` le toglie dall'elenco per tutto lo studio, solo quelle che chi lo chiede vede: scrive `archived_at` e `archived_by`, lo stato non cambia e la ricetta resta nello storico del paziente.
- **Ricetta del medico in un passo** (D255): nell'interfaccia «Firma e invia» crea la ricetta, chiama `POST /api/ricette/:id/controlla` e, se il controllo non ha problemi, `POST /api/ricette/:id/firma-e-invia`. Il servizio non cambia: rifà i controlli all'invio e vuole le credenziali di chi firma. Con un problema qualsiasi l'interfaccia si ferma sui controlli.
- **Tempo massimo di attesa** dell’invio al SAR: 8 secondi (il limite alto dei 6–8 del Piemonte); oltre, esito incerto (D94).

## Da completare (servono le specifiche e le credenziali di collaudo)

- Formato vero dell'NRE e dell'NRBE: il simulatore usa numeri di fantasia che cominciano con `SIM`.
- Adattatori veri per SAR e Sistema TS, con l'autenticazione forte (Id-Sessione) del Sistema TS.
- Casi in cui l'annullamento è ammesso.
- Modulo di stampa della ricetta rossa.
- Promemoria (D217): la frase regionale (campo 28) e la frase sui farmaci in DPC come le restituisce il SAC vero; un'eventuale validità minore di 180 giorni comunicata dal Piemonte; i tipi di ricetta diversi da «Assist. SSN»; il codice regionale davanti al nome del medico, da confermare al collaudo. Stampa vera e lettura dei codici in farmacia.
- Fornitore vero di email e SMS, con le garanzie sul trattamento dei dati.
- Se il SAR comunica l'erogazione in farmacia; lo stato «sospesa» (6) delle specifiche del Sistema TS nella tavola degli stati di processo, oggi non tra gli stati del prodotto (D70).
