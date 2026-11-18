# Decisioni

Le scelte prese senza Simone, ognuna con il motivo e con che cosa toccare per cambiarla.

## Tappa 0 – Preparazione

**D1 · Un branch per blocco.** `tappe-0-2`, `tappe-3-4`, `tappe-5-6`, ognuno con la sua pull request verso `main`. Nomi che dicono cosa contengono. Il branch di sessione assegnato dall'ambiente non aveva commit e non serve.

**D2 · Hook di avvio sincrono.** `scripts/avvio-sessione.sh`, impronte delle dipendenze in `node_modules/.avvio-sessione.sha256`. Sincrono: la sessione parte solo con database e dipendenze pronti, senza corse. Le impronte dentro `node_modules` spariscono con i pacchetti, quindi non si salta mai un'installazione necessaria.

**D3 · Credenziali locali del database.** Utente `mmg`, password `mmg`, con CREATEDB. Solo sviluppo, non un segreto. CREATEDB serve alle prove, che creano e cancellano database temporanei per provare le migrazioni da zero.

**D4 · Prefisso dei pacchetti `@mmg/`.** Il nome del prodotto non può stare fuori da `packages/brand` (regola 6); `mmg` descrive il dominio ed è coerente con utente e database.

## Tappa 1 – Scheletro

