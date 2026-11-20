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

**D97 · Che cosa non si è potuto verificare del promemoria.** Il documento «Specifiche tecniche per la stampa del promemoria» (1/3/2016) non è sul portale: posizioni sulla pagina, suddivisione dell’NRE nei codici a barre e dicitura aggiornata restano «da completare». L’NRE in chiaro va in OCR-A (ECMA, tipo 1): oggi è in Courier, da completare con un carattere OCR-A di licenza compatibile. Le descrizioni delle righe (codice della prestazione tra parentesi, «NON SOSTITUIBILE») e il tipo di accesso sulla specialistica sono scelte nostre in attesa di quel documento. Superata: D211 per l'OCR-A, D217 per le specifiche di stampa, trovate nella versione del 28/02/2024.

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

## Risposte della terza fermata (18/11/2026)

Simone ha risposto con il pulsante: via alla pull request #4.

**D108 · Al datore di lavoro protocollo con nome e cognome.** Risposta: «se indicare nome e cognome non viola la privacy, ok anche per nome e cognome». Verificato sulla fonte: l’attestato per il datore di lavoro (allegato B del DM 26/2/2010) contiene già cognome, nome e codice fiscale del lavoratore, e l’INPS lo mette a disposizione del datore (3.5). Quindi l’email non gli dice nulla di più di quello che riceve comunque.

- Il testo contiene protocollo, nome e cognome del lavoratore come all’invio; il nome sta solo nel testo, non nell’oggetto.
- Mai la diagnosi né altri dati clinici.
- Si manda sempre e solo se il lavoratore lo chiede.

Sostituisce la parte di D88 sul solo protocollo. Resta da confermare con il consulente privacy.

**D109 · Secondo fattore per le ricette in Piemonte: SPID o CIE dal programma.** Si costruisce la modalità OAuth2 del SIRPED: il medico entra con SPID o CIE dalla pagina di autorizzazione regionale e il programma riceve il codice da solo; per il SAR non servono più password e PIN RUPAR. Si fa con un simulatore, nel branch `tappe-9-10`, prima della tappa 9. La modalità con il codice per email resta come alternativa.

**D110 · Fascicolo Sanitario Elettronico e rete AFT dopo la tappa 10.** Durante le tappe 9 e 10 si prepara `docs/fse.md` dalle fonti ufficiali (Profilo Sanitario Sintetico: contenuto, aggiornamento, firma, invio, accreditamento). Lo si presenta alla fermata finale del secondo giro, poi si fanno con il via:

- tappa 11: Profilo Sanitario Sintetico con un simulatore del Gateway;
- tappa 12: condivisione tra i medici dell’AFT che usano il programma.

Con gli altri programmi solo formati pubblici (D104).

## Dopo la terza fermata (18/11/2026)

**D111 · Come è fatto l’accesso con SPID o CIE (D109).**

- **Dove sta la richiesta**: nel database, legata al medico che la avvia, con l’impronta dello state (mai lo state in chiaro) e il code_verifier cifrato. Vale 10 minuti ed è monouso; la Regione dà al codice «qualche minuto».
- **Identità**: il codice fiscale nel token deve essere quello del medico collegato. Se non lo è, il token si revoca e l’accesso non vale, perché altrimenti si manderebbero ricette a nome di un altro.
- **Profilo**: serve lo scope `prescrizione` concesso dalla Regione (configuratore regionale).
- **Token**: senza rinnovo, come chiede la Regione. Nel simulatore vale 8 ore; la durata vera viene dalla risposta, da verificare in collaudo per l’ambiguità di `expires_in`.
- **Parametri da completare con la Regione**: codice del gestionale (`client_id`) e indirizzo di ritorno registrato (D103). Il simulatore usa `SIMULATORE_000` e un ritorno interno.
- **Pagina simulata**: servita dal programma solo in simulazione. Chi entra lo dice il programma (`login_hint`, solo per il simulatore); il servizio vero lo ricava da SPID o CIE.
- **Codice per email**: resta come alternativa, con le credenziali RUPAR.

## Tappa 9 – Voci cliniche dall'interfaccia (18/11/2026)

**D112 · Chi scrive le voci cliniche e che cosa si modifica.** Problemi, allergie, diario, parametri, anamnesi, stili di vita ed esame obiettivo li scrive il medico (permesso «scrivere voci cliniche»: titolare, sostituto o collega con l'autorizzazione attiva); la segreteria no, come nei requisiti. Che cosa si modifica di una voce:

- riservata, oscurata e promemoria;
- per i problemi: stato attivo o risolto con la data, quesito aperto.

Il testo non si corregge: si annulla la voce con un motivo e se ne scrive una nuova. Così ciò che è stato scritto resta leggibile, oltre che nello storico delle modifiche. I parametri della stessa visita si scrivono insieme, in una sola transazione: un valore sbagliato li ferma tutti.

**D113 · Parametri: unità fisse, solo controlli formali.** Unità di ogni parametro: mmHg, kg, cm, kg/m², mg/dL, %. Si accettano la virgola e il punto, al più due decimali. Controlli: numero maggiore di zero, e la saturazione non oltre 100 (è una percentuale). Nessun intervallo «normale», nessun giudizio sul valore (regola 3, come D71 per gli esami). Il BMI si scrive come valore: calcolarlo dal peso e dall'altezza è un calcolo clinico, che R12 esclude dalla prima versione; è una domanda per la fermata finale. La glicemia solo in mg/dL; altre unità, se servono, con una serie a parte (il grafico non mescola le scale).

**D114 · Codice dei problemi.** ICD-9-CM, facoltativo, nel formato dello schema del Sistema TS già usato per il certificato (D105): stessa regola, un solo controllo. Il programma non ha il catalogo ICD-9-CM, quindi non si cerca per descrizione. Da completare: la tabella ufficiale ICD-9-CM 2007 del Ministero della salute, da importare come le altre banche dati, se Simone e la Dr.ssa Rocca la vogliono.

**D115 · Consensi del Fascicolo come nel DM 7 settembre 2023.** Letto sulla Gazzetta Ufficiale (GU n. 249 del 24/10/2023). Le modifiche dell'11/11/2025 (GU n. 286 del 10/12/2025) toccano gli art. 22 e 27-bis e l'allegato D, non gli art. 8 e 9. Quelle del 30/12/2024 non le ho lette nel testo: secondo il decreto del 2025 hanno inserito l'art. 27-bis. La consultazione da parte di terzi si consente separatamente:

- per cura;
- per prevenzione, da chi ha in cura il paziente e, a parte, da Regione e Ministero (art. 8, c. 1; art. 16, c. 1 e 2);
- per profilassi internazionale.

In cartella: un'espressione per riga (dato o negato, con la data e chi l'ha espresso se non è il paziente), revoca con la data, nuovo consenso come riga nuova; in vigore resta l'ultima. Altri consensi con la loro descrizione. Li registra chi gestisce l'anagrafica, segreteria compresa (requisiti, «Utenti e ruoli»). La Regione è titolare della raccolta dei consensi (art. 8, c. 13) e l'Anagrafe consensi e revoche si alimenta tramite INI (art. 8, c. 10): l'invio è un'interfaccia futura (tappa 11), da verificare sulle specifiche.

**D116 · Oscuramento.** Una voce oscurata su richiesta del paziente resta in cartella e chi può leggerla la vede, segnata. Non va nel Fascicolo né ai colleghi dell'AFT (tappe 11 e 12). Il decreto vuole che l'oscuramento si possa chiedere al momento della prestazione o dopo, e revocare (art. 9). Chi alimenta il Fascicolo segnala anche i dati a maggiore tutela dell'anonimato (art. 6, art. 12, c. 4): si costruisce con la tappa 11. L'oscuramento di nome e indirizzo sulla ricetta SSN (tappa 7, `oscuramDati` delle specifiche del Sistema TS) è un'altra cosa e resta com'è.

**D117 · Piani terapeutici dalla cartella.** Si registrano, si modificano (storico delle modifiche) e si annullano con un motivo; i piani non si cancellano. Un piano annullato non vale più per R5 e R6, né nel riepilogo né nella pagina Oggi. Un piano può essere riservato come le terapie: allora lo vede solo il medico, e la segreteria non lo trova nemmeno tra le scadenze. Le regole riconoscono il piano dal codice AIC o dal principio attivo, come prima; il collegamento esplicito dalla scheda della terapia non è nell'interfaccia (da fare se serve).

**D118 · Grafico dei parametri.** Una scala per grafico, mai due assi: sistolica e diastolica insieme (stessa unità), ogni altro parametro nel suo grafico. Colori nei token del marchio, validati con il controllo dei colori dei grafici sul fondo bianco: luce di SCRIPT per la prima serie, magenta `#D55181` per la seconda. Contrasto almeno 3:1, distinti anche per chi confonde i colori; non sono colori di stato. In più la forma del punto (tondo, quadrato), la legenda e il valore in fondo alla linea. Sotto ogni grafico la tabella con gli stessi valori. Il cursore segue il puntatore e le frecce della tastiera. L'interfaccia non ha un tema scuro, quindi il grafico nemmeno.

**D119 · Dettatura vocale del diario: per ora no.** I requisiti chiedono la «dettatura vocale del browser». In Chrome il riconoscimento vocale delle pagine web passa da un servizio in rete del produttore: l'audio viene mandato fuori per essere riconosciuto (documentazione MDN della Web Speech API). Sarebbe contro le regole 7 e 8, perché la voce del medico che detta dati clinici uscirebbe verso un servizio esterno, forse fuori dall'UE. Non è costruita. È una domanda per la fermata finale. Le alternative:

- lasciarla fuori;
- usare la dettatura del sistema operativo, fuori dal programma e sotto la responsabilità dello studio;
- cercare un riconoscimento vocale che lavori solo nel browser.

**D120 · Database delle prove che non si cancellano.** A volte, alla fine di un file di prova, Postgres è ancora collegato al database temporaneo per la sua manutenzione automatica, e l'utente delle prove non può interromperlo. La cancellazione allora riprova per qualche secondo, invece di far fallire una prova già passata. Una prova su tre falliva così.

## Tappa 10 – Presidi e seguito delle prestazioni (18/11/2026)

**D121 · Allegati nel database, e nell'esportazione.** I referti (PDF, JPEG o PNG, al più 5 MB) si salvano nel database, non in una cartella a parte: così stanno nei salvataggi e nell'esportazione come il resto. Il tipo si controlla dai primi byte del file, non solo dal nome. Il file si serve con `Content-Security-Policy: sandbox`, quindi niente script. Non si modifica e non si cancella; non ha lo storico delle modifiche (il file intero finirebbe nello storico). Nell'esportazione:

- JSON: sezione `allegati` con il contenuto in base64 e l'impronta;
- ZIP: i file nella cartella `allegati/`, con l'indice `allegati.csv` e le impronte nel manifesto.

Il limite di 5 MB è una nostra scelta, da rivedere con la Dr.ssa Rocca se i referti scansionati sono più grandi.

**D122 · Seguito delle prestazioni.** Vale per le prestazioni della ricetta specialistica inviata o stampata. Per ogni prestazione si registrano data di esecuzione, struttura, esito e referto. Per i cicli (quantità maggiore di 1) si registrano le sedute, numerate fino a quelle prescritte, una per numero. Lo scrive il medico e lo legge chi legge il diario: l'esito è un dato clinico. Il referto è anche una voce «referto» della cronologia. Si annulla con un motivo, e con l'esecuzione si annulla il suo referto. Controlli: la data non è nel futuro e non viene prima della prescrizione. L'acquisizione dei referti strutturati dal Fascicolo resta da verificare (requisiti, «Esami di laboratorio»).

**D123 · Presidi e assistenza integrativa.** Fonti lette il 18/11/2026:

- DPCM 12/1/2017 sui LEA, art. 10–14 (GU n. 65 del 18/3/2017, S.O. n. 15): dispositivi medici monouso (allegato 2), presidi per diabetici (allegato 3), prodotti dietetici. Le Regioni decidono modalità e quantità massime.
- Vademecum per i malati cronici sul sito della Regione Piemonte (gennaio 2023, rivisto dalla Direzione Sanità), cap. 6.

Che cosa si registra: categoria, prodotto, codice del nomenclatore (facoltativo), fabbisogno al mese con l'unità, mesi, dal–al; chi prescrive; la prima prescrizione dello specialista; l'indicazione. Il rinnovo riparte dal giorno dopo la fine della precedente, che si conclude; si annulla con un motivo; può essere riservato. Unico controllo di sostanza, dal vademecum: per le medicazioni avanzate la prima prescrizione è dello specialista, e il medico di famiglia le prescrive per al massimo 6 mesi. La fonte è una guida per i cittadini: la regola va verificata sull'atto regionale. I limiti numerici (fabbisogno fino a 9999, fino a 99 mesi) sono solo di formato, come in D93.

Da completare:

- il modulo da consegnare all'ASL: la guida dice che dipende dalle procedure di ciascuna ASL; il decreto parla del ricettario standardizzato del SSN per i monouso;
- i codici del nomenclatore (allegati 2 e 3), da importare come banca dati;
- i percorsi dematerializzati (alimenti senza glutine, dispositivi per diabetici con il piano di automonitoraggio glicemico): non ho trovato specifiche pubbliche.

**D124 · Modifiche del 2026 ai LEA da verificare.** La ricerca ha riportato una nota del Ministero della salute: il DPCM 12/1/2017 sarebbe stato integrato e modificato dal DM 3 agosto 2026 e dal DPCM 7 agosto 2026. La pagina del Ministero non si legge in modo automatico (controllo anti-robot), quindi non l'ho verificato. Gli articoli usati (10–14) sono quelli del testo del 2017: prima dell'uso vero vanno confrontati con il testo vigente. Verificato il 20/11/2026 sulla Gazzetta Ufficiale: D216.

## Risposte della fermata finale del secondo giro (18/11/2026)

Simone ha risposto con il pulsante.

**D125 · Via all'unione della pull request #5** (tappe 9 e 10, SPID o CIE, documento sul Fascicolo).

**D126 · Dettatura vocale del diario: fuori per ora.** Conferma D119. Si riprende quando ci sarà un riconoscimento vocale che non manda l'audio fuori dallo studio.

**D127 · BMI: resta scritto a mano.** Risposta: «Se diventa dispositivo medico no. Se ci sono gli estremi per poterlo fare allora ok. Altrimenti resta da compilare». Ho cercato la fonte: la linea guida europea MDCG 2019-11 (rev. 1 del 2025) e il manuale sui casi di confine. Dalla ricerca risulta che il manuale tratta il calcolo di un punteggio con una formula come un'azione sui dati che va oltre la semplice ricerca (passo 3 della linea guida); gli esempi sono CHA₂DS₂-VASc e Cockcroft-Gault. Non ho trovato un caso sul BMI e non ho letto i testi integrali. Gli estremi non ci sono: il BMI resta da compilare, come oggi. Da riesaminare con il consulente regolatorio sui testi integrali.

**D128 · Via alle tappe 11 e 12.** Prima il Profilo Sanitario Sintetico con un simulatore del Gateway (tappa 11), poi la condivisione tra i medici dell'AFT (tappa 12), con lo stesso metodo: fonti, simulatori, prove e sabotaggi, schermate. Branch `tappe-11-12`, una fermata dopo la tappa 12. Si parte dalle fonti non ancora lette elencate in `docs/fse.md`.

**Medicazioni avanzate (D123)**: resta il blocco oltre i 6 mesi per il medico di famiglia, come deciso; si cambia se Simone lo chiede o se l'atto regionale dice altro.

## Dopo la fermata finale del secondo giro (18/11/2026)

**D129 · Cartelle aperte con molte schede, e quello che si scrive resta per paziente.** Simone ha chiesto se la schermata con più cartelle aperte era provata. Nel browser era provata con due schede. Il limite di 20 era provato solo senza browser, e le pagine delle tappe 9 e 10 non erano provate dentro le schede. La prova nuova, con 21 pazienti inventati, ha trovato due difetti, ora corretti:

- **Scheda attiva fuori vista**: con molte schede la barra scorre, e la scheda del paziente attivo poteva restare fuori dalla parte visibile, soprattutto su tablet. Ora la barra scorre da sola fino alla scheda attiva, anche quando cambia la larghezza dello schermo; la pagina non si sposta.
- **Scritti persi cambiando paziente**: nelle pagine nuove, e nel certificato di malattia, quello che si stava scrivendo si perdeva passando a un altro paziente e tornando. Ora resta ricordato per paziente come la ricetta e la terapia (D68, D80), nella memoria della scheda del browser, che si svuota all'uscita. Vale per voci cliniche, parametri, piani terapeutici, presidi, consensi, deleghe, seguito delle prestazioni e certificato. Si cancella quando si registra; il file del referto no, perché il browser non lo conserva e va scelto di nuovo.

## Tappa 11 – Profilo Sanitario Sintetico (18/11/2026)

**D130 · Fonti della tappa 11.** Prima di costruire ho letto le fonti che `docs/fse.md` dava ancora da leggere:

- le specifiche di integrazione del Gateway (versione 2.26 del 30/10/2026), con i servizi, i due token JWT, gli errori e le tabelle dei valori;
- il modello del nodo regionale e le domande frequenti del Ministero;
- l'esempio di PSS che passa la validazione;
- lo schematron del PSS (versione 4.0) e i dizionari ufficiali;
- la DGR piemontese 19-1912 del 2025: il Piemonte usa il Gateway nazionale centralizzato;
- l'art. 20 del DM 2023 (accesso in emergenza).

Non si raggiungono da qui la guida HL7 Italia e il portale del Fascicolo; al loro posto valgono le regole dello schematron, che sono quelle che il Gateway applica. Che cosa ne è venuto è in `docs/fse.md`.

**D131 · Copie dei file ufficiali nel repository.** Lo schematron del PSS, sedici dizionari e un estratto LOINC sono in `packages/integrations/fse-ufficiale/`. Ogni file ha la sua provenienza (repository e commit del Ministero) e l'impronta SHA-256, e una prova controlla che nessuno li cambi a mano. Motivo: le prove e il simulatore devono girare senza rete, e il documento del programma va controllato con le regole vere. Il repository del Ministero non indica una licenza: è una domanda per la fermata. Per LOINC c'è l'avviso di licenza.

**D132 · Il simulatore del Gateway applica lo schematron ufficiale.** Come il Gateway vero, la validazione del simulatore controlla il documento con lo schematron e risponde con gli stessi tipi di errore (RFC 7807). Lo schematron usa XPath 1.0 più una funzione di XPath 2 (`matches`). Lo esegue un piccolo motore nostro su due librerie con licenza MIT, `@xmldom/xmldom` e `xpath`. Non provato: i controlli sui dizionari (errore «vocabolario») che il Gateway fa oltre allo schematron. Il simulatore controlla solo i codici dei dizionari copiati.

**D133 · Impostazioni del Fascicolo dello studio.** Servono i valori che lo studio riceve con l'accreditamento: radice OID dei documenti, identificativo del repository, radice OID degli invii, custode del documento, struttura del medico nel formato XON. Restano «da completare» finché la Regione non li assegna. Tre valori sono fissi:

- organizzazione 010, Regione Piemonte, che usa il Gateway nazionale (D130);
- tipologia della struttura «Territorio»: la tabella 58 la indica per i documenti di «uno specialista territoriale (ad es. MMG, PLS)»;
- assetto organizzativo AD_PSC130, «Medicina di Base».

Tipo di attività clinica e regime si scelgono tra i valori delle tabelle 57 e 63 della specifica del Gateway; codici e nomi stanno in un solo posto (`FSE_CLINICAL_ACTIVITIES`, `FSE_ADMINISTRATIVE_REQUESTS`), usato dal simulatore, dal servizio e dall'interfaccia. Nelle prove e nei dati dimostrativi si usano OBS («Documento stato di salute») e SSN («Regime SSN»): sono una proposta da confermare alla fermata. Le impostazioni le cambia l'amministratore nella pagina «Strumenti dello studio», che compare solo nel suo menu; chi lavora nello studio le legge.

**D134 · Il programma propone, il medico sceglie e conferma.** Dalla cartella si propongono:

- le patologie croniche, gli organi mancanti, i trapianti e le malformazioni;
- le allergie attive;
- le terapie croniche in corso, se hanno l'AIC o l'ATC e la via (le altre terapie in corso il medico le può aggiungere);
- l'anamnesi familiare, se ha il parente e il codice della patologia;
- gli ultimi parametri, gli stili di vita e la capacità motoria.

Le voci oscurate non entrano mai (art. 4, c. 3). Le riservate non si propongono: la pagina dice quante sono, e per farle entrare si toglie la riservatezza nella cartella. Una voce a cui manca un dato non si può spuntare, e la pagina dice che cosa manca.

Una sezione obbligatoria senza voci dice l'assenza con i codici ufficiali: per difetto «nessuna informazione»; «nessuna allergia nota» e simili solo se li sceglie il medico. Prima della validazione il medico conferma di aver controllato il contenuto voce per voce. Se cambia una scelta, la conferma si ripete. Motivo: il programma prepara, ma il documento è del medico che lo firma (regola 3: nessuna scelta clinica automatica).

**D135 · Campi nuovi nelle voci cliniche, dai dizionari ufficiali.**

- Problema: «patologia cronica»; categoria (diagnosi, organo mancante, trapianto, malformazione). L'organo mancante ha solo il codice del dizionario ICD-10 «Organi mancanti».
- Allergia: allergia o intolleranza; l'agente; il codice, cioè AIC o ATC per i farmaci, oppure l'elenco «Allergeni (No Farmaci)»; la criticità; «non più attiva».
- Anamnesi familiare: parente, patologia in ICD-9-CM, età all'esordio.
- Capacità motoria: un tipo di voce nuovo.

La scheda della terapia offre le dodici vie con il codice HL7. Le prende dal dominio attraverso il catalogo, così una terapia nuova ha sempre una via che il Profilo sa codificare.

**D136 · Validare, firmare, pubblicare, controllare lo stato.** Il medico valida: prima lo schematron nel programma, poi la validazione del Gateway. Poi firma (PAdES) e pubblica, oppure sostituisce la versione precedente. Infine il programma chiede lo stato della transazione.

Il Profilo è «pubblicato» solo quando lo stato dice che i dati sono arrivati a INI (SEND_TO_INI riuscito). Prima è «preso in carico», e la pagina ha «Controlla lo stato»; il simulatore può rispondere in due tempi per provarlo. Il servizio che valida e crea con una sola chiamata non si usa: il medico firma solo quello che il Gateway ha già validato. La specifica fa rifiutare i documenti più vecchi di 5 giorni (errore `max-day-limit-exceed`): la pagina lo ricorda dopo la validazione.

**D137 · Firma del Profilo simulata.** Il PDF si firma PAdES con un certificato di prova per ogni medico (`SimulatedDocumentSigner`). La firma digitale vera ha bisogno di un fornitore di firma qualificata (remota o con dispositivo) da scegliere: è una domanda per la fermata. L'interfaccia `DocumentSigner` è già quella che il fornitore vero dovrà rispettare.

**D138 · Certificati del Gateway.** Il Gateway vuole due certificati che Sogei rilascia con l'accreditamento: uno per il collegamento e uno per firmare i token. Il simulatore ne rilascia di prova e rifiuta quelli che non ha rilasciato. Quelli veri non entrano nel repository (regola 7): andranno tra i segreti del servizio.

**D139 · Versioni del Profilo.** Ogni versione nuova tiene lo stesso `setId`, ha il numero successivo e dichiara che sostituisce la precedente (RPLC). Il Gateway la riceve come sostituzione. La precedente resta consultabile con il suo PDF firmato e resta «pubblicata» finché INI non conferma la nuova. Il codice P81 («Versioni precedenti Profilo Sanitario Sintetico») non si usa ancora: il suo uso va chiarito con la Regione (`docs/fse.md`).

**D140 · Recapiti di studio del medico.** Il Profilo vuole nome e cognome del medico separati e almeno un recapito (schematron, ERRORE-38 ed ERRORE-40). Si inseriscono nella pagina «Recapiti di studio», raggiungibile da «Credenziali dei servizi» e dall'avviso del Profilo quando manca qualcosa. Li cambia solo il medico stesso. Il codice fiscale del medico resta quello del profilo creato con l'account: qui non si cambia.

**D141 · Indirizzo del paziente fuori dal Profilo.** Lo schematron non lo chiede. Se c'è, però, deve avere anche il codice ISTAT del comune (ERRORE-11), che l'anagrafica non ha. Per ora non entra; il programma lo scrive solo se è completo. Da rivedere quando l'anagrafica avrà il codice ISTAT del comune di residenza.

## Provenienza dimostrabile (18/11/2026)

**D142 · Nessun appiglio per pretese di copyright o di reverse engineering.** Richiesta di Simone: «fai in modo che nessuno possa rivendicare violazione del copyright o reverse engineering». La regola c'era dall'inizio: requisiti («Sviluppo indipendente» e licenza di Next²), regola 2, D87 e D89. Ora è anche documentata e controllata:

- `docs/provenienze.md` dice da dove viene ogni contenuto, a quali condizioni e chi lo controlla.
- Una prova su tutto il repository (`packages/brand/test/provenienza.test.ts`) accetta immagini, documenti e archivi solo con una provenienza dichiarata: le schermate fotografate dal programma, i file inventati di `genera.py`, i marchi. Una schermata o un manuale di un altro programma la fa diventare rossa. La stessa prova ammette nelle dipendenze di produzione solo licenze permissive.
- I cataloghi dello studio vengono dalle fonti pubbliche o li inserisce lo studio; nessun elenco si prende da altri programmi.

Nessuno può impedire a un terzo di avanzare una pretesa. Si può fare in modo che sia infondata e che lo si possa dimostrare. Per questo restano due cose:

- la revisione di un avvocato prima del lancio (requisiti);
- una proposta per la fermata: da ora le richieste arrivano a parole vostre, senza schermate di Next². Così la traccia resta pulita anche rispetto all'art. 7 della sua licenza, che vieta ogni analisi finalizzata a riprodurne i contenuti.

## Modelli dei certificati (18/11/2026)

**D143 · I modelli dei certificati entrano nel terzo giro.** Simone li chiede direttamente: certificato per l'attività sportiva non agonistica, porto d'armi, anamnestico per la patente «e via dicendo». Sono modelli fissi in cui cambiano solo i dati del paziente, in un menu «Modelli» degli strumenti, con caratteri, intestazione e dimensioni scelti dal medico, strutturati secondo le linee guida dove ci sono. Sono già nei requisiti («Altri certificati e moduli»).

Ordine: prima si chiude la tappa 11, poi la tappa 13 (modelli), poi la 12 (condivisione nell'AFT). La fermata resta dopo la tappa 12 e copre tutte e tre. Motivo: i modelli poggiano su due pagine appena fatte, «Strumenti dello studio» e i recapiti del medico; e Simone li ha chiesti due volte.

I testi dei modelli vengono solo dagli atti ufficiali (D142): dove un modello ufficiale non c'è, il testo lo scriviamo noi dai requisiti di legge, e lo segniamo da far verificare. Prima di costruire si leggono le fonti.

**D144 · Come sono fatti i modelli.** Ci sono due tipi di modello.

- **Modelli ufficiali.** Il testo è quello dell'atto, copiato parola per parola. Stanno in `apps/api/modelli/`, un file per modello, con fonte e versione; il servizio li controlla all'avvio, e un file sbagliato lo ferma (`apps/api/modelli/LEGGIMI.md`).
- **Modelli dello studio.** Per i certificati che non hanno un modello ufficiale. Li scrivono i medici o l'amministratore (requisiti: «modelli» tra i compiti dell'amministratore). I segnaposto sono controllati.

