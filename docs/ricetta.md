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
- **Stampata su ricetta rossa**: chiusa, non si invia più.

## Chi fa che cosa

- La segreteria prepara le ripetizioni di terapie croniche non riservate: una ricetta per terapia, nella coda «da firmare». Non firma, non invia, non prepara ricette nuove.
- Il medico prepara, firma e invia. Il sostituto e il collega autorizzato firmano **a nome loro**.
- Ogni operazione passa dalla guardia sui dati del paziente e finisce nel registro degli accessi (`ricetta_bozza`, `ricetta_ripetizione`, `ricetta_da_firmare`, `ricetta_firma_invio`, `ricetta_annullamento`, `ricetta_cartacea`).

## Integrazioni

- `packages/integrations`: un'interfaccia comune (`PrescriptionGateway`) per SAR (ricette SSN, poi inoltrate al SAC del Sistema TS) e Sistema TS (ricetta bianca).
- In sviluppo e nelle prove c'è solo il **simulatore**, con quattro esiti: accettata, rifiutata, non raggiungibile, esito incerto. Una prova controlla che il pacchetto non contenga indirizzi di rete né richieste HTTP (regola 7).
- Ogni chiamata, riuscita o no, resta in `external_submission` con richiesta, risposta, esito e durata: non si modifica e non si cancella.

## Da completare (servono le specifiche e le credenziali di collaudo)

- Formato vero dell'NRE e dell'NRBE: il simulatore usa numeri di fantasia che cominciano con `SIM`.
- Adattatori veri per SAR e Sistema TS, con l'autenticazione forte (Id-Sessione) del Sistema TS.
- Casi in cui l'annullamento è ammesso.
- Modulo di stampa della ricetta rossa e del promemoria, conformi alle specifiche: oggi il servizio restituisce i dati da stampare.
- Se il SAR comunica l'erogazione in farmacia.
- Promemoria al paziente sul canale scelto (R15, R16): le regole arrivano alla tappa 4, l'invio vero con l'interfaccia.