**D5 · TypeScript 6.0 e non 7.0.** typescript-eslint 8.73 (l'ultima) dichiara `typescript >=4.8.4 <6.1.0`: con la 7 il lint con controllo dei tipi non è supportato. Si passa alla 7 quando typescript-eslint la supporta.

**D6 · ESLint 10.** La 9 risulta «no longer supported» su npm (verificato il 18/11/2026). typescript-eslint e il plugin di React per gli hook supportano la 10; il plugin jsx-a11y dichiara solo fino alla 9: per l'accessibilità si usano le prove con axe-core (tappa 6).

**D7 · Vitest come test runner.** Diffuso, nativo per TypeScript e per Vite, un solo comando per tutto il monorepo con i progetti (`vitest.config.ts` alla radice).

**D8 · Fastify per il servizio applicativo.** Diffuso, stabile, con prove senza aprire porte (`app.inject`). Validazione degli ingressi con zod.

**D9 · Drizzle per lo schema, esecutore delle migrazioni nostro.** Drizzle ORM dà le query tipizzate; drizzle-kit genera le migrazioni SQL versionate in `apps/api/migrations/`. Le applica `apps/api/src/db/migrate.ts`, che in più rifiuta una migrazione modificata o sparita dopo essere stata applicata. Motivo in più: il migratore di Drizzle vuole un'opzione il cui nome contiene la parola vietata dalla regola 6, e la guardia sul nome l'ha trovata. Per ciò che lo schema non esprime (trigger, permessi) si scrive SQL a mano con `drizzle-kit generate --custom`.

**D10 · React con Vite per l'interfaccia.** Diffusi e stabili. Il titolo della pagina lo inserisce `vite.config.ts` da `brand.ts`, così `index.html` non contiene il nome.

**D11 · Interfaccia solo con tema chiaro.** I requisiti chiedono testo grande e contrasto alto, non un tema scuro. I colori di stato (errore, avviso, esito) e i neutri sono scelti da me e controllati da una prova di contrasto WCAG AA; i colori di marchio sono quelli di SCRIPT. Il tema scuro esiste solo per il logo.

**D12 · Pazienti inventati che non possono essere reali.** Codice fiscale costruito con il DM 23/12/1976 (testo letto su def.finanze.it), con luogo di nascita `X001`–`X999`: la Z è degli Stati esteri e ai comuni sono assegnati codici dalla A alla M (Wikipedia, «Codice catastale»), quindi nessuna persona reale ha la X in dodicesima posizione. Email su `example.org` (dominio riservato, RFC 2606), telefoni con prefisso `000`. Da riverificare sul file ISTAT dei comuni alla tappa 5.

**D13 · Proposte di logo nella tavolozza di SCRIPT.** Segno in luce `#4D6BFE`, nome in testo `#0E1435`; su fondo scuro `#8FA0FF` e bianco. Folder si presenta come prodotto di SCRIPT; il blu `#1F3A9E` dei prototipi era un segnaposto. Contrasti calcolati: 4,33:1 su bianco e 7,38:1 sul fondo scuro (sopra il 3:1 richiesto per gli elementi grafici).

**D14 · Niente CAP nei pazienti inventati.** I CAP che avevo in mente non venivano da una fonte letta. Le sigle di provincia dei capoluoghi piemontesi restano, da riscontrare con il file ISTAT alla tappa 5.

**D15 · «by SCRIPT» come testo, con accanto il simbolo ufficiale.** Il simbolo è il file `script_simbolo.svg` usato identico; è decorativo (testo alternativo vuoto) perché il testo dice già SCRIPT.

**D16 · CI a ogni push e su ogni pull request verso `main`.** Così un errore si vede prima di aprire la pull request. Due lavori: TypeScript (lint, tipi, prove con Postgres 16 come servizio) e Python (prove di `sync/`).

**D17 · Un database temporaneo per ogni file di prova.** `mmg_test_<casuale>`, creato con le migrazioni e cancellato alla fine; quelli rimasti da un giro interrotto si cancellano all'avvio delle prove. Le prove non si disturbano e partono sempre da zero. Senza `DATABASE_URL` le prove del database falliscono, non si saltano.

## Tappa 2 – Modello, ruoli e accesso

**D18 · Medicina di gruppo come autorizzazione, non come ruolo.** Studio di tipo «gruppo», un archivio per titolare, segreteria condivisa. Un collega vede i pazienti di un altro titolare solo con un'autorizzazione (`archive_grant` di tipo `group_colleague`) data dal titolare, con periodo e motivo. I requisiti dicono «condizioni da definire»: è una domanda della fermata. Per cambiarle si tocca `can()` in `packages/domain/src/permissions.ts`.

**D19 · Durate dell'accesso.** Sessione al massimo 12 ore (una giornata di ambulatorio), passaggio fra password e codice 5 minuti. TOTP con HMAC-SHA1, 6 cifre, 30 secondi, tolleranza di un intervallo prima e dopo: è il profilo che leggono tutte le app di autenticazione diffuse. Non sono soglie dei requisiti ma parametri tecnici; si cambiano in `.env` (`SESSION_MAX_HOURS`) e in `apps/api/src/auth/service.ts`.

**D20 · Soglie di sicurezza vuote, «da completare».** Minuti di inattività prima del blocco, tentativi falliti prima del blocco dell'utente, durata del blocco: i requisiti non li fissano. Sono impostazioni dello studio (`studio.idle_lock_minutes`, `max_failed_logins`, `failed_login_lock_minutes`), vuote per difetto; i meccanismi sono provati con valori di prova. Domanda della fermata.

**D21 · Sostituto e colleghi non esportano e non leggono il registro.** I dati sono del titolare; il sostituto lavora sull'archivio, firma a nome suo, ma l'esportazione completa e il registro degli accessi restano al titolare.

**D22 · Segreteria con il minimo indispensabile.** Anagrafiche, agenda, richieste, terapie non riservate (per preparare le ripetizioni), bozze di ripetizione solo di terapie croniche, promemoria. Niente riepilogo clinico (allergie, problemi): i requisiti non lo chiedono e «Cosa deve poter fare la segreteria» è ancora una domanda aperta per Chiara.

**D23 · Registro protetto dal database.** Trigger che rifiutano modifica, cancellazione e svuotamento; numero progressivo e impronta SHA-256 di ogni riga legata alla precedente, verificabili con `mmg_access_log_verify()`. Chi possiede le tabelle può spegnere i trigger: la catena serve a scoprirlo. In produzione il servizio dovrà collegarsi con un utente del database che non possiede le tabelle (annotato in avanzamento: richiede la configurazione del server).

**D24 · Esportazione in un solo JSON con le righe del database.** Nessuna traduzione dei campi, quindi nessuna perdita; impronte per sezione; descrizione in `docs/esportazione.md`. Una prova obbliga a esportare ogni nuova tabella con dati dei pazienti.

**D25 · Dettagli delle voci cliniche in tabelle separate.** Una tabella per tipo invece di un campo JSON: vincoli nel database e revisione più semplice.

**D26 · Dati dimostrativi inventati, medici compresi.** Lo studio e i medici dei dati dimostrativi hanno nomi inventati (non quello della Dr.ssa Rocca). Le password sono casuali e mostrate una sola volta da `pnpm db:seed`.

**D27 · Chiave di cifratura di sviluppo fuori dal repository.** L'hook la crea in `~/.config/mmg/` con permessi 600 e la esporta nella sessione. In produzione arriverà da un archivio di segreti.

**D28 · Ricerca dei pazienti per nome, cognome, codice fiscale, telefono e data di nascita.** Indirizzo e famiglia arriveranno con l'interfaccia (tappa 6).

## Prima fermata – risposte di Simone (18/11/2026)

**D29 · Soglie di sicurezza: 5 minuti, 5 tentativi, 15 minuti.** Scelte da Simone. Sono i valori per difetto delle impostazioni dello studio (migrazione 0003, che li dà anche agli studi esistenti). Sostituisce la D20.

**D30 · Che cosa vede la segreteria lo decide il titolare, per il suo archivio.** Simone ha chiesto di aggiungere il possibile «se la normativa lo consente, altrimenti filtro del medico». Da qui la norma non si può verificare (è la domanda aperta per il consulente privacy dei requisiti), quindi: riepilogo clinico e diario alla segreteria solo se il titolare li abilita (`archive.secretary_can_read_summary`, `archive.secretary_can_read_diary`, rotta `PATCH /api/archivi/:id/impostazioni`), spenti per difetto; i dati riservati mai. L'impostazione del diario passa dallo studio all'archivio. Aggiorna la D22.

**D31 · Sblocco della sessione con il codice a 6 cifre.** Scelta di Simone: dopo l'inattività si sblocca con il codice dell'app di autenticazione, non con la password. Lo stesso codice non vale due volte; i codici sbagliati contano come tentativi falliti.

**D32 · Esportazione anche in CSV.** Richiesta di Simone. ZIP con un CSV per sezione, separatore `;` e UTF-8 con BOM (si aprono in un foglio di calcolo in italiano senza passaggi), virgolette RFC 4180, manifesto con righe e impronte. Libreria ZIP: fflate (diffusa, senza dipendenze).

**D33 · Logo: proposta B, linguetta a picco.** Scelta di Simone. La geometria sta in `packages/brand/logo-proposals.ts`; `productMark` in `mark.ts` la usa; i file definitivi in `packages/brand/assets/logo/`; la favicon in `apps/web/public/`. Tutto generato da `pnpm --filter @mmg/brand logo:proposte`.

**D34 · Confermate:** medicina di gruppo con autorizzazione del titolare (D18), sostituto (D21), dati mai cancellati e storico, registro degli accessi.

## Tappa 3 – Ciclo della ricetta

**D35 · Stato tecnico «in invio».** Fra «da firmare» e «inviata» c'è uno stato di pochi istanti, preso con un aggiornamento atomico: due firme contemporanee non producono due invii. Una prova con una barriera lo verifica davvero.

**D36 · Esito incerto distinto da sistema non raggiungibile.** Se il SAR non risponde in tempo non si sa se la ricetta è arrivata: niente ricetta rossa (rischio di doppione), si riprova l'invio. La ricetta rossa solo quando il sistema è certamente irraggiungibile. Da verificare sulle specifiche del SAR, come chiedono i requisiti.

**D37 · Ripetizione: una ricetta per terapia** (superata dalla D49). Semplice e sempre entro i limiti di confezioni per ricetta; la segreteria la mette nella coda «da firmare», il medico la trova in bozza. Raggruppare più farmaci in una ricetta si può aggiungere quando le regole delle confezioni (R2–R4) sono attive.

**D38 · Numeri di ricetta del simulatore riconoscibili.** `SIMR…` (SAR) e `SIMB…` (bianca): il formato vero è nelle specifiche del Sistema TS, da riprendere con l'adattatore vero.

**D39 · Un errore imprevisto dell'adattatore vale come esito incerto.** Se il codice dell'adattatore si guasta non si sa se la ricetta è partita: la scelta prudente.

**D40 · Il corpo delle richieste si valida dopo la guardia.** Anche una richiesta sbagliata su un paziente finisce nel registro degli accessi.

## Tappa 4 – Regole di prescrizione

**D41 · Regole come dati JSON versionati, con data di efficacia.** `packages/rules/data/regole-AAAA-MM-GG.json`, validati da uno schema; si usa la versione in vigore alla data della ricetta (A5 dei requisiti). Questa prima versione vale dal 18/11/2026: le prove con date precedenti usano il 2027.

**D42 · Un dato mancante non si indovina.** Senza la banca dati farmaci: R3 e R4 non alzano il limite (resta R2); R5 vale per i piani collegati in cartella; R8 e R17 dicono «non verificabile» senza bloccare; R11 non calcola. Senza catalogo delle esenzioni, R9 controlla solo l'esenzione registrata e la sua validità.

**D43 · Validità di 30 giorni contata includendo il giorno di compilazione** (R1), come l'esempio del contatore nei requisiti. Da confermare.

**D44 · R13 blocca anche la riga senza principio attivo.** I requisiti: «la ricetta riporta sempre il principio attivo».

**D45 · R4 chiede anche l'opzione «Multiprescrizione».** La scheda della terapia dice che la multiprescrizione «consente fino a 6 confezioni, solo se valgono le condizioni di R3 o R4».

**D46 · Ogni controllo prima di un invio è registrato e immutabile** (`prescription_check`): versione, problemi, motivi, note confermate. Il controllo di anteprima (`/controlla`) non si registra, ma l'accesso alla cartella sì.

**D47 · Nessun numero nel codice delle regole.** Regola di lint `no-magic-numbers` su `packages/rules/src` (tranne le date): i valori stanno solo nei dati.

**D48 · Date delle regole nel fuso dello studio.** La data della ricetta e quella delle ricette inviate sono quelle di Europe/Rome; i conti si fanno in giorni interi.

## Seconda fermata – risposte di Simone (18/11/2026)

**D49 · Ripetizioni raggruppate.** Scelta di Simone. Più terapie croniche nella stessa ricetta se hanno lo stesso tipo di ricetta (SSN o bianca) e la stessa esenzione abituale, fino al limite di confezioni di R2 letto dalle regole in vigore (oggi 2). Una terapia che da sola supera il limite va in una ricetta sua e decidono le regole (R4). Sostituisce la D37.

**D50 · Contatore R11 solo informativo, in una versione nuova delle regole.** Scelta di Simone. File `regole-2026-11-18-2.json`, versione 2026-11-18.2, in vigore dallo stesso giorno: a parità di data vale il numero più alto. La .1 (R11 che avvisa) resta per verificare i controlli fatti con lei.

**D51 · Confermate:** ciclo della ricetta (stati, esito incerto senza ricetta rossa), confezioni R1–R4, piani, note, classe ed esenzioni (R5–R9, R17).

**D52 · R15 e R16: blocco con avviso spiegato, non deroga.** Simone ha confermato R15 e R16 chiedendo «comunque un alert con motivazione nel caso bloccasse». Letto come: quando bloccano, l'avviso spiega il perché (con la fonte) e che cosa fare. Fatto per tutte le regole che bloccano: ogni problema porta `source` e, dove serve, `remedy`. Non è una deroga con motivo, perché i requisiti dicono che le regole che discendono da una norma «bloccano l'invio e non hanno deroghe»: se Simone intendeva una deroga, è un conflitto con i requisiti da chiarire alla fermata finale.

**D53 · Confermate R13 e R14** così come sono.

## Tappa 5 – Banche dati pubbliche

**D54 · Mappature come dati.** Le colonne dei file d'origine si collegano ai campi in `packages/reference/data/mappature.json`, versionato: se una fonte cambia le colonne si cambia il file, non il codice. Una colonna `null` è «da completare» e il file non si importa finché manca un campo obbligatorio.

**D55 · Colonne AIFA da completare.** Il 18/11/2026 i file AIFA non si leggono dal cloud: il collegamento diretto è bloccato e la lettura tramite Firecrawl si ferma sulla protezione contro i programmi automatici, che non si aggira. Le intestazioni non si scrivono a memoria: dopo il primo giro di `sync/` dal computer dello studio sono in `stato.json` (campo `intestazione`), e l'importazione le mostra accanto a «mappatura da completare».

**D56 · Intestazioni ISTAT lette dal file vero.** Lette il 18/11/2026 dal file ISTAT aggiornato al 21/02/2026 (estrazione testuale del foglio tramite Firecrawl), compresa «Codice Catastale del Comune». Da confermare sul file scaricato da `sync/`.

**D57 · I PDF entrano solo da una trascrizione controllata (A8).** Accanto al CSV trascritto c'è una scheda JSON: tipo, atto, in vigore dal, chi ha trascritto e quando, chi ha controllato, e fonte, chiave e impronta SHA-256 del PDF scaricato da `sync/`. Se il PDF in uso cambia, la trascrizione risulta superata e non si importa. Un atto che `sync/` non scarica (per esempio gli allegati LEA) si accetta senza impronta, con la nota «origine non verificabile».

**D58 · Ogni importazione è una versione immutabile, valida da una data (A5).** Serie = id della mappatura, o la serie dichiarata nella trascrizione (così due determine sul catalogo sono versioni della stessa tabella). Alla data di una ricetta vale, per ogni serie, la versione con la data d'inizio più recente non successiva; a parità, l'ultima importata. Data d'inizio: per i file di `sync/` il giorno del download; per le trascrizioni la data dell'atto. Le tabelle non si modificano e non si cancellano: si importa una versione nuova.

**D59 · Fatti per le regole solo con una fonte, e mai un «no» per assenza.** Classe A: a carico del SSN (R8). Nota AIFA: dall'elenco di classe o dalla DPC (R7). Piano terapeutico: dalla DPC solo quando dice «sì» (R5). Restano non noti, quindi le regole non bloccano su di essi: prescrivibilità dal medico di medicina generale e regime di fornitura (R8), unità per confezione (R4, R11), antibiotici iniettabili (R3). Servono una fonte strutturata (banca dati a licenza) o una mappatura da completare.

**D60 · Catalogo delle esenzioni separato dall'elenco esenzione → prestazioni.** L'elenco del SAR (D.D. 1167/2022) riguarda le esenzioni per patologia: usato come catalogo farebbe risultare «inesistenti» le altre esenzioni (R9). Il catalogo completo è un tipo a sé, da trascrivere dagli atti.

**D61 · Righe non valide: il file non entra.** Il rapporto elenca riga, campo e motivo. Dopo un controllo umano `--accetta-scarti` importa le righe valide e registra quante ne sono state scartate, come `--accetta` di `sync/`.

**D62 · Soglie di vecchiaia (A6) da completare.** Il meccanismo c'è (`vecchiaDopoGiorni` nelle mappature, campo `stale` nelle versioni in uso); i valori non sono nei requisiti e restano `null`: la versione si mostra sempre con la sua data, ma senza avviso di vecchiaia.

**D63 · La prova usa `sync/` vero.** Un sito d'esempio servito in locale (`fixtures/banche-dati/sito`) e `sync/banche_dati.py` lanciato su di esso: l'importazione legge l'output dello script, non un'imitazione. I file d'esempio sono inventati, tranne le intestazioni ISTAT e le righe di Agliè e Airasca; l'XLSX lo scrive `openpyxl`, un produttore diverso dal lettore.

**D64 · La D12 si controlla all'importazione dei comuni.** Se un codice catastale reale inizia con la lettera riservata ai luoghi di nascita inventati (X), il rapporto lo segnala.

## Tappa 6 – Richieste di Simone (18/11/2026)

**D65 · Storico delle prescrizioni di ogni farmaco.** Richiesta di Simone. Nella scheda delle terapie, toccando un farmaco si apre lo storico delle sue prescrizioni: data, stato, NRE, confezioni, posologia, nota AIFA, «non sostituibile» con il motivo, esenzione, chi ha preparato e chi ha firmato, esito dei controlli con i motivi registrati. Le ricette si legano alla terapia; le righe senza terapia, per AIC o principio attivo. Completa la «Confezioni prescritte negli ultimi 12 mesi» proposta nei requisiti.

**D66 · Lo stesso per le prestazioni.** Richiesta di Simone, esempio «visita chirurgica – primo accesso». Toccando una prestazione si apre lo storico delle sue ricette: data, quantità, tipo di accesso, priorità, quesito diagnostico, esenzione, stato, NRE, autori, controlli. Le righe si raggruppano per codice regionale della prestazione, o per descrizione quando il codice manca.

**D67 · Simboli accanto ai nomi, mai al loro posto.** Domanda di Simone: simboli o solo testo? Nel menu principale, nelle sezioni della cartella e nelle azioni frequenti il simbolo sta davanti al nome; nessun pulsante ha solo il simbolo. Motivi: i requisiti vogliono opzioni «con il loro nome e una riga di spiegazione, non icone da ricordare»; chi usa lo studio di rado (sostituto, segreteria nuova) non deve impararle; per l'accessibilità il nome scritto è il nome del pulsante e il simbolo è decorativo. Stile dei simboli come il logo (tratto continuo, spessore costante, estremi arrotondati, un colore), serviti dal nostro dominio.

**D68 · Fino a 20 cartelle aperte insieme.** Richiesta di Simone. Una barra «Cartelle aperte» sotto il menu: una scheda per paziente, che riporta all'ultima pagina vista per quel paziente; la ricetta in corso resta ricordata per paziente, così si cambia cartella e si torna. Alla ventunesima si chiude quella usata meno di recente, con un avviso. Sulle schede cognome e nome per intero, con la data di nascita per gli omonimi, e il paziente attivo evidenziato: con molte cartelle aperte scambiare due pazienti è il rischio clinico vero, più dell'esposizione dei nomi sullo schermo. Tutto sta nella memoria della scheda del browser (sessionStorage) e si svuota all'uscita e a fine sessione; al blocco per inattività resta, per riprendere dallo stesso punto.

**D69 · Evidenziatore giallo, avvisi in arancio bruciato.** A Simone piaceva la palette dei prototipi. Ripreso l'evidenziatore `#FFE45C`, solo come sfondo con testo scuro `#0E1435` (contrasto circa 14:1): contatori, cartella attiva, filtri scelti. Mai come colore del testo né per gli avvisi: il giallo vuol dire «in evidenza». Gli avvisi passano all'arancio bruciato (`#8A3B00` su `#FFE9D6`); errori rossi, esiti verdi, struttura e informazioni con i blu di SCRIPT. Ogni messaggio porta anche simbolo e parola. Alternative dei prototipi per l'evidenziatore: menta, pesca, azzurro. Da confermare alla fermata finale.

**D70 · Una ricetta già lavorata dall'ente non si annulla; nello storico resta tutto.** Richiesta di Simone. Prima di annullare una ricetta inviata si chiede all'ente lo stato di erogazione: si annulla solo se non è ancora presa in carico, prenotata o erogata, altrimenti il rifiuto è immediato e spiegato. Se lo stato non si sa, decide l'ente come prima. Ogni verifica resta nel registro degli invii; nella ricetta l'ultimo stato noto. Le ricette annullate restano nello storico, con chi, quando e perché, e si contano a parte. Da verificare sulle specifiche del SAR e del Sistema TS: che il servizio di stato esista e quali codici restituisce (i nostri cinque stati vanno mappati; da completare). Nell'editor, la stessa prestazione già prescritta fa comparire un avviso con data, NRE e stato.

**D71 · Esami senza «sopra» o «sotto».** I prototipi confrontavano il valore con l'intervallo del referto e chiedevano di validare la funzione con il consulente regolatorio. Finché non c'è quella validazione si mostrano valore e intervallo stampato sul referto, senza giudizio (regola 3).

**D72 · Scheda della terapia in sola lettura.** In questa tappa la scheda mostra le tre parti, le opzioni con nome e spiegazione e lo storico. Nuova terapia, modifica, sospensione e schema orario stampabile non ci sono: mancano le rotte del servizio. Prossimo passo. _Superata da D80–D83._

**D73 · Nel menu solo ciò che funziona.** Oggi, Pazienti, Ricette, Farmaci e prestazioni. Agenda e Riepiloghi dei prototipi non ci sono: non sono nella tappa 6, e per l'agenda è aperta la proposta di Ready! (domanda della fermata finale).

**D74 · La prova dell'interfaccia gira nel browser vero.** Playwright con Chromium, axe-core per WCAG 2.2 A e AA, misura dei bersagli (almeno 44 px, caselle con la loro etichetta), tablet in verticale e in orizzontale senza scorrimento di lato. Sta nelle prove del servizio perché usa il database di prova, `sync/` e le banche dati d'esempio. In CI si installa Chromium.

**D75 · «Oggi».** Il medico vede i suoi appuntamenti, la segreteria quelli dello studio; le code (da firmare, invii non riusciti, richieste aperte, piani in scadenza entro i giorni di R5) sono calcolate, non tabelle.

## Fermata finale – risposte di Simone (18/11/2026)

**D76 · Palette confermata.** Evidenziatore giallo e avvisi in arancio bruciato, come in D69.

**D77 · R15 e R16: blocco spiegato, confermato.** La lettura di D52 resta: nessuna deroga, l'avviso spiega il perché e che cosa fare.

**D78 · Ready! e una versione «Full»: proposta, da decidere.** Simone chiede se tutte le funzioni di Ready! possano entrare nel prodotto, in una versione «Full», e come gestire la palette. Proposta, senza lavori finché non decide:

- **Si può.** Il modello del prodotto ha già appuntamenti e richieste dei pazienti, e i requisiti prevedono la prenotazione online dei pazienti in fase 2.
- **«Full» come integrazione, non come riscrittura.** Il prodotto con Ready! dentro come modulo di prenotazione: un solo accesso per lo studio, l'elenco degli assistiti passato da solo, appuntamenti e richieste che arrivano in «Oggi». Ready! resta vendibile da solo agli studi con altri gestionali. Riscriverlo nel prodotto vorrebbe dire due codici per la stessa cosa (PHP e TypeScript) da tenere allineati, e toccare un prodotto che parte da Chiara l'1/12.
- **Separazione anche nella «Full».** L'app dei pazienti resta un servizio esposto a parte, con i soli dati che le servono; dall'app la cartella non si raggiunge. Una richiesta di ripetizione delle terapie passa subito alla cartella e non resta nell'app.
- **Palette con due pubblici.** Interfaccia dello studio: blu di SCRIPT, evidenziatore giallo e colori di stato (D69). App dei pazienti: lo stile e la palette che lo studio sceglie in Ready!, dalle combinazioni con i contrasti già misurati. In comune, i colori di stato con lo stesso significato ovunque (rosso errore e blocco, arancio attenzione, verde fatto, blu informazione) e i token in un solo posto (`packages/brand`). Il giallo resta un segnale per lo studio: ai pazienti non compare come avviso.
- **Da decidere prima di lavorarci:** integrazione o riscrittura; quando (dopo il lancio di Ready! dall'1/12); prezzi, contratti art. 28 e informative per la versione «Full».

## Terapia completa e collegamenti pronti (dopo la fermata finale, 18/11/2026)

Simone ha visto in `docs/interfaccia.md` che cosa mancava e ha scelto «Terapia + collegamenti pronti»: terapia completa, poi anagrafica, esportazione e impostazioni collegate all'interfaccia.

**D79 · Tipo di accesso con le parole del Sistema TS.** Simone: oltre a «primo accesso» l'altra voce è «altra tipologia di accesso». Verificato sulle [Specifiche tecniche della ricetta dematerializzata – prescrizione](https://sistemats1.sanita.finanze.it/portale/documents/20182/81804/20241205_Specifiche%20tecniche%20ricetta%20dematerializzata%20-%20prescrizione/7cfbbd34-e929-d051-d5b2-629232f3d79e) (Sistema TS, 5/12/2024), campo `tipoAccesso`: «Valori ammessi: 1 = primo accesso, 0 = altra tipologia di accesso». Interfaccia, storico e messaggio di R14 usano queste parole; il codice interno resta `subsequent`, perché la definizione del campo comprende proprio l'accesso successivo (controllo, follow-up). Le specifiche rendono il campo obbligatorio solo con prestazioni del PNGLA; R14 resta «sempre», come nei requisiti. Nella versione viva dei requisiti la riga «primo accesso o accesso successivo» va aggiornata.

**D80 · Scheda della terapia modificabile.** Nuova terapia e modifica salvano la scheda intera (`POST` e `PUT /api/pazienti/:id/terapie`), con le tre parti del prototipo. Il farmaco viene dalla banca dati (AIC, principio attivo, ATC, classe, gruppo di equivalenza, DPC; la nota AIFA è proposta e si conferma a ogni ricetta, R7) oppure si scrive a mano, e allora le regole che leggono la banca dati non lo possono controllare. Unità, frequenza, momento e via usano gli elenchi del prototipo; un valore già salvato fuori elenco resta. «Come la legge il paziente» si compone da sola. Le unità al giorno per il contatore (R11) sono proposte come dose × volte al giorno: a giorni alterni ½, una volta a settimana ⅐, al più tre decimali. Restano vuote per «al bisogno» o quando dose o frequenza non si leggono come numeri, e allora il contatore non conta. Il medico le può correggere e la correzione resta finché non chiede di ricalcolare. I controlli formali (R13, fine del ciclo, date, suggerita S, confezioni) sono gli stessi del servizio, detti prima di salvare vicino al campo; il servizio li ripete. La scheda nuova parte vuota: nessuna dose o unità presunta. Quello che si sta scrivendo è ricordato per paziente, come la ricetta (D68).

**D81 · Sospensione con motivo e reazione avversa.** La sospensione chiede il motivo. Se è una reazione avversa, la reazione entra tra le allergie e reazioni da farmaci (voce clinica con sostanza = principio attivo, o nome del farmaco se manca, e `drugRelated`), riservata se la terapia lo è, e quindi compare subito in testata. Una terapia sospesa si può riprendere: il motivo si toglie dalla scheda, lo storico delle modifiche lo conserva. Nessun controllo automatico tra allergie e prescrizioni (R12 è fuori perimetro: regola 3).

**D82 · Segnalazione di farmacovigilanza: collegamento da completare.** I requisiti chiedono di offrire il collegamento alla segnalazione. L'indirizzo ufficiale non è stato verificato alla fonte: la ricerca non era disponibile in questa sessione. Il meccanismo c'è (`apps/web/src/lib/links.ts`); il valore è vuoto con la nota «da completare», e l'interfaccia lo dice invece di inventarlo.

**D83 · Schema orario stampabile.** Solo le terapie in corso (le sospese no), raggruppate per momento della giornata: mattino, pranzo, sera, in qualsiasi momento, al bisogno. Per ognuna: come si prende, fino a quando, istruzioni. Le terapie riservate restano fuori dal foglio finché chi stampa non le include, perché il foglio va al paziente o a chi lo accompagna. Si stampa dal browser, con un foglio di stile che toglie menu, schede e piede. Non è un modulo conforme: i requisiti non ne indicano uno.

**D84 · Pagina Archivio per il titolare.** È nel menu solo per chi è titolare di un archivio (`/api/io` restituisce `archivio`). Le due impostazioni della segreteria (D30) cambiano subito sullo schermo e tornano com'erano se il servizio rifiuta; ogni cambio è registrato. L'esportazione completa (JSON, oppure CSV in ZIP) parte da due collegamenti alla rotta esistente ed entra nel registro degli accessi. Sostituti, colleghi e segreteria non vedono la pagina (D21).

**D85 · Messaggi di validazione in italiano.** I dettagli dei dati non validi arrivano all'interfaccia. Il servizio usa la traduzione italiana di zod (`z.locales.it`), così un'email sbagliata non mostra più «Invalid email address».

**D86 · Recapiti dalla cartella.** Telefono, email, residenza, domicilio, professione ed email del datore di lavoro (per i certificati INPS) si correggono dalla cartella, con la rotta della tappa 2. Si manda solo ciò che cambia; la sigla della provincia va in maiuscolo; un campo svuotato diventa «non scritto». Possono farlo medico e segreteria (`registry.write`), e la guardia registra ogni modifica. Codice fiscale, nome, nascita, ASL e scelta del medico restano fuori: vanno allineati con AURA quando ci sarà il collegamento.

**D87 · Next²: la sessione non si apre, le schermate servono solo al confronto.** Simone ha autorizzato la consultazione della sua sessione di Next² «non per reverse engineering, ma per capire quali dati ci sono», e ha mandato alcune schermate: procedura diagnostica, procedura terapeutica, presidio, certificato INPS, menu. La sessione non si apre, per tre motivi: da qui non si raggiunge; contiene dati sanitari veri di altri pazienti (regola 1); la regola 2 chiede uno sviluppo indipendente. Le schermate non entrano nel repository e non se ne riprendono impaginazione, campi o elenchi. Sono servite solo a controllare che le funzioni siano già nei requisiti (confronto in `docs/avanzamento.md`). I campi si prendono dalle specifiche pubbliche (Sistema TS, INPS, catalogo regionale). L'unico dato preso dal messaggio di Simone è la dicitura di D79, verificata sulla fonte pubblica. Se Simone vuole usare le schermate anche per i campi, la regola 2 cambia: è una domanda per la fermata.

**D88 · Al datore di lavoro solo il numero di protocollo.** Simone: l'email del datore di lavoro è facoltativa, e al datore di lavoro va solo il numero di protocollo del certificato di malattia, senza dati sensibili. Scelta: nessun dato clinico (diagnosi, codice ICD, note) esce verso il datore di lavoro; il protocollo gli basta per chiedere l'attestato a INPS. L'invio si fa solo se il lavoratore lo chiede. Da confermare con il consulente privacy e sulle specifiche INPS quando si faranno i certificati; la spiegazione è già sotto il campo, nei recapiti.

## Risposte della fermata «terapia e collegamenti» (18/11/2026)

**D89 · Campi suggeriti da chi usa Next².** Risposta di Simone alla domanda su D87: «prendi spunto anche dai campi. Se sono obbligatori o necessari, non c'è violazione di copyright. Io e Chiara, che siamo utenti di Next², possiamo chiederti di implementarli perché, secondo la nostra conoscenza e necessità, riteniamo servano». La regola 2 di `CLAUDE.md` è aggiornata così. Le schermate mandate da Simone o dalla Dr.ssa Rocca possono suggerire campi e funzioni, che diventano richieste loro. I campi obbligatori si verificano sulle specifiche pubbliche, che restano la fonte dei nomi e dei valori ammessi. Gli elenchi di valori vengono dalla fonte pubblica quando c'è, altrimenti si scrivono da noi. Non si copiano impaginazione, testi, codice, documentazione o dati di Next², e le schermate non entrano nel repository (contengono anche dati veri: regola 1). Supera D87 per la parte sui campi.

**D90 · Secondo giro: ordine dei blocchi.** Simone: «fai tutto, nell'ordine che ritieni giusto e opportuno». L'ordine scelto:

1. **Tappa 7 – Promemoria e invio.** Chiude il ciclo della ricetta già fatto, ed è nella versione 1 dei requisiti («stampa dei promemoria»). Serve ogni giorno. Canali e deleghe ci sono già (R15, R16).
2. **Tappa 8 – Certificati INPS.** Sono nella versione 1 e usano dati già in cartella (lavoro, residenza, diagnosi ICD). Terza fermata: promemoria e certificati si guardano con la Dr.ssa Rocca, con i modelli e le fonti.
3. **Tappa 9 – Voci cliniche.** Completano la cartella e non dipendono da nulla di esterno.
4. **Tappa 10 – Presidi e seguito delle prestazioni.** Vengono per ultimi perché prima vanno trovate e verificate le fonti: codici dei presidi, campi del catalogo regionale. Fermata finale del secondo giro.

Branch `tappe-7-8` e `tappe-9-10`, con una pull request ciascuno. Restano dopo: riepiloghi (non sono nella versione 1), agenda (aspetta la decisione su Ready!, D78), AURA e FSE (servono specifiche e accreditamenti), importazione dei dati dal software attuale. L'importazione è nella versione 1, ma serve il formato dell'esportazione di Next² con un file d'esempio senza dati veri.

**D91 · Voci nuove: prima la fonte, poi i requisiti.** «Segmento» delle prestazioni, «giornata lavorata» e «trauma» del certificato INPS, ricetta bianca ripetibile: ognuna si verifica sulla specifica pubblica (catalogo regionale, specifiche INPS e Sistema TS, norma della ricetta bianca). Se c'è, entra nei requisiti con la fonte, nella tappa che la usa; se non si trova, resta annotata come «da verificare» e non si inventa.

## Tappa 7 – Promemoria e invio (18/11/2026)

**D92 · Rete della sessione: ambiente «Folder» con sette siti pubblici.** Su scelta di Simone, la sessione è passata all’ambiente «Folder», che ora raggiunge i registri dei pacchetti e sette siti pubblici, solo in lettura: `sistemats1.sanita.finanze.it`, `www.gazzettaufficiale.it`, `www.inps.it`, `www.aifa.gov.it`, `www.regione.piemonte.it`, `servizi.regione.piemonte.it`, `www.salute.gov.it`. Servono a leggere specifiche e decreti; il prodotto non li chiama (regola 7). I documenti scaricati restano fuori dal repository; nel codice e nei documenti si citano con titolo, data e passaggio.

**D93 · Promemoria dal modello pubblico, fissato all’invio.** Il promemoria della ricetta SSN segue l’allegato 2 del DM 2 novembre 2011, con le aggiunte delle specifiche del Sistema TS (codice di autenticazione, nome del medico dal SAC) e del Piemonte (codice regionale e nominativo sotto il codice fiscale). I dati si fissano all’invio in una tabella che non si modifica, così le ristampe sono identiche. La ricetta bianca consegna solo il PDF del SAC, byte per byte, e non ha il foglio «solo NRE»: il disciplinare vieta le stampe prodotte dai gestionali. La ripetibilità della ricetta bianca (`numRipetibilita`, `validitaFarm`) è verificata sul disciplinare ed entra nei requisiti con questa fonte (D91); i limiti del modulo (0–99 volte, 1–99 mesi) sono solo controlli di formato: le regole di ripetibilità le controlla il SAC.

**D94 · Tempo massimo di attesa dell’invio: 8 secondi.** La Regione Piemonte (SIRPE, 4.4.7) chiede un parametro per l’attesa del codice di autenticazione, «al momento definiti in 6-8 secondi», poi la ricetta cartacea. Valore per difetto 8000 ms (`sendTimeoutMs`), configurabile; oltre, l’esito è incerto e la ricetta rossa resta ferma finché non è chiaro (regola già in uso dalla tappa 3).

**D95 · Prima di inviare, il promemoria si deve poter fare.** Senza la regione dello studio (intestazione, campo 1) o il codice fiscale del medico (campo 20) l’invio di una ricetta SSN si ferma prima di contattare il SAR: meglio che una ricetta valida senza promemoria. Nuovi campi: `studio.region_name`, `doctor_profile.fiscal_code`. Nei dati dimostrativi e nelle prove i codici fiscali dei medici sono inventati, con la X come luogo di nascita (D12).

**D96 · Risposta senza codice di autenticazione = rifiuto.** Le specifiche del Sistema TS dicono che senza codice la ricetta non è valida; il documento piemontese lo tratta come esito negativo. La ricetta va in errore con il codice `SENZA_CODICE_AUTENTICAZIONE` e il promemoria non esce.

**D97 · Che cosa non si è potuto verificare del promemoria.** Il documento «Specifiche tecniche per la stampa del promemoria» (1/3/2016) non è sul portale: posizioni sulla pagina, suddivisione dell’NRE nei codici a barre e dicitura aggiornata restano «da completare». L’NRE in chiaro va in OCR-A (ECMA, tipo 1): oggi è in Courier, da completare con un carattere OCR-A di licenza compatibile. Le descrizioni delle righe (codice della prestazione tra parentesi, «NON SOSTITUIBILE») e il tipo di accesso sulla specialistica sono scelte nostre in attesa di quel documento.

**D98 · Email e SMS: il minimo, e solo a chi ha diritto.** L’email porta il promemoria allegato e un testo senza dati clinici; l’SMS porta solo il numero di ricetta (e il PIN per la bianca). Destinatari: il recapito del paziente in anagrafica o quello di un delegato con delega valida oggi (stesso criterio di R16). Ogni consegna, riuscita o no, resta in `reminder_delivery`. Fornitore vero da scegliere con le garanzie sul trattamento dei dati.

**D99 · Codice a barre: tabella da una fonte scritta, verificata con un’altra implementazione.** La tabella del Code 39 viene dal file `barcode.ps` di Barcode Writer in Pure PostScript (pacchetto bwip-js 4.11.4, licenza MIT); il disegno usa il rapporto 2,5 del decreto. Una prova confronta le barre di ogni carattere con quelle disegnate da bwip-js (rapporto 3, normalizzato). Le prove leggono il testo dei PDF con pdfjs-dist 6.4.299 (Apache 2.0), solo per le prove.

## Tappa 8 – Certificati INPS (18/11/2026)

Domanda della Dr.ssa Rocca, tramite Simone: in Next² ha configurato, oltre all’accesso al programma, le credenziali del Sistema TS (certificati di malattia) e le credenziali RUPAR. Verificato sulle fonti ufficiali:

- Regione Piemonte, SIRPED: specifiche del SAR per i prescrittori (`servizi.regione.piemonte.it/media/1019`), piano dei test per le cartelle cliniche, V02 (`media/1036`), autenticazione forte, versione 4.0 del 2/3/2026 (`media/3354`).
- Sistema TS: specifiche per i certificati di malattia, versione 3.2; disciplinare tecnico della ricetta bianca, 1/12/2022; autenticazione forte per la ricetta SSN, versione 1.1 del 3/6/2025; autenticazione forte per i web service, versione 1.1 del 12/1/2026.

**D100 · Credenziali dei servizi nel profilo del medico.** Ogni medico, titolare o sostituto, conserva le proprie credenziali per due servizi:

- **Sistema TS**: utente, password e PIN, per i certificati INPS e la ricetta bianca. Fonti: specifiche INPS 4.1 (basic authentication o CNS) e disciplinare della ricetta bianca 2.3 («credenziali di autenticazione rilasciate dal Sistema TS»).
- **RUPAR Piemonte**: utente, password e PIN, per le ricette SSN al SAR. Fonte: specifiche del SAR 3.1.1 («le credenziali Rupar Piemonte (user, password e pin)»).

Le regole:

- Le inserisce e le cambia solo il medico a cui appartengono; la segreteria e l’amministratore no (regola 5). Il sostituto usa le proprie (requisiti, «Medico sostituto»).
- Sono cifrate con una chiave derivata da `APP_ENCRYPTION_KEY` solo per questo uso, e legate al medico e al servizio.
- L’interfaccia non le rilegge mai: mostra solo se ci sono, le ultime tre lettere dell’utente e la data del cambio della password.
- Non entrano nell’esportazione né nello storico delle modifiche, perché nessun segreto vecchio deve restare conservato. Il medico può cancellarle.
- Il campo segnaposto `doctor_profile.external_credentials_enc`, mai usato, lascia il posto alla tabella `service_credential`.

**D101 · Password RUPAR: scadenza trimestrale e avviso.** Il piano dei test SIRPED dice che la password RUPAR «ha scadenza trimestrale, come richiesto dal provvedimento del Garante»: si cambia sul portale SistemaPiemonte e subito dopo nel gestionale.

- Il medico indica la data del cambio. Il programma calcola la scadenza con tre mesi solari (la funzione `addMonths` del certificato).
- L’avviso parte 14 giorni prima. È un parametro dell’interfaccia, non una regola.
- Decide la risposta del SAR («Password scaduta»): il programma non blocca l’invio per la data calcolata.

**D102 · Secondo fattore: l’Id-Sessione.** I decreti dell’8/6/2023 (ricetta bianca) e del 27/2/2025 (ricetta SSN) aggiungono a utente, password e PIN un codice di sessione.

- **Sistema TS**: l’«ID-SESSIONE» va nell’intestazione `Authorization2F: Bearer` e vale «per almeno 8 ore» per la ricetta SSN (3/6/2025, 5). Si ottiene dal portale con SPID, CIE o CNS, oppure con un web service che lo manda all’email certificata (12/1/2026, 5). La tessera TS-CNS ne è esente (3/6/2025, 3).
- **Piemonte**: il SIRPED ha due modalità (V04, 3 e 4):
  - un codice per email certificata, chiesto con le credenziali RUPAR;
  - OAuth2 con SPID, CIE, TS-CNS o CNS tramite GASP-RP Salute, che per il SAR sostituisce utente, password e PIN.
- **Nel prodotto**:
  - Ogni medico ha una sessione per servizio, con la sua scadenza.
  - Se un invio la richiede e manca o è scaduta, si ferma prima di contattare il servizio, come per D95.
  - È costruita la modalità con il codice per email, che vale per tutti e due i servizi. Nel simulatore il codice compare a video, come fa l’ambiente di prova del SIRPED (4.2.1).
- **Da completare o verificare**:
  - La durata della sessione SIRPED è indicata come «tempo predefinito»: valore da completare. Nel simulatore vale 8 ore, come quella del Sistema TS.
  - Per i certificati INPS il secondo fattore non compare nelle fonti lette: da verificare in collaudo.
  - La modalità da usare in Piemonte (email o SPID/CIE) è una domanda della terza fermata.

**D103 · Registrazione del programma presso la Regione.** Per i due fattori la Regione assegna al programma un codice del gestionale all’avvio dell’autocertificazione (SIRPED, autenticazione forte, 4.2.1, campo `infoAggiuntive` «APP»). Il medico deve essere censito nel configuratore regionale con i suoi profili. È una pratica esterna: è annotata tra quelle da avviare con i collaudi, e il codice resta un parametro vuoto, da completare.

**D104 · Net Medica Italia: che cosa si sa, che cosa si propone.** Lo ha chiesto la Dr.ssa Rocca. Il sito non è raggiungibile da questa sessione, quindi le informazioni vengono solo dai risultati di ricerca:

- È la società di innovazione tecnologica della FIMMG.
- Un programma sul PC dello studio, NetDesk, manda i dati della cartella a un cloud con un database unico «standardizzato». I colleghi dell’AFT lo consultano anche se usano programmi diversi.
- Dichiara la compatibilità con molti programmi di cartella (Millewin, Medico 2000, Next, Profim, Perseo, Effepieffe, Iatros e altri), tramite NetDesk o integrazioni dirette con i produttori.
- Ha un canone annuale e credenziali proprie.

Proposta, nel rispetto della regola 2:

- tra chi usa il nostro programma, la condivisione della medicina di gruppo (D18), da estendere all’AFT;
- con chi usa altri programmi, solo formati pubblici (il Profilo Sanitario Sintetico dell’FSE 2.0) o accordi con i produttori.

I requisiti mettono la medicina di gruppo con più archivi in fase 2, quindi è una domanda della terza fermata. Non è stato costruito nulla.

**D105 · Tempo massimo di attesa dell’INPS: lo stesso delle ricette.** Per i certificati le fonti lette non indicano un tempo. Si usa lo stesso parametro delle ricette, 8 secondi (D94), configurabile (`sendTimeoutMs`). Oltre quel tempo l’esito è incerto e il certificato va in errore; si può riprovare.

**D106 · Luogo sulla copia.** I fac-simile hanno «Luogo» accanto a protocollo e data, ma lo schema XSD non ha il campo. Si stampa:

- l’indirizzo dello studio per la visita ambulatoriale;
- il comune della casa (reperibilità o residenza) per la domiciliare;
- niente per il pronto soccorso.

**D107 · Esito incerto dei certificati.** Come per le ricette, dopo un tempo scaduto si può riprovare l’invio o annullare il certificato nel programma. Se l’INPS rifiuti un certificato doppio va verificato con l’adattatore vero e con il servizio di ricerca delle specifiche (RicercaMalattia), che oggi non si usa.
