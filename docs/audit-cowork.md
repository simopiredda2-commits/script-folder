# Istruzioni per l'audit con Cowork

Audit dall'esterno del programma, una volta sola, a programma chiuso salvo il collaudo finale (D247). Questo testo si dà a Cowork così com'è. Cowork legge, prova e annota; non modifica nulla. Il resoconto torna a Claude, che verifica ogni punto e corregge i difetti veri.

## Che cosa è il programma

Una cartella clinica in cloud per medici di medicina generale, partendo dal Piemonte. Il medico prescrive (ricette SSN, bianche e specialistiche), manda i certificati di malattia all'INPS, tiene le voci cliniche, pubblica il Profilo Sanitario Sintetico sul Fascicolo; la segreteria prepara, il medico firma e invia. I collegamenti con gli enti (SAR, Sistema TS, AURA, INPS, Fascicolo) sono simulati: nessun ente vero viene chiamato.

## Dove si prova

- **Dimostrazione nel browser**: https://claude.ai/artifact/Md4KFYrVagjLdnNewSMzCQ (versione 23). È privata: va aperta dal conto di Simone. Programma, database e servizi simulati girano nella pagina; ricaricando si riparte da capo, con i dati del giorno.
- **Accesso**: il riquadro «Dimostrazione» mostra gli utenti, la password (la stessa per tutti) e il codice del secondo fattore di chi accede. Utenti: `medico` (titolare), `segreteria`, `sostituto`, `amministratore`; in più una collega dello studio e un medico di un altro studio dell'AFT.
- **Dati**: solo pazienti inventati. Farmaci: le liste di classe A e H di AIFA del 30/6/2026 e le confezioni dell'anagrafica che vi compaiono; classe C e farmaci senza obbligo di prescrizione non ci sono (da integrare, D257).
- **Repository** (facoltativo): `simopiredda2-commits/script-folder`. Da leggere: `docs/requisiti.md` (che cosa deve fare), `docs/decisioni.md` (le scelte, D1–D257), `docs/avanzamento.md` («Che cosa resta aperto»), `docs/interfaccia.md` (schermate e accessibilità).

## Che cosa guardare

Per ogni punto: funziona come ci si aspetta? Il testo è chiaro, in italiano professionale? Che cosa succede se si sbaglia o se il servizio simulato non risponde?

1. **Accesso e ruoli**: accesso con il secondo fattore; che cosa vede e che cosa può fare ogni ruolo. La segreteria prepara e non firma mai; l'amministratore non vede i dati clinici; il sostituto firma solo con l'autorizzazione.
2. **Oggi e pazienti**: elenco, ricerca, apertura della cartella, cartelle aperte in alto, fascia del paziente, menu della cartella.
3. **Ricetta farmaceutica** (la parte cambiata di più):
   - ricerca per nome, principio attivo, AIC o ATC: il principio attivo si vede nei risultati dei marchi;
   - «Aggiungi», confezioni con «− N +» e totale in ricetta;
   - farmaci prescritti con l'ultima ricetta, dettagli col «+»;
   - medico: «Firma e invia» in un passo. Si ferma sui controlli (tranne la R1) e chiede «Ho visto i controlli: firma e invia». C'è anche «Salva in bozza», con l'anteprima del promemoria «BOZZA – NON VALIDA»;
   - segreteria: «Prepara la ricetta», poi «Manda alla firma del medico».
4. **Ricette** (pagina): da firmare, confermate con «Stampa e invio del promemoria» e «Archivia ricette confermate», invii non riusciti, invii senza risposta (con il codice di autenticazione per segnarle arrivate).
5. **Promemoria**: PDF su A5, solo NRE, email al paziente o al delegato.
6. **Ricetta specialistica e seguito**: prestazioni dal catalogo regionale, quesito, priorità; esecuzione e referto.
7. **Certificati di malattia**: compilazione, invio, copia per il lavoratore, attestato per il datore di lavoro senza la diagnosi; certificato fermo «in invio».
8. **Voci cliniche, parametri, esami, vaccinazioni, piani terapeutici, privacy**; Profilo Sanitario Sintetico (bozza, validazione, firma, pubblicazione).
9. **Presidi, medicazioni avanzate, prestazioni aggiuntive (PPIP)** e distinta del mese.
10. **AURA simulata**: variazioni in Oggi, nuovo assistito, cambio di medico dentro lo studio («Sposta», «Non spostare»).
11. **AFT**: consultazione del riepilogo con il consenso e il motivo, registro.
12. **Strumenti e amministrazione**: studio, utenti, postazioni e stampa, elenchi, importazione da altri programmi, esportazione dei dati.
13. **Accessibilità** (WCAG 2.2 AA): tutto con la sola tastiera, fuoco visibile, contrasto, bersagli di almeno 44 px, nomi dei pulsanti per i lettori di schermo.
14. **Misure dello schermo**: computer (1280 e 1440 px), tablet in orizzontale e in verticale. La pagina della ricetta e la cartella stanno in una schermata.
15. **Regole che non si discutono**: nessun suggerimento diagnostico o terapeutico (le regole di prescrizione sono solo controlli formali); ogni accesso a una cartella nel registro; esportazione completa dei dati.

## Che cosa non fare

- Non inserire dati di persone vere: solo pazienti inventati.
- Non modificare il repository né aprire richieste su GitHub: solo leggere e annotare.
- Non giudicare i servizi degli enti: sono simulati, e i valori veri arriveranno da Regione e CSI (`docs/avanzamento.md`, «Che cosa resta aperto»).

## Come scrivere il resoconto

Una tabella, un punto per riga:

| N.  | Area | Che cosa succede | Che cosa ci si aspettava | Come riprodurlo (utente, pagina, passi) | Gravità | Schermata |
| --- | ---- | ---------------- | ------------------------ | --------------------------------------- | ------- | --------- |

- **Gravità**: «blocca» (non si può lavorare o un dato è sbagliato), «importante» (si lavora ma male), «minore» (testo, aspetto).
- Difetti e suggerimenti in due tabelle separate.
- In fondo: che cosa non è stato guardato, e con quale browser e quale misura dello schermo si è provato.
