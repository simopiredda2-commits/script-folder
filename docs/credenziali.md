# Credenziali dei servizi e secondo fattore

Per mandare ricette e certificati, il medico usa le proprie credenziali presso i servizi pubblici. Il programma le conserva cifrate e le usa solo per gli invii del medico a cui appartengono. Decisioni D100–D103; fonti lette il 18/11/2026.

## Quali credenziali, per che cosa

| Servizio       | Che cosa serve                                    | A che cosa                                        | Fonte                                                                                     |
| -------------- | ------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| RUPAR Piemonte | Utente, password e PIN                            | Ricette SSN (farmaceutica e specialistica) al SAR | Regione Piemonte, SIRPED, specifiche del SAR per i prescrittori, 3.1.1                    |
| Sistema TS     | Utente, password e PIN (oppure la tessera TS-CNS) | Certificati di malattia INPS, ricetta bianca      | Specifiche INPS del Sistema TS, versione 3.2, 4.1; disciplinare della ricetta bianca, 2.3 |

- **Scadenza della password RUPAR**: tre mesi. Si cambia sul portale SistemaPiemonte e subito dopo nel programma (piano dei test SIRPED, «Integrazione Cartelle Cliniche MMG/PLS», V02). Il programma calcola la scadenza dalla data del cambio indicata dal medico e avvisa da 14 giorni prima (D101). Per il Sistema TS le fonti lette non indicano una scadenza: nessun avviso.
- **Il sostituto** usa le proprie credenziali: ricette e certificati restano a nome suo.

## Secondo fattore: il codice di sessione

Per le ricette, oltre a utente, password e PIN serve un codice di sessione («Id-Sessione»): ricetta bianca dal DM 8/6/2023, ricetta SSN dal DM 27/2/2025.