Al rilascio il programma mette i dati del paziente (dalla cartella) e del medico (dal profilo). Il medico compila i campi che il modello prevede e il luogo; la data è quella del giorno. Il programma non decide niente di clinico: ogni dichiarazione è del medico (regola 3). Rilascia solo il medico, con il permesso «firmare i certificati», come per i certificati INPS; la segreteria no.

Il certificato rilasciato si conserva com'era: testo, campi, fonte e versione del modello, impaginazione. Non si modifica: si annulla una volta, con un motivo (protezione nel database). Il PDF si rifà identico dal certificato conservato.

Se il modello fissa una validità in mesi, «valido fino al» è il giorno prima della stessa data, tanti mesi dopo. È un'interpretazione, da confermare con la Dr.ssa Rocca.

**D145 · Impaginazione scelta dal medico.** Simone: il professionista imposta caratteri, intestazione e dimensione. Si sceglie:

- il carattere, fra quelli standard del PDF: Helvetica, Times o Courier. Non vanno incorporati e non hanno licenze da rispettare (D142);
- la dimensione, da 9 a 14 punti;
- l'intestazione, fino a 6 righe (la prima in neretto), a sinistra o al centro;
- i margini, da 10 a 40 mm;
- il luogo proposto per «luogo e data»;
- il timbro, sotto lo spazio della firma.

C'è la prova di stampa prima di salvare. Vale per i certificati dai modelli; il testo dei modelli non cambia. Un certificato già rilasciato tiene l'impaginazione che aveva.

**D146 · «Strumenti» anche per i medici.** La pagina degli strumenti ha tre schede: modelli dei certificati, impaginazione (solo per i medici) e Fascicolo sanitario. La vedono i medici e l'amministratore, la segreteria no. Le impostazioni del Fascicolo le cambia solo l'amministratore.

**D147 · Il programma usato oggi dallo studio non si nomina nel codice.** Domanda di Simone: «confermi con assoluta certezza che nel codice non c'è traccia né alcun riferimento» a quel programma? Verificato il 18/11/2026:

- **Codice:** nessun riferimento in `apps/`, `packages/`, `sync/`, `fixtures/`, `scripts/` e `.github/`, né oggi né in tutta la storia (66 commit), né nei nomi dei file.
- **Immagini e documenti:** nella storia sono entrati solo le nostre schermate e i file inventati delle prove.
- **Testi:** il nome compare solo nei documenti che fissano la regola e ne tengono traccia (requisiti, `CLAUDE.md`, decisioni D87, D89 e D104, avanzamento, `docs/provenienze.md`), in un messaggio di commit e nella descrizione della pull request #3. Restano, perché sono la traccia del processo pulito: dicono che cosa non si è preso e perché.

Da ora una prova su tutto il codice (`packages/brand/test/provenienza.test.ts`) diventa rossa se il nome o l'indirizzo del programma compaiono nel codice. L'espressione è scritta in modo che il file della prova non li contenga.

**D148 · Farmaci dimostrativi veri, dalle liste AIFA.** Simone, sulle schermate: «"provalina" è davvero orrendo, trova il modo di poter mettere anche solo un principio attivo». Scelte del 18/11/2026:

- **Estratti veri invece di farmaci inventati.** Nel sito d'esempio (`fixtures/banche-dati/`) i file AIFA sono estratti dei file veri: intestazioni e righe copiate senza cambiare un byte dall'anagrafica delle confezioni e dalle liste di classe A e H del 30/6/2026, letti il 18/11/2026. AIFA pubblica i dati aperti con licenza CC BY 4.0 e chiede di citare la fonte (pagina «Open Data», letta lo stesso giorno). La citazione è nel generatore, nel `LEGGIMI.md` degli esempi e in `docs/provenienze.md`; nel programma, l'elenco «Banche dati dei farmaci in uso» dice da dove viene ogni dato.
- **Quali farmaci.** Uno per ogni problema dei pazienti dimostrativi, ognuno con un equivalente di marca: amlodipina per l'ipertensione, metformina per il diabete, atorvastatina per l'ipercolesterolemia. Poi:
  - dulaglutide, per l'esempio di nota AIFA e piano terapeutico. È la riga dell'elenco DPC della Regione Piemonte aggiornato al 9/7/2026: nota 100, «PT elettronico - Sistema TS»;
  - ceftriaxone, in classe H;
  - paracetamolo, che non è nelle liste di classe.
- **Prezzi e classi.** Sono quelli dei file del 30/6/2026. Servono a provare il programma, non a prescrivere, e non si aggiornano. Le prove interne che non producono schermate restano con i loro dati di prova («Farmaco di prova»).
- **Mappature AIFA complete.** Prima erano «da completare», perché dal cloud i file non si leggevano. Ora www.aifa.gov.it si raggiunge (D92), e drive.aifa.gov.it è stato aggiunto il 18/11/2026 con l'approvazione di Simone. Le intestazioni vere sono nelle mappature del repository; quelle di prova sono state tolte.
- **Controllo sui file interi.** Anagrafica: 160.101 righe. Classe A: 10.766. Classe H: 2.487. Tutti gli AIC hanno 9 cifre e tutti gli ATC sono nella forma attesa.
- **Prezzi che non sono numeri.** Nella classe H, 117 prezzi non sono numeri: 31 «-», perché c'è solo il prezzo massimo di cessione, e 86 prezzi dell'ossigeno a metro cubo («6,55/m³»). Senza una regola, l'intero file sarebbe stato rifiutato. Una mappatura ora può dichiarare quali valori, in un campo facoltativo, valgono «nessun valore» (`nessunValore`). Vale solo per i valori visti nei file veri, con il motivo nella nota. Il rapporto d'importazione dice quante celle ha letto così.
- **Nota AIFA.** Le liste di classe non hanno la colonna della nota: le note vengono dall'elenco DPC. La lista di trasparenza (`Lista_farmaci_equivalenti.csv`) ha nota e ATC per ogni AIC, ma scrive l'AIC senza lo zero iniziale, a 8 cifre. Va mappata in un passo dedicato: finché non lo è, il programma non conosce, per esempio, la nota 13 delle statine.
- **Equivalenti.** Si ordinano per prezzo e, a parità di prezzo, per nome e AIC: lo stesso ordine a ogni ricerca.

**D149 · Dati dimostrativi: solo adulti, terapie per principio attivo.** Due richieste del 18/11/2026:

- **Nessun paziente in età pediatrica.** Simone: «non mettere pazienti pediatrici!!». La schermata delle cartelle aperte mostrava pazienti di 4 e di 14 anni, che non hanno senso nello studio di un medico di medicina generale.
  - Il generatore ora ha un'età minima (`minAge`): i pazienti più giovani si saltano, gli altri restano gli stessi e nello stesso ordine.
  - Il seed chiede solo maggiorenni (`apps/api/src/db/demo.ts`). Una prova lo controlla.
  - Le prove interne restano con le età di prima, perché alcune hanno bisogno di minori.
- **Nessun nome di ditta o marchio nelle schermate per il sito di SCRIPT.** La richiesta è arrivata dalla sessione che fa il sito. Riporta le parole di Simone: «se ci sono dubbi, scegli un principio attivo in cui sia indicato "generico"». Il dubbio riguarda la pubblicità al pubblico di medicinali con obbligo di ricetta (d.lgs. 219/2006) e l'uso di marchi altrui.
  - I generici AIFA portano sempre il nome della ditta (per esempio «METFORMINA MYLAN GENERICS»): una confezione senza ditta non c'è.
  - Le terapie dimostrative sono quindi **per principio attivo**, come il programma già consente. Il nome è la descrizione AIFA del gruppo di equivalenza, letta dalla lista di classe A del 30/6/2026, per esempio «METFORMINA 500MG 30 UNITA' USO ORALE».
  - Anche il piano terapeutico dimostrativo è per principio attivo (dulaglutide).
  - La terapia nuova scelta dalla banca dati (schermate 12 e 13) va a un altro paziente, così la cartella del paziente principale resta senza ditte.
  - I nomi delle confezioni restano dove sono il punto della schermata: ricerca ed equivalenti (10), controlli della ricetta (07), terapia dalla banca dati (12 e 13). Quelle schermate servono alla documentazione, non al sito.
- **Difetto messo in luce.** Nel promemoria, una riga per principio attivo stampa solo il principio attivo, senza dosaggio né confezione (schermata 18). La descrizione giusta è quella AIFA del gruppo di equivalenza. È nelle liste di classe (colonna «Descrizione gruppo») ma non è ancora importata: da correggere, con le specifiche del promemoria alla mano.

**D150 · Quadri clinici dimostrativi credibili per l'età.** La Dr.ssa Rocca: un paziente nato nel 1995 difficilmente prende la metformina, è più credibile l'insulina. Simone: «nelle screenshot tieni conto delle condizioni che effettivamente un paziente sia probabile possa avere».

- **Quadri per età e sesso** (`apps/api/src/db/demo.ts`). Il seed sceglie il quadro clinico così:
  - sotto i 40 anni: diabete tipo 1 con insulina glargine e insulina aspart per gli uomini, ipotiroidismo con levotiroxina per le donne;
  - fra 40 e 64 anni: ipertensione con amlodipina, ipercolesterolemia con atorvastatina, oppure diabete tipo 2 con metformina;
  - dai 65 anni: ipertensione insieme al diabete tipo 2 o all'ipercolesterolemia.
- **Prove.** Anche la pressione dimostrativa dipende dall'età. Una prova controlla due cose: sotto i 40 anni non ci sono diabete tipo 2, ipertensione o ipercolesterolemia, e dai 40 anni non c'è il diabete tipo 1.
- **Codici e farmaci.** I codici ICD-9-CM (250.01, 244.9, 401.9, 250.00, 272.0) sono verificati il 18/11/2026 sulle edizioni inglesi dell'ICD-9-CM, che hanno gli stessi codici della versione italiana 2007. Le descrizioni sono quelle che scriverebbe il medico. I farmaci sono per principio attivo, con la descrizione AIFA del gruppo (D149).
- **Schermate.**
  - Dulaglutide, nella ricetta con i controlli e nel piano terapeutico, va a un paziente con diabete tipo 2.
  - L'amlodipina scelta dalla banca dati va a un iperteso.
  - Al paziente principale (30 anni, diabete tipo 1) si aggiunge l'ipotiroidismo, con pressione e peso da trentenne.
  - Le estrazioni casuali sono le stesse di prima, quindi i pazienti delle schermate non cambiano.
- **Che cosa non vale.** Le dosi (per esempio 14 unità di glargine la sera) sono dati inventati di pazienti inventati: non sono indicazioni terapeutiche (regola 3).

**D151 · La ditta dei generici si vede.** Simone: «l'importante è che il nome dei fornitori possa essere mostrato sui farmaci generici». I generici si distinguono per la ditta, e il medico deve poterla vedere quando sceglie una confezione.

- L'anagrafica AIFA ha la ditta titolare dell'AIC nella colonna `RAGIONE_SOCIALE`: la mappatura la importa nel campo `holder` (migrazione 0016).
- La ditta si vede nei risultati della ricerca dei farmaci (pagina «Farmaci e prestazioni», ricetta, terapia) e in una colonna della tabella degli equivalenti.
- Nelle schermate per il sito di SCRIPT le terapie restano per principio attivo, senza ditte (D149). Il programma la ditta la mostra, dove serve al medico.
- Nella scheda di una terapia già salvata la ditta non è un dato a parte: per i generici è già nel nome della confezione (per esempio «AMLODIPINA EG»). Si può aggiungere se servirà.

**D152 · Tutti i farmaci e tutte le prestazioni restano nella cartella, ognuno con il suo storico; i farmaci hanno un colore per tipo.** Richiesta di Simone del 18/11/2026, sopra D65 e D66: ogni farmaco prescritto con il suo storico, i cronici e i suggeriti distinti dal colore, «visite o esami» nei loro menu. Simone: niente formattazione elementare del testo, meglio lo sfondo, con una piccola legenda sempre nello stesso punto, e colori scelti secondo il significato.

- **Farmaci prescritti** (menu della cartella e pagina propria): le terapie in corso, quelle sospese o concluse (la parola è «concluse» dalla D176) e i farmaci prescritti senza una terapia in cartella. Le righe senza terapia si raggruppano per AIC; senza AIC, per principio attivo; senza nessuno dei due (scritte a mano), per nome. Ogni voce apre il suo storico: quello della terapia (D65) o uno nuovo per AIC, principio o nome. La regola di corrispondenza è una sola, per lo storico e per l'elenco: il numero di ricette di una voce è quello che il suo storico mostra, e una prova lo controlla voce per voce. Le terapie riservate, e le loro righe, le vede solo chi può (come nello storico).
- **Colori**, sempre con la parola accanto e mai al suo posto. Lo sfondo tenue della riga, con una barra a sinistra nello stesso colore pieno, dice come si prende il farmaco:
  - **cronica: azzurro**, la continuità; è il blu di SCRIPT, il colore della struttura;
  - **ciclo con data di fine: verde**, un percorso che si chiude;
  - **al bisogno: giallo**, il più leggero, per l'uso saltuario. È più chiaro dell'evidenziatore e non ha mai il bordo scuro delle selezioni (D69).

  La tipologia sulla ricetta ha un'etichetta **viola**: «S · suggerita dallo specialista» o «H · da ricovero». Il viola vuol dire «proposta da un altro medico». Sfondo ed etichetta stanno insieme, senza regole di precedenza: una terapia cronica suggerita dallo specialista ha lo sfondo azzurro e l'etichetta S. **Senza colore**: non in corso (sospesa, conclusa, o prescritta senza terapia). Contrasti provati sui token (testo ≥ 4,5:1 su ogni tinta, barre ≥ 3:1).

- **Legenda**: piccola, uguale per ogni paziente, sempre in testa all'elenco dei farmaci (nella cartella subito sotto «Terapia in corso», nella pagina dei farmaci sotto la testata).
- **Visite ed esami prescritti** (menu della cartella e pagina propria): due gruppi, «Visite» ed «Esami e altre prestazioni». È una visita la prestazione la cui descrizione comincia con «VISITA», «PRIMA VISITA» o «TELEVISITA», oppure nomina la visita dopo un trattino. La regola è verificata il 18/11/2026 su tre elenchi interi, senza eccezioni:
  - catalogo regionale della D.D. 868/2024: 349 visite;
  - catalogo regionale della D.D. 990/2024: 356 visite. Le uniche due che non cominciano con «VISITA» sono le rivalutazioni al centro demenze, 8901.85 e 9412.85;
  - nomenclatore nazionale, allegato 4 del DPCM LEA, PDF del Ministero in 5 parti scaricato da Simone: 61 visite su 2113 prestazioni.

  Cercare la parola in qualunque punto della descrizione non basta: il nomenclatore la usa nelle note. Esempi: «ELETTROCARDIOGRAMMA. Non associabile a Prima visita cardiologica», «Incluso: Visita anestesiologica» negli interventi, e la spiegazione della consulenza genetica. Consulti, colloqui e valutazioni non sono chiamati visite dalle fonti e stanno tra gli esami e le altre prestazioni. A ogni catalogo nuovo il rapporto d'importazione ripete la prova: conta le visite ed elenca le voci che nominano la visita senza esserlo, perché una persona le controlli.

- Il catalogo in vigore dal 30/10/2026 (allegato C della D.D. 710/2026) non è pubblicato con l'atto: la pagina del Bollettino collega solo il testo. Va chiesto o scaricato da Simone (vedi `docs/avanzamento.md`); quando entrerà, il rapporto rifarà la prova.

**D153 · Ricerca delle prestazioni per parole chiave, per tutti gli esami.** Simone: scrivendo «rachide» si devono trovare tutte le prestazioni che lo coinvolgono; lo stesso per gli esami, «potassio, oppure K», «glicemia o glucosio»; le varianti con codici regionali diversi devono comparire; si cerca anche iniziando a scrivere il codice. Regole generali, non un elenco di casi:

- **Parole**: tutte le parole della domanda, in qualunque ordine, ognuna all'inizio di una parola della descrizione. Non contano maiuscole, accenti e segni. Le parole di una o due lettere (K, RX, TC) valgono solo intere. «rachide» non trova «ARACHIDE». «lombo sacrale», «lombo-sacrale» e «lombosacrale» si trovano a vicenda. La branca trova la prestazione, ma conta meno.
- **Codici**: l'inizio del codice del catalogo o del nomenclatore («codice DM»), con o senza punti, anche quando comincia con una lettera (G9.01). Il codice vale più delle parole.
- **Varianti**: le voci con lo stesso codice del nomenclatore restano vicine, per esempio le sei del glucosio, 90.27.1. Prima viene la voce che comincia con la parola cercata («glicemia» dà il glucosio prima delle dialisi «con soluzioni di glucosio»); a parità di punti, il gruppo con la descrizione più corta.
- **Materiali**: la sigla tra quadre in fondo alla descrizione si mostra per esteso e si può cercare («glucosio urine» trova [U] e [DU]):
  - S siero/sangue, P plasma, U urine e DU urine 24 ore vengono da Simone;
  - (SG)ER eritrociti, SG e (SG) sangue, SA saliva e LA liquido amniotico vengono da un elenco regionale campano, letto negli estratti di una ricerca. Simone ha chiesto di non scriverlo nell'interfaccia: la fonte resta nei dati e in `docs/provenienze.md`;
  - [ALB] e [F] restano come sono scritte, senza fonte.

  Il DM 22/7/1996, da cui vengono le sigle, dice solo che la parentesi quadra indica «il materiale nel quale si dosa l'analita» (S.O. n. 150, p. 7).

- **Sinonimi** come dati, in `packages/reference/data/ricerca-prestazioni.json`. Ogni gruppo ha un codice d'esempio verificato sul catalogo intero della D.D. 990/2024 e la fonte.
  - **Simboli chimici** degli elementi che compaiono nel catalogo: K, Na, Cl, Ca, Mg, Fe, Li, Ni, Cu, Zn, Cd, Pb. Sono «sigle»: valgono quando il medico le scrive, ma «potassio» non si allarga a ogni parola «K» (le catene K delle immunoglobuline). Esclusi Cr (per molti è la creatinina), Se e Al (sono parole italiane) e Co.
  - **Nomi d'uso**: glicemia e glicosuria per glucosio, azotemia per urea, uricemia e acido urico per urato, sideremia per ferro, natremia, kaliemia, transaminasi.
  - **Sigle che il catalogo non scrive**: HbA1c, INR, PTT, GGT, PCR, TAC, RMN, EEG, MOC e DEXA.
  - **Regola generale per i nomi in «-emia» e «-uria»**: si cerca anche la radice (colesterolemia → colesterolo, proteinuria → proteine), se ha almeno 5 lettere.
- **Provata sul catalogo intero** (4739 voci della D.D. 990/2024): l'indice si costruisce in circa 60 millisecondi e una ricerca dura da 1 a 25. L'indice sta in memoria per ogni versione del catalogo, che dopo l'importazione non cambia (A2).

**D154 · I due codici della specialistica e il codice scritto a mano.** Simone: i codici regionali vanno aggiornati ogni giorno, perché se un codice cambia alcune strutture rifiutano la ricetta; quando l'aggiornamento non c'è ancora, il medico deve poter scrivere il codice a mano, se è consentito. Le specifiche del Sistema TS (prescrizione, 5/12/2024, pp. 28 e 40–42) dicono quattro cose:

- per la specialistica sono obbligatori il codice del nomenclatore (`codProdPrest`, il «codice DM») e quello del catalogo regionale (`codCatalogoPrescr`), coerenti tra loro, più la descrizione del catalogo, che è ciò che vede la struttura;
- il Sistema TS, e prima di lui il SAR, controlla la coppia sul catalogo che la Regione gli ha trasmesso, non sulla copia del programma;
- un codice nuovo scritto a mano viene quindi accettato, se la Regione lo ha già trasmesso;
- la nota libera (`descrTestoLiberoNote`) non sostituisce il codice.

Scelte:

- **La riga conserva entrambi i codici** (migrazione 0017). Scegliendo dal catalogo, il codice del nomenclatore viene dalla voce del catalogo; se la riga non lo porta, il programma lo ricava dal catalogo in uso, quando la prepara e quando la invia. Al SAR arrivano entrambi.
- **R10**, nella versione 2026-11-18.3 delle regole: blocca se manca il codice del nomenclatore, e se quello scritto non è quello del catalogo in uso. Punti e spazi non contano. Le ricette controllate con le versioni precedenti restano com'erano: la regola lo legge da un valore della versione.
- **R18**, regola nuova: avvisa se il codice non è nel catalogo regionale in uso e chiede un motivo, che resta registrato con il controllo. Il controllo finale è del SAR. Tace se nessun catalogo è importato. La numerazione dei requisiti finisce a R17: R18 c'è dalla versione .3.
- **Modulo «scritta a mano»** nella ricetta specialistica: codice del catalogo, codice del nomenclatore (DM) e descrizione come nel catalogo della Regione, con la spiegazione di quando usarlo.
- **Simulatore del SAR**: può avere il «catalogo della Regione» e allora rifiuta le coppie che non conosce, dicendo quale prestazione.

L'aggiornamento quotidiano del catalogo è nell'aggiornamento automatico (attività a parte). In produzione la fonte giusta è il catalogo strutturato del CSI Piemonte, se esiste per le software house: è una domanda per la fermata.

**D155 · L'interfaccia si prova con i tre motori dei browser.** Domanda di Simone: «sarà dunque un programma indipendente in cloud compatibile sia per windows che per apple, giusto?». I requisiti chiedono «browser su PC e tablet, nessuna installazione». Fino a qui la prova nel browser girava solo con Chromium, il motore di Chrome e di Edge (D74). Ora la stessa prova gira anche con WebKit, il motore di Safari su Mac e iPad, e con Firefox: due lavori di CI in più, che scelgono il motore con `E2E_BROWSER` e scrivono la versione del browser. La prova controlla che il motore avviato sia quello chiesto, e un nome sconosciuto la ferma subito. In locale resta Chromium, l'unico installato nella macchina di sviluppo. Non provato: WebKit in CI gira su Linux, quindi non è Safari su un Mac o su un iPad veri; quella prova va fatta sui dispositivi dello studio.

**D156 · Le banche dati si aggiornano da sole ogni notte, con un comando e con un pulsante; la vecchiaia di una versione si misura sul controllo della notte.** Simone: elenchi, moduli e banche dati devono poter essere aggiornati di continuo, «o con un comando o in automatico secondo una cadenza appropriata e/o prevista»; i codici regionali «ogni giorno». I requisiti dicono già «ogni notte, senza interventi manuali» (A1) e chiedono di avvisare quando una versione è «più vecchia del previsto per quella fonte» (A6). Scelte:

- **Un solo giro per tutto**: `sync/`, poi l'importazione con i suoi controlli, poi il registro (`reference_update_run`, migrazione 0018). Lo stesso giro parte dall'orologio di ogni notte, dal comando `pnpm banche-dati:aggiorna` e dal pulsante «Aggiorna adesso». Il pulsante è solo per l'amministratore dello studio: azione nuova `admin.reference_data`, nella matrice dei permessi.
- **Ogni notte tutte le fonti**, all'ora scelta in configurazione (proposta: 03:30). È fuori dall'intervallo che il cambio dell'ora salta o ripete, e l'orologio regge comunque qualunque ora: un'ora ripetuta vale la prima volta, un'ora saltata si sposta dopo il salto. Nessuna cadenza diversa per fonte: A1 vuole tutte le fonti ogni notte, e le richieste condizionate rendono leggero il controllo di una fonte ferma. La cadenza di pubblicazione di ogni fonte resta scritta in `sync/fonti.json` e serve alla soglia d'età.
- **Giro perso**: se il servizio era spento all'ora prevista, il giro parte un minuto dopo l'avvio. **Uno alla volta**: un vincolo del database sul giro «in corso», che vale anche con più istanze. Un giro fermo da più di 6 ore si chiude come interrotto, la stessa durata del lucchetto di `sync/`.
- **`sync/` scrive anche un rapporto JSON** (`ultimo-rapporto.json`, con l'identificativo del giro) e l'ora di ogni controllo riuscito, anche per i file fermi (`controllato_il`). Le ore hanno ora i millisecondi: con i secondi due giri vicini non si distinguevano, e il sabotaggio lo ha mostrato.
- **«Più vecchia del previsto» (A6)** non si misura più solo sull'età del download. Una fonte ferma è aggiornata se stanotte è stata controllata. L'avviso c'è quando:
  - il controllo dell'ultimo giro è fallito;
  - il giro di stanotte manca;
  - una versione più nuova aspetta: trattenuta dai controlli, non importabile, o un PDF da trascrivere. È il caso del catalogo regionale quando esce una determina nuova.

  Accanto alla data, il motivo in parole e l'ora del controllo della fonte.

- **Soglia d'età (`vecchiaDopoGiorni`)**: solo dove la fonte dichiara una cadenza regolare, cioè l'intervallo più lungo dichiarato più una notte. ISTAT dichiara «almeno ogni sei mesi», quindi 185 giorni. Per l'anagrafica AIFA, pubblicata ogni giorno ma a volte uguale, una soglia d'età darebbe avvisi falsi: vale il controllo di ogni notte. Le altre fonti non hanno una cadenza regolare. Sostituisce il «da completare» di D62.
- **Regola 7**: senza `BANCHE_DATI_DIR` il servizio non aggiorna nulla, ed è il caso dello sviluppo e delle prove. Le prove usano il sito d'esempio in locale. In produzione le fonti sono quelle pubbliche di `sync/fonti.json`, scaricate per leggere dati aperti, come chiedono i requisiti.

Non provato: il giro sulle fonti vere (il primo va fatto da un computer dello studio, come dicono i requisiti) e due istanze del servizio insieme. I moduli dei certificati entreranno tra le fonti controllate con i loro atti, alla tappa 13.

**D157 · Gli atti che modificano il catalogo si trascrivono come modifiche.** Simone ha mandato il PDF della D.D. 710/A1400B/2026 (BUR n. 44 del 5/11/2026): testo e allegati A, B, C e D. L'allegato C non è il catalogo intero, sono 69 righe di 3 pagine. Gli allegati sono tre elenchi di voci:

- A: 27 voci prescrivibili fino al 29/10/2026;
- B: 56 voci di radioterapia prescrivibili fino al 12/01/2027;
- C: 69 voci dal 30/10/2026, nuove o al posto di voci di A.

Il catalogo in vigore è quindi il precedente più queste modifiche. Alcuni codici del catalogo cambiano a parità di prestazione: 45.30.1 diventa 45.30.1A, 42.33.1 diventa 42.33.1A, 90324.1 e 90324.2 diventano 90324. È il caso di cui parlava Simone, delle strutture che rifiutano un codice cambiato. Scelte:

- **Trascrizione «solo modifiche»** (`solo_modifiche` nella scheda, colonna `operazione` con `aggiunge` o `toglie`). La versione intera si ricostruisce dalla versione della serie in vigore il giorno prima e si salva come le altre: immutabile, dalla data dell'atto. La consultazione alla data (A5) non cambia. Trascrivere 69 righe invece di più di 3000 rende possibile tenere il catalogo al passo con ogni atto, anche senza il catalogo strutturato.
- **Un atto per data**: per la D.D. 710, A e C dal 30/10/2026, B dal 13/01/2027. Gli atti si applicano per data, dopo le versioni intere.
- **Chiave**: codice del catalogo e branca. Senza branca valgono tutte le righe del codice, e l'allegato A le elenca tutte. Maiuscole, accenti e spazi non contano: nel PDF le branche vanno a capo dentro le celle.
- **Controlli**: senza una versione prima dell'atto non si applica nulla. Una voce da togliere che la base non ha ferma l'atto, perché la base non è quella su cui l'atto è scritto.
- Il PDF resta fuori dal repository. Nelle prove ci sono righe copiate parola per parola dagli allegati A e C, con le pagine; la provenienza è in `docs/provenienze.md`.

Il catalogo vero non è ancora nel programma. L'ultimo catalogo intero letto è quello della D.D. 990/2024, e mancano gli aggiornamenti della D.D. 444/2025 e della D.D. 590/2026. Applicata alla D.D. 990/2024, la D.D. 710 darebbe un catalogo senza le modifiche del 2025 e del 2026. Serve il catalogo strutturato del CSI Piemonte, già domanda della fermata, oppure i PDF delle due determine. La trascrizione della D.D. 710 si prepara appena c'è la base, e una persona la controlla prima dell'uso (A8).

Nel testo dell'atto c'è un'incoerenza: le premesse dicono che l'allegato B vale «sino al 12 gennaio 2026», la parte che determina «sino al 12 gennaio 2027». Vale la parte che determina, ed è coerente con il resto dell'atto.

**D158 · Struttura comune dei modelli e i primi due modelli ufficiali.** Simone: «la struttura e i font dei modelli deve essere standardizzato. Poi modificabile, ma comunque con una formattazione iniziale standard fra tutti». Scelte:

- **Una struttura per tutti i modelli**, ufficiali e dello studio:
  - intestazione del medico;
  - titolo;
  - riferimento normativo, sotto il titolo. Per i modelli ufficiali, per difetto, è l'atto della fonte con la pubblicazione;
  - testo;
  - luogo e data;
  - firme: il medico a destra con il timbro, le altre firme a sinistra;
  - note in fondo, in corpo più piccolo, come nei moduli cartacei.

  Caratteri e dimensioni restano quelli dell'impaginazione del medico (D145). La riga di luogo e data non si ripete se il testo li scrive già.

- **Pagine**: un paragrafo che sta in una pagina non si spezza. L'ultimo paragrafo, la dichiarazione finale, resta sulla pagina di luogo, data e firme. Le note restano insieme. Una prova stampa testi da 15 a 45 righe e controlla ogni volta che la dichiarazione finale sia con le firme.
- **Caselle**: una scelta con `boxes` si stampa come nel modello cartaceo, «[X] No [ ] Pregressa [ ] In atto». Sullo schermo è una riga di pulsanti. Il testo del modello resta quello dell'atto; cambia solo come si segna la scelta.
- **Le parti restano con il certificato** (migrazione 0019): riferimento, note, luogo e data e altre firme si conservano al rilascio come il testo. La ristampa è identica anche se il modello cambia.
- **Modelli ufficiali**, dal testo degli atti confrontato con le immagini della Gazzetta:
  - sportivo non agonistico: allegato 2 del DM 8/8/2014, valido un anno. La frase dell'atto «Luogo, data, timbro e firma del medico certificatore.» sta sotto la firma;
  - porto d'armi: allegato 1 del DM 28/4/1998, con le firme del dichiarante e del medico e con le note dell'atto. È valido tre mesi, perché l'atto lo vuole «di data non anteriore a tre mesi». Accenti e «Post-operatorie» come nella scansione; il refuso «sostenze» dell'atto resta.

  «Unità sanitaria locale n.», «Regione» e «Numero tesserino assistito» sono voci del 1998. Restano come nell'atto, compilate dal medico; il tesserino è facoltativo, finché non si conferma con l'ASL che cosa scrivere oggi.

- **Anamnestico per la patente**: nessun modello nazionale. L'art. 119, comma 3, del Codice della strada chiede solo che la certificazione tenga conto dei «precedenti morbosi del richiedente dichiarati da un certificato medico rilasciato da un medico di fiducia». Il modello proposto seguirà la struttura dei PDF mandati da Simone, con un testo nostro da far controllare a Chiara. Quei PDF però non sono più in questa sessione: servono di nuovo, oppure il modulo che usa Chiara.

**D159 · Il catalogo regionale in vigore, trascritto dai PDF e da controllare.** Simone ha mandato il PDF della D.D. 590/A1400B/2026 del 20/9/2026 (BU n. 38 del 24/09/2026) in tre parti: testo, allegato A intero (il catalogo, 194 pagine) e allegato B. Il catalogo vale per le ricette prescritte dal 21/09/2026. Scelte:

- **Base e modifiche.** L'allegato A della D.D. 590 è la versione intera dal 21/09/2026. Sopra, la D.D. 710/2026 come modifiche (D157): allegati A e C dal 30/10/2026, allegato B dal 13/01/2027. Il programma ricostruisce le tre versioni: 5107, 5149 e 5093 voci. La D.D. 444/2025 non serve più, perché la D.D. 590 ripubblica il catalogo intero.
- **Estratto in automatico, entra in uso solo dopo il controllo di una persona (A8).** Una scheda con `controllato_da: null` è «da controllare»: non si importa e ogni importazione la segnala tra le cose da guardare a mano. Così il lavoro fatto resta nel programma e si vede, ma non si usa prima del controllo.
- **Le trascrizioni stanno nel programma**, in `packages/reference/data/trascrizioni/`: è la cartella per difetto dell'importazione e dell'aggiornamento di ogni notte. `BANCHE_DATI_TRASCRIZIONI` e `--trascrizioni` la sostituiscono.
- **Differenze dal PDF**, tutte elencate in `docs/catalogo-regionale.md`:
  - le 2 voci non prescrivibili restano fuori (90418.1 e 90418.2, test reflex del TSH);
  - 7 righe ripetute identiche nell'atto, anche nella D.D. 990/2024, ci sono una volta sola;
  - 26 descrizioni e 16 note sono tagliate nel PDF, al bordo della cella. Sono completate con il testo della stessa voce, per codice e branca, nella D.D. 990/2024. È il testo di un altro atto ufficiale, non un testo ricostruito: in tutte le altre voci in comune le descrizioni dei due atti sono uguali;
  - una parola che va a capo dopo il trattino si riunisce come la stessa parola dentro una riga, nei tre atti. Senza nessuna prova, si riunisce senza spazio, come quasi tutti i trattini dentro le righe;
  - nella D.D. 710 le branche spezzate nella cella si scrivono come nel catalogo.
- **Controlli all'importazione.** Il rapporto rifà la prova della regola delle visite (D152): 348 visite su 5107 voci. La voce 11.99.2 nomina le visite di controllo senza essere una visita, e resta da guardare.
- **Fonte strutturata.** Il PDF dell'allegato A è stampato da un file Excel della Regione («Allegato A_Catalogo Ambulatoriale_092026_ALL.xlsx», scritto in testa a ogni pagina). Con quel file, o con il catalogo strutturato del CSI Piemonte, il confronto si fa da programma, riga per riga. È una domanda per la fermata, insieme a chi controlla la trascrizione.

Non provato: il catalogo vero nelle schermate e nelle ricette, perché non è ancora controllato. Le prove usano copie delle schede con un nome di prova in `controllato_da`.

**D160 · Modelli proposti: il certificato anamnestico per la patente.** Per la patente non c'è un modello ufficiale, né nazionale né della Regione Piemonte (art. 119, comma 3, del Codice della strada: il certificato del medico di fiducia, senza modello). Simone: «per l'anamnestico patente prendi comunque spunto dai pdf allegati». Come previsto in D143, il testo lo scriviamo noi dai requisiti di legge e lo segniamo da verificare. Scelte:

- **Un terzo tipo di modello, «proposto».** Sta con gli ufficiali in `apps/api/modelli/`, con `"official": false` e `proposal`, cioè che cosa resta da verificare. Ha la base di legge come fonte. Il catalogo vuole o l'uno o l'altro; il dominio controlla fonte e nota. Nell'interfaccia si vede come «modello proposto, da verificare»; il certificato rilasciato è un «modello proposto».
- **Gruppi di malattie dalla legge**: allegato III del D.Lgs. 59/2011 (vista, cardiovascolari, diabete, epilessia, alcol, sostanze e medicinali, turbe psichiche, malattie neurologiche e apnee nel sonno), artt. 321–323 del DPR 495/1992 (arti, vista, udito). Le «altre malattie» dell'appendice II all'art. 320 (per esempio endocrine, del sangue, renali) sono una voce sola: l'appendice non è stata letta.
- **Struttura dai moduli in uso**: un gruppo per riga con «No/Sì» e le note, da quanto tempo il medico ha in cura la persona, la dichiarazione dell'interessato, le due firme. Il testo è nostro; dei moduli non si copia nulla.
- **Niente giudizio di idoneità.** Uno dei moduli chiede al medico «compatibile/incompatibile con la guida». Il certificato riporta l'anamnesi; il giudizio spetta al medico accertatore o alla Commissione medica locale, e la nota stampata lo dice.
- **Validità tre mesi**, dalla scheda del Ministero della Salute («in data non anteriore ai tre mesi precedenti»), che dice anche che serve solo per il primo rilascio e il primo rinnovo.

Da verificare con la Dr.ssa Rocca prima dell'uso: il testo, i gruppi e le «altre malattie». È una domanda per la fermata, insieme ai moduli che usa oggi.

**D161 · Condivisione del riepilogo tra i medici dell'AFT che usano il programma (tappa 12).** Tra chi usa il nostro programma, la condivisione della medicina di gruppo si estende all'AFT (D104, D110), con le regole del dossier sanitario: il medico curante decide, il paziente consente, si vede il minimo, ogni accesso resta registrato. Scelte:

- **AFT nel programma.** Un medico titolare la crea; i colleghi entrano su invito, con il loro codice regionale, e solo accettando. Un medico sta in una sola AFT alla volta. Chi esce resta nella storia con la data d'uscita: AFT e membri non si cancellano e ogni modifica va nello storico (migrazione 0020).
- **Il titolare decide.** Per difetto non condivide. Attiva la condivisione dei suoi pazienti nell'AFT, e la spegne quando vuole; uscendo dall'AFT la spegne subito.
- **Il paziente decide.** Consenso a parte, specifico, «Condivisione del riepilogo con i medici dell'AFT», registrato in cartella come gli altri; revocabile, con effetto immediato.
- **Il minimo.** Il collega vede solo il riepilogo: allergie e reazioni, problemi, terapie in corso, ultimi parametri, ognuno con il suo stato clinico. Viene dalla composizione del Profilo sanitario (tappa 11), che lascia fuori le voci oscurate e riservate. Nessun conteggio delle voci escluse: chi consulta non deve capire che il paziente ha oscurato qualcosa. Un avviso fisso dice che il riepilogo può non essere completo e non certifica lo stato di salute (Garante, linee guida sul dossier sanitario del 4/6/2015, par. 5.1).
- **Come si consulta.** Con il codice fiscale e il motivo dell'accesso, almeno 10 caratteri; nessun elenco dei pazienti dei colleghi. Se il riepilogo non c'è, la risposta è la stessa in ogni caso; il motivo preciso va nel registro del medico curante.
- **Registro.** Ogni consultazione, consentita o negata, va nel registro degli accessi del medico curante, con il medico, lo studio, il motivo e l'esito. Il titolare la vede in Strumenti › AFT; è anche nell'esportazione completa.
- **Chi consulta.** Solo i medici titolari. Il sostituto no, per ora: è una domanda per la fermata, come chi può creare un'AFT e se il paziente va avvisato di ogni consultazione.
- **Fonti (lette il 19/11/2026).** D.Lgs. 502/1992, art. 8; D.L. 158/2012, art. 1; ACN 2022-2024, artt. 29 e 43; accordo integrativo del Piemonte (D.G.R. 31-8647/2024), art. 22; Garante, linee guida sul dossier sanitario del 4/6/2015, par. 3, 5.1, 5.2, 6 e 7. Che cosa dice ognuna e come la segue il programma: `docs/aft.md`, «Fonti». Hanno confermato le scelte sopra e ne hanno aggiunte quattro, qui sotto.
- **Dati precedenti al consenso.** Si condividono solo con un secondo consenso, «anche dei dati precedenti al consenso» (Garante, par. 3, «consenso per il pregresso»). Senza, il riepilogo contiene solo le voci dal giorno del consenso, e lo dice. La data di una voce è quella in cartella; per le terapie l'inizio, per i parametri la misura.
- **Attività svolta e registro di AFT.** Il collega che visita il paziente registra tipologia (ambulatorio, domicilio, telefono, televisita, altro), esito, note e ora, alle stesse condizioni della consultazione e mai nel futuro. L'attività va nella tabella `aft_activity` (migrazione 0021: storico, nessuna modifica né cancellazione) e nella cronologia del medico curante, «Collega dell'AFT: …» (accordo integrativo, art. 22, c. 2, 3 e 5; ACN, art. 43, c. 7, lett. b). Il collega non scrive nella cartella del collega.
- **Consultazioni per paziente.** Nella cartella, in «Privacy», il titolare vede chi ha consultato o annotato i dati del paziente, quando e da quale studio, per rispondere alla sua richiesta entro 15 giorni (Garante, par. 5.2). La segreteria no.
- **Motivi comuni.** L'interfaccia propone quattro motivi d'accesso; se ne può sempre scrivere un altro.
- **Non fatto.** Avvisi sugli accessi anomali (Garante, par. 7, lett. c): fatti nella tappa 14 (D177), con le soglie «da completare». Scambio con programmi diversi (accordo integrativo, art. 22, c. 1): condividono solo i medici che usano questo programma. Scheda intera invece del riepilogo (ACN, art. 43, c. 5, lett. h) e prescrizione e certificazione del collega (accordo integrativo, art. 22, c. 2): domande per la fermata.

**D162 · Regola degli hook di React in ESLint.** Nella pagina Privacy un hook chiamato dopo un'uscita anticipata faceva cadere la pagina; l'ha trovato solo la prova nel browser. ESLint ora applica `react-hooks/rules-of-hooks` a `apps/web/src` (pacchetto `eslint-plugin-react-hooks` 7.1.1, MIT, solo per lo sviluppo). Solo questa regola: le altre del pacchetto riguardano il compilatore di React, che il programma non usa. Provata con un sabotaggio.

**D163 · Strumenti: tutte le impostazioni in un posto, per ruolo (tappa 14).** Richiesta di Simone del 19/11/2026: «nel pannello admin o strumenti ci devono essere tutte le varie opzioni di configurazione e impostazioni del programma». Strumenti ha una scheda per area e ognuno vede le sue: l'amministratore studio, utenti, postazioni e stampa, elenchi, modelli, Fascicolo, banche dati, registro di amministrazione, stato del servizio; il medico dati dello studio (in lettura), postazioni e stampa, elenchi, modelli, impaginazione, Fascicolo, banche dati; il titolare anche AFT, importazione e registro. Chi può modificare lo decide il servizio, non la scheda. Ogni azione di amministrazione va nel registro degli accessi come «amministrazione», con area, azione e nomi dei campi (mai password o segreti), anche quando è negata; il registro di amministrazione lo leggono l'amministratore e i titolari, perché un ruolo dato da un amministratore apre le cartelle. Azioni nuove nella matrice: `admin.studio`, `archive.grants`, `studio.lists`, `studio.admin_log`. Restano fuori dal pannello, per scelta: le regole di prescrizione (D41, D47), i testi dei modelli ufficiali (D144), le mappature e le soglie di vecchiaia delle banche dati (D156), i valori fissi del Fascicolo (D133), i segreti del servizio (regola 7), le credenziali dei medici (D100) e il registro, che non si modifica (D23).

**D164 · Utenti e ruoli dall'amministratore (tappa 14).** L'amministratore crea gli utenti (nome utente, nome, email, uno o più ruoli, dati del medico) con una password temporanea mostrata una volta e da cambiare al primo accesso; li modifica, li sospende e li riattiva, li sblocca (dalla D179 medici e segreteria li sblocca solo il server, e la loro password la riceve il titolare che li conferma). Regole, ognuna con prova e sabotaggio: permesso `admin.users` controllato nella rotta prima della validazione e di nuovo nel servizio; nessuno cambia i propri ruoli e nessuna azione vale su sé stessi; l'ultimo amministratore attivo non si toglie, anche con due richieste insieme (righe bloccate per la transazione); il ruolo di titolare crea l'archivio «Archivio di Nome Cognome» e la riga del medico; togliere un ruolo non cancella nulla e la risposta dice che cosa resta. Nome utente da 3 a 64 caratteri fra minuscole, cifre, punto, trattino e trattino basso, unico in tutto il programma (indice esistente); codice fiscale e codice regionale del medico unici nello studio. L'amministratore cambia anche nome, cognome e codice fiscale del medico (domanda per la fermata). I limiti dei poteri dell'amministratore sull'accesso clinico sono in D179.

**D165 · Password (tappa 14).** Da 12 a 128 caratteri dopo la normalizzazione NFC, diversa dall'attuale e dal nome utente; nessuna regola di composizione e nessuna scadenza. Sono valori di sicurezza scelti qui, senza una fonte letta (né AgID né NIST né il Garante): domanda per la fermata. Gli errori sulla password attuale contano come tentativi falliti con le soglie dello studio (D29) e un utente bloccato riceve 429; il cambio chiude le altre sessioni dell'utente; il cambio non risponde mai 401, che nell'interfaccia vuol dire «sessione finita». Con la password temporanea, dopo password e secondo fattore si apre solo la pagina del cambio: ogni altra rotta risponde 403. La password temporanea non scade (valore da completare).

**D166 · Dati e impostazioni dello studio dal pannello (tappa 14).** Nome, tipo, regione, indirizzo completo (via e civico, CAP, comune, provincia), telefono, email, PEC, intestazione dello studio (fino a 6 righe), sicurezza dell'accesso (D29), tempo di attesa degli invii (D94), soglie degli avvisi sugli accessi anomali. Si salvano per gruppi interi, ognuno con il suo permesso (`admin.studio`; l'intestazione anche `admin.headers`); nel registro i campi cambiati con prima e dopo, niente se nulla cambia. La regione è obbligatoria (senza, nessuna ricetta SSN parte: D95), in maiuscolo e senza la parola «REGIONE», che il promemoria stampa già. «Medico singolo» solo con al più un titolare attivo. Limiti di buon senso, non da norme, per fermare gli errori di battitura: inattività da 1 a 30 minuti, tentativi da 3 a 10, blocco da 5 a 60 minuti (prima 1440: D179), attesa da 1 a 60 secondi con un avviso fuori dai 6–8 della Regione. Il tempo di attesa si legge dallo studio a ogni chiamata (ricette all'invio; certificati all'invio, alla rettifica e all'annullamento, D105); sulla copia INPS il luogo della visita in studio è l'indirizzo completo, a capo se lungo (D106); nei certificati dai modelli vale l'intestazione dello studio quando il medico non ha la sua (D145). Postazioni con nome unico fra le attive, archiviate e mai cancellate. Stato del servizio in sola lettura: collegamenti simulati con l'ultimo uso, durata della sessione, aggiornamento delle banche dati, e l'avviso che i salvataggi non li fa il programma (domanda per la fermata: i requisiti mettono i backup cifrati nella versione 1).

**D167 · Primo avvio di uno studio vero con un comando (tappa 14).** Fuori dal seed dimostrativo nessuno poteva creare uno studio. `pnpm studio:crea -- --nome … --tipo singolo|gruppo --regione … --amministratore … --nome-amministratore …` applica le migrazioni, crea lo studio e il primo amministratore (solo amministratore, senza accesso clinico) con una password temporanea mostrata una volta; poi l'amministratore crea gli altri utenti dagli Strumenti. Il primo medico titolare resta in attesa e lo conferma il server, con `pnpm utente:ripristina` (D179): nello studio non c'è ancora un titolare che possa farlo. In uno studio con un solo medico servono due utenti, l'amministratore e il medico, perché nessuno cambia i propri ruoli; al medico confermato l'amministratore può poi aggiungere il ruolo di amministratore. Messaggi di controllo in italiano. La regione si chiede sempre: niente valore per difetto.

**D168 · Database di prova: la pulizia non tocca i giri in corso.** Ogni avvio di Vitest cancellava con FORCE tutti i database `mmg_test_` della macchina: con più giri insieme (più sessioni o più agenti sullo stesso Postgres) uno distruggeva i database dell'altro, e due sezioni della tappa 14 lo hanno visto. Ora il nome porta l'istante di creazione (`mmg_test_<istante in base 36>_<8 cifre>`) e si cancellano solo i database di prova vecchi di oltre 6 ore e senza connessioni, senza FORCE.

**D169 · Pannello amministrativo del paziente (tappa 15).** Richiesta di Simone: «pannello amministrazione del paziente», destinazione anche dell'importazione. Nuovo paziente: il titolare nel suo archivio, la segreteria scegliendo l'archivio, il sostituto solo con un'autorizzazione attiva; l'amministratore no. Il codice fiscale si controlla nella struttura e nel carattere di controllo e si spiega il problema; la coerenza con nome, cognome, sesso, data e luogo di nascita è un avviso, non un blocco, perché esiste l'omocodia (decodificata nel confronto). Codice fiscale già nello studio: 409, con il nome solo a chi vede l'altro paziente. Dati amministrativi completi (residenza e recapiti con il CAP, dati SSN, stato e decesso, stranieri, lavoro, canale del promemoria per R15), salvati campo per campo con gli stessi controlli dell'importazione (`packages/domain/src/patient-registry.ts`). Esenzioni (lo stesso codice in periodi sovrapposti: 409; le righe di AURA non si toccano), scelta del medico fra i titolari attivi dello studio, senza periodi sovrapposti, con cessazione datata e motivata; nucleo familiare, di cui chi legge vede solo i componenti che può vedere, senza conteggi (come in D161). L'identità si corregge con un motivo di almeno 10 caratteri, nel registro e nello storico: **supera in parte D86**, che la lasciava fuori dalla cartella in attesa di AURA, perché senza AURA un errore di trascrizione non si poteva correggere. Ogni modifica ha due righe di registro: l'accesso della guardia e, se qualcosa cambia, i campi cambiati.

**D170 · Ambiente dell'installazione: «prova» o «produzione».** Variabile `APP_AMBIENTE`, per difetto «prova»; un valore diverso da «produzione» o «prova» ferma l'avvio invece di essere indovinato. In «prova» il programma accetta solo pazienti inventati dove può controllarlo (regola 1, D12: codice fiscale con la X in dodicesima posizione, per l'importazione) e il seed dimostrativo è ammesso; in «produzione» il seed dimostrativo non parte. Lo stato del servizio mostra l'ambiente. Prova e sabotaggio.

**D171 · Causa del decesso: dato clinico.** Dalla revisione del piano: la causa del decesso, in ICD-9-CM, stava fra i dati amministrativi, che la segreteria legge. È un dato clinico: nei dati amministrativi la vede solo chi legge il riepilogo clinico dell'archivio (il medico, o la segreteria se il titolare glielo consente, D30) e la scrive solo chi scrive voci cliniche; agli altri la risposta dice soltanto che c'è un dato riservato al medico. Stato e data del decesso restano amministrativi. Prove e due sabotaggi.

**D172 · Formule nel CSV dell'esportazione.** Dalla revisione del piano: ora nella cartella entrano anche testi da file di altri programmi, e un testo che comincia con `=`, `+`, `-` o `@` (o con una tabulazione o un ritorno a capo), aperto in un foglio di calcolo, diventa una formula (OWASP, «CSV injection»). Nel CSV quei testi ricevono un apostrofo davanti; i numeri veri restano numeri; nell'esportazione in JSON il testo è com'è, e il LEGGIMI dello ZIP lo dice. Prova e sabotaggio.

**D173 · Importazione da altri programmi (tappa 15).** Richiesta di Simone del 19/11/2026. In Strumenti › Importazione, del solo titolare sul suo archivio (`data.import`, come `data.export`: i dati sono suoi, D21); i profili d'importazione sono condivisi fra i titolari dello studio. Il programma d'origine non si nomina e non si analizza (regola 2, D142, D147): il medico costruisce la mappatura sul suo file. Scelte, con prove e sabotaggi (`docs/importazione.md`):

- **File non fidati.** Tipo dal contenuto; lettori rigorosi accanto a quelli di sync, che restano com'erano (CSV con il separatore contato fuori dalle virgolette, errori per virgolette non chiuse e campi in più; XLSX con l'indice dello ZIP letto da noi e dimensioni e CRC controllati; JSON senza chiavi pericolose); tetti come costanti nominate, scelte d'ingegneria da rivedere con file veri. Il file non si conserva: le tabelle lette restano in memoria un'ora, nel database solo nome, impronta e dimensione.
- **Smistamento.** Per foglio e per valore di una colonna, verso 14 destinazioni (anagrafica e dati amministrativi, esenzioni, problemi, allergie, diario, anamnesi, stili di vita, esame obiettivo, capacità motoria, parametri, vaccinazioni, esami di laboratorio, terapie, ricette fatte con altri programmi), con trasformazioni chiuse e senza espressioni dell'utente.
- **Stessi controlli dell'inserimento a mano.** Una voce senza data non entra e non prende la data dell'importazione (D161). Per ora un campo facoltativo non valido scarta la riga intera (domanda per la fermata).
- **Abbinamento e doppioni.** Per codice fiscale nell'archivio del titolare; un paziente già presente si completa solo nei campi vuoti, con le differenze come avvisi senza valori; un paziente di un altro archivio non si tocca e il tentativo va nel suo registro. Provenienza di ogni riga scritta, con la chiave d'origine come impronta: la seconda importazione dello stesso file non duplica.
- **Prova e scrittura.** Prima la prova senza scrivere, poi la scrittura con la stessa mappatura e lo stesso piano, altrimenti 409; un'importazione alla volta per archivio.
- **Annullamento** con motivo, solo per voci cliniche e ricette passate non modificate dopo; pazienti, esenzioni e terapie non ancora (manca lo stato «annullato»).
- **Regola 1:** in prova solo pazienti inventati (D170).
- **Terapie già in cartella** (dalla revisione del piano): una terapia in corso o sospesa con lo stesso farmaco di una già in cartella non ne crea una seconda; la riga si scarta con il motivo. Lo stesso AIC, o senza AIC lo stesso nome; le concluse entrano, sono storia.
- **Date con l'ora** (dalla revisione del piano): con il fuso indicato (Z o +hh:mm) vale il giorno italiano, perché un orario in UTC vicino alla mezzanotte cade nel giorno dopo; senza fuso vale il giorno scritto e l'ora si lascia, perché le voci hanno il giorno.

**D174 · Importazione della scelta del medico e del nucleo familiare.** Le due voci del pannello amministrativo che mancavano all'importazione (richiesta di Simone: i dati vanno anche al «pannello amministrazione del paziente»). Stessi controlli del pannello: il periodo della scelta e la sua coerenza sono schemi comuni di `@mmg/domain` (`doctorChoicePeriodSchema`, `doctorChoiceIssues`, `choiceValidity`). La scelta importata è sempre del titolare che importa: il programma conosce solo i medici dello studio e l'importazione è sua, sul suo archivio; le scelte di altri medici non si importano. Una scelta in un periodo già coperto da un'altra si scarta con il motivo, senza date nel rapporto (controllo nuovo del motore: una voce si può scartare per quello che c'è già in cartella). Nucleo: le righe con lo stesso valore vanno nello stesso nucleo, anche in importazioni diverse, grazie alla provenienza del nucleo (un'impronta del valore, mai il valore in chiaro); l'etichetta è quella del file o il valore stesso, nessun nome inventato; un paziente già in un altro nucleo resta nel suo. Scelte e nuclei non si annullano ancora da Strumenti, come pazienti, esenzioni e terapie. Prove e quattro sabotaggi.

**D175 · Elenchi dello studio (tappa 14).** Suggeritori, posologie, pacchetti di prestazioni e contatti utili, comuni allo studio (`docs/amministrazione.md`). Li scrivono titolare, sostituto e amministratore (`studio.lists`); li leggono tutti. Aggiornata da D181: il sostituto solo con un'autorizzazione attiva su un archivio dello studio. Scelte: la posologia ha il testo obbligatorio e le parti facoltative (dose, unità, frequenza, momento, via), perché la scheda della terapia ha quelle parti (D80) e il contatore R11 le usa, mentre leggere le parti dal testo libero sarebbe fragile; un pacchetto si compone solo dal catalogo regionale in vigore, con la sua descrizione, e una prestazione uscita resta finché non si toglie ma non entra più in ricetta; doppioni fra le voci attive; limiti di lunghezza come controlli di buon senso, non valori di una norma (al più 30 prestazioni per pacchetto); nessuna cancellazione, solo l'archiviazione. In più, integrando: la segreteria vede in Strumenti la sola scheda degli elenchi, in sola lettura, perché prepara le ricette con pacchetti e posologie e usa i contatti (aggiorna D146); gli elenchi entrano nell'esportazione completa, anche le voci archiviate (regola 4); dati dimostrativi nel seed, controllati come quelli scritti a mano, senza pacchetto (il seed non importa il catalogo). Prove, 36 sabotaggi.

**D176 · Vaccinazioni, esami di laboratorio, ricette fatte con altri programmi, terapie concluse (tappa 15).** I menu che mancavano perché l'importazione avesse dove mettere i dati (richiesta di Simone: «se qualcosa … non era prevista … devi ovviamente prevederla»); si scrivono anche a mano. Scelte:

- **Vaccinazioni:** voce clinica nuova (vaccino, lotto, dose da 1 a 99, campagna; la data è quella della somministrazione, il promemoria per la dose successiva). Il vaccino ha un nome libero: l'elenco ufficiale dei vaccini non è tra le banche dati (fonte da individuare).
- **Esami di laboratorio:** voce clinica nuova (esame, valore come testo, unità, intervallo come minimo e massimo oppure come il testo del referto, codice della prestazione facoltativo); un referto con più esami si scrive in una volta sola, in una transazione. Solo controlli formali sull'intervallo (gli estremi sono numeri, il minimo non supera il massimo); il valore non si confronta mai con l'intervallo (regola 3, D71).
- **Ricette fatte con altri programmi:** storico a sola lettura, in «Farmaci prescritti» e in «Visite ed esami prescritti» con il segno «Con un altro programma», nello storico di ogni voce e nella cronologia (tipo a sé). Contate a parte: i conti delle nostre ricette non cambiano. Non entrano mai nella macchina degli stati delle ricette. Le scrive e le annulla il medico, con un motivo; non si cancellano. Da una ricetta passata con un AIC in vigore oggi si apre «Nuova terapia da questo farmaco», con i dati del farmaco di oggi e senza copiare la posologia. Alla segreteria si nascondono quelle con lo stesso farmaco di una terapia riservata (la tabella non ha la colonna «riservata»: domanda per la fermata).
- **Terapie concluse:** lo stato «conclusa» ora si raggiunge, da una terapia in corso o sospesa con la data di fine (non nel futuro, non prima dell'inizio), oppure registrando una terapia già conclusa. Una conclusa non si sospende, non si riprende e non si ripete. Sospesa e conclusa non si confondono: la sospesa si riprende e tiene il motivo. Nei prescritti la parola è «Conclusa» (prima «Terminata»).
- **Integrando:** l'importazione scrive vaccinazioni, esami e ricette passate con gli stessi inserimenti a mano (`newEntryBody` e `insertEntry`, `newHistoricalBody`, `historicalIssues` e `insertHistorical`), e le terapie concluse con lo stesso controllo della scheda; i suoi controlli propri sono tolti. Il modulo del referto mette il nome dell'esame davanti al motivo: nel rapporto dell'importazione si toglie, perché lì non va nessun valore del file (D173). Una riga di farmaco con i campi di una prestazione, o il contrario, si scarta come errore di smistamento.

Prove, 42 sabotaggi.

**D177 · Autorizzazioni sull'archivio, registro di amministrazione, avvisi sugli accessi anomali, dati dell'AFT (tappa 14).** Scelte (`docs/amministrazione.md`):

- **Autorizzazioni** dal titolare, nell'Archivio: sostituzione a chi ha il ruolo di sostituto, medicina di gruppo agli altri titolari e solo in uno studio di gruppo (D18); mai a sé stessi né a utenti sospesi. Periodo a giorni interi in ora italiana, dal giorno di oggi in avanti (un'autorizzazione retroattiva farebbe sembrare autorizzati accessi già avvenuti), nessuna durata massima (domanda per la fermata); motivo da 10 a 300 caratteri. La revoca chiude subito, solo le attive e le future; nulla si cancella. Nel registro medico, tipo e periodo, mai il motivo (testo libero, e il registro non si cancella); ogni rifiuto con la regola.
- **Avvisi sugli accessi anomali** (Garante, linee guida sul dossier sanitario, par. 7, lett. c), calcolati dal registro con le soglie dello studio: cartelle diverse aperte da un utente in un giorno (anche tentativi negati, non le consultazioni dell'AFT), accessi nella fascia oraria (anche oltre la mezzanotte, per giorno del calendario), consultazioni dell'AFT di un collega in un giorno. Si supera con «più di N». Le righe dell'importazione (una per paziente toccato) non contano né fra le cartelle né nella fascia: sono un'operazione massiva del titolare, già nella storia delle importazioni (dalla revisione del piano). Soglie vuote: avviso spento e «da completare»; non valide: spente e segnalate. Contano anche gli accessi del titolare, segnati «tu» (così si vedrebbe chi usa le sue credenziali): domanda per la fermata. Li legge solo il titolare, e ogni lettura è registrata.
- **Registro di amministrazione** in Strumenti, per i titolari e l'amministratore: le azioni di amministrazione dello studio in parole, a pagine, con i nomi dei campi cambiati e mai i valori, mai dati dei pazienti. Integrando: la consultazione e la modifica di «che cosa vede la segreteria» ora si distinguono, la modifica con i campi; dalla revisione del piano, in medicina di gruppo un titolare vede le azioni sullo studio e sugli utenti e quelle sul suo archivio e sulle sue AFT, non le autorizzazioni e le impostazioni degli archivi dei colleghi (l'amministratore vede tutto lo studio).
- **Dati dell'AFT** (nome, ASL, codice) li cambia un medico titolare che ne fa parte; nel registro i campi, nello storico della tabella i valori di prima.
- **Integrando:** autorizzazioni dimostrative nel seed (in corso, scaduta, revocata); le autorizzazioni dell'archivio, anche scadute e revocate, entrano nell'esportazione completa (regola 5: il titolare porta con sé chi ha potuto lavorare sul suo archivio). Aggiorna D161: gli avvisi non sono più «non fatti».

Prove, 35 sabotaggi.

**D178 · La postazione si ricorda nel browser.** Dalla revisione del piano: la postazione si scriveva a ogni accesso e il campo proponeva sempre «Studio», quindi quasi tutti gli accessi risultavano dalla stessa postazione e le preferenze di stampa per postazione non sarebbero servite. Dopo una password giusta il browser ricorda il nome (memoria persistente del browser, l'unica eccezione alla memoria della scheda che si svuota all'uscita): descrive il computer o il tablet, non una persona né un paziente. Con una password sbagliata non si ricorda nulla. Scegliere la postazione da un elenco prima dell'accesso direbbe a chiunque i nomi delle postazioni dello studio: non si fa. Che cosa debba fare il segno «condivisa» delle postazioni (per esempio il blocco per inattività solo lì) è una domanda per la fermata. Prova e due sabotaggi.

**D179 · L'amministratore non si prende l'accesso clinico (tappa 14).** Requisiti, «Utenti e ruoli»: l'amministratore non ha accesso clinico, a meno che non sia anche medico. Ma chi crea gli utenti e ne gestisce le credenziali potrebbe creare un medico o una segreteria, o ripristinarne la password, ed entrare al suo posto. Scelte di chi coordina, poi corrette in tre giri, ognuno seguito da una revisione avversaria con prove d'attacco (la prima: 13 problemi; la seconda: 3 punti ancora aperti e 3 problemi nuovi; la terza, con due revisori indipendenti, concorrenza e autorizzazioni: 4 problemi medi e 10 bassi). In `docs/amministrazione.md`:

- **Conferma di un titolare.** Chi ha un ruolo che apre dati dei pazienti (titolare, sostituto, segreteria), creato dall'amministratore o a cui l'amministratore aggiunge uno di quei ruoli, resta «in attesa di conferma» e non entra finché un medico titolare attivo e confermato dello studio non lo conferma, in Strumenti › Utenti da confermare (colonna esplicita, falsa per gli utenti di prima, per il seed e per le prove). La password temporanea la riceve il titolare che conferma, una volta sola, da consegnare di persona, e il secondo fattore si azzera: se la conoscesse l'amministratore, dopo la conferma potrebbe fare lui il primo accesso. Chi aveva già ruoli clinici rientra con le sue credenziali. Si conferma solo la richiesta letta (se l'amministratore cambia l'utente nel frattempo, 409 e l'elenco si rilegge); chi conferma si ricontrolla nel database, sotto il blocco della riga dello studio. Il rifiuto sospende l'utente, che resta in attesa; una riattivazione dall'amministratore gli dà una richiesta nuova. Un utente in attesa che resta senza ruoli clinici non è più in attesa.
- **Nessuna eccezione di avvio.** Anche il primo titolare di uno studio nuovo aspetta. Quando nello studio non c'è un titolare attivo e confermato (studio nuovo, titolari tutti sospesi o in attesa), decide chi gestisce il servizio, dal server, in due passi: `pnpm utente:ripristina -- --utente NOME --mostra` stampa la richiesta (ruoli in italiano e con i codici, dati del medico, chi l'ha fatta e la data esatta) senza cambiare nulla, poi `--conferma --richiesta-il DATA` conferma solo quella richiesta, sotto il blocco degli utenti (password temporanea nuova mostrata una volta, secondo fattore azzerato, sessioni chiuse; nel registro «tramite: comando del server»), oppure `--rifiuta`. Con un titolare attivo e confermato il comando rifiuta e rimanda alla conferma dal programma. L'avviso all'amministratore cita i due passi ma non la data: un comando già completo, da lanciare senza leggere, non lo può preparare lui. Dalla prima revisione: l'eccezione per il primo titolare si poteva riaprire e dava all'amministratore la password di un medico (problemi 1, 2 e 13); dalla seconda: la conferma dal server non mostrava che cosa confermava.
- **Testi che il server stampa.** Nomi, dati del medico e testi dello studio non ammettono caratteri di controllo, a capo o invisibili (\p{Cc}, \p{Cf}, separatori di riga): con ESC un nome riscriveva sul terminale la riga dei ruoli di `--mostra`. Quello che fosse già nel database `--mostra` lo stampa visibile come \u{…}. Le note delle postazioni restano libere di andare a capo (terza revisione).
- **Credenziali di medici e segreteria solo dal server**: password temporanea, azzeramento del secondo fattore e sblocco dopo i tentativi falliti (403 con la strada del server); per gli amministratori dal programma. Il comando ha anche `--secondo-fattore`, `--sblocca`, `--sospendi` e `--riattiva`, non sospende l'unico amministratore attivo e non applica migrazioni; una riga di registro per azione. **Chi è sospeso o rifiutato dal server si riattiva solo dal server** (colonna apposita, migrazione 0026), di qualunque ruolo: altrimenti l'amministratore annullava una decisione presa sul server (problema 7). Un medico bloccato aspetta la fine del blocco o il server.
- **Titolari protetti.** L'amministratore non sospende e non toglie il ruolo a un titolare con pazienti (regola 4 e D21: prima l'esportazione, poi chi gestisce il servizio), né all'ultimo titolare attivo e confermato; non aggiunge segreteria o sostituto a un titolare con pazienti, perché l'attesa lo chiuderebbe fuori dal suo archivio; un titolare con pazienti sospeso si riattiva solo dal server. Sospensione, cambio dei ruoli e rifiuto bloccano gli archivi del titolare prima degli utenti dello studio e prima di contarne i pazienti, con un'attesa massima di 2 secondi (poi 409 «scrittura in corso nell'archivio»): così una sospensione dietro un'importazione non ferma gli accessi dello studio (problema 6, problema nuovo 2). Il rifiuto dal programma non sospende un titolare con pazienti: decide il server.
- **Pazienti nuovi solo negli archivi aperti.** Nell'archivio di un titolare sospeso, non più titolare o in attesa di conferma non entrano pazienti, né dal pannello né dall'importazione; si ricontrolla sotto il blocco della riga dell'archivio (FOR KEY SHARE), che aspetta la sospensione o il rifiuto in corso (gara inversa). Quegli archivi non si propongono nel modulo del nuovo paziente, e un titolare in attesa non si sceglie come medico di famiglia (terza revisione).
- **Accesso.** Chi è in attesa è rifiutato solo dopo la password giusta, e le sue sessioni si chiudono. Il codice del secondo fattore si prenota sul passaggio prima di guardarlo, con un solo comando atomico: il passaggio guarda al più tanti codici quanti i tentativi dello studio (5 se lo studio non li fissa), giusti o sbagliati, anche con molte richieste insieme; i tentativi falliti dell'utente si contano in modo atomico e il blocco scatta alla soglia (seconda revisione, punto 5: prima le richieste in parallelo contavano come una). Il passaggio si consuma una volta sola e l'utente si rilegge sotto blocco prima di aprire la sessione; un utente bloccato non entra nemmeno con un passaggio già aperto; lo stesso codice non vale su due passaggi. Un passaggio di attivazione aperto prima non vale dopo l'attivazione, che chiude gli altri (terza revisione). Nel cambio della password l'impronta della password nuova si calcola anche con quella attuale sbagliata: il tempo non dice chi ha indovinato. Il blocco dura al più 60 minuti (prima fino a 1440). Una riga dell'utente occupata oltre 1 secondo dà 503 «servizio occupato», senza contare il tentativo; il gruppo di connessioni aspetta al più 10 secondi, poi 503, invece di fermare anche gli altri studi.
- **Indirizzo nel registro.** Ogni tentativo fallito registra l'indirizzo della richiesta, oltre alla postazione scritta. Dietro un proxy inverso l'indirizzo vero si ha solo indicando il proxy in `APP_PROXY_FIDATI` (indirizzi o reti; vuota per difetto, e allora l'intestazione X-Forwarded-For si ignora); un valore non valido, o una rete /0 che vorrebbe dire fidarsi di tutti, ferma l'avvio con il motivo in italiano.
- **Codici del medico corretti.** Se l'amministratore corregge il codice fiscale o il codice regionale di un medico, si chiudono le sessioni dei servizi legate a quel codice (D111: con il codice fiscale Sistema TS e RUPAR Piemonte, con il codice regionale solo RUPAR), solo nel programma, e la risposta lo dice; le credenziali restano. Una sessione dei servizi aperta con un codice fiscale diverso da quello attuale non vale più e si chiude al primo uso; quelle salvate prima di questa versione si chiudono al primo uso e il medico chiede un codice nuovo (problema 8).
- **Registro.** Conferme, rifiuti (anche i rifiuti 409), letture del server (`--mostra`), richieste ritirate e cambi di nome e cognome del medico vanno nel registro di amministrazione (D177), con etichette in italiano, i nomi dei campi e mai i valori. Le righe di registro di un'importazione, una per paziente, si scrivono in un solo comando: la catena del registro (migrazione 0002), che mette in fila tutte le scritture del servizio fino al commit, resta presa per poco. Il salvataggio delle preferenze di stampa dello studio blocca lo studio senza entrare in conflitto con le righe del registro (FOR NO KEY UPDATE), che con FOR UPDATE andavano in stallo (terza revisione). Gli inviti dell'AFT cercano solo titolari attivi e confermati: un titolare mai confermato di un altro studio, con il codice regionale di un medico, non ne blocca gli inviti e non li riceve.
- **L'interfaccia non ripete la regola:** il servizio dice per ogni utente se le sue credenziali si ripristinano dal server, se è un titolare con pazienti, se è l'ultimo titolare, se l'ha sospeso il server e se lo conferma il server; l'interfaccia nasconde i pulsanti di conseguenza, con il perché, e il servizio controlla comunque.
- **Restano, come note:** i tentativi rifiutati con «servizio occupato» non entrano nel registro (solo nei log del servizio); la conferma è legata alla data della richiesta al millisecondo (un numero di versione la renderebbe indipendente dall'orologio); le sospensioni del server fatte prima della migrazione 0026 non sono segnate (solo ambienti di prova, come il problema 10); `--mostra` non ricorda le decisioni precedenti del server sulla stessa persona; la catena del registro resta una sola per tutto il servizio.
- **Domande per la fermata:** in medicina di gruppo una segreteria confermata da un solo titolare legge gli archivi di tutti (problema 3); codice fiscale del medico corretto dall'amministratore senza la conferma del medico (problema 12); chi conosce il nome utente di un medico lo tiene fuori un'ora alla volta (problema 4, la parte rimasta); come chi gestisce il servizio riconosce il medico prima di confermarlo dal server; `--rifiuta` anche per un utente già confermato; ripristino in autonomia con SPID o CIE; scadenza della password temporanea (da completare); avviso al titolare degli utenti da confermare.

Prove d'attacco delle revisioni rovesciate (l'attacco deve fallire), prove con richieste davvero sovrapposte, prova nel browser della conferma; sabotaggi nel registro.

**D180 · Preferenze di stampa (tappa 14).** Richiesta di Simone: «impostazioni stampanti». Per sei documenti (promemoria SSN, ricetta bianca, certificato INPS, certificati dai modelli, schema orario, Profilo sanitario) stampante consigliata, copie, carta e, per il promemoria, che cosa proporre per primo. Vale la postazione, poi lo studio, poi la predefinita, campo per campo: di solito una postazione cambia solo la stampante. Le imposta l'amministratore; le leggono tutti per la propria postazione, segreteria compresa, perché stampa i promemoria; ogni modifica va nel registro con prima e dopo, niente se nulla cambia; non si cancellano, si svuotano. Il programma è nel browser: stampante e copie sono suggerimenti da confermare nella finestra di stampa, la carta dei certificati dai modelli cambia il PDF (A4 o A5), lo schema orario la suggerisce soltanto. Formati senza valori ricostruiti a memoria: dove l'atto non è stato letto per la carta resta il formato di oggi, e lo dice la fonte. Le copie non impostate si scrivono 0 («come il livello sotto»), perché la colonna non ammette il vuoto. La postazione è quella scritta all'accesso, confrontata senza maiuscole con le postazioni attive (D178). Limiti di buon senso: da 1 a 5 copie, nome della stampante fino a 100 caratteri. Prove e 32 sabotaggi; domande per la fermata in `docs/amministrazione.md`.

**D181 · Risposte della fermata dopo la tappa 15 (19/11/2026).** Domande con il pulsante a Simone, in tre gruppi:

- **Via** all'unione della pull request #7 (tappe 14 e 15), con la CI verde.
- **Poteri dell'amministratore** (D179): restano come sono, e in più medici e segreteria possono ripristinare da soli le proprie credenziali con SPID o CIE (D109), oltre che dal server. Da costruire.
- **Medicina di gruppo**: la segreteria si conferma per archivio, ogni titolare per il suo; finché un titolare non la conferma, il suo archivio non lo vede (D179, problema 3). Da costruire.
- **Blocco dopo i tentativi falliti**: ritardi crescenti per indirizzo e postazione, blocco del conto solo oltre una soglia alta, e un avviso di ogni blocco al medico e ai titolari (problema 4). Da costruire; le soglie sono valori da completare.
- **Codice fiscale del medico corretto dall'amministratore**: la correzione resta in sospeso finché il medico non la conferma, dal programma (problema 12). Da costruire.
- **Primo titolare confermato dal server**: chi gestisce il servizio riconosce il medico di persona, con un documento e il codice regionale, e lo annota fuori dal programma (procedura in `docs/amministrazione.md`).
- **Voci importate**: entrano subito nel Profilo sanitario sintetico e nel riepilogo dell'AFT, come oggi, con il segno della provenienza.
- **Ricette fatte con altri programmi**: contano nelle regole R11 e R6, e il messaggio dice che c'è una ricetta fatta con un altro programma (D176). Da costruire.
- **Catalogo regionale** (D159): lo controlla la Dr.ssa Rocca con il catalogo dell'ASL, dalla lista di `docs/catalogo-regionale.md`.
- **AFT** (D161): il collega vede la scheda intera non riservata (diario, esami, storico), sempre con il consenso del paziente e il motivo, invece del solo riepilogo. Da costruire; niente voci riservate o oscurate, come oggi.
- **Modello proposto della patente** (D160): lo verifica la Dr.ssa Rocca; fino ad allora resta «da verificare».
- **Elenchi dello studio** (D175): risposta «solo i medici e l'amministratore». Interpretata così: scrivono tutti gli elenchi i medici titolari, il sostituto con un'autorizzazione attiva sull'archivio di un titolare dello studio, e l'amministratore; la segreteria li legge. Oggi il sostituto scrive anche senza autorizzazione. Da costruire; da correggere se l'intenzione era un'altra.

Le altre domande annotate nei documenti (stampa diretta, campi facoltativi non validi nell'importazione, soglie degli avvisi, salvataggi cifrati, scadenza della password temporanea e le altre) restano con la scelta di oggi.

**D182 · Quinto blocco: «chiudi tutto ciò che puoi chiudere» (19/11/2026).** Dopo l'elenco di che cosa restava aperto, Simone ha risposto «ok. Chiudi tutto ciò che puoi chiudere». Interpretato come via a tutto quello che non dipende da altri: le sette scelte della fermata dopo la tappa 15 (D181, tappa 16) e i due lavori annotati e mai avviati, il catalogo delle diagnosi ICD-9-CM con la ricerca per descrizione e gli allegati del DPCM LEA (tappa 17). Restano fuori le cose che dipendono da altri: il primo giro di `sync/` dal computer dello studio, le specifiche e le credenziali di collaudo di SAR, Sistema TS e AURA, la decisione su Ready!, le prove con tablet e lettori di schermo veri. La tabella ufficiale ICD-9-CM 2007 è sul sito del Ministero, che blocca questa sessione (403): si costruisce il meccanismo e la si importa quando arriva. Branch `ccr-9780f0fd-iyj18e` (quello della sessione); fermata dopo la tappa 17, con lo stesso giro. Da correggere se l'intenzione era un'altra.

**D183 · R6 e R11 con le ricette fatte con altri programmi (tappa 16, D181).** Versione 2026-11-19.1 delle regole, in vigore dal 19/11/2026: R6 (confezioni del piano terapeutico) e R11 (contatore delle confezioni) contano anche le ricette di farmaci fatte con altri programmi e importate (D176), e il messaggio lo dice («la ricetta del …, fatta con un altro programma (nome), copre fino al …»; «già prescritte 3, di cui 2 con un altro programma»). Scelte: le versioni di prima restano come erano (interruttore `countOtherPrograms` nei dati, come `requireNationalServiceCode` per R10), così i controlli di allora restano verificabili; una ricetta importata non è collegata a una terapia, quindi la si riconosce dal farmaco della riga, per AIC o principio attivo (senza maiuscole né spazi in più, perché i file di altri programmi variano); una ricetta importata senza il numero di confezioni non si conta, e un'informazione lo dice (non si inventa un numero); quelle annullate qui, importate per errore, non contano. Le prove che passano dal servizio leggono la versione in vigore invece di scriverla a mano. Prove e cinque sabotaggi.

**D184 · Codice fiscale del medico corretto dall'amministratore (tappa 16, D181, problema 12).** La correzione del codice fiscale di un medico confermato resta in sospeso: vale il codice di prima, anche per promemoria, SAR e Sistema TS, finché il medico non la conferma dal programma. Il medico vede un avviso nella cornice e decide in «Recapiti di studio»: conferma o rifiuta la correzione che ha davanti (il codice proposto va con la risposta; se nel frattempo è cambiata o è stata ritirata, il servizio rifiuta). Alla conferma si ricontrolla che nessun altro utente dello studio abbia quel codice, in uso o proposto; il codice cambia e le sessioni dei servizi legate al codice di prima si chiudono, come prima succedeva alla correzione. L'amministratore vede la correzione in attesa nell'elenco degli utenti e la può ritirare; un codice proposto per un medico non si dà a un altro. Lo stesso codice di adesso, rimandato con un'altra modifica, non ritira la correzione: il ritiro è un'azione a parte, per non perderla per sbaglio. Scelta: per chi è o va in attesa di conferma la correzione vale subito, perché con quel codice non ha ancora lavorato e chi conferma la vede nella richiesta; una correzione di prima decade. Nel registro: la modifica con «codice fiscale in attesa della conferma del medico», la conferma, il rifiuto e il ritiro, con i nomi dei campi e mai i valori. Non fatto: un avviso al medico fuori dal programma (email) e una scadenza della correzione, perché non c'è un canale né un valore deciso. Prove e sei sabotaggi.

**D185 · Segreteria confermata per archivio (tappa 16, D181, problema 3).** In medicina di gruppo ogni titolare conferma la segreteria per il suo archivio; finché non lo fa, la segreteria non lo vede, nemmeno l'anagrafica. La regola è nel dominio (`can()`: il contesto dell'archivio porta le segreterie confermate dal titolare) e vale per ogni passaggio verso i dati dei pazienti, perché tutti leggono il contesto dell'archivio dallo stesso punto. Il titolare che conferma la segreteria come utente la conferma anche per il suo archivio; gli altri titolari la confermano, o no, in «Utenti da confermare», e la possono togliere dopo. Le decisioni si aggiungono e non si cambiano (tabella `archive_secretary`, con trigger): vale l'ultima. Scelte: il ruolo di segreteria tolto o ridato azzera le conferme (chi riceve di nuovo un ruolo con i dati dei pazienti aspetta, D179); la conferma dal server non dà archivi; un archivio nuovo parte senza segreteria; le segreterie già confermate prima della regola restano su tutti gli archivi dello studio (migrazione 0028), perché nessuna resti fuori di colpo, e ogni titolare le può togliere dal suo. L'amministratore vede lo stato per archivio; le decisioni entrano nel registro e nell'esportazione completa. Prove (dominio, servizio, riporto della migrazione, interfaccia) e sette sabotaggi.

**D186 · Diagnosi ICD-9-CM: il catalogo dal manuale, da controllare (tappa 17).** Simone ha mandato l'estrazione dal PDF del manuale del Ministero (versione italiana 2007, elenco sistematico delle diagnosi), poi rivista con un controllo esterno, e ha chiesto di chiudere la questione. Scelte:

- **Trascrizione da controllare (A8).** Dati estratti da un PDF: entrano come trascrizione (`packages/reference/data/trascrizioni/icd9cm/`) e il programma li usa solo dopo il controllo di una persona. Lo fa la Dr.ssa Rocca (Simone, 19/11/2026), con l'elenco di `docs/icd9cm.md`; fino ad allora la ricerca dice che il catalogo non è in uso e il codice si scrive a mano.
- **Correzioni solo con una prova.** Codici e titoli sbagliati nel PDF si correggono quando lo dicono lo stesso PDF (codici paralleli, legende, note, indice) e il significato del codice nell'elenco ufficiale ICD-9-CM del 2007 (CMS); senza prova la riga resta come stampata. 41 righe corrette (dal controllo esterno, dalla simulazione o da tutti e due), 3 ricostruite dal testo del PDF, E978 fuori (nessun testo italiano).
- **Codici dalle legende.** Il PDF definisce la quinta cifra di 531–535 e la quarta di E800–E841 solo con una legenda: per la codifica servono i codici completi, che si compongono con le parole della legenda stampata (395 codici, segnati come composti).
- **COVID-19.** Il DM 28/10/2020 (GU n. 26 dell'1/2/2021) entra come atto che modifica il catalogo (D157), dal 2/2/2021: 24 codici nuovi, esclusioni e note su 18 codici. V07.0 diventa una categoria.
- **Ricerca e campi.** Ricerca per parole in qualunque ordine o per codice (con o senza punto), con i titoli dei padri, nei problemi, nell'anamnesi familiare, nel certificato di malattia e nella causa del decesso; il codice scritto a mano mostra il titolo, o un avviso se non è nel catalogo o se è una categoria (per la codifica si usa il codice più specifico: nota del DM 28/10/2020). Nessun blocco: è la classificazione, non un suggerimento diagnostico (regola 3).
- **Controlli all'importazione.** Ogni codice una volta; il padre di ogni sottocodice è il codice senza l'ultima cifra e c'è, anche dopo un atto che modifica il catalogo.
- **Aggiornamento.** La pagina del manuale del Ministero entra fra le fonti controllate ogni notte (`salute_icd9cm`); un decreto nuovo si trascrive come atto che modifica il catalogo. ICD-10-IM resta un tipo da fare, quando servirà ai certificati e al Fascicolo.
- **Simulazione del controllo.** Chiesta da Simone («puoi fare una simulazione anche tu»): confronto dei codici con l'elenco della CMS e controlli sui titoli; il confronto titolo per titolo con molti agenti è stato avviato e poi fermato, perché il controllo vero lo fa Chiara. Le procedure (interventi) non entrano: il medico di famiglia non le codifica.

Prove (pacchetto, servizio, interfaccia) e otto sabotaggi.

**D187 · AFT: la scheda intera non riservata (tappa 16, D181).** Il collega dell'AFT, con il consenso del paziente e il motivo dell'accesso, vede oltre al riepilogo la scheda: la cronologia della cartella con le note di visita, gli esami, le ricette, le ricette fatte con altri programmi e le attività dei colleghi. Scelte:

- **Filtri.** Fuori le voci riservate e quelle oscurate dal paziente, come prima; in più le voci annullate (sono errori corretti), le ricette su cui il paziente ha chiesto di oscurare i suoi dati e le righe delle terapie riservate. Senza il consenso per i dati precedenti, la scheda parte dal giorno del consenso, come il riepilogo.
- **Una sola cronologia.** La scheda e la cronologia del medico vengono dalla stessa funzione (`chronology`), con i filtri della condivisione. Trovato in passaggio: nella cronologia la segreteria (quando il titolare le fa leggere il diario) vedeva anche le righe delle ricette di terapie riservate; ora no, come per le terapie.
- **Consenso.** Il testo diventa «Condivisione della scheda sanitaria con i medici dell'AFT (senza le voci riservate)». Nessun consenso vero è stato raccolto con il testo di prima: il programma non è ancora in uso.
- **Niente altro cambia.** Le condizioni dell'accesso, il registro, la risposta uguale quando non c'è nulla da vedere e il divieto di indizi su ciò che è oscurato restano come in D161.

Prove (servizio, browser con accessibilità) e sei sabotaggi.

**D188 · Tentativi sbagliati: attese per provenienza, due soglie, un avviso di ogni blocco (tappa 16, D181).** Risposta di Simone alla fermata dopo la tappa 15 (D179, problema 4: chi conosce il nome utente di un medico lo teneva fuori un'ora alla volta): «attese crescenti per indirizzo e postazione, blocco del conto solo oltre una soglia alta, e un avviso di ogni blocco al medico e ai titolari». Scelte:

- **Attese per provenienza, solo sulle password.** Prima di guardare una password il servizio la conta sulla sua provenienza: l'indirizzo della richiesta e la postazione scritta a quell'indirizzo. Dopo 5 password sbagliate di seguito dalla stessa postazione, o 20 dallo stesso indirizzo (uno studio esce su internet con un indirizzo solo per tutti i computer), ogni password aspetta: 2 secondi, poi il doppio, fino a 15 minuti, la durata del blocco di prima. Intanto da lì nessuna password si guarda: 429 «Troppe password sbagliate da questa postazione: riprova tra …», con l'intestazione Retry-After. Una password giusta, o un giorno senza errori, fanno ricominciare la provenienza da capo, e le righe ferme da un giorno si cancellano con il loro indirizzo. Il medico, da un altro computer, non aspetta.
- **La postazione da sola non conta.** La scrive chi accede: chi scrivesse «Ambulatorio» da fuori farebbe aspettare l'ambulatorio vero. Per questo la postazione vale solo insieme al suo indirizzo, e l'indirizzo da solo, con una soglia più alta, ferma chi cambia nome a ogni tentativo.
- **Contate prima di guardarle.** Ogni password si conta sulla provenienza prima di guardarla, con le righe bloccate sempre nello stesso ordine: con molte richieste insieme se ne guardano al più quante ne ammette la soglia, più una. Le richieste respinte durante l'attesa non vanno nel registro degli accessi, come quelle con il servizio occupato (D179); ci va la password sbagliata che fa partire l'attesa, con i secondi. La tabella è del servizio, non dello studio: un nome utente sconosciuto non ha studio, e lo stesso indirizzo può provare utenti di studi diversi.
- **Due soglie del conto.** Le password sbagliate all'accesso le sbaglia anche chi conosce solo il nome utente: il conto si blocca alla soglia alta, 50 di seguito (l'amministratore la sceglie da 20 a 100). I codici a 6 cifre sbagliati, all'accesso e allo sblocco della sessione, e la password attuale sbagliata nel cambio della password li sbaglia solo chi ha già la password o una sessione aperta: restano con la soglia di prima, 5 (D29; da 3 a 10), che è anche il numero di codici che un passaggio guarda. Alzare la soglia anche per i codici avrebbe dato dieci volte più codici da provare a chi ha rubato una password. La durata del blocco resta una sola (15 minuti, al più 60). La migrazione 0030 porta la soglia di prima di ogni studio ai codici e mette 50 alle password; uno studio senza soglia resta senza.
- **Valori provvisori** (confermati da Simone alla fermata dopo la tappa 17, D191). Attese (5, 20, da 2 secondi a 15 minuti, un giorno) e soglia alta (50) sono di buon senso, non di una norma: da completare. Si scelgono comunque, perché vuoti vorrebbero dire nessuna protezione dell'accesso. Le attese sono valori del servizio, nel codice (`LOGIN_SOURCE_LIMITS`), mostrati nello stato del servizio; la soglia alta e quella dei codici sono dello studio.
- **Un avviso di ogni blocco.** Ogni blocco si registra con gli indirizzi e le postazioni dei tentativi contati (al più 10 ciascuno, dal registro degli accessi), va nel registro come «conto_bloccato» e dà un avviso nella cornice all'utente bloccato e ai medici titolari dello studio, finché ognuno non lo segna come visto nella pagina «Blocchi del conto». Il testo dice che cosa può voler dire: con le password, qualcuno conosce il nome utente; con i codici, qualcuno conosceva la password o aveva una sessione aperta, e va cambiata la password. Un conto già bloccato da un'altra richiesta non si allunga e non dà un avviso nuovo. Blocchi e «visto» non si modificano e non si cancellano; ogni lettura degli avvisi va nel registro, perché dice da dove si è provato a entrare. L'amministratore vede il blocco nell'elenco degli utenti, come prima, e non riceve l'avviso: non era chiesto.
- **Non fatto:** un avviso fuori dal programma (email o SMS: nessun canale deciso, regola 7); lo sblocco da parte del medico stesso, che arriva con SPID o CIE (tappa 16.1); una difesa contro chi prova da molti indirizzi insieme (CAPTCHA, elenchi di indirizzi). Questo è il limite della scelta: con abbastanza indirizzi si arriva comunque alla soglia alta, e allora restano il blocco di 15 minuti, l'avviso e lo sblocco dal server.

Prove (servizio, richieste davvero insieme, migrazione, interfaccia) e sabotaggi.

**D189 · Ripristino delle credenziali con SPID o CIE (tappa 16, D181).** Risposta di Simone alla fermata dopo la tappa 15: i poteri dell'amministratore restano come sono (D179), e in più medici e segreteria possono ripristinare da soli le proprie credenziali con SPID o CIE, oltre che dal server. Scelte:

- **Un accesso con SPID o CIE del programma, non quello del SIRPED.** L'accesso regionale di D109 e D111 rilascia l'Id-Sessione delle ricette solo al medico prescrittore: non serve alla segreteria, e non è fatto per riconoscere chi entra nel programma. Il programma si fa riconoscere la persona da un gestore dell'identità digitale (SPID o CIE): interfaccia `DigitalIdentityGateway` e simulatore, come le altre integrazioni (regola 7). Per farlo davvero il programma va accreditato come fornitore di servizi per SPID e per CIE: protocollo, codice del programma e indirizzi di ritorno sono da completare con l'accreditamento e le specifiche ufficiali. La forma costruita (state casuale, PKCE S256, codice monouso, ritorno al programma) è quella comune ai protocolli con ritorno.
- **Di chi è il codice fiscale.** Per il medico vale il codice fiscale del suo profilo, che l'amministratore non cambia senza la conferma del medico (D184) e che un titolare, o chi gestisce il servizio, ha visto alla conferma. La segreteria non ha un profilo: collega lei stessa la sua identità, a sessione aperta e con il codice a 6 cifre di adesso (chi trova una sessione lasciata aperta non lo ha), entrando con SPID o CIE; il programma tiene il codice fiscale riconosciuto. L'amministratore non lo scrive e non lo vede cambiare senza traccia: collegamento e scollegamento vanno nel registro di amministrazione. Per gli amministratori resta il ripristino da un altro amministratore.
- **Il percorso.** Dalla pagina di accesso: nome utente e postazione, poi SPID o CIE. Se la persona riconosciuta ha il codice fiscale dell'utente, e l'utente è un medico o una segreteria attivo, confermato e non sospeso dal server, sceglie una password nuova (stesse regole del cambio) e, se l'ha persa, azzera il secondo fattore, che riattiva al primo accesso. Il conto si sblocca, i contatori dei tentativi si azzerano, tutte le sessioni e i passaggi aperti si chiudono. Il passaggio per la password vale 10 minuti, una volta, in un cookie riservato alle rotte del ripristino (mai nell'indirizzo); una password che non va non lo consuma.
- **Niente indizi.** L'avvio risponde allo stesso modo per qualunque nome; a nome sconosciuto, utente che non ripristina da sé e identità diversa il ritorno dà lo stesso messaggio. Il motivo vero va nel registro degli accessi. Ogni avvio conta come un tentativo sulla sua provenienza (D188), finché il ripristino non si conclude.
- **Nel registro**: avvio, rifiuto con il motivo, riconoscimento con SPID o CIE, ripristino; nel registro di amministrazione «Ripristino delle credenziali, dall'utente stesso, con SPID o CIE», con i nomi dei campi e mai i valori.
- **In produzione con il simulatore, spento.** Il simulatore riconosce chiunque come chiunque (la sua pagina chiede il codice fiscale di chi «entra»): con `APP_AMBIENTE=produzione` e il simulatore, ripristino e collegamento rispondono «non ancora collegato al servizio vero». In prova chiunque può ripristinare un utente di prova: lì ci sono solo dati inventati.
- **Non fatto:** il collegamento vero con SPID e CIE (accreditamento, da completare); un avviso ai titolari quando una segreteria collega la sua identità o ripristina le credenziali (c'è il registro); la scadenza della password temporanea, che resta una domanda (D179).

Prove (servizio, simulatore, interfaccia, browser con accessibilità) e sabotaggi.

**D190 · Esenzioni del DPCM LEA: l'allegato 8 come catalogo, e un catalogo parziale non rende inesistenti le altre esenzioni (tappa 17, D182).** Dagli allegati 7, 8, 10 e 4D mandati da Simone (versioni del 29/9/2026 della pagina del Ministero):

- **Allegato 8, trascritto** (da controllare): i 66 codici delle condizioni della prima parte e i 181 codici della tabella di corrispondenza con le malattie ICD9-CM, in un catalogo `esenzioni` dal 30/10/2026 (da quella data valgono in Piemonte le esenzioni 068, 069 e 070 di questa versione; data da verificare). Le celle che nel PDF vanno a capo sono ricomposte; HIV-2 è 020.042 con il codice aggiuntivo 079.53, non un codice a parte. Le esenzioni del paziente hanno già un codice e un «codice in ricetta»: nel catalogo entrano sia i codici delle condizioni sia quelli con la malattia, perché sono tutti e due codici dell'atto.
- **Famiglie dei codici.** Fino a oggi, con un catalogo importato, un codice assente era «inesistente» e R9 bloccava. Con le sole malattie croniche avrebbe bloccato le esenzioni per reddito o per gravidanza. Ora un codice assente è inesistente solo se il catalogo contiene la sua famiglia (codici che cominciano con una cifra, codici con R e una lettera, gli altri per le lettere iniziali); altrimenti è non noto, e R9 controlla solo che sia registrato per il paziente e valido alla data.
- **Non trascritti, con il motivo:** le prestazioni di ogni esenzione (per R17 vale l'elenco regionale che il SAR usa, D.D. 1167/2022; nella parte nazionale la visita di controllo non ha un codice, alcune prestazioni valgono solo in certi casi, alcune condizioni non hanno elenco); l'allegato 7 (nomi delle malattie rare mescolati con note ed esempi nel PDF: serve una fonte strutturata o un'estrazione controllata); l'allegato 10 (prestazioni per periodo, senza i codici di esenzione); l'allegato 4D (serve con l'allegato 4, che dice a quali prestazioni si applica ogni nota).

Prove e sabotaggi.

**D191 · Risposte della fermata dopo la tappa 17 (19/11/2026).** Domande con il pulsante a Simone:

- **Via** all'unione della pull request #9 (tappe 16 e 17), con la CI verde: «ok Via: Unisci. Le verifiche le facciamo alla fine». Unita. Le verifiche di Simone e della Dr.ssa Rocca (cataloghi da controllare, prove sui dispositivi veri) si fanno alla fine, tutte insieme; fino ad allora i cataloghi da controllare restano fuori dal database, come proposto.
- **Chi aggiorna banche dati e trascrizioni**: «adottiamo la soluzione più facile e semplice per tutti». Interpretata come la proposta consigliata: il fornitore, una volta per tutti gli studi del servizio, con un medico che controlla le trascrizioni (A8). È la più semplice per gli studi, che non fanno nulla, e tutti lavorano con gli stessi dati. Lo studio vede com'è andato l'ultimo aggiornamento; il pulsante «Aggiorna adesso» non è più dell'amministratore dello studio (D192; poi rimesso al via della #10, D194). Da correggere se l'intenzione era un'altra.
- **Soglie dei tentativi** (D188): «Vanno bene così». Le attese (5 password dalla postazione, 20 dall'indirizzo, da 2 secondi a 15 minuti, una provenienza dimenticata dopo un giorno) e le soglie del conto (50 password, 5 codici) restano queste e non sono più segnate come provvisorie: si riguardano se in studio danno fastidio.
- **Esenzioni** (D190): «Li scarico io». Simone manda il PDF della D.D. 1167/2022 dal Bollettino (elenco regionale esenzioni–prestazioni, per R17) e un'estrazione dell'allegato 7 (malattie rare), come per l'ICD-9-CM; poi la trascrizione, che controlla la Dr.ssa Rocca. Fino ad allora R17 resta «non verificabile» e le malattie rare restano fuori dal catalogo.

Restano annotati: nome e impronta del PDF del manuale ICD-9-CM (poi indicato da Simone e registrato in `docs/provenienze.md`), l'accreditamento del programma per SPID e CIE.

**D192 · Le banche dati le aggiorna chi gestisce il servizio (D191).** Superata in parte da D194: il pulsante dello studio resta. Le banche dati sono comuni a tutti gli studi del servizio (D156): un aggiornamento avviato da uno studio cambiava i dati di tutti. Scelte:

- **Ogni notte e dal server.** Restano l'orologio di ogni notte e il comando `pnpm banche-dati:aggiorna` sul server, di chi gestisce il servizio. Il pulsante «Aggiorna adesso», la rotta che lo avviava e l'azione `admin.reference_data` si tolgono: nessun utente di uno studio avvia un aggiornamento.
- **Lo studio vede lo stato.** Tutti gli utenti continuano a vedere in Strumenti › Banche dati quando parte il prossimo aggiornamento, com'è andato l'ultimo e che cosa aspetta un controllo; la pagina dice che a quei controlli pensa chi gestisce il servizio. Gli aggiornamenti avviati con il pulsante prima di oggi restano nel registro con il loro nome.
- **Non fatto:** una pagina per chi gestisce il servizio. Il comando sul server basta per oggi, come per il ripristino delle credenziali (D179).

Prove e sabotaggi.

**D193 · I ritorni da SPID o CIE e dalla pagina regionale portano un codice, non un testo.** Da una rilettura del codice dopo la fermata. Il ritorno da SPID o CIE (ripristino e collegamento, D189) e quello dalla pagina regionale (D109) mettevano nell'indirizzo il testo del motivo (`?motivo=…`), e la pagina lo mostrava così com'era. Chiunque poteva mandare a uno studio un collegamento al dominio vero con un messaggio falso, per esempio «conto sospeso: chiama questo numero». Scelte:

- **Un codice fra pochi noti.** Il servizio mette nell'indirizzo solo il codice (`non-possibile`, `non-riconosciuta`, `annullato` e gli altri); il testo lo scrive l'interfaccia (`apps/web/src/lib/return-reasons.ts`). Un codice sconosciuto, anche il nome di una proprietà come `toString`, dà un testo generico. Il motivo vero resta nel registro.
- **Le risposte dei gestori non si mostrano più.** I codici d'errore del gestore dell'identità o della Regione entravano nel testo; ora vanno solo nel registro, e chi accede legge che cosa fare.
- **I simulatori rimandano solo ai ritorni registrati.** Accettavano qualunque indirizzo che cominciava con «/», anche «//altro-sito», che il browser legge come un altro sito. Come un gestore vero, ora accettano solo gli indirizzi di ritorno del programma.
- **Non cambia:** lo storico di una prestazione o di un farmaco, quando non trova nulla, ha per titolo la parola cercata. È la ricerca stessa, dentro la cartella e a sessione aperta.

Prove (servizio, simulatori, interfaccia) e sette sabotaggi.

**D194 · Il pulsante «Aggiorna adesso» resta all'amministratore dello studio (supera D192 in parte).** Al via della pull request #10 Simone ha scritto: «il pulsante che aggiorna record e database da parte dello studio lo lascerei». Scelte:

- **Come prima di D192.** Le banche dati le aggiorna chi gestisce il servizio, una volta per tutti gli studi, ogni notte e con il comando sul server (D191). In più l'amministratore dello studio può avviare subito un aggiornamento con «Aggiorna adesso», senza aspettare la notte (D156, azione `admin.reference_data`).
- **Vale per tutti gli studi.** Il giro è lo stesso di ogni notte, e le banche dati sono comuni: la pagina lo dice accanto al pulsante. Ne parte uno alla volta: un secondo avvio trova il primo in corso e non parte.
- **Prove.** Tornano le prove di D156: solo l'amministratore avvia un giro, poi tutti vedono com'è andato. Le due prove e i due sabotaggi di D192 si tolgono con il controllo che provavano.

Prove (servizio, browser con accessibilità) e un sabotaggio.

**D195 · Allegato 7 del DPCM LEA trascritto: malattie rare, da controllare.** Simone doveva mandare un'estrazione dell'allegato 7 (D191); poi ha chiesto di non chiedergli ciò che si può fare da sé (19/11/2026). Il PDF che aveva già mandato si legge cella per cella: la tabella ha quattro colonne (codice, malattia o gruppo, esempi di malattie afferenti al gruppo, sinonimi) e le righe senza codice continuano quella sopra, anche sulla pagina dopo. Dal testo impaginato, invece, nomi ed esempi si mescolavano: 98 nomi su 370 erano sbagliati (per esempio RCG040 prendeva il nome dell'esempio «fenilchetonuria»). Scelte:

- **Una riga per codice**, 370 (116 gruppi e 254 malattie), nella serie `lea-esenzioni-malattie-rare`, dal 30/10/2026 come l'allegato 8 (gli aggiornamenti delle malattie rare del 2026 valgono in Piemonte da quella data, D.D. 710/2026, punto 7; data da verificare).
- **Che cosa entra nelle colonne**: nome della malattia o del gruppo; esempi e sinonimi, separati da « | »; le malattie del gruppo che il PDF elenca con il loro codice («… (codice RN1200)»), in una colonna a parte; sezione e sottosezione; pagina del PDF.
- **Una correzione**: in RNG262 il PDF distanzia le lettere («D I S G E N E S I A G O N A D I C A»); il testo vero si prende dalla stessa pagina letta con pdftotext («DISGENESIA GONADICA»).
- **Da controllare** prima di entrare nel catalogo (A8), come l'allegato 8: lo controlla la Dr.ssa Rocca alla fine (D191).

Prove e quattro sabotaggi.

**D196 · Elenco esenzioni–prestazioni per R17: l'ultimo pubblicato non si importa.** Il PDF della D.D. 1167/2022 si scarica da qui; Simone non doveva farlo. Il suo allegato 1 (le prestazioni di ogni esenzione che il SAR accetta, con il controllo bloccante dal 28/06/2022) è stato sostituito dall'allegato C della D.D. 1452/2023, in vigore dal 20/07/2023: 9871 righe, 48 esenzioni, letto cella per cella. È però precedente al nuovo nomenclatore (dal 30/12/2024: D.D. 868/2024, il diritto all'esenzione segue l'allegato 8 del DPCM e non più l'8-bis). Dei 1170 codici di prestazione distinti, solo 437 (37%) esistono nel catalogo regionale 2026 (78% delle righe, perché restano soprattutto le visite). Gli atti letti dopo il 2023 (D.D. 868/2024, 990/2024, 444/2025, 590/2026, 710/2026) aggiornano il catalogo e le esenzioni nazionali, non l'elenco del SAR; altri non se ne sono trovati. Scelte:

- **Non si importa.** Con questo elenco R17 bloccherebbe ricette giuste fatte con i codici di oggi. R17 resta «non verificabile», come prima; il SAR controlla comunque all'invio.
- **Domanda per la fermata**: chiedere alla Regione o al CSI Piemonte l'elenco in uso nel SAR, cosa che solo Simone può fare.
- **Correzioni**: dove i documenti dicevano che l'elenco della D.D. 1167/2022 era «già importato» c'era solo l'esempio delle prove. La fonte di R17 nei dati delle regole cita ancora la D.D. 1167/2022: si aggiorna con la prossima versione delle regole.
- Nell'estrazione, le lettere «A» ed «E» prima di alcuni codici di prestazione (esenzioni 027 e 057) sono la fine del nome dell'esenzione, tagliato nella cella del PDF: non fanno parte del codice.

**D197 · AURA con un simulatore: esenzioni e scelte dall'anagrafe regionale.** Simone ha chiesto se un'esenzione nuova in AURA aggiorna il programma da sola, come negli altri programmi. Alla fermata dopo l'unione della #10 ha risposto «Sì, costruiscilo ora». Le fonti sono due. I requisiti dicono: AURA per anagrafica, scelte e revoche, esenzioni; web service SOAP/XML; servizi in tempo reale, «si interrogano al momento». Il manuale pubblico dei servizi di cooperazione (AURA--ORG-01-V08) descrive la ricerca dei profili per codice fiscale (FIND), il profilo sanitario completo (GET) e le notifiche delle variazioni a un servizio dell'ente sulla rete RUPAR. Le specifiche di dettaglio (AURA--SER-01) le dà il CSI Piemonte alle software house: Simone le ha chieste con la PEC del 19/11/2026. Scelte (dettagli in `docs/aura.md`):

- **Interfaccia e simulatore** in `packages/integrations` (regola 7): ricerca per codice fiscale, profilo, notifiche, assenza di rete. Nomi dei campi e codici degli eventi da completare con le specifiche.
- **Quando si controlla.** A ogni notifica; ogni notte all'ora di `AURA_AGGIORNAMENTO`, se c'è; dal pannello, con «Aggiorna da AURA», per chi scrive nell'archivio. Anche prima dei controlli di una ricetta con esenzione, se l'ultimo allineamento ha più di dieci minuti: in quel caso si aspetta al massimo tre secondi, poi valgono i dati che ci sono (il SAR controlla comunque all'invio).
- **AURA è la fonte delle sue righe.** Esenzioni (per codice e data d'inizio) e scelte (per medico e data) arrivano con la fonte «AURA» e non si modificano dal pannello. A ogni controllo si allineano: nuove, cambiate, tolte. Le righe inserite a mano non si toccano.
- **Le righe tolte in AURA non si cancellano.** Si annullano con data, autore (vuoto se l'ha fatto il controllo) e motivo «Non c'è più in AURA». Esenzioni e scelte hanno ora l'annullamento, come le voci cliniche (migrazione 0033). Una riga annullata non si modifica più e non vale per le regole, per il pannello e per l'importazione; resta nello storico e nell'esportazione.
- **Scelte solo dei medici dello studio**, riconosciuti dal codice fiscale del profilo medico. Le scelte di altri medici, anche di altri studi dello stesso servizio, non entrano.
- **Risposte che non tornano.** Un profilo con un altro codice fiscale non cambia nulla: il collegamento si azzera e al controllo dopo il paziente si cerca di nuovo per codice fiscale. Con più persone per lo stesso codice fiscale non cambia nulla, e il motivo dice di chiarire con l'ASL.
- **Variazioni in parole** (`aura_change`): non si modificano e non si cancellano. Nel pannello del paziente le ultime venti; nella pagina Oggi quelle degli ultimi sette giorni, dei pazienti che l'utente vede.
- **Registro e storico.** Nel registro degli accessi vanno ogni controllo chiesto da una persona e ogni variazione arrivata. Non ci vanno i controlli di ogni notte e le notifiche senza variazioni: non leggono e non cambiano nulla, e sarebbero una riga per paziente ogni notte. Per la stessa ragione il collegamento ha lo storico quando cambia lo stato, non a ogni controllo.
- **Stato del servizio.** L'amministratore vede il prossimo giro e l'ultimo, con i numeri dei soli pazienti del suo studio (`aura_sync_run_studio`): quelli degli altri studi non si vedono.
- **In produzione con il simulatore AURA è spenta**, come SPID e CIE (D189), perché i dati del simulatore non sono veri. Il pannello lo dice, e esenzioni e scelte si inseriscono a mano.
- **Fuori, per ora: domanda per la fermata.** L'anagrafica (indirizzo, ASL, decesso) e lo stato del paziente quando AURA dice che la scelta è cessata. Il programma non scrive in AURA: scelte e revoche le registra l'ASL.

Prove (servizio, interfaccia, browser con accessibilità) e diciannove sabotaggi.

**D198 · AURA: revoca automatica, anagrafica da confermare, un controllo alla volta.** Alla fermata dopo l'unione della #11 Simone ha dato il via alla #12 e ha risposto alle due domande su AURA. Per la scelta cessata: «Revocato da solo». Per l'anagrafica: «Differenze da confermare, intendi gli aggiornamenti che arrivano da Aura? Allora ok»; la risposta è sì, sono gli aggiornamenti dell'anagrafica che arrivano da AURA. Scelte:

- **Revoca automatica.** Quando AURA dice che la scelta del titolare dell'archivio è cessata, e non ce n'è un'altra in corso, il paziente passa a «revocato» da solo. Con una scelta nuova in corso torna «in carico», sempre da solo: AURA è la fonte delle scelte. Contano solo le scelte del titolare dell'archivio arrivate da AURA. Le scelte di altri medici e quelle scritte a mano non cambiano lo stato, e i pazienti deceduti o temporanei non si toccano. Ogni cambio di stato è una variazione in parole («Paziente revocato: …», «Paziente di nuovo in carico: …»). Il giro di notte comprende anche i revocati già collegati ad AURA, così un ritorno si vede anche senza notifica.
- **Anagrafica da confermare.** AURA manda residenza (via, numero civico, CAP, comune, provincia), domicilio, ASL, distretto e decesso. Il programma li confronta con la cartella e mostra le differenze nel pannello di AURA, che non entrano da sole:
  - **Che cosa conta come differenza.** Maiuscole, minuscole e spazi non contano. Un campo vuoto in AURA non propone di svuotare quello della cartella.
  - **Chi decide.** Medico o segreteria, cioè chi scrive nell'archivio, usano il dato di AURA, con gli stessi controlli del pannello amministrativo e il registro con la fonte «AURA», oppure tengono quello della cartella.
  - **Un dato tenuto non si ripropone**, finché AURA non ne manda un altro.
  - **Risposte su dati superati.** Si risponde solo alle differenze di adesso, con il valore visto: se AURA nel frattempo ha cambiato, il programma chiede di ricaricare (409).
  - **Il decesso** si segnala anche nella pagina Oggi, in evidenza, e si conferma dal pannello con i suoi controlli (per esempio una data nel futuro è rifiutata).
- **Registro.** Quando AURA manda un'anagrafica nuova con differenze, la variazione si registra una volta, in parole. Dopo, va nel registro ogni scelta di usare o tenere un dato.
- **Un controllo alla volta per paziente** (difetto trovato dalle prove nuove, presente dalla #12). Due notifiche vicine per lo stesso paziente si applicavano in parallelo e potevano registrare due volte la stessa variazione. Ora ogni controllo prende un blocco nel database (anche con più processi) e legge AURA dentro il blocco: chi arriva dopo aspetta e legge dopo.
- **Fuori, per ora**: l'identità (cognome, nome, nascita), che si corregge con un motivo e non da AURA; la scadenza di una scelta a tempo determinato, da verificare con le specifiche (oggi conta solo la cessazione); i nuovi assistiti, cioè chi sceglie il medico e non è ancora nell'archivio (domanda per la fermata).

Prove (servizio, interfaccia, browser con accessibilità) e sabotaggi.

**D199 · Nuovi assistiti da AURA, paziente temporaneo in un passo, stato del paziente alla ricetta.** Alla fermata dopo l'unione della #12 Simone ha dato il via alla #13 e, per i nuovi assistiti, ha scelto «Elenco in Oggi, un clic». Poi ha chiesto: «il medico deve poter inserire un paziente in incarico temporaneo e dunque poter prescrivere esami o farmaci. già previsto?». In parte: c'erano lo stato «temporaneo», la scelta con la scadenza e le ricette, ma lo stato si sceglieva solo dopo la registrazione e alla ricetta il programma non guardava lo stato di nessun paziente. Alla proposta ha risposto «ok, procedi così». Scelte:

- **Nuovi assistiti da AURA.**
  - **Quando.** Alla notifica di una scelta, e a ogni notifica di chi è già fra i nuovi, il programma legge il profilo in AURA. Conta la scelta che vale oggi o più avanti (non cessata, non scaduta) con un medico titolare di uno studio del servizio, riconosciuto dal codice fiscale, con il suo archivio. Se nello studio il paziente c'è già (stesso codice fiscale), si collega e si allinea; altrimenti entra fra i nuovi assistiti dell'archivio di quel medico. Un controllo alla volta per assistito, come in D198.
  - **Chi lo vede.** Chi può registrare pazienti in quell'archivio, cioè scrivere l'anagrafica: il titolare, il sostituto autorizzato, la segreteria. Si vede nella pagina Oggi, con il codice fiscale mascherato come nell'elenco dei pazienti; la lettura resta nel registro.
  - **«Registra».** Un clic: i dati di AURA con i controlli di «Nuovo paziente».
    - Sesso e luogo di nascita dal codice fiscale (omocodia compresa); il nome del luogo dal catalogo dei comuni, se c'è.
    - Residenza, domicilio, ASL e distretto di AURA, solo i valori che passano i controlli del pannello: gli altri si vedono dopo come differenze da confermare (D198).
    - Stato «temporaneo» se la scelta ha una scadenza.
    - Poi il collegamento con AURA porta esenzioni e scelte, con la fonte «AURA».
    - Due clic insieme fanno un paziente solo: il primo prende il blocco dell'assistito, il secondo non lo aspetta (terrebbe occupata una connessione al database) e riceve «Registrazione già in corso». Un paziente registrato a mano nel frattempo si dice, con il collegamento alla sua cartella, e l'assistito esce dall'elenco.
  - **«Non registrare».** Esce dall'elenco, e la scelta resta nel registro. Non si ripropone finché AURA non manda una scelta nuova (altro medico o altra data).
  - **Esce dall'elenco da solo** quando la scelta non vale più, o AURA dice il decesso.
  - **Dati.** Tabella `aura_new_patient` (migrazione 0035), con lo storico di ogni modifica e il divieto di cancellazione, nell'esportazione dell'archivio (regola 4).
  - **Fuori, per ora.** Il giro di notte non trova i nuovi assistiti di cui la notifica non è arrivata: servirebbe l'elenco degli assistiti di un medico, se le specifiche AURA--SER-01 lo danno (da completare). Un paziente che c'è già in un altro archivio dello studio si allinea soltanto: non cambia archivio.
- **Il giro di ogni notte comprende anche i temporanei**, che hanno scelte a tempo, anche da AURA.
- **Paziente temporaneo in un passo solo.** In «Nuovo paziente» lo stato si sceglie: in carico o temporaneo. Per il temporaneo servono le date della scelta, dal giorno (per difetto oggi) fino alla scadenza. La scelta è del titolare dell'archivio, inserita a mano, e si registra nella stessa transazione del paziente. Si rifiutano il temporaneo senza scadenza, la scadenza prima della scelta e la scelta senza il temporaneo.
- **Stato del paziente alla ricetta**: due regole nuove nei dati (versione 2026-11-19.2), come R18 (D154). Non sono nei requisiti: la fonte scritta nei dati è questa scelta di Simone, da validare con la Dr.ssa Rocca come le altre (validata: no).
  - **R19, paziente deceduto: blocca.** La bozza e la ripetizione delle terapie si rifiutano subito (409), e la pagina della ricetta lo dice con il rimedio (correggere lo stato nei dati amministrativi, se è sbagliato). Una bozza fatta prima si ferma ai controlli prima dell'invio, e un motivo non basta.
  - **R20, paziente revocato, o temporaneo senza una scelta in corso** (scaduta, cessata, futura o mancante): avviso con un motivo per procedere, come gli altri avvisi (tappa 4), e il motivo resta nel controllo. Il temporaneo con la scelta che vale non dà avvisi, fino al giorno della scadenza compreso. Contano le scelte non annullate, a mano o da AURA.
  - La testata della cartella dice «deceduto il …» con la data.
- **Prove.** Lo scenario delle prove tiene in carico il paziente con la cartella piena: da R19 e R20 lo stato conta alla ricetta, e uno stato dato a caso dal generatore renderebbe instabili le prove delle ricette.

Prove (servizio, interfaccia, browser con accessibilità) e sabotaggi.

**D200 · Cambio di medico dentro lo studio: avviso in Oggi, sposta il titolare di prima.** Fino a D199 un paziente che in AURA sceglieva un altro medico dello stesso studio restava nell'archivio di prima, revocato (D198), e il medico scelto non lo sapeva. Alla fermata dopo l'unione della #13 Simone ha scelto «A. Avviso, decide il titolare»: un avviso nella pagina Oggi ai due medici, e lo spostamento nell'archivio del nuovo medico lo conferma il titolare di prima, con un clic. Scelte (dettagli in `docs/aura.md`):

- **Quando.** A ogni controllo con AURA (notifica, notte, «Aggiorna da AURA», ricetta), dopo l'allineamento dello stato. Conta la scelta di AURA che vale oggi (non cessata, non scaduta), la più recente, di un medico titolare di un altro archivio dello stesso studio. Allora il cambio è «da decidere». Una riga per paziente, `aura_doctor_change` (migrazione 0036), con lo storico e senza cancellazioni; la proposta resta anche fra le variazioni di AURA del paziente.
- **Chi decide.** Solo il titolare dell'archivio dove il paziente sta: permesso nuovo `archive.transfer`, del medico titolare sul suo archivio. Non il sostituto né il collega di gruppo con l'autorizzazione, non la segreteria, non l'amministratore. Un no si registra.
- **Che cosa vede chi.** Il titolare di prima, in Oggi: il paziente, il medico scelto e da quando, con «Sposta» e «Non spostare». Il medico scelto, in Oggi: chi l'ha scelto e da quando, e che decide il titolare di prima; senza collegamento alla cartella, che non è nel suo archivio. Le due letture restano nel registro, paziente per paziente.
- **«Sposta».** Il paziente passa nell'archivio del medico scelto con la cartella intera e lo storico; lo stato si riallinea con la scelta del nuovo titolare (di nuovo in carico, D198). Restano nel registro lo spostamento, chi l'ha deciso, e la variazione fra quelle di AURA del paziente. Non si sposta:
  - con pratiche aperte nell'archivio di prima: ricette in bozza, da firmare, in invio o con errore, e certificati in bozza, in invio o con errore. Il programma le elenca: si chiudono prima, per non lasciarle in una coda che nessuno vede più;
  - mentre un controllo con AURA lavora sullo stesso paziente: chi clicca non aspetta il blocco (terrebbe occupata una connessione al database) e lo si dice;
  - due volte: il secondo clic riceve «Già spostato».
- **«Non spostare».** Il paziente resta nell'archivio di prima, revocato, e il cambio non si ripropone finché AURA non manda una scelta nuova (altro medico o altra data).
- **La proposta decade** quando la scelta non vale più, quando il paziente torna dal titolare di prima, quando è già nell'archivio giusto, o quando è deceduto.
- **Dopo lo spostamento.** Le ricette e i certificati di prima restano con l'archivio dove sono nati, nello storico del paziente. L'esportazione segue il paziente: va con l'archivio dove sta adesso. Un'importazione fatta nell'archivio di prima non si annulla più per intero se ha scritto dati di pazienti spostati: il titolare di prima non tocca più quelle cartelle.
- **Alla fermata dopo l'unione della #14** Simone ha risposto sul titolare assente: «Non penso sia un problema grande da affrontare dal momento che il sostituto avrebbe accesso ai pazienti con l'utenza da sostituto». Lo spostamento resta al titolare.

**D201 · Riepiloghi dell'archivio per periodo.** Alla fermata dopo l'unione della #14 Simone ha scelto «A e B»: A sono i riepiloghi per periodo. I requisiti, «La giornata di lavoro»: «Riepiloghi. Visite, prescrizioni, vaccinazioni, PPIP e fatture per periodo, con esportazione». Scelte:

- **Dove.** Nella pagina «Archivio», sezione «Riepiloghi», con la pagina sua (`/archivio/riepiloghi`). Il periodo resta nell'indirizzo; per difetto, dal primo del mese a oggi. I giorni sono quelli dello studio, in ora italiana.
- **Che cosa conta.**
  - **Visite e contatti**: le note del diario non annullate dei pazienti dell'archivio, per tipo di contatto. Le visite sono quelle in studio, a domicilio e in televisita; i contatti telefonici sono a parte.
  - **Ricette** fatte nell'archivio, come eventi: inviata (il giorno dell'invio), cartacea (il giorno della stampa), annullata (il giorno dell'annullamento, solo se era stata inviata o stampata: una bozza scartata non è una ricetta). Per tipo, con le righe delle ricette inviate e cartacee.
  - **Vaccinazioni** non annullate, per vaccino e campagna.
  - **Per medico**: chi ha scritto le visite e le vaccinazioni, chi ha firmato, stampato o annullato le ricette.
- **Chi.** Solo il medico titolare, sul suo archivio: permesso nuovo `reports.read`, come l'esportazione completa (i dati sono suoi, regola 4). Non il sostituto, la segreteria, il collega di gruppo o l'amministratore; un no resta nel registro. Se la segreteria debba vederli è una domanda per la fermata.
- **Esportazione in CSV.** Una riga per visita o contatto, per evento di una ricetta e per vaccinazione, con nome, cognome e codice fiscale del paziente, e mai testi clinici (né il testo della nota del diario, né i farmaci). Stesso formato dell'esportazione completa (D32). La lettura dei conteggi lascia una riga nel registro; l'esportazione una riga per paziente.
- **Fuori, per ora.** PPIP e fatture: servono le regole del Piemonte per le prestazioni di particolare impegno professionale e la fattura delle prestazioni private (fase 2). La pagina lo dice.

Prove (servizio, interfaccia, browser con accessibilità) e sabotaggi.

**D202 · Liste AIFA: trasparenza e farmaci carenti; carenze sui farmaci in terapia; segnalazione di farmacovigilanza.** Alla fermata dopo l'unione della #14 Simone ha scelto anche B: «Liste AIFA e farmacovigilanza: Lista di trasparenza con le note, carenze dei farmaci; collegamento alla segnalazione di farmacovigilanza (D82)». I requisiti, sezione «Banche dati»: la lista di trasparenza per «Differenza di prezzo, R13»; i farmaci carenti per l'«Avviso di carenza sui farmaci in terapia»; A7, «Un aggiornamento che tocca un farmaco in terapia (carenza, nota, classe, piano, ritiro) arriva in Da fare, con i pazienti interessati». Scelte:

- **Due banche dati nuove**, dai file veri della pagina «Liste dei farmaci» di AIFA, scaricati e letti il 19/11/2026 (impronte in `docs/provenienze.md`). Le mappature sono in `packages/reference/data/mappature.json`; le tabelle nella migrazione 0037, con le stesse protezioni delle altre banche dati (non si modificano, non si cancellano, non si svuotano).
  - **Lista di trasparenza** (`Lista_farmaci_equivalenti.csv`, prezzi del 16/11/2026): 8.598 righe, nessun problema. Ha il prezzo di riferimento del SSN, il prezzo al pubblico, la differenza, un'annotazione e il gruppo di equivalenza. I prezzi hanno l'euro in fondo («5,63 €»): il numero si legge senza.
  - **L'AIC della lista di trasparenza è scritto senza gli zeri davanti** (8.594 righe con 8 cifre, 4 con 7). La mappatura li rimette (`zeriDavanti`), solo ai codici di sole cifre più corti della lunghezza data, e il rapporto d'importazione dice quanti. Con gli zeri, 8.400 AIC sono anche nella lista di classe A del 30/6/2026, tutti con lo stesso gruppo di equivalenza: i codici dei gruppi sono gli stessi.
  - **Farmaci carenti** (`elenco_medicinali_carenti.csv`, aggiornato al 17/11/2026): 2.516 righe, nessun problema. L'intestazione è alla terza riga, sotto l'avvertenza di AIFA e la data. Ha inizio, fine presunta, «Equivalente» (sempre «Sì» o «No»), motivazioni, indicazioni AIFA, un'annotazione che può andare a capo, classe e ATC. Campo nuovo di tipo data (GG/MM/AAAA, solo date vere). Tre AIC compaiono due volte; 367 carenze cominciano dopo il 17/11/2026, e la fine presunta di 32 è già passata (l'avvertenza dice che il farmaco resta nell'elenco finché il titolare non comunica la fine).
  - **Soglia di vecchiaia (D156)**: 32 giorni per la lista di trasparenza, che esce ogni mese il 15; nessuna per i carenti, che AIFA aggiorna senza una cadenza dichiarata.
- **Correzione di D148: la lista di trasparenza non ha le note AIFA.** La colonna «Nota» è un'annotazione in parole (12 valori diversi, per esempio «In distribuzione diretta da parte delle Regioni»), non il numero della nota. Il programma la mostra così com'è, con il nome «annotazione». La nota AIFA del farmaco resta quella dell'elenco DPC e quella scritta nella terapia o nella riga della ricetta (R7). Una fonte delle note per AIC, come la nota 13 delle statine, non c'è fra le liste importate: da completare.
- **Che cosa cambia nei dati del farmaco.**
  - Prezzo di riferimento e differenza dal riferimento, accanto al prezzo; la differenza zero non si scrive. Il prezzo al pubblico della lista di trasparenza, che esce ogni mese, vale prima di quello delle liste di classe.
  - La ricerca trova anche i farmaci che sono solo nella lista di trasparenza.
  - Gli equivalenti vengono dalle liste di classe e dalla lista di trasparenza, con la differenza dal riferimento e la carenza in due colonne.
  - L'elenco «Banche dati dei farmaci in uso» (A6) della ricerca, della terapia e della ricetta nomina anche le due liste, con la data della versione.
- **Carenza alla data.** Per ogni AIC vale la carenza dell'elenco in vigore alla data: la più recente fra quelle cominciate; se nessuna è cominciata, la prima prevista. Il testo è quello dell'elenco: «nell'elenco AIFA dei farmaci carenti dal 02/11/2026 (Cessata commercializzazione definitiva); equivalente secondo l'elenco: sì», oppure «carenza prevista dal …», con la fine presunta se c'è.
- **R21, farmaco carente: solo informazione** (versione 2026-11-19.3 delle regole). Una regola nuova nei dati, come R18–R20: la fonte scritta è l'elenco AIFA e questa scelta di Simone, da validare con la Dr.ssa Rocca (validata: no). Vale per ogni ricetta con il farmaco, anche bianca, perché la carenza non dipende dal SSN. Non ferma l'invio e non chiede un motivo: la ricetta resta valida, il farmacista può avere scorte o un equivalente.
- **Avviso di carenza sui farmaci in terapia.** Le terapie non concluse con l'AIC mostrano «Farmaco carente: …» in cartella; la scheda della terapia aggiunge le indicazioni AIFA e l'annotazione dell'elenco, con le sue parole. Il programma non suggerisce alternative (regola 3).
- **A7 per le carenze: «Farmaci in terapia carenti» in Oggi, fra le cose da fare.** I farmaci delle terapie in corso che sono nell'elenco in vigore oggi, ognuno con i pazienti che lo prendono e il collegamento alla loro cartella. Lo vede chi legge le terapie dell'archivio, anche la segreteria che prepara le ripetizioni; le terapie riservate solo chi le legge. Come i piani in scadenza, è una vista calcolata: compare quando l'elenco nuovo è importato e sparisce quando il farmaco esce dall'elenco o la terapia si conclude. Le terapie sospese non ci sono, ma la loro scheda mostra la carenza. Gli altri casi di A7 (nota, classe, piano, ritiro) restano da progettare.
- **Ditte nelle schermate.** La carenza è di una confezione, quindi ha il nome della ditta (per esempio «AMLODIPINA TEVA ITALIA»). Le schermate che la mostrano servono alla documentazione, non al sito di SCRIPT, come le 07, 10, 12 e 13 (D149). Le terapie dimostrative restano per principio attivo, senza AIC: nei dati dimostrativi nessuna terapia risulta carente.
- **Segnalazione di farmacovigilanza (chiude D82).** Nella sospensione per reazione avversa, due collegamenti, aperti in una scheda nuova e senza l'indirizzo della cartella (`rel="noreferrer"`):
  - «Come segnalare una sospetta reazione avversa (AIFA)»: https://www.aifa.gov.it/content/segnalazioni-reazioni-avverse, letta il 19/11/2026. La pagina dice le due strade: la scheda di segnalazione da mandare via email al responsabile di farmacovigilanza della propria struttura (o al titolare dell'AIC), oppure la segnalazione online sul sito AIFA.
  - «Segnala online (AIFA)»: https://servizionline.aifa.gov.it/schedasegnalazioni/#/, l'indirizzo scritto in quella pagina («Segnala online una reazione avversa a farmaci e/o vaccini»). Il modulo non è stato aperto da qui: la rete di questo ambiente non raggiunge servizionline.aifa.gov.it (rifiuto del proxy). Il programma non chiama nessuno dei due siti (regola 7): sono collegamenti che apre il medico.

Prove (lettura dei file, importazione, regole, servizio, interfaccia, browser con accessibilità) e sabotaggi.

**D203 · Prove indipendenti dalla mezzanotte; il cookie della sessione dice quanto dura.** Il primo giro delle prove su GitHub della #16 è partito alle 23:57 ora di Roma ed è finito dopo la mezzanotte. Sono cadute prove che c'erano già: quattro dell'importazione, e nel browser l'accesso, l'archivio e i blocchi del conto. La causa erano gli orologi diversi, che a mezzanotte non segnano più lo stesso giorno:

- l'orologio vero, con cui le prove scrivono i dati «di oggi» o «di domani»;
- quello dello scenario, che usa il servizio e che avanza di 30 secondi a ogni accesso con il codice;
- quello del browser.

Scelte:

- **Un orologio solo, fermo a mezzogiorno.** Lo scenario delle prove accetta l'ora di partenza (`clockAt`), e `middayOf` dà il mezzogiorno del giorno dello studio. L'importazione e le prove nel browser calcolano le loro date dallo stesso istante. Lontano dalla mezzanotte, i minuti che l'orologio avanza non cambiano la data, anche se l'ora vera passa dalla mezzanotte durante il giro.
- **Nel browser la stessa data.** Ogni contesto del browser ha la data fissata con lo strumento di Playwright (`clock.setFixedTime`); i timer continuano a girare. Così le date proposte dai moduli (per esempio «Dal» di un'autorizzazione) sono quelle del servizio.
- **Il cookie della sessione dice quanto dura (Max-Age), non a che ora scade.** Prima portava l'ora di scadenza calcolata dall'orologio del servizio, e il browser la confronta con il suo. In una prova con l'orologio fermo a mezzogiorno e sessioni di 12 ore, il cookie sarebbe scaduto proprio alla mezzanotte vera. Lo stesso vale per un computer dello studio con l'ora sbagliata: perderebbe la sessione prima del tempo, o la terrebbe dopo. La durata il browser la conta con il suo orologio; la scadenza vera resta quella del servizio, che la controlla a ogni richiesta.
- **Come è provato.**
  - Simulazione nella prova dell'importazione, con la prova caricata un istante prima della mezzanotte di ieri. Col vecchio modo cadono le stesse 4 prove di GitHub; con l'orologio unico passano tutte e 31.
  - Nel browser, 52 prove su 52 con l'orologio a mezzogiorno di oggi.
  - Ancora nel browser, una simulazione più dura: il servizio fermo a mezzogiorno di ieri. Passano accesso, archivio e blocchi del conto. Cadono solo le 12 prove dei farmaci: le banche dati d'esempio sono importate con la data vera di oggi, quindi per il servizio non sono ancora in vigore. In un giro vero non capita, perché l'orologio si ferma dopo l'importazione.
  - Una prova nuova sul cookie (`apps/api/test/cookie-sessione.test.ts`), con il suo sabotaggio.
- **Che cosa non è provato.** Un giro su GitHub che passi davvero dalla mezzanotte. Le altre prove del servizio usano ancora l'orologio vero dove non preparano dati «di oggi» da guardare dopo; se un giro a mezzanotte ne fa cadere altre, si correggono allo stesso modo.

**D204 · Riepiloghi anche alla segreteria, con il CSV.** Alla fermata dopo l'unione della #15 Simone ha scelto «C. Segreteria, anche il CSV»: la segreteria vede i riepiloghi a video e scarica il file con i nomi dei pazienti, e ogni esportazione resta nel registro degli accessi. Corregge la scelta di D201 («solo il titolare»). Scelte:

- **Dove la segreteria li vede.** Sugli archivi i cui titolari l'hanno confermata (D181, D185), come il resto del suo lavoro: permesso `reports.read` alla segreteria (matrice in `docs/ruoli-permessi.md`). Su un archivio che non l'ha confermata, o dopo una conferma tolta, no; il rifiuto resta nel registro. Il sostituto, il collega di gruppo e l'amministratore restano senza.
- **Che cosa vede.** Gli stessi riepiloghi del titolare, compreso il CSV. Nel CSV ci sono, paziente per paziente, il tipo di contatto, il tipo di ricetta, e il vaccino con la campagna. Nessun testo clinico, come per il titolare (D201).
- **Come ci arriva.** La segreteria non ha un archivio suo e la pagina «Archivio» non è sua: «Riepiloghi» è una voce del suo menu. Se gli archivi che l'hanno confermata sono più d'uno, la pagina chiede quale («Archivio»), e lo tiene nell'indirizzo insieme al periodo. Servizio: `GET /api/riepiloghi/archivi` dà gli archivi di cui chi guarda legge i riepiloghi.
- **Il registro** è quello di D201: la lettura dei conteggi una riga, l'esportazione una riga per paziente, a nome della segreteria.

Prove (permessi, servizio, interfaccia, browser con accessibilità anche su tablet) e sabotaggi.

**D205 · Variazioni AIFA sui farmaci in terapia (A7): confezione sospesa o uscita dall'anagrafica, classe, nota, piano.** Alla fermata dopo l'unione della #15 Simone ha scelto «Sia altre variazioni AIFA che registri AIFA». Requisito A7: «Un aggiornamento che tocca un farmaco in terapia (carenza, nota, classe, piano, ritiro) arriva in Da fare, con i pazienti interessati» (avvisa). Le carenze erano fatte (D202). Scelte:

- **Stato amministrativo dall'anagrafica.** Il file AIFA `confezioni_fornitura.csv` ha la colonna «STATO_AMMINISTRATIVO»: nel file scaricato il 20/11/2026, 160.067 confezioni «Autorizzata» e 33 «Sospesa»; le confezioni revocate non ci sono. Campo nuovo `adminState` (mappature 2026-11-20.1, migrazione 0038). Nel sito d'esempio c'è una riga vera di ranitidina «Sospesa», copiata senza cambiare un byte.
- **Che cosa è una variazione**, per le terapie in corso con l'AIC, alla data e con le versioni in vigore:
  - _confezione sospesa_: l'anagrafica in vigore la dà «Sospesa»;
  - _uscita dall'anagrafica_: non c'è nell'anagrafica in vigore e c'era in una versione superata. Il testo dice «non è più nell'anagrafica», mai «revocata»: l'assenza non dice il motivo (D59);
  - _classe_: la scheda della terapia ha la classe A o H; la confezione era in quell'elenco in una versione superata e non c'è più nella versione in vigore della stessa serie. Se è nell'altro elenco, il testo dice la classe nuova;
  - _nota_: la nota della scheda era quella dell'elenco DPC in una versione superata, e l'elenco in vigore ne dice un'altra, o nessuna;
  - _piano_: l'elenco DPC in vigore chiede il piano, la terapia non ne ha uno collegato e una versione superata dell'elenco non lo chiedeva.
- **Perché il confronto con la scheda e con una versione superata.** Quando si sceglie il farmaco, la scheda della terapia registra classe e nota dalla banca dati. Confrontarle con i dati in vigore dice che cosa è cambiato per quella terapia. Chiedere che il dato della scheda si ritrovi in una versione superata evita di chiamare «variazione» una scheda scritta a mano o importata da un altro programma.
- **Quanto resta.** Nessuna soglia di giorni da inventare: la voce resta finché la terapia non è aggiornata o conclusa. Per classe e nota basta scegliere di nuovo il farmaco nella scheda, che riporta i dati in vigore; per il piano, collegarlo; per la confezione sospesa o uscita, passare a un'altra confezione.
- **Dove si vede.** In Oggi, «Variazioni AIFA sui farmaci in terapia»: una voce per farmaco e variazione, con i pazienti e il collegamento alla cartella. Poi nella cartella, sotto la terapia, e nella scheda, con come si chiude. La visibilità è quella delle carenze (D202): chi legge le terapie dell'archivio; le riservate, solo chi le legge.
- **Nella ricerca dei farmaci** la confezione sospesa si dice con simbolo e parola: «Confezione sospesa secondo l'anagrafica AIFA delle confezioni». Nessuna regola nuova alla ricetta: le regole vengono dai requisiti. Se serve un avviso alla ricetta, è una domanda per la fermata.
- **Fonti.** L'anagrafica e le liste di classe di AIFA, già importate; l'elenco DPC della Regione (trascrizione). La nota AIFA non ha ancora una fonte per AIC (D202): le variazioni di nota valgono per i farmaci dell'elenco DPC.

Prove nel servizio con versioni scritte a mano, nell'interfaccia e nel browser, con 17 sabotaggi. Non provato: due versioni vere dell'anagrafica o delle liste, una dopo l'altra (le prove usano versioni scritte a mano); quanto spesso AIFA sospende o toglie le confezioni.

**D206 · Registri di monitoraggio e piani terapeutici AIFA nei dati del farmaco.** È la seconda parte della scelta di Simone alla fermata dopo l'unione della #15 («Sia altre variazioni AIFA che registri AIFA»). La fonte è la pagina AIFA «Liste dei farmaci», che `sync/` già scarica per intero: l'elenco dei registri e dei piani attivi (`Elenco_Registri_PT_attivi_19.11.2026.csv`, letto il 20/11/2026). Scelte:

- **Che cosa si importa.** L'elenco dei registri attivi. Per ogni farmaco e indicazione:
  - il tipo di monitoraggio: «Registro» 327, «Registro semplificato» 23, «Piano Terapeutico» 19, «Registro 648/96» 4, «Registro - Legge 326/2003 (fondo 5%)» 1;
  - lo stato, la patologia, l'indicazione rimborsata, la data d'inizio e l'indirizzo della scheda.

  Non si importano l'indicazione autorizzata e le colonne MEA (gli accordi di rimborso fra AIFA e le ditte): per la prescrizione conta l'indicazione rimborsata. Non si importa nemmeno l'elenco dei registri chiusi.

- **Come si collega ai farmaci: per ATC.** Il file non ha l'AIC. Il principio attivo è scritto in modi diversi da un file all'altro: «Sacubitril e Valsartan» nei registri, «VALSARTAN/SACUBITRIL» nell'anagrafica. L'ATC invece è un codice, uguale nei due file. Così il registro di un farmaco di marca vale anche per gli equivalenti con lo stesso ATC. Il testo dice «per lo stesso ATC» e nomina il farmaco del registro; decide il medico (regola 3).
- **Le righe in fondo al file.** Il file vero finisce con 33 righe vuote o quasi. Due hanno un valore spurio («Nessuno» fra le colonne MEA, «quan» nel principio attivo) e non hanno il farmaco. Una riga senza un campo obbligatorio fermerebbe il file (D61), e l'aggiornamento di ogni notte non entrerebbe mai.
  - Opzione nuova delle mappature, `saltaRigheSenza`: le righe senza il farmaco si saltano, e il rapporto le conta («2 righe saltate perché senza name»).
  - Sul file vero intero: 374 registri, nessun problema, 2 righe saltate.
- **La scheda AIFA.** L'elenco dà l'indirizzo della scheda del registro o del piano (un archivio zip).
  - Il collegamento si mostra solo se l'indirizzo è in https su aifa.gov.it o su un suo sottodominio: un file importato non può mettere nel programma un collegamento verso un altro sito.
  - Nel file vero 361 indirizzi su 374 si collegano. Gli altri 13 sono in http: 12 su www.aifa.gov.it e uno sul vecchio agenziafarmaco.gov.it. Per quelli il collegamento non c'è, ma il resto della voce sì.
  - Il collegamento si apre in una scheda nuova, senza l'indirizzo della cartella.
- **Dove si vede.** Nella ricerca dei farmaci (ricetta, terapia, banche dati), una riga informativa in blu con il simbolo: «Registri e piani AIFA per lo stesso ATC: …». Nei dati del farmaco (Banche dati), ogni registro con tipo, stato, data, patologia, indicazione rimborsata e scheda. Nessuna regola nuova alla ricetta.
- **Sito d'esempio.** Righe vere del file del 19/11/2026: i due piani di ENTRESTO (adulti e pediatrico), LEQVIO (indicazione su più righe), NEMLUVIO (ATC fra spazi) e tre righe della coda. Nell'anagrafica d'esempio c'è anche una confezione vera di ENTRESTO, dal file del 20/11/2026.

Prove: lettura e mappatura, importazione e consultazione, indirizzo della scheda, interfaccia e browser, con 12 sabotaggi. Non provato:

- lo scaricamento con `sync/` dal computer dello studio (la pagina è la stessa delle altre liste AIFA);
- le schede zip, che non sono state aperte;
- gli indirizzi in http, che non sono stati provati né trasformati in https;
- se il collegamento per ATC basta per i farmaci in associazione che hanno un ATC di gruppo.

**D207 · Connessioni inattive chiuse da Postgres: si avvisa, il servizio non si ferma.** Il giro completo delle prove del 20/11/2026, notte, ha superato tutte le 1643 prove ma è uscito con un errore non gestito: «terminating connection due to administrator command», mentre una prova cancellava il suo database.

- **Causa.** Quando il gruppo di connessioni si chiude, pg-pool lo dà per chiuso prima che le connessioni lo siano davvero. Il `DROP DATABASE … WITH (FORCE)` della prova manda allora la chiusura a una connessione ancora aperta, e il gruppo la segnala con un evento «error» che nessuno ascoltava.
- **Lo stesso nel servizio.** Se Postgres si riavvia o la rete si interrompe, le connessioni inattive ricevono lo stesso errore, e un evento «error» senza ascoltatore ferma il processo.
- **Scelta.** Il gruppo ascolta l'evento e scrive un avviso con il messaggio di Postgres, che non contiene dati dei pazienti. Le richieste dopo aprono una connessione nuova.
- **Prova.** Una connessione inattiva chiusa con `pg_terminate_backend`: si avvisa e la richiesta dopo va. Un sabotaggio toglie l'ascoltatore e la prova diventa rossa.

**D208 · Aggiornare la scheda della terapia dalla banca dati.** Con le variazioni AIFA (D205), una variazione di classe o di nota si chiudeva solo scegliendo di nuovo il farmaco nella scheda della terapia. Ora nella scheda, sotto la variazione, il medico ha il pulsante «Aggiorna dalla banca dati».

- **Che cosa fa.** Classe, nota AIFA, DPC e gruppo di equivalenza vengono dalle banche dati in vigore oggi, come quando si sceglie il farmaco. Il resto della scheda (dose, date, opzioni) non cambia, e lo storico delle modifiche conserva i valori di prima.
- **Quando no.** Non per una terapia conclusa, né senza il codice AIC, né per un farmaco che non è nelle banche dati in vigore: il servizio lo dice e non cambia nulla.
- **Chi.** Il pulsante è del medico, come «Modifica»; il servizio chiede lo stesso permesso della modifica della terapia.
- **Non è una scelta della fermata.** Qualunque sia la risposta sulla domanda delle variazioni (fine con la terapia aggiornata, pulsante «Visto» o 30 giorni), il pulsante serve, perché aggiorna la scheda.

Prove: servizio (aggiornamento, rifiuti, archivio di un altro medico), interfaccia (medico e segreteria) e quattro sabotaggi. Non provato nel browser: la prova nel browser ha un solo aggiornamento delle banche dati d'esempio, quindi nessuna variazione di classe.

**D209 · Correzioni dopo una revisione indipendente della #17.** Prima dell'unione, un agente separato ha rivisto il codice della pull request #17 e ha trovato quattro difetti veri. Sono corretti, ciascuno con prove e sabotaggi:

1. **Riepiloghi della segreteria e voci riservate.** I riepiloghi della segreteria (D204) contavano ed esportavano anche le voci che il medico ha segnato «Riservata»: note del diario, vaccinazioni e ricette con la riga di una terapia riservata. Altrove la segreteria non le vede. Ora le voci riservate contano solo per chi le legge; il titolare le ha come prima. È la regola di sempre sulle riservate, non una scelta nuova: corregge «gli stessi riepiloghi del titolare» di D204.
2. **Registri AIFA modificabili.** La tabella dei registri (migrazione 0039) non aveva le due protezioni delle altre banche dati: niente modifiche, cancellazioni o svuotamenti. Ora le ha, e una prova controlla che ogni tabella delle banche dati le abbia, comprese quelle che verranno.
3. **Variazioni AIFA più lente col passare dei mesi.** Il calcolo leggeva una riga per ogni versione superata delle banche dati e la confrontava con ogni terapia. Le versioni non si cancellano e l'anagrafica ne ha una quasi ogni giorno, quindi Oggi sarebbe diventata più lenta ogni giorno. Ora il database riassume le versioni superate in una riga per farmaco, e le righe si cercano per codice: il tempo non cresce con il numero delle versioni. Le prove e gli otto sabotaggi del calcolo sono ripetuti sul codice nuovo.
4. **Connessioni in uso.** D207 copriva solo le connessioni ferme. Una transazione in corso quando Postgres si riavvia avrebbe fermato il processo. Ora ogni connessione ha il suo ascoltatore e scrive un avviso solo.

**D210 · R22: la ricetta informa sulla confezione sospesa.** Scelta di Simone alla fermata del 20/11/2026: «Regola che informa». Prima la confezione sospesa si vedeva nella ricerca dei farmaci, nella terapia e in Oggi (D205), non nella ricetta.

- **Che cosa dice.** Sulla riga del farmaco: «confezione sospesa secondo l'anagrafica AIFA delle confezioni», con la fonte. Le parole sono quelle dell'anagrafica: niente su che cosa fare (regola 3).
- **Quando.** Quando l'anagrafica in vigore alla data della ricetta dà la confezione «Sospesa» (colonna `STATO_AMMINISTRATIVO`). «Autorizzata», nessuno stato o nessuna riga non sono una sospensione. Una confezione uscita dall'anagrafica non è «sospesa»: la regola tace, e lo dicono le variazioni sulla terapia.
- **Come.** Come la R21: informa soltanto, non ferma l'invio e non chiede un motivo. Vale per ogni ricetta con il farmaco, anche bianca, perché lo stato della confezione non dipende dal SSN.
- **Versione.** Versione nuova delle regole, 2026-11-20.1, in vigore dal 20/11/2026. Le ricette controllate con le versioni di prima restano com'erano.

Prove: regole (`packages/rules/test/regole.test.ts`), servizio con la ranitidina «Sospesa» del sito d'esempio accanto all'amlodipina «Autorizzata» (`apps/api/test/banche-dati.test.ts`), interfaccia (`apps/web/test/regole-informative.test.tsx`), con 10 sabotaggi. Non provato: nel browser, perché la ricetta mostra i problemi delle regole tutti allo stesso modo; un'anagrafica vera con una confezione che passa da «Autorizzata» a «Sospesa».

**D211 · OCR-A per l'NRE e il codice fiscale in chiaro del promemoria.** Il DM 2/11/2011, allegato 2, chiede l'OCR-A per il testo in chiaro; da D97 era in Courier, «da completare con un carattere OCR-A di licenza compatibile». Non dipende né dalla Regione né da CSI, quindi si chiude ora («chiudi ciò che puoi chiudere»).

- **Il carattere.** `OCRA.ttf` di John Sauter (progetto «ocr-a-font»), dal pacchetto Debian `fonts-ocr-a` 1.0-10, copiato senza cambiarlo. Secondo le note dell'autore segue ANSI X3.17-1977. Licenza: pubblico dominio, secondo il file `copyright` del pacchetto. Fonte, impronta e condizioni sono in `apps/api/caratteri/ocr-a/` e in `docs/provenienze.md`.
- **Come si usa.** Il servizio lo incorpora nel PDF del promemoria, completo e «solo NRE», solo con i caratteri usati, sotto i due codici a barre (NRE e codice fiscale), a 10 punti come prima. Niente si scarica da fuori (regola 8). Per incorporarlo serve `@pdf-lib/fontkit` (MIT). Le ristampe restano identiche byte per byte.
- **Non verificato.** La corrispondenza con la forma chiesta dal decreto («OCR-A, ECMA, tipo 1») e la lettura con un lettore ottico: servono una stampa vera e la verifica in farmacia. Le posizioni sulla pagina restano quelle di oggi, in attesa delle specifiche di stampa del 1/3/2016 (D97).

Prove: il PDF incorpora l'OCR-A e non più il Courier (`apps/api/test/promemoria.test.ts`); il file ha l'impronta registrata e tutti i caratteri dell'NRE e del codice fiscale (`apps/api/test/carattere-ocr-a.test.ts`); due sabotaggi. Guardato a vista su un promemoria con dati inventati.

**D212 · Risposte della fermata dopo l'unione della #17.** Via alla #18, unita. Per le PPIP Simone ha risposto: «Ok adesso ma predisponiamo il tutto in modo che venga aggiornato dopo che regione e asl ci dicono come procedere». Interpretata così:

- **Elenco delle prestazioni come dato con versione e data di efficacia**, come le altre banche dati: l'allegato 6 dell'ACN in vigore, l'AIR del Piemonte e, quando l'ASL lo dirà, l'accordo aziendale. Un accordo nuovo è un file nuovo da importare, senza cambiare il codice.
- **Riepilogo del mese costruito dai dati registrati**, con un'esportazione il cui formato è anch'esso un dato. Quando Regione e ASL diranno come vogliono il riepilogo, si aggiunge il loro formato.
- **Invio predisposto**: un'interfaccia con un simulatore, come per SAR, Sistema TS e AURA. Il collegamento vero (portale regionale o strumento dell'ASL) si scrive quando arrivano le specifiche.

Allegati 2 e 3 del DPCM LEA: li manda Simone. Dicitura del tipo di accesso: «Lasciamo dicitura sistema ts»; vale quella del Sistema TS, già nel programma (D79), e il documento vivo dei requisiti non si tocca.

**D213 · Prestazioni aggiuntive: come sono costruite (D212).** Le scelte di dettaglio. Dove gli atti tacciono, la scelta è fatta qui e lo dice. Documento: `docs/ppip.md`.

- **Catalogo per giorno.** Vale il catalogo del giorno dell'esecuzione, con tutte le serie in vigore insieme: ACN, AIR e, quando ci sarà, l'accordo aziendale. Se lo stesso codice è in due serie, vale quella con la data di efficacia più recente: un accordo aziendale che cambia un compenso vale dalla sua data, e il passato resta com'era. Ogni prestazione registrata porta voce, compenso e versione della banca dati del suo giorno.
- **Codici scelti qui.** Lettera della sezione più numero della voce dell'allegato (A1–A12, B1–B4); `AIR35.4` per la trasfusione dell'AIR. Al posto degli asterischi c'è il testo delle note.
- **Controlli solo formali (regola 3).** La voce dev'essere nel catalogo di quel giorno; per la sezione B servono gli estremi dell'autorizzazione (comma 5); la data non può essere futura né dopo il decesso; luogo in studio o a domicilio (comma 2). La quantità va da 1 a 99: è un limite di formato, come D93, perché l'allegato non ne pone. Le condizioni di una voce (ADI, frigorifero, impianti fissi, autorizzazione complessiva delle vaccinazioni) non si controllano: le note della voce le ricordano.
- **Chi fa che cosa.** Registrano e annullano i medici con accesso all'archivio e la segreteria confermata (D185). La distinta la manda solo il titolare (`ppip.send`), come la firma. Restano nel registro degli accessi, paziente per paziente, le letture e le registrazioni, gli annullamenti, la distinta, il CSV e gli invii.
- **Niente si cancella.** Una prestazione si annulla con un motivo finché non è partita; dopo, la correzione si chiede all'ASL. Gli invii restano come sono partiti, con il contenuto mandato.
- **Distinta del mese.** Contiene le prestazioni non annullate dei pazienti dell'archivio. Scade il 15 del mese dopo (comma 4) e si manda dal primo giorno del mese dopo. Partono solo le prestazioni non ancora inviate; un invio non accolto, o un'ASL non raggiungibile, le lascia da inviare. L'indirizzo è quello di residenza, come sul promemoria. Il totale resta vuoto se una voce non ha il compenso.
- **CSV.** Il formato è un dato, in `apps/api/distinte/ppip-formati.json`. Oggi c'è il formato con i campi del comma 4, più codice, prestazione, quantità, luogo, autorizzazione e compenso. Il formato dell'ASL si aggiunge lì.
- **Invio.** C'è l'interfaccia `AdditionalServicesPortal` con il simulatore. In produzione, con il simulatore, l'invio è spento e resta il CSV.
- **Trascrizioni vere da controllare.** Hanno `controllato_da` vuoto, quindi non si usano finché una seconda persona non le confronta con gli atti (A8, D159). Chi le controlla è una domanda per la fermata.
- **Testi fedeli agli atti.** Per le prestazioni aggiuntive, l'AIR 2024 nomina il portale regionale solo fra i compiti dei medici ad attività oraria (art. 30, comma 1). Altrove rimanda a uno strumento su supporto digitale dell'ASL, «come previsto per le prestazioni di cui all'Allegato 6» (art. 36, comma 6, sulle visite occasionali). L'interfaccia dice soltanto questo.

Prove:

- servizio, `apps/api/test/ppip.test.ts` (13). Comprende un accordo aziendale inventato che cambia un compenso da una data;
- interfaccia, `apps/web/test/ppip.test.tsx` (4);
- browser, «prestazioni aggiuntive (D212)» in `apps/api/test/e2e/interfaccia.test.ts`.

31 sabotaggi, uno anche nel browser. Non provato: invio vero, formato dell'ASL, modulo regionale delle prestazioni multiple, controllo della trascrizione da parte di una seconda persona.

**D214 · Logo su fondo scuro: icona gialla con il segno blu scuro.** Domanda di Simone del 20/11/2026: il logo giallo si leggerebbe? Il giallo dell'evidenziatore (`#FFE45C`) dà questi contrasti:

- sul bianco, circa 1,3:1, quindi non si legge, e sulla carta sparisce;
- sul blu notte di SCRIPT, circa 14:1;
- come fondo, sotto il blu scuro, circa 10:1.

Proposta: il giallo come fondo di un'icona, con il segno blu scuro sopra; sul chiaro resta il segno blu. Simone: «ok, allora icona gialla col segno blu scuro per le versioni su fondo scuro».

- **Su fondo scuro** il segno è un quadratino giallo `#FFE45C` (angoli arrotondati) con al centro il segno nell'ombra di SCRIPT (`#1B237A`), che occupa tre quarti del lato. È la regola del giallo della palette (D69): solo come fondo, con sopra il blu scuro. Nella versione con il nome, il nome resta bianco.
- **Allineamento** (verifica chiesta da Simone). Il segno era centrato come ingombro (6,6 unità di margine su 32 da ogni lato), ma sembrava basso: il corpo della cartella pesa in basso e la punta è sottile. Il baricentro del tratto stava 1,76 unità sotto il centro, misurato su un disegno a 1024 px; di lato solo 0,3 unità, cioè centrato. Il segno ora sale di 0,9 unità, metà dello scarto (`productMark.onDark.raise`): sembra al centro, e la punta resta lontana dal bordo. Confrontati a vista quattro spostamenti (0; 0,9; 1,3; 1,76) a 16, 32, 64 e 128 px: con tutto lo scarto il segno sembra alto.
- **Su fondo chiaro** non cambia niente: il segno resta nella luce di SCRIPT (`#4D6BFE`), anche nell'interfaccia, che ha solo il tema chiaro (D11).
- **Favicon**: nel tema chiaro del browser resta il segno blu; nel tema scuro diventa l'icona gialla (`prefers-color-scheme` dentro l'SVG). Chrome, Edge e Firefox la seguono; Safari non mostra le favicon SVG nelle schede.
- **File**: `segno-su-scuro.svg`, `con-nome-su-scuro.svg` e la tavola `tavola-su-scuro.svg` in `packages/brand/assets/logo/`, generati da `pnpm --filter @mmg/brand logo:proposte` con i valori di `productMark.onDark` (`packages/brand/mark.ts`). Le proposte della prima fermata restano com'erano, come traccia.

Prove (`packages/brand/test/logo-scelto.test.ts`):

- i file su scuro hanno l'icona gialla e il segno blu scuro;
- il segno sul giallo e il giallo sul fondo scuro superano 7:1;
- nell'icona il segno è centrato di lato e alzato di `raise`, con la punta ad almeno tre quarti del margine di lato;
- la favicon cambia nel tema scuro.

Sei sabotaggi. Guardato a vista nei due temi a 16, 32 e 64 px. Non provato: l'icona su un tablet vero, e le favicon in Safari.

**D215 · Risposte della fermata dopo l'unione della #18.** Via alla #19, unita. Il controllo delle 17 voci trascritte delle PPIP e il modo in cui la Dr.ssa Rocca manda oggi la distinta si fanno alla fine, con le altre verifiche (`docs/avanzamento.md`, «Che cosa resta aperto», B2). Fino al controllo, il catalogo vero delle PPIP resta spento (A8). Il resto aspetta i file di Simone (allegati 2 e 3 dei LEA) e le risposte di Regione, ASL e CSI.

**D216 · Modifiche del 2026 ai LEA, verificate sulla Gazzetta (D124).** I due decreti sono nella GU n. 227 del 30/9/2026, serie generale, che si scarica da gazzettaufficiale.it: il DPCM 7 agosto 2026 alle pagine 20–22, il DM 3 agosto 2026 alle pagine 43–47. Entrambi entrano in vigore il trentesimo giorno dopo la pubblicazione, cioè il 30/10/2026. La Gazzetta pubblica gli articoli; gli allegati sono sulla pagina LEA del Ministero (avvertenza in fondo a ciascun decreto), che da qui risponde con un controllo anti-robot.

Che cosa cambiano, secondo gli articoli dei decreti:

- **DPCM 7/8/2026**: allegato 1 (screening), allegati 4 e 4D (nomenclatore e note), allegato 5 (protesica, elenchi 1 e 2B), allegato 8 (malattie croniche: condizioni nuove, tabella di corrispondenza, prestazioni; allegato D, fogli D–D4) e allegato 10B (gravidanza).
- **DM 3/8/2026**: gli articoli 11, 14, 17, 18, 27, 33, 35 e 38 del DPCM (con il suo allegato 1); l'allegato 2 «Ausili monouso» (allegato M, fogli M1–M4); l'allegato 11 sui dispositivi medici monouso e l'allegato 12 sulla protesica (allegato V); gli allegati 1, 4 e 4D, 5, 7 (malattie rare, allegato R, fogli R1–R6), 8 (allegato D, fogli D1–D4) e 10B; sostituisce gli allegati 6A e 9.

Che cosa vuol dire per il programma:

- **Presidi** (D121–D123): l'art. 11 (dispositivi medici monouso), l'allegato 2 e l'art. 14 (prodotti dietetici) cambiano; l'art. 13 (presidi per diabetici e malattie rare) e l'allegato 3 no. Le categorie restano: citano articoli e allegati, non il loro testo. Quando Simone manda l'allegato 2 aggiornato (o l'allegato M), l'allegato 11 e l'allegato 1 del DM, si trascrivono come gli allegati 7 e 8. L'allegato 3 si trascrive dalla Gazzetta del 2017 (D217).
- **Esenzioni**: le trascrizioni degli allegati 7 e 8 vengono dai PDF della pagina del Ministero (versione del 29/9/2026) e valgono dal 30/10/2026. I fogli R e D dei decreti servono a controllare che quei PDF abbiano già le modifiche.
- **Nomenclatore**: nelle ricette vale il catalogo regionale, che la Regione aggiorna con le sue determinazioni (dal 30/10/2026 la D.D. 710/2026, D159). Qui non cambia niente.

Non verificato: il testo degli allegati dei due decreti.

**D217 · Promemoria secondo le specifiche di stampa del Sistema TS (28/02/2024).** Trovate sul portale del Sistema TS il 20/11/2026: «Specifiche tecniche per la stampa del promemoria della ricetta dematerializzata (D.M. 2 novembre 2011)», versione 28/02/2024, 22 pagine. È il documento che D97 non aveva trovato; la versione del 1/3/2016 è superata. Il modello vale in tutta Italia, sostituisce quello dell'allegato tecnico del DM e i modelli regionali.

Che cosa cambia nel promemoria:

- **Mezzo foglio A4.** La pagina resta A4 e il promemoria ne occupa la metà alta (148,5 mm). Stampato al 100%, i codici a barre restano delle misure giuste; una pagina di mezzo A4 molte stampanti la ingrandirebbero.
- **Campi e diciture del facsimile nr. 0**, con i loro numeri:
  - intestazione e riquadro della Regione (1), NRE (2), assistito (3–9), esenzione e altri dati della ricetta (10–16);
  - area delle prescrizioni (17–20), quesito (21), totale, tipo ricetta, data e medico (22–27);
  - dicitura «Rilasciato ai sensi dell'art.11, comma 16 del DL 31 mag 2010,n.78 e dell'art.1, comma 4 del DM 2 nov 2011», frase regionale (28).
- **NRE in due codici a barre separati**, i primi 5 caratteri (Regione e raggruppamento del lotto) e il resto. Le barre sono alte 8 mm, e sotto c'è il valore tra asterischi in OCR-A (D211); lo stesso vale per il codice fiscale.
- **Modulo del codice a barre di 0,254 mm**, prima 0,339. Il codice fiscale deve stare nello spazio del modello accanto al nome, e così resta sopra il minimo di 0,240 mm del DM.
- **Diciture delle specifiche**: dati oscurati, «SUGG» e «RICOV», priorità in parole, «PRIMO ACCESSO» e «ALTRA TIPOLOGIA DI ACCESSO», «PRESCRIZIONE VALIDA 180 GIORNI AI FINI DELLA PRENOTAZIONE», «---» per la nota non compilata, «Assist. SSN».
- **Area delle prescrizioni fissa.** È grande come nel facsimile nr. 0, si disegnano solo le righe usate e i campi dal 21 non si spostano. Se le righe non ci stanno, il carattere scende fino a 6 punti.
- **Farmaci.** Prima il gruppo di equivalenza, con codice e denominazione: principio attivo e confezione di riferimento della lista di trasparenza AIFA in vigore alla data. Poi l'AIC con il nome. Infine «NON SOSTITUIBILE - motivazione».
- **Specialistica**: «codice nomenclatore (codice catalogo) – descrizione», con i codici proprio come sono partiti (D154).
- **Farmaci in DPC.** La frase arriva con il messaggio 0196 della ricevuta e si stampa sotto l'ultima prescrizione, centrata. L'interfaccia delle integrazioni porta ora i messaggi della ricevuta; il simulatore li dà solo nelle prove.

Scelte, dove le specifiche tacciono o il programma non ha il dato:

- **Tipologia S o H (campo 14)**: una per ricetta, e c'è solo se tutte le prescrizioni la hanno uguale. Prima si stampava per riga.
- **Piemonte** (SIRPE, «Cartelle cliniche MMG e PLS», 4.4.3): nel campo 27 il codice regionale davanti al nome. Da verificare al collaudo, perché le specifiche nazionali vogliono lo stesso modello in tutta Italia.
- **Validità di 180 giorni**: è il valore delle specifiche. Un valore minore comunicato dal Piemonte non è noto (A1).
- **Campi vuoti**, come vogliono le specifiche quando il dato manca:
  - disposizioni regionali (13), «Altro» (15), frase regionale (28);
  - ambulatorio di erogazione, televisita, note e numero di sedute (18A);
  - note del DM 9/12/2015 (20, che stampa «---»);
  - codice ICD-9-CM nel quesito (21): il programma scrive il quesito come testo.
- **Tipo ricetta (23).** Il messaggio di invio porta solo ricette di assistiti del SSN, quindi si stampa «Assist. SSN». Gli altri tipi (UE, EE, ST, NA…) sono da completare con l'adattatore vero. Per gli assicurati esteri il promemoria stampa istituzione e tessera, con le etichette del facsimile nr. 4.
- **Foglio «solo NRE»**: stesse misure e stessi codici a barre, con data, medico, codice di autenticazione e dicitura.

Ristampe: i dati del promemoria hanno una versione. Quelli fissati prima (versione 1) si ristampano con il modello di prima, uguali byte per byte; una prova ne controlla l'impronta. I nuovi sono della versione 2.

Prove (`apps/api/test/promemoria-modello.test.ts`, `apps/api/test/promemoria.test.ts`):

- versione 1 identica;
- NRE in due parti con gli asterischi;
- misure delle barre;
- tutto nella metà alta e campi dal 21 fermi;
- diciture uguali al testo delle specifiche;
- gruppo di equivalenza, AIC, non sostituibile e frase DPC;
- codici e righe della specialistica;
- SUGG.

28 sabotaggi. Guardati a vista quattro promemoria con dati inventati: farmaci, specialistica con otto righe lunghe, dati oscurati con assicurato estero, solo NRE. I tre codici a barre letti con un lettore indipendente (ZXing, solo per la prova, fuori dal repository) a 300 e 600 punti per pollice. Non provato: la stampa vera e la lettura in farmacia.

**D218 · Nomenclatore dei presidi: l'allegato 3 del DPCM LEA come banca dati.** D123 aveva lasciato «da completare» i codici del nomenclatore dei presidi (allegati 2 e 3). Simone doveva mandare i due allegati dalla pagina del Ministero, che da qui non si legge. La Gazzetta del 2026 dice però che i decreti di agosto non toccano né l'art. 13 né l'allegato 3 (D216). Quindi l'allegato 3 si prende dalla Gazzetta del 2017, che da qui si scarica: supplemento ordinario n. 15 alla GU n. 65 del 18/3/2017, pagine 52 e 53.

- **Tipo di banca dati nuovo**, `presidi`, con tabella `ref_supply` (migrazione 0041, non si modifica e non si svuota). Una voce è un presidio con il suo codice, oppure una delle malattie rare che danno diritto ai presidi dell'allegato. Ogni voce ha il titolo del suo gruppo e il numero dell'allegato. L'allegato 2 (ausili monouso, con le modifiche del DM 3/8/2026) entrerà come serie dello stesso tipo.
- **La trascrizione** (`lea/allegato-3-presidi`): 18 presidi in 10 gruppi e 12 malattie rare, in vigore dal 19/3/2017, il giorno dopo la Gazzetta. Testo e codici come stampati. Controllata così:
  - ogni cella si ritrova nel testo del PDF;
  - ogni codice sta sulla riga della sua descrizione;
  - le due pagine sono state guardate come immagine.

  Resta **da controllare** da una persona, e fino ad allora non si usa (A8).

- **Nel programma**: nella prescrizione dei presidi per diabetici si sceglie la voce dal nomenclatore in vigore, e prodotto e codice si riempiono da soli. Si può sempre scrivere a mano, come prima. Sotto la scelta c'è l'elenco delle malattie rare dell'art. 13, solo come informazione: il diritto lo accertano le Regioni (art. 13, comma 2), e il programma non lo controlla.
- **Le categorie dicono il loro allegato**: per diabetici il 3, monouso il 2. Una categoria senza nomenclatore trascritto resta a testo libero.
- **Rotta** `GET /api/presidi/nomenclatore`: dati pubblici, come le categorie. Se una voce è in due serie, vale la più recente.

Prove:

- trascrizione (`packages/reference/test/lea.test.ts`, 4);
- servizio, con tre serie inventate: una vecchia, una più recente e una di domani (`apps/api/test/seguito-presidi.test.ts`);
- interfaccia (`apps/web/test/presidi.test.tsx`, 3).

15 sabotaggi. Non provato: nel browser e nelle schermate, perché i dati dimostrativi non hanno il nomenclatore.

**D219 · Risposte della fermata dopo l'unione della #19.** Via alla #20, unita. Nel campo 27 del promemoria resta il codice regionale davanti al nome (D217), da confermare al collaudo con il CSI. Per aprire il Fascicolo dalla cartella Simone ha risposto: «predisponilo subito ma poi chiediamo al CSI». Si costruisce con un simulatore sul modulo regionale del 2019 (D220); se valga ancora con l'autenticazione forte è una domanda per il CSI (`docs/avanzamento.md`, «Che cosa resta aperto», A4).

**D220 · Aprire il Fascicolo regionale dalla cartella.** Risposta di Simone alla fermata dopo l'unione della #19 (D219): «predisponilo subito ma poi chiediamo al CSI». Fonte: CSI Piemonte, «Modulo regionale di accesso semplificato dalle CCE – Specifiche di integrazione dei servizi di accesso», V03, settembre 2019 (`docs/fse.md`).

- **Come funziona, dalle specifiche.** La cartella chiama il servizio `getAuthentication` con:
  - le credenziali RUPAR del medico;
  - il ruolo (MMG) e l'applicazione (DMAWA);
  - l'IP della postazione e il codice fiscale del paziente.

  Il servizio controlla le credenziali e chiede al Fascicolo se il paziente c'è e se ha dato il consenso alla consultazione. Se va bene dà un token, e la cartella apre la pagina regionale con quel token. Il token vale una volta, e solo dall'IP dichiarato.

- **Nel programma**: nella cartella, per i medici, «Fascicolo regionale». La pagina ha il filtro dei documenti delle specifiche (TIPO_DOCUMENTO, 16 tipi, scritti come una frase) e il pulsante «Apri il Fascicolo». La scheda nuova si prepara al clic, staccata dalla cartella (`opener` nullo), poi riceve l'indirizzo. Se il browser la blocca, resta un collegamento che vale una volta.
- **Chi lo apre**: il medico sul suo archivio e il sostituto su quelli autorizzati (permesso `fse.consult`), ognuno con le sue credenziali RUPAR. Segreteria e amministratore no. Ogni richiesta resta nel registro degli accessi alla cartella (`apertura_fascicolo_regionale`).
- **Errori**: i codici delle specifiche arrivano al medico con le loro parole. Quando la Regione rifiuta le credenziali (AUTH_ER_501), il rifiuto si annota come per gli invii (D102) e la pagina porta a «Credenziali dei servizi».
- **Simulatore** (regola 7). Tiene i token in memoria, monouso e legati all'IP, e mostra una pagina del programma al posto di quella regionale. La pagina della cartella dice che il collegamento è simulato. In produzione, con il simulatore, l'apertura è spenta.
- **Secondo fattore**: il modulo del 2019 chiede utente, password e PIN RUPAR, senza secondo fattore. Con l'autenticazione forte di oggi (D102, D109) è la domanda per il CSI (A4): se il modulo vale ancora, e con quali credenziali.

Prove: `packages/integrations/test/fascicolo-regionale.test.ts` (5), `apps/api/test/fascicolo-regionale.test.ts` (8), `apps/web/test/fascicolo-regionale.test.tsx` (7), e la prova nel browser. Nel browser si controllano accessibilità, bersagli di 44 px e tablet; la scheda nuova con la pagina simulata, staccata dalla cartella; il token già usato, rifiutato. 14 sabotaggi. Non provato: il servizio vero del CSI e la pagina regionale vera.

**D221 · Dimostrazione nel browser.** Richiesta di Simone del 20/11/2026: «per iniziare a testare il programma mi restituisci un artifact?». Un artifact è una pagina su claude.ai, senza servizio e senza database. Per provare il programma vero e non un'imitazione, gira tutto nel browser (pacchetto `apps/demo`):

- **Interfaccia** di `apps/web` senza modifiche; **servizio** di `apps/api` in un Web Worker, con `buildApp` e i simulatori di sempre (regola 7).
- **Database**: PGlite, cioè Postgres compilato in WebAssembly (licenze Apache-2.0 e PostgreSQL, permissive). Le 43 migrazioni e le banche dati d'esempio di `sync/` si preparano in Node durante la costruzione. I dati dimostrativi si creano nel browser all'avvio, con le date di quel giorno: `seedDemo` (`apps/api/src/db/demo-seed.ts`), separato da `pnpm db:seed` senza cambiarlo.
- **Moduli di Node che il browser non ha**: sostituti in `apps/demo/src/worker/shims`. Crypto con @noble/hashes e @noble/ciphers (MIT); RSA dei certificati di prova del Fascicolo con i BigInt e una scorta di chiavi nuove a ogni costruzione; un disco in memoria con i file che il servizio legge; un server HTTP finto che passa le richieste al gestore di Fastify.
- **Limiti della cornice**: dentro un artifact non si aprono schede, non si scarica e non si stampa. PDF e file si aprono in un visore della pagina (pdf.js, Apache-2.0) con la filigrana «DIMOSTRAZIONE – DOCUMENTO NON VALIDO»: i numeri sono inventati ma i moduli somigliano a quelli veri. Le pagine dei simulatori di SPID e CIE si aprono nel visore; il ritorno al programma fa ripartire l'interfaccia, come farebbe il ricaricamento della pagina.
- **Riquadro della dimostrazione**: utenti, password unica `dimostrazione` (non è un segreto: la mostra la pagina), codice del secondo fattore di chi sta entrando, ripartenza da capo.
- Nessun dato esce dal browser; ricaricando la pagina si riparte da capo.

`apps/demo` è uno strumento di prova, non parte del prodotto: le sue dipendenze sono di sviluppo (la prova delle licenze guarda quelle di produzione). Pagina di 1,9 MB e file accanto per circa 25 MB. Quando il programma cambia si ricostruisce (`pnpm --filter @mmg/demo build`) e si ripubblica sullo stesso indirizzo.

**D222 · Promemoria su carta A5 per difetto.** Richiesta di Simone del 20/11/2026: «le ricette dematerializzate (al netto di alcune tipologie) vengono stampate di solito su carta A5 o sbaglio? direi di predisporre pdf di stampa direttamente su A5 per evitare margini di carta bianca inutili». Le specifiche del 28/02/2024 vogliono il promemoria grande metà foglio A4 (D217): è un A5 orizzontale, 210 × 148 mm.

- **Per difetto, A5 orizzontale.** Il promemoria completo e il foglio «solo NRE» escono su una pagina A5 orizzontale. Misure e campi sono quelli di D217, alle stesse distanze dal bordo alto e da quello sinistro.
- **A4 resta una scelta**, per le stampanti senza cassetto A5: in Strumenti › Stampa, per lo studio o per una postazione. Il promemoria sta allora nella metà alta della pagina, come prima.
- **Chi decide la carta**: le preferenze di stampa (D180), nell'ordine postazione, studio, A5. Vale anche per l'email al paziente: l'allegato ha la carta della postazione di chi lo invia.
- **Supera il punto «Mezzo foglio A4» di D217.** Lì la pagina restava A4 perché molte stampanti, con l'A4 nel cassetto, ingrandiscono una pagina più piccola. Il rischio resta per chi stampa l'A5 su carta A4 con «adatta alla pagina»: i codici a barre escono 1,41 volte più grandi delle misure del decreto. Per questo c'è la scelta A4, e il PDF si stampa al 100% («dimensioni effettive»).
- **Margini sull'A5**: 8 mm a sinistra e a destra. La base della prima riga è a 7 mm dal bordo alto, quella della dicitura finale a 141,2 mm, cioè 6,8 mm sopra il bordo basso. La frase regionale (campo 28) avrebbe la base a 144,8 mm, 3,2 mm sopra il bordo basso, dentro la striscia che molte stampanti non stampano. Oggi è sempre vuota (D217): se il Piemonte la chiederà, va guardata su carta.
- **Che cosa non cambia**:
  - i promemoria fissati prima del 20/11/2026 (versione 1) si ristampano su A4, uguali byte per byte;
  - il promemoria della ricetta bianca elettronica è il PDF del Sistema TS, consegnato com'è (D93);
  - il certificato INPS resta A4, sui fac-simile del DM 26/2/2010;
  - i certificati dai modelli avevano già la scelta tra A4 e A5;
  - la ricetta rossa non ha ancora il suo modulo di stampa («da completare»): si stampa sul modulo ufficiale, con la sua misura.
- **Nel pannello del promemoria**, sotto i pulsanti: la carta che vale alla postazione e «Stampa al 100% («dimensioni effettive»), senza adattare alla pagina».
- **Una sola fonte per la carta predefinita**: il tipo di documento `promemoria` in `packages/domain/src/printing.ts`. Il PDF (`apps/api/src/reminders/pdf.ts`) la legge da lì.

Prove:

- `apps/api/test/promemoria-modello.test.ts`: pagina A5 per difetto con tutte le scritte dentro; su A4 le stesse scritte alle stesse distanze dall'alto, nella metà alta; la versione 1 sempre su A4;
- `apps/api/test/promemoria.test.ts`: dal servizio A5, poi A4 quando lo studio sceglie A4, anche per l'allegato dell'email, poi di nuovo A5;
- `packages/domain/test/printing.test.ts` e `apps/api/test/stampa.test.ts`: per il promemoria si sceglie A5 o A4, mai altro;
- `apps/web/test/stampa.test.tsx`: il pannello del promemoria dice la carta che vale alla postazione e di stampare al 100% («dimensioni effettive»).

6 sabotaggi. Non provato: la stampa vera su A5 e su A4 con stampanti diverse, e la lettura dei codici in farmacia.

**D223 · Risposte della fermata dopo l'unione della #20.** Via alla #21, unita con le verifiche su GitHub verdi. Per la conferma del CSI sul modulo di accesso al Fascicolo del 2019 Simone ha risposto «Rimandiamo»: resta in «Che cosa resta aperto» (A4), e il programma usa il simulatore, spento in produzione (D220). Mentre si aspettano i file dei LEA e le risposte di Regione, ASL e CSI: «Dimostrazione completa». Nell'artifact (D221) si rende provabile tutto il programma, compresi certificati, importazione, strumenti e AURA, con prove automatiche della dimostrazione anche su WebKit (Safari) e Firefox.

**D224 · Dimostrazione completa.** Risposta di Simone alla fermata (D223): nella dimostrazione (D221) si prova tutto il programma, con prove automatiche anche su Safari e Firefox.

- **AURA simulata con i pazienti dimostrativi** (`apps/demo/src/worker/aura.ts`):
  - all'avvio i pazienti si iscrivono nel simulatore e si collegano;
  - poi arrivano le variazioni, che si vedono in «Oggi»: un'esenzione 013 per un paziente diabetico, un'ASL diversa e un decesso da confermare, una scelta cessata che fa revocato il paziente, un nuovo assistito da registrare;
  - il riquadro della dimostrazione dice chi sono;
  - non c'è il cambio di medico dentro lo studio (D200): lo studio dimostrativo ha un solo titolare.
- **Conferme e stampa nella cornice** (`apps/demo/src/dialogs.ts`). Nell'artifact il browser non apre le sue finestre: `window.confirm` risponde subito «no» e `window.print` non fa nulla.
  - Nella cornice la domanda compare subito in un riquadro della pagina, senza provare la finestra del browser. Safari, che non la apre, segnala il tentativo come errore della pagina: lo ha trovato la prima prova su WebKit. Con «Conferma» il clic si ripete e passa.
  - Nella cornice la stampa mostra un avviso, senza chiamare la stampa del browser.
  - Fuori dalla cornice le finestre del browser funzionano come sempre. Se una conferma risponde «no» prima che una persona possa leggere la domanda, la finestra era bloccata: la domanda passa nel riquadro.
- **Una sessione sola con il database** (`apps/demo/src/worker/database.ts`). PGlite ha una sola sessione: mentre una transazione è aperta, ogni altra query aspetta che finisca. Il servizio è scritto per Postgres, con più connessioni, e in qualche punto usa `db` dentro una transazione. «Registra» un nuovo assistito da AURA, per esempio, crea il paziente e cerca il comune con `db`: nella dimostrazione tutto si fermava.
  - Ora ciò che arriva mentre una transazione è aperta entra in quella transazione, e le transazioni dentro diventano punti di salvataggio.
  - Perché sia giusto, le richieste dell'interfaccia passano una alla volta.
  - Le variazioni di AURA dell'avvio si applicano con due giri in fila, prima che il servizio ascolti. Il nuovo assistito arriva dopo, con una notifica sola.
- **Prove della dimostrazione costruita** (`apps/demo/prove/dimostrazione.e2e.ts`, `pnpm --filter @mmg/demo test:browser`).
  - La pagina gira dentro un iframe con la sandbox dell'artifact: niente finestre del browser, niente schede nuove, niente download.
  - 15 prove: avvio, accesso con il codice del riquadro, AURA, ricetta con SPID simulato e promemoria su A5, certificato, ricetta dalla banca dati, voci cliniche e Profilo sanitario firmato, specialistica e seguito con il referto, prestazioni aggiuntive, ripetizione della segreteria, Fascicolo regionale, stampa, riepiloghi in CSV, importazione, strumenti con la conferma nella pagina.
  - Accessibilità (axe) e bersagli di 44 px del riquadro, del visore e della conferma. In tutto il giro nessun errore della pagina né del servizio, e nessun messaggio d'errore nella console, nemmeno quelli del browser sulle finestre bloccate.
  - Nella CI c'è una parte apposta, «Dimostrazione con …», che costruisce e prova con Chromium, WebKit e Firefox.
  - Restano fuori da `pnpm test`, perché vogliono la dimostrazione costruita.

Non provati nella dimostrazione: AFT (servono due studi), esportazione completa (un archivio che il visore non apre), «Aggiorna adesso» delle banche dati (nel browser non c'è `sync/`), cambio di medico dentro lo studio. La dimostrazione dentro la cornice vera di claude.ai e sul tablet resta da provare a mano.

**D225 · Risposte della fermata dopo l'unione della #21.** Via alla #22, unita con le verifiche su GitHub verdi. Dopo l'unione Simone ha scelto «Sia punto 1 che 2».

1. **Transazioni del servizio.** «Registra» un nuovo assistito da AURA crea il paziente fuori dalla transazione della registrazione. Lo ha mostrato la dimostrazione, dove PGlite ha una sola sessione (D224). Si porta dentro, e un controllo nelle prove cerca nel servizio gli altri punti che usano il database fuori dalla transazione aperta.
2. **AFT e cambio di medico nella dimostrazione.** Un secondo studio e un secondo medico titolare, per provare la condivisione nell'AFT (D161) e il cambio di medico dentro lo studio (D200).

**D226 · Una transazione sola per «Registra», e il controllo delle transazioni nelle prove.** Primo punto della risposta di Simone alla fermata (D225).

- **«Registra» un nuovo assistito da AURA** (`apps/api/src/http/aura-routes.ts`): il paziente e l'assistito «registrato» entrano insieme o per niente. Prima il paziente nasceva in una transazione sua: se l'ultimo passo non riusciva, il paziente restava e l'assistito risultava ancora «da registrare».
  - La creazione del paziente lavora nella transazione di chi chiama (`createPatientIn`). «Nuovo paziente» apre la sua, come prima.
  - I rifiuti escono con la loro riga del registro (`Refusal`) e si scrivono dopo il ritorno indietro (`settleRefusal`): permesso negato, archivio chiuso, codice fiscale già registrato. Dentro la transazione la riga tornerebbe indietro. Scritta con un'altra connessione, aspetterebbe la fine della transazione se questa ha già scritto nel registro: la catena delle righe tiene un blocco fino alla fine (migrazione 0002).
  - Il comune di nascita si cerca prima della transazione. Se intanto AURA cambia il codice fiscale, la risposta è 409: «AURA ha cambiato il codice fiscale: ricarica la pagina».
- **Controllo delle transazioni** in ogni prova del servizio (`apps/api/test/helpers/transaction-guard.ts`). Se il servizio chiama il database (`db`) mentre una transazione è aperta, la prova fallisce e dice il punto del codice e dove si è aperta la transazione.
  - Le uscite volute vanno in `ALLOWED`, con il motivo: oggi nessuna.
  - Con `CONTROLLO_TRANSAZIONI=annota` le annotazioni si scrivono in un file (`CONTROLLO_TRANSAZIONI_FILE`), senza far fallire.
  - Sulle 807 prove del servizio di allora trovava solo «Registra».
  - Una lettura dei tipi di tutto il servizio (151 file) ha trovato lo stesso punto: `createPatient(db…)` e la ricerca del comune dentro la transazione. Le altre segnalazioni erano l'orologio (`deps.now()`), che non tocca il database.
- Nella dimostrazione resta la sessione sola di `database.ts` (D224), come protezione.

Non provati: i percorsi che le prove non percorrono, guardati solo dalla lettura dei tipi, che non vede un servizio che tiene `db` dentro una funzione; due registrazioni dello stesso codice fiscale nello stesso istante (il 409 «appena stato registrato» non ha una prova, né prima né ora).

**D227 · AFT e cambio di medico nella dimostrazione.** Secondo punto della risposta di Simone alla fermata (D225). Tutto in `apps/demo/src/worker/colleghi.ts` e in AURA simulata (`aura.ts`), con i servizi del programma: i dati dimostrativi di `seedDemo`, che usano anche `pnpm db:seed` e le prove, non cambiano.

- **Una collega titolare nello studio dimostrativo**, la Dott.ssa Sara Galli, con il suo archivio. Con due titolari attivi lo studio è una medicina di gruppo, come vuole Strumenti › Studio.
  - In AURA simulata un paziente della Dott.ssa Marchi sceglie la collega. È il più giovane senza ricette né certificati aperti, perché quelli fermano lo spostamento (D200).
  - In «Oggi», «Cambi di medico nello studio», la Dott.ssa Marchi lo sposta, e la collega lo trova nel suo archivio.
- **Un altro studio nella stessa AFT**, con il Dott. Luca Rinaldi e un suo paziente inventato. Il paziente ha dato il consenso alla condivisione, anche dei dati precedenti.
  - Il Dott. Rinaldi condivide i suoi pazienti. La Dott.ssa Marchi, come per difetto, no: chi prova può accendere la condivisione e registrare il consenso di un suo paziente.
  - In Strumenti › AFT la Dott.ssa Marchi consulta la scheda con il codice fiscale e il motivo. Il Dott. Rinaldi vede la consultazione nel suo registro.
- Il riquadro della dimostrazione elenca i due utenti nuovi, `collega` e `medico.aft`, con la stessa password. Dice anche chi ha scelto la collega e quale codice fiscale consultare.
- In AURA simulata ci sono solo i pazienti dello studio dimostrativo.
- Prove: due nuove nella cornice, 17 in tutto, e quattro sabotaggi.

Non provati nella dimostrazione: «Non spostare»; l'attività svolta registrata da un collega dell'AFT; la consultazione al contrario, del Dott. Rinaldi sui pazienti della Dott.ssa Marchi, che vuole prima la condivisione e un consenso.

**D228 · Risposte della fermata dopo l'unione della #22.** Via alla #23, unita con le verifiche su GitHub verdi. Dopo l'unione Simone ha scelto «Prove che mancano»:

1. la lettura dei tipi del servizio (D226) diventa una prova fissa, per i percorsi che le prove non percorrono;
2. le prove che mancano: «Non spostare» e l'attività svolta nell'AFT nella dimostrazione, due registrazioni dello stesso codice fiscale nello stesso istante;
3. le prove lanciate più volte, per trovare altre prove instabili come le due corrette nella #23.

**D229 · Le prove che mancano.** Risposta di Simone alla fermata (D228), nello stesso branch ripartito da `main`.

1. **La lettura dei tipi è una prova fissa** (`apps/api/test/controllo-transazioni-tipi.test.ts`). Con il compilatore di TypeScript legge tutto `src/` del servizio e cerca, dentro i callback di `withActor` e di `db.transaction`:
   - un valore di tipo `Database`, o `Database | Tx`: per esempio `createPatient(db, …)`;
   - la chiamata a un servizio fatto come classe che tiene un `Database`, come `ReferenceData`;
   - la chiamata a una funzione del servizio che usa un `Database` preso da fuori, anche attraverso altre funzioni, fino a quattro passi: per esempio una funzione dell'ambiente delle rotte.

   Oggi non trova niente. Le uscite volute vanno in `ALLOWED`, con il motivo. Guarda anche i percorsi che le prove non percorrono, e completa il controllo che gira nelle prove (D226). Non segue i servizi fatti di funzioni che tengono `db` dentro di sé, come `createAuraService({ db })`: quelli li vede il controllo nelle prove. Tre sabotaggi.

2. **Due registrazioni dello stesso codice fiscale nello stesso istante.** Tutte e due passano il controllo del doppione, perché nessuna ha ancora finito; l'indice unico dello studio ferma la seconda.
   - Prima la seconda riceveva «Il codice fiscale è appena stato registrato per un altro paziente», e il suo rifiuto non entrava nel registro degli accessi.
   - Adesso, dopo il ritorno indietro, riceve la risposta del doppione di sempre: il paziente, con il collegamento alla cartella, o «in un archivio che non puoi vedere». Il rifiuto entra nel registro di quel paziente, come gli altri (D226). Scelta presa da sé: il registro tiene ogni rifiuto (regola 5), e chi arriva secondo ha bisogno dello stesso aiuto di chi arriva dopo.
   - Vale per «Nuovo paziente», per «Registra» di AURA (l'assistito esce dall'elenco, come con il doppione di sempre) e per la correzione del codice fiscale.
   - Conta come doppione solo l'indice del codice fiscale dello studio (`patient_studio_fiscal_code_key`). Un altro errore di unicità resta un errore del servizio.
   - Le prove usano un cancello (`apps/api/test/helpers/cancello.ts`). Un trigger ferma la scrittura di quel codice fiscale, dopo il controllo, su un blocco che la prova tiene; la prova fa scrivere le richieste una dopo l'altra, nell'ordine scelto, e l'esito è sempre lo stesso.
   - Cinque gare: nello stesso archivio, in due archivi, la correzione dopo un paziente nuovo e il contrario, «Registra» dopo «Nuovo paziente». Sei sabotaggi.

3. **Nella dimostrazione**, 19 prove invece di 17:
   - in AURA simulata due pazienti della Dott.ssa Marchi scelgono la collega. Uno passa a lei con «Sposta»; l'altro resta con «Non spostare» e non si ripropone, né alla Dott.ssa Marchi né alla collega;
   - la Dott.ssa Marchi registra l'attività svolta per il paziente dell'altro studio dell'AFT. Il Dott. Rinaldi la vede in Strumenti › AFT e nella cronologia della cartella, con il nome della collega;
   - quattro sabotaggi.

Non provati: tre richieste o più sullo stesso codice fiscale; due correzioni insieme dello stesso codice fiscale su due pazienti (stessa strada del codice, senza una prova sua); nella dimostrazione, la consultazione al contrario nell'AFT, del Dott. Rinaldi sui pazienti della Dott.ssa Marchi.
