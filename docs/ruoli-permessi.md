# Ruoli e permessi

Da verificare con la Dr.ssa Rocca alla prima fermata. Fonte: la tabella «Utenti e ruoli» di `docs/requisiti.md`. Il principio: **la segreteria prepara, il medico firma e invia; ogni accesso a una cartella viene registrato.**

## I ruoli

- **Medico titolare.** Ha un archivio, cioè i pazienti che lo hanno scelto. Sul proprio archivio può tutto: firma e invia ricette e certificati, legge il registro degli accessi, esporta i dati.
- **Segreteria.** È condivisa dallo studio e lavora sugli archivi dei titolari che l'hanno confermata, ognuno per il suo (D181, D185): finché un titolare non la conferma, il suo archivio non lo vede. Lì fa: anagrafiche, agenda, richieste dei pazienti, terapie non riservate, bozze di ricette ripetute di terapie croniche, stampa dei promemoria. Non firma e non invia. Il **riepilogo clinico** (allergie, problemi, scadenze) e il **diario** li vede solo se il titolare li abilita per il suo archivio: per difetto sono spenti (scelta della prima fermata, da confermare con il consulente privacy). I dati riservati non li vede mai.
- **Medico sostituto.** Lavora sull'archivio del titolare solo nel periodo autorizzato, con le proprie credenziali. Ricette e certificati restano a nome suo. Non esporta i dati e non legge il registro: i dati sono del titolare.
- **Medicina di gruppo.** Non è un ruolo dell'utente ma un modo di organizzare lo studio: più titolari, ognuno con il suo archivio, e una segreteria condivisa. Un collega vede i pazienti di un altro titolare solo con un'**autorizzazione** che il titolare gli dà, con periodo e motivo: confermato da Simone alla prima fermata.
- **Medici dell'AFT** (tappa 12, D161). Non è un ruolo ma un'appartenenza: titolari di studi diversi che usano il programma. Un collega dell'AFT vede solo il **riepilogo** di un paziente (allergie, problemi, terapie in corso, parametri), solo se il medico curante condivide i suoi pazienti e il paziente ha dato il consenso, scrivendo il motivo. Niente voci oscurate o riservate, niente scritture. Dettagli in `docs/aft.md`.
- **Amministratore dello studio.** Gestisce utenti, stampanti, intestazioni e modelli. Non ha accesso clinico, a meno che non sia anche medico: un utente può avere più ruoli, per esempio titolare e amministratore. Non può nemmeno prenderselo (D179): chi crea con i dati dei pazienti (medici e segreteria) entra solo dopo la conferma di un medico titolare dello studio, che riceve la password temporanea e la consegna di persona; le credenziali di medici e segreteria (password, secondo fattore, sblocco) le ripristina chi gestisce il servizio, sul server; non sospende un titolare con pazienti né l'ultimo titolare attivo, e non riattiva chi ha sospeso il server. Dettagli in `docs/amministrazione.md`.
- **Paziente.** Fase 2, non c'è ancora.

## Matrice

Calcolata dal codice (`packages/domain/src/permissions-matrix.ts`) chiamando le stesse regole che usa il servizio; una prova controlla che questa tabella sia allineata. Per aggiornarla: `pnpm --filter @mmg/domain docs:permessi`.

<!-- matrice:inizio -->