- **Sistema TS**: il codice va in ogni chiamata nell'intestazione `Authorization2F: Bearer` e per la ricetta SSN vale «per almeno 8 ore». Si chiede dal portale con SPID, CIE o CNS, oppure con un servizio che lo manda all'email certificata. La tessera TS-CNS non lo richiede. Fonti: autenticazione forte per la ricetta SSN, versione 1.1 del 3/6/2025, 3 e 5; autenticazione forte per i web service, versione 1.1 del 12/1/2026, 5.
- **Piemonte (SIRPED)**: due modalità (REL-STC-01, autenticazione forte, V08 del 23/09/2026, 3 e 4):
  1. il programma chiede il codice con le credenziali RUPAR, il codice arriva all'email che il medico ha certificato sul Punto Unico di Accesso, il medico lo inserisce nel programma;
  2. il programma apre l'accesso regionale con SPID, CIE, TS-CNS o CNS (OAuth2 con PKCE) e riceve il codice da solo; per il SAR non servono più utente, password e PIN.

  Il codice vale 8 ore per i servizi di prescrizione (16 per la presa in carico e l'erogazione, V08, 3). Una richiesta nuova annulla il codice precedente. Ci sono servizi per verificarlo e revocarlo.

- **Certificati INPS**: nelle fonti lette il secondo fattore non c'è. È da verificare in collaudo.

## Accesso regionale con SPID o CIE (D109)

È l'accesso della Regione per le ricette, solo per il medico prescrittore. Il ripristino delle credenziali del programma con SPID o CIE è un'altra cosa (D189, `docs/amministrazione.md`).

È la modalità scelta alla terza fermata per le ricette SSN in Piemonte. Fonte: REL-STC-01, autenticazione forte, V08 del 23/09/2026, 3.2 e 4.3 (D265).

1. Il medico preme «Entra con SPID o CIE». Il programma crea uno `state` casuale (ne conserva l'impronta) e un `code_verifier` PKCE (cifrato), poi apre la pagina di autorizzazione regionale (`/oauth2/authorize` con `client_id`, `redirect_uri`, scope `prescrizione`, `state`, `code_challenge` S256).
2. Il medico entra con SPID o CIE e autorizza. La Regione rimanda il browser al programma con `code` e `state`, oppure con un errore.
3. Il programma fa questi controlli:
   - lo `state` è di una richiesta di **questo** medico, non usata e non più vecchia di 10 minuti;
   - scambia il codice con il `code_verifier` (`/oauth2/token`);
   - chi è entrato con SPID o CIE (`sub` del token) è il medico collegato; altrimenti revoca il token;
   - la Regione ha concesso il profilo di prescrizione;
   - il token è stato rilasciato per il programma (`aud` uguale al `client_id`) e non è già scaduto.
4. Il token si conserva cifrato. La scadenza è il campo `exp` del token, non `expires_in`: la V08 descrive `expires_in` come «Unix time», ma nell'esempio vale 7199, una durata (4.3.2, D265). Non si rinnova: alla scadenza si rientra.
5. Le ricette SSN, i loro annullamenti e lo stato di erogazione usano il token nell'intestazione `X-OAuth2-Authorization: Bearer`, senza l'autenticazione Basic, con `<pinCode>` vuoto e nessun altro dato di autenticazione (V08, 4.3.6). Utente, password e PIN RUPAR non servono.
6. «Esci dall’accesso regionale» revoca il token (`DELETE /sessionid/revoke`, V08, 4.3.5). Se per la Regione il token era già scaduto, revocato o sconosciuto (risposta 401), si chiude solo qui e si annota.

Errori come annullamento, identità diversa, richiesta scaduta o accesso al programma scaduto nel frattempo tornano come messaggio chiaro nella pagina delle credenziali, mai come errore tecnico. Nell'indirizzo del ritorno c'è solo un codice, e il testo lo scrive il programma: un testo nell'indirizzo lo potrebbe scrivere chiunque (D193). Il codice per email resta come alternativa.

In prova la pagina regionale è simulata dal programma stesso:

- esiste solo con il simulatore;
- accetta solo indirizzi di ritorno interni;
- non imita il sito della Regione.

## Come funziona nel programma

- **Pagina «Credenziali dei servizi»**, dal collegamento «Credenziali» nell'intestazione, solo per i medici.
  - Il medico inserisce utente, password, PIN e la data del cambio della password.
  - Dopo il salvataggio vede solo «Impostate», le ultime tre lettere dell'utente e le date: le credenziali non si rileggono, né qui né altrove.
  - Per cambiare solo la password basta scrivere quella.
  - Può cancellarle.
- **Codice di sessione**: «Chiedi il codice», poi il codice ricevuto per email e «Attiva». La pagina dice fino a quando vale; «Revoca il codice» lo annulla. Nel simulatore il codice compare anche a video, come nell'ambiente di prova della Regione (REL-STC-01 V08, 4.2.1); in produzione mai.
- **Pagina «Oggi»**: avvisa se mancano credenziali, se la password è in scadenza o scaduta, se il codice di sessione non è attivo.
- **Prima di ogni invio** (ricetta, annullamento, stato di erogazione) il programma prende le credenziali e il codice di chi firma. Se mancano o il codice è scaduto, l'invio si ferma prima di contattare il servizio, con un messaggio che porta alla pagina giusta. La ricetta non cambia stato.
- **Rifiuto del servizio per l'accesso** (credenziali sbagliate, password scaduta, codice revocato):
  - la ricetta va in errore di tipo «accesso» (`auth`) e si rimanda così com'è, senza correggerla;
  - non si stampa la ricetta rossa, perché il servizio risponde;
  - se il problema è il codice di sessione, il programma lo toglie e chiede di attivarne uno nuovo.

## Sicurezza

- Utente, password e PIN si cifrano insieme (AES-256-GCM) con una chiave derivata da `APP_ENCRYPTION_KEY` solo per questo uso (HKDF), legata al medico e al servizio. Copiati sulla riga di un altro medico non si aprono: il programma chiede di reinserirli.
- Il codice di sessione è cifrato allo stesso modo.
- Le credenziali passano ai servizi come argomento a parte e non entrano nei messaggi conservati nel registro degli invii.
- Solo il medico a cui appartengono le vede, le cambia e le usa. La segreteria e l'amministratore no (regola 5).
- Nessuno storico delle modifiche, perché nessuna password vecchia resti conservata. Ogni evento (impostate, cambiate, cancellate, codice chiesto, attivato, rifiutato, revocato) resta in `service_credential_event` con data, postazione ed eventuale messaggio del servizio, mai con i valori. Quella tabella non si modifica e non si cancella.
- Le credenziali non entrano nell'esportazione dei dati.

## Prove

- `apps/api/test/credenziali.test.ts`, 12 prove:
  - solo il medico;
  - invio fermato senza credenziali, con la ricetta invariata;
  - valori mai restituiti e mai in chiaro nel database;
  - nessuno storico;
  - testo cifrato copiato su un altro medico che non si apre;
  - codice di sessione: richiesto, sbagliato, attivato, valido 8 ore;
  - sessione scaduta;
  - sessione revocata dal servizio, poi la ricetta rimandata;
  - cambio della sola password;
  - avviso di scadenza e data nel futuro rifiutata;
  - ricetta bianca con il Sistema TS e sostituto con le proprie credenziali;
  - eventi senza valori, non modificabili;
  - esportazione senza credenziali.
- Simulatori (`packages/integrations/test/simulatore.test.ts`): rifiuti per credenziali o PIN mancanti, codice che vale 8 ore e annulla il precedente, password scaduta, Id-Sessione chiesto a ogni chiamata.
- Dominio (`packages/domain/test/credenziali-servizi.test.ts`): scadenza a tre mesi solari, avviso, quali invii chiedono il secondo fattore.
- Nel browser: pagina accessibile (axe, 44 px, tablet), avviso nella pagina «Oggi», codice revocato, chiesto e attivato.

## Da completare, non provato

- **Adattatori veri**, che arrivano con le credenziali di collaudo:
  - cifratura del PIN con il certificato della Regione o del Sistema TS;
  - codici d'errore veri per credenziali e sessione (oggi l'esito è segnalato dal simulatore);
  - intestazione `Authorization2F`;
  - per il SAR le intestazioni sono già scritte e provate in `sarAuthentication` (`packages/integrations/src/service-auth.ts`): con il token, `X-OAuth2-Authorization`; con il codice per email, `Authorization: Basic`, `X-idSessione` e `X-Gestionale` (V08, 4.2.5 e 4.3.6).
- **Durata del codice SIRPED**: 8 ore per i servizi di prescrizione (V08, 3), come nel simulatore.
- **Accesso con SPID o CIE, con il servizio vero**:
  - codice del gestionale (`client_id`) e indirizzo di ritorno da registrare presso la Regione (D103);
  - verifica della firma del token con la chiave pubblica (JWKS, `/.well-known/jwks.json`, kid «rel-oauth2-key»): il simulatore emette token con i campi della V08 ma senza firma;
  - `expires_in`: la V08 lo descrive come «Unix time» e nell'esempio vale 7199; il programma usa `exp` del token, ma il significato va chiesto al CSI;
  - revoca: la V08 dice `DELETE`, la descrizione OpenAPI pubblicata con la V08 (`yaml.zip`) dice `GET`: da chiarire con il CSI. Il simulatore segue la V08.
- **Registrazione del programma presso la Regione** (codice del gestionale, autocertificazione) e censimento dei medici nel configuratore regionale: pratiche da avviare (D103).
- **Secondo codice del Sistema TS**: il Sistema TS ammette un secondo codice «in attesa» accanto a quello attivo; non è simulato.
- **Scadenza della password del Sistema TS**: da verificare.
