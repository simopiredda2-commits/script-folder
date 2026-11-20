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
   │                                    └──► Errore: esito incerto ── riprova l'invio
   │
 Annullata ◄── da Bozza, Da firmare, Errore (solo locale) o Inviata (tramite SAR)
```

- **Bozza**: la prepara il medico, oppure la segreteria per le terapie croniche richieste dal paziente.
- **Da firmare**: la coda del medico, raggruppata per paziente (`GET /api/ricette/da-firmare`). Le ripetizioni preparate dalla segreteria arrivano qui direttamente.
- **In invio**: stato tecnico di pochi istanti. Il passaggio è atomico, così la stessa ricetta non parte due volte anche con due clic contemporanei.
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
- Ogni operazione passa dalla guardia sui dati del paziente e finisce nel registro degli accessi (`ricetta_bozza`, `ricetta_ripetizione`, `ricetta_da_firmare`, `ricetta_firma_invio`, `ricetta_annullamento`, `ricetta_cartacea`).

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
- **Ricetta bianca**: si conserva il PDF del SAC (`promemoria_sac`, in base64 con l’impronta SHA-256) e si consegna byte per byte; il foglio «solo NRE» non c’è.
- **Stampa**: `GET /api/ricette/:id/promemoria` (completo) e `?formato=nre` (numero, codice fiscale e codice di autenticazione). Dal 20/11/2026 il modello è quello delle specifiche del 28/02/2024 (D217): metà alta di una pagina A4, NRE in due codici a barre (i primi 5 caratteri e il resto) e codice fiscale, modulo 0,254 mm (minimo 0,240), largo 2,5 volte, barre alte 8 mm, valori tra asterischi in OCR-A. I promemoria fissati prima si ristampano con il modello di prima, uguali byte per byte (versione dei dati).
- **Invio**: `POST /api/ricette/:id/promemoria/invio`, email con il PDF allegato o SMS con il solo numero, al paziente o a un delegato con delega valida oggi (R16). Nel testo dell’email nessun dato clinico. Simulatore, nessun invio vero.
- **Consegne**: ogni stampa e ogni invio entrano in `reminder_delivery`, che non si modifica; `GET /api/ricette/:id/promemoria/consegne`.
- **Tempo massimo di attesa** dell’invio al SAR: 8 secondi (il limite alto dei 6–8 del Piemonte); oltre, esito incerto (D94).

## Da completare (servono le specifiche e le credenziali di collaudo)

- Formato vero dell'NRE e dell'NRBE: il simulatore usa numeri di fantasia che cominciano con `SIM`.
- Adattatori veri per SAR e Sistema TS, con l'autenticazione forte (Id-Sessione) del Sistema TS.
- Casi in cui l'annullamento è ammesso.
- Modulo di stampa della ricetta rossa.
- Promemoria (D217): la frase regionale (campo 28) e la frase sui farmaci in DPC come le restituisce il SAC vero; un'eventuale validità minore di 180 giorni comunicata dal Piemonte; i tipi di ricetta diversi da «Assist. SSN»; il codice regionale davanti al nome del medico, da confermare al collaudo. Stampa vera e lettura dei codici in farmacia.
- Fornitore vero di email e SMS, con le garanzie sul trattamento dei dati.
- Se il SAR comunica l'erogazione in farmacia; lo stato «sospesa» (6) delle specifiche del Sistema TS nella tavola degli stati di processo, oggi non tra gli stati del prodotto (D70).
