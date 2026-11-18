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