| Azione | Titolare (proprio archivio) | Segreteria | Sostituto (nel periodo) | Collega di gruppo (autorizzato) | Collega di gruppo (senza autorizzazione) | Amministratore |
| --- | --- | --- | --- | --- | --- | --- |
| Leggere anagrafica, dati SSN, esenzioni, consensi e deleghe | Sì | Sì | Sì | Sì | No | No |
| Modificare anagrafica, recapiti, esenzioni, consensi e deleghe | Sì | Sì | Sì | Sì | No | No |
| Gestire l’agenda | Sì | Sì | Sì | Sì | No | No |
| Gestire le richieste dei pazienti | Sì | Sì | Sì | Sì | No | No |
| Leggere il riepilogo clinico (allergie, problemi, scadenze) | Sì | Se il titolare lo consente | Sì | Sì | No | No |
| Leggere il diario clinico | Sì | Se il titolare lo consente | Sì | Sì | No | No |
| Scrivere voci cliniche | Sì | No | Sì | Sì | No | No |
| Leggere le terapie non riservate | Sì | Solo non riservate | Sì | Sì | No | No |
| Leggere terapie e voci riservate | Sì | No | Sì | Sì | No | No |
| Modificare le terapie | Sì | No | Sì | Sì | No | No |
| Preparare una ricetta nuova | Sì | No | Sì | Sì | No | No |
| Preparare la bozza di una ricetta ripetuta | Sì | Solo terapie croniche non riservate | Sì | Sì | No | No |
| Firmare e inviare le ricette | Sì | No | Sì | Sì | No | No |
| Firmare e inviare i certificati | Sì | No | Sì | Sì | No | No |
| Firmare e pubblicare il Profilo Sanitario Sintetico nel Fascicolo | Sì | No | Sì | No | No | No |
| Aprire il Fascicolo regionale del paziente dalla cartella | Sì | No | Sì | Sì | No | No |
| Stampare i promemoria | Sì | Sì | Sì | Sì | No | No |
| Leggere il registro degli accessi | Sì | No | No | No | No | No |
| Esportare tutti i dati dell’archivio | Sì | No | No | No | No | No |
| Importare dati da altri programmi nell’archivio | Sì | No | No | No | No | No |
| Leggere ed esportare i riepiloghi dell’archivio per periodo | Sì | Sì | No | No | No | No |
| Leggere le prestazioni aggiuntive (PPIP) del paziente | Sì | Sì | Sì | Sì | No | No |
| Leggere e scaricare la distinta mensile delle prestazioni aggiuntive | Sì | Sì | No | No | No | No |
| Registrare e annullare le prestazioni aggiuntive (PPIP) | Sì | Sì | Sì | Sì | No | No |
| Inviare all’ASL la distinta mensile delle prestazioni aggiuntive | Sì | No | No | No | No | No |
| Decidere che cosa vede la segreteria dell’archivio e quali sono le medicazioni avanzate | Sì | No | No | No | No | No |
| Autorizzare un sostituto o un collega di gruppo sull’archivio | Sì | No | No | No | No | No |
| Spostare un paziente nell’archivio del medico scelto in AURA | Sì | No | No | No | No | No |
| Modificare i dati e le impostazioni dello studio | No | No | No | No | No | Sì |
| Gestire gli utenti dello studio | No | No | No | No | No | Sì |
| Gestire le stampanti | No | No | No | No | No | Sì |
| Gestire le intestazioni | No | No | No | No | No | Sì |
| Gestire i modelli | No | No | No | No | No | Sì |
| Avviare subito l’aggiornamento delle banche dati | No | No | No | No | No | Sì |
| Modificare gli elenchi dello studio (suggeritori, posologie, pacchetti, contatti) | Sì | No | Con un’autorizzazione attiva | Sì | Sì | Sì |
| Leggere il registro delle azioni di amministrazione | Sì | No | No | Sì | Sì | Sì |
| Confermare gli utenti con i dati dei pazienti creati o cambiati dall’amministratore | Sì | No | No | Sì | Sì | No |

<!-- matrice:fine -->

## Regole che valgono sempre

- Ogni studio vede solo i propri dati. L'unica eccezione è il riepilogo condiviso nell'AFT, alle condizioni scritte sopra; ogni consultazione entra nel registro del medico curante.
- La segreteria lavora su un archivio solo dopo la conferma del suo titolare; il titolare la può togliere, e se il ruolo di segreteria viene tolto o ridato le conferme di prima non valgono più (D185).
- Un'autorizzazione vale solo nel suo periodo e finché non è revocata; vale solo per chi è medico (data per errore a un amministratore o alla segreteria, non apre nulla in più).
- Ogni apertura di una cartella, consentita o negata, entra nel registro degli accessi con utente, paziente, azione, data e postazione, e il motivo della decisione.
- I dati dei pazienti non si cancellano: si annullano con un motivo. Ogni modifica entra nello storico con l'utente che l'ha fatta.

## Accesso

- Nome utente e password, poi il **secondo fattore obbligatorio per tutti** (codice a 6 cifre da un'app di autenticazione, standard TOTP). Al primo accesso il secondo fattore si attiva. SPID e CIE arriveranno più avanti.
- Messaggio uguale per utente sconosciuto e password sbagliata, per non rivelare quali utenti esistono.
- Lo stesso codice non vale due volte; il passaggio fra password e codice scade dopo 5 minuti; una sessione dura al massimo 12 ore.
- Dopo **5 minuti** di inattività la sessione si blocca e si sblocca con il **codice a 6 cifre** dell'app (valore scelto da Simone alla prima fermata).
- **Tentativi sbagliati** (D188): dopo **5** password sbagliate dalla stessa postazione, o **20** dallo stesso indirizzo, ogni password aspetta, da 2 secondi a 15 minuti; il conto si blocca per **15 minuti** dopo **50** password sbagliate o **5** codici sbagliati (all'accesso, allo sblocco, o la password attuale nel cambio). Soglie e durata sono impostazioni dello studio (il blocco al più 60 minuti, D179); le attese sono del servizio. Valori confermati da Simone alla fermata dopo la tappa 17 (D191); i 5 codici e i 15 minuti vengono dalla prima fermata (D29).
- Ogni blocco del conto lo vedono l'utente bloccato e i **medici titolari** dello studio, nella cornice, finché ognuno non lo segna come visto; la lettura va nel registro.
- **Ripristino con SPID o CIE** (D189): medici e segreteria attivi e confermati ripristinano da sé password, secondo fattore e blocco, se SPID o CIE riconoscono il codice fiscale del loro utente (del profilo per il medico, collegato da lei stessa per la segreteria). Gli amministratori no. In produzione con il simulatore è spento.
- Durante il blocco non vale nemmeno il codice di un passaggio già aperto; il passaggio fra password e codice guarda al più tanti codici quanti i codici sbagliati ammessi dallo studio, giusti o sbagliati, anche con molte richieste insieme, e vale una volta sola (D179).
