# Condivisione tra i medici dell'AFT (tappa 12, D161)

Documento per la revisione della tappa 12: che cosa vede un collega dell'AFT, a quali condizioni, come lo decide il medico curante e come lo decide il paziente. Le fonti sono in fondo; quello che non è stato letto è scritto lì.

## In breve

- **Chi.** I medici titolari che usano il programma e fanno parte della stessa AFT. Un medico crea l'AFT nel programma e invita i colleghi con il loro codice regionale. Un collega entra solo se accetta l'invito. Un medico sta in una sola AFT alla volta.
- **Il medico curante decide.** Ogni titolare sceglie se condividere i suoi pazienti con l'AFT. Per difetto non condivide. Può smettere quando vuole, o uscire dall'AFT: la condivisione finisce subito.
- **Il paziente decide.** Senza il suo consenso nessun collega vede nulla. È un consenso a parte, «Condivisione del riepilogo con i medici dell'AFT», che si registra nella cartella in «Privacy», come gli altri. Si revoca, e la revoca vale subito.
- **Che cosa si vede.** Solo un riepilogo: allergie e reazioni, problemi, terapie in corso e ultimi parametri, ognuno con il suo stato. Le voci che il paziente ha chiesto di oscurare e quelle riservate non entrano. Chi consulta non può capire se qualcosa è stato oscurato.
- **Come si consulta.** Con il codice fiscale del paziente e il motivo dell'accesso. Non c'è un elenco dei pazienti dei colleghi da sfogliare. Se il riepilogo non c'è, la risposta è la stessa in ogni caso: chi consulta non sa se il paziente è di un collega o se ha negato il consenso.
- **Registro.** Ogni consultazione, consentita o negata, va nel registro degli accessi del medico curante: chi, da quale studio, quando, perché, con quale esito. Il titolare la vede in Strumenti › AFT, «Consultazioni dei colleghi sui miei pazienti».
- **Niente scritture.** Il collega legge e basta: non scrive nella cartella del collega e non prescrive dal suo archivio.

## Dove sta nel programma

| Che cosa                                     | Dove                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Regole di chi vede che cosa                  | `packages/domain/src/aft.ts` (`aftAccess`), con le prove in `packages/domain/test/aft.test.ts` |
| AFT e membri, con lo storico delle modifiche | tabelle `aft` e `aft_member` (migrazione 0020): non si cancellano, si esce con una data        |
| Consenso del paziente                        | `aft_condivisione` tra i consensi di `packages/domain/src/privacy.ts`                          |
| Servizio e rotte                             | `apps/api/src/aft/service.ts`, `apps/api/src/http/aft-routes.ts`                               |
| Riepilogo                                    | la composizione del Profilo sanitario sintetico (tappa 11), con lo stato clinico di ogni voce  |
| Interfaccia                                  | Strumenti › AFT (`apps/web/src/pages/AftSection.tsx`)                                          |
| Prove                                        | `apps/api/test/aft.test.ts` (due studi diversi), una prova nel browser                         |

## Regole, una per una

Ognuna ha la sua prova; quelle segnate con il sabotaggio sono state rotte apposta per vedere la prova diventare rossa (registro in `docs/avanzamento.md`).

1. Consulta solo un medico titolare, membro attivo della stessa AFT del medico curante.
2. Il medico curante condivide (sabotaggio: condivisione ignorata).
3. Il paziente ha dato il consenso e non l'ha revocato; negato o revocato fermano l'accesso (sabotaggio: consenso ignorato).
4. Il motivo dell'accesso è scritto, almeno 10 caratteri.
5. Le voci oscurate e riservate non entrano (sabotaggio: voci oscurate incluse).
6. La consultazione va nel registro del medico curante, non in quello di chi consulta (sabotaggio: registro sbagliato).
7. Uscita dall'AFT e revoca del consenso chiudono l'accesso subito.
8. L'invito si fa con il codice regionale; se due medici hanno lo stesso codice, l'invito non parte.

## Domande per la fermata

- Chi può creare un'AFT nel programma: un medico qualsiasi, come oggi, o solo chi ne è il referente per l'ASL?
- Il sostituto di un medico dell'AFT può consultare durante la sostituzione? Oggi no: consultano solo i titolari.
- Il paziente va avvisato di ogni consultazione, oppure basta il registro che il medico curante gli può mostrare?
- La sezione dei parametri serve, o basta il resto?
