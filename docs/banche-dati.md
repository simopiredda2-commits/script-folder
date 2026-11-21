# Banche dati pubbliche (tappa 5)

Il servizio importa nel database ciò che `sync/` scarica e controlla. Lo script resta com'è: l'importazione legge la sua cartella (`--dest`), cioè `stato.json` e i file in `correnti/`, e non scarica nulla.

```
sync/banche_dati.py  →  dati-pubblici/correnti/…, stato.json  →  importazione  →  database  →  regole e ricerche
                                                       ↑
                              trascrizioni controllate dei PDF (A8)
```

## Che cosa si importa

| Tipo                     | Da dove                                                             | Come            | Serve per                                 |
| ------------------------ | ------------------------------------------------------------------- | --------------- | ----------------------------------------- |
| `farmaci`                | AIFA, anagrafica delle confezioni (CSV)                             | file di `sync/` | ricerca farmaci, R22 (D210)               |
| `farmaci_classe`         | AIFA, classe A e H per principio attivo (CSV)                       | file di `sync/` | R8, prezzo, equivalenti                   |
| `farmaci_trasparenza`    | AIFA, lista di trasparenza dei farmaci equivalenti (CSV)            | file di `sync/` | prezzo di riferimento, equivalenti (D202) |
| `farmaci_carenti`        | AIFA, elenco dei medicinali carenti (CSV)                           | file di `sync/` | R21, carenze in terapia e in Oggi (D202)  |
| `registri_aifa`          | AIFA, registri di monitoraggio e piani terapeutici attivi (CSV)     | file di `sync/` | dati del farmaco, per ATC (D206)          |
| `farmaci_dpc`            | Regione Piemonte, farmaci PHT in DPC (PDF)                          | trascrizione    | R5, R7, indicazione DPC                   |
| `comuni`                 | ISTAT, elenco dei comuni (XLSX)                                     | file di `sync/` | anagrafica, codice fiscale, D12           |
| `prestazioni`            | Regione Piemonte, catalogo delle prestazioni (PDF)                  | trascrizione    | ricerca prestazioni, R14                  |
| `esenzioni`              | DPCM LEA e atti regionali (PDF)                                     | trascrizione    | R9                                        |
| `esenzioni_prestazioni`  | Regione Piemonte, D.D. 1167/2022 (PDF)                              | trascrizione    | R17                                       |
| `diagnosi`               | Ministero della salute, manuale ICD-9-CM 2007 (PDF) e DM 28/10/2020 | trascrizione    | ricerca delle diagnosi (D186)             |
| `prestazioni_aggiuntive` | ACN 2022-2024, allegato 6, e AIR del Piemonte 2024 (PDF)            | trascrizione    | prestazioni aggiuntive e distinta (D212)  |
| `presidi`                | DPCM LEA, allegato 3 (Gazzetta del 2017); poi l'allegato 2          | trascrizione    | scelta del presidio con il codice (D218)  |

Non importati per ora: l'elenco dei registri AIFA chiusi, ICD-10-IM. Si aggiungono con un tipo e una mappatura nuovi. Le diagnosi ICD-9-CM: `docs/icd9cm.md`.

L'anagrafica porta anche lo **stato amministrativo** della confezione («Autorizzata» o «Sospesa»), per le variazioni AIFA sui farmaci in terapia (D205).

## Lettura dei file

- **CSV**: come `sync/` (`ispeziona_csv`). Codifica utf-8 (con o senza BOM), poi cp1252, poi latin-1. Separatore: il più frequente nella prima riga tra `;` `,` tab `|`. Campi tra virgolette e virgolette raddoppiate come il modulo `csv` di Python. Una prova confronta, cella per cella, il lettore con Python sugli stessi file.
- **XLSX**: primo foglio, testi condivisi o in linea, celle mancanti come testo vuoto (lettore minimo su `fflate`).
- **Intestazioni**: confrontate senza date, senza maiuscole e con gli spazi compattati, con le stesse espressioni di `sync/` (`_norma_cella`). Così «Prezzo al 15/6/2026» e «Prezzo al 30/6/2026» sono la stessa colonna. Anche questo lo verifica una prova contro Python.
- L'intestazione si cerca nelle prime 20 righe: la prima che contiene tutte le colonne della mappatura.

## Mappature

`packages/reference/data/mappature.json` collega le colonne dei file ai campi dei tipi (D54). Per ogni mappatura:

- `fonte` e `chiave`: il file in `correnti/<fonte>/<chiave>`; `*` vale qualsiasi testo (la cartella AIFA davanti alla chiave può cambiare);
- `colonne`: campo → intestazione; `null` = **da completare**;
- `costanti`: campo → valore uguale per tutto il file (la classe di un elenco);
- `nessunValore`: campo facoltativo → espressioni (su tutta la cella) dei valori che nel file vogliono dire «nessun valore», per esempio «-» al posto di un prezzo. Solo quelli visti nei file veri, con il motivo nella nota; il rapporto d'importazione dice quante celle sono state lette così (D148);
- `zeriDavanti`: campo → lunghezza. Un codice di sole cifre più corto riprende gli zeri davanti che il file ha tolto (l'AIC della lista di trasparenza, D202); il rapporto d'importazione dice quanti valori. Un codice con altri caratteri resta com'è, e il controllo della forma lo segnala;
- `saltaRigheSenza`: campi senza i quali una riga si salta invece di fermare il file. Solo dove il file vero ha righe che non sono dati (la coda dell'elenco dei registri AIFA, D206); il rapporto dice quante righe;
- `vecchiaDopoGiorni`: soglia di A6; `null` = da completare (D62).

I campi possono essere testo (con la forma attesa: AIC, ATC, codice catastale), numero (scritto all'italiana o con il punto; l'euro in fondo, «5,63 €», non fa parte del numero), sì o no, e data (GG/MM/AAAA o AAAA-MM-GG, solo date vere: niente 31/02).

Stato al 20/11/2026:

| Mappatura          | Stato                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `istat-comuni`     | Completa. Intestazioni lette dal file ISTAT al 21/02/2026 tramite un'estrazione testuale: da confermare (D56)                                                                                                                                                                                                                                                |
| `aifa-anagrafica`  | Completa (D148). Intestazioni lette il 18/11/2026 da `confezioni_fornitura.csv`: 160.101 righe, tutti gli AIC di 9 cifre e tutti gli ATC nella forma attesa. Con la ditta titolare dell'AIC (`RAGIONE_SOCIALE`, D151) e lo stato amministrativo (`STATO_AMMINISTRATIVO`, D205: nel file del 20/11/2026, 160.067 «Autorizzata» e 33 «Sospesa»)                |
| `aifa-classe-a`    | Completa (D148). File del 30/6/2026 in cp1252: 10.766 righe, AIC e prezzi tutti validi. **Non ha la colonna della nota AIFA**                                                                                                                                                                                                                                |
| `aifa-classe-h`    | Completa (D148). File del 30/6/2026: 2.487 righe; l'intestazione «Codice AIC» va a capo dentro le virgolette; 117 prezzi senza valore («-» e il prezzo dell'ossigeno a metro cubo, `nessunValore`)                                                                                                                                                           |
| `aifa-trasparenza` | Completa (D202). File del 19/11/2026, prezzi del 16/11/2026, cp1252: 8.598 righe, nessun problema. AIC senza gli zeri davanti (`zeriDavanti`: 8.594 con 8 cifre, 4 con 7); gruppi di equivalenza uguali a quelli della classe A (8.400 AIC in comune). **La colonna «Nota» è un'annotazione in parole, non la nota AIFA** (corregge D148). Soglia: 32 giorni |
| `aifa-carenti`     | Completa (D202). File aggiornato al 17/11/2026, cp1252: 2.516 righe, nessun problema. Intestazione alla terza riga; «Nota AIFA» è un testo che va a capo nelle virgolette; tre AIC compaiono due volte. Nessuna soglia: AIFA non dichiara una cadenza                                                                                                        |
| `aifa-registri`    | Completa (D206). File del 19/11/2026, utf-8 con BOM: 374 registri, nessun problema; nessun AIC, si collegano per ATC. Alcuni ATC fra spazi (la lettura li toglie); due righe in fondo senza il farmaco, saltate e contate (`saltaRigheSenza`). Nessuna soglia: AIFA non dichiara una cadenza                                                                 |
| `trascrizione-*`   | Complete: il formato è nostro (sotto)                                                                                                                                                                                                                                                                                                                        |

**Se AIFA cambia le colonne.** `sync/` mette il file nuovo «da verificare» (colonne cambiate). Dopo il controllo: si correggono i nomi delle colonne nella mappatura, si alza la `versione` del file e si rilancia l'importazione. Con una colonna nulla il rapporto dice «mappatura da completare» e riporta l'intestazione vera, letta da `stato.json`.

## Trascrizioni dei PDF (A8)

I PDF non si estraggono da soli. Una persona copia i dati in un CSV (UTF-8, separatore `;`) e compila una scheda JSON con lo stesso nome, accanto al CSV (D57):

```json
{
  "tipo": "farmaci_dpc",
  "serie": "piemonte-dpc",
  "fonte": "piemonte_dpc",
  "chiave": "farmaci_pht_dpc.pdf",
  "sha256_origine": "impronta SHA-256 del PDF, come in stato.json",
  "atto": "Elenco dei farmaci PHT in DPC, aggiornamento del …",
  "in_vigore_dal": "AAAA-MM-GG",
  "trascritto_da": "Nome e cognome",
  "trascritto_il": "AAAA-MM-GG",
  "controllato_da": "Nome e cognome"
}
```

- `fonte`, `chiave` e `sha256_origine` vanno indicati tutti e tre, oppure nessuno (atto che `sync/` non scarica: si importa con la nota «origine non verificabile»).
- Se il PDF in uso in `sync/` ha un'impronta diversa, la trascrizione è **superata** e non entra: va trascritta la versione nuova.
- `serie` (facoltativa) lega le versioni successive della stessa tabella, per esempio due determine sul catalogo.
- `ambito` (facoltativo, D232) dice dove vale l'atto: `{"regione": "Piemonte"}`, `{"asl": "ASL TO3"}` o tutti e due. Senza, l'atto vale in tutta Italia. Oggi lo legge il catalogo delle prestazioni aggiuntive: un accordo aziendale vale solo per gli archivi della sua ASL, uno regionale solo per gli studi della sua regione. I nomi si confrontano senza maiuscole, accenti e segni.
- **Da controllare (D159).** Finché nessuno l'ha controllata, `controllato_da` è `null`: la trascrizione non entra in uso e ogni importazione la segnala come «trascrizione da controllare», tra le cose da guardare a mano. Chi la controlla scrive nome e cognome; dal giro successivo entra, con il suo nome nella versione.

### Trascrizioni che il programma porta con sé (D159)

`packages/reference/data/trascrizioni/` contiene le trascrizioni degli atti regionali e nazionali (catalogo, esenzioni, diagnosi ICD-9-CM, prestazioni aggiuntive), ed è la cartella delle trascrizioni per difetto (`BANCHE_DATI_TRASCRIZIONI` e `--trascrizioni` la sostituiscono). Oggi:

| File (in `piemonte_catalogo/`) | Atto                                     | In vigore dal | Voci in vigore |
| ------------------------------ | ---------------------------------------- | ------------- | -------------- |
| `dd590-2026-allegato-a`        | D.D. 590/2026, allegato A: il catalogo   | 21/09/2026    | 5107           |
| `dd710-2026-dal-2026-10-30`    | D.D. 710/2026, allegati A e C, modifiche | 30/10/2026    | 5149           |
| `dd710-2026-dal-2027-01-13`    | D.D. 710/2026, allegato B, modifiche     | 13/01/2027    | 5093           |

Sono estratte in automatico dai PDF e restano **da controllare**. Che cosa è diverso dal PDF e che cosa controllare: `docs/catalogo-regionale.md`.

| File (in `icd9cm/`)              | Atto                                                   | In vigore dal | Voci in vigore |
| -------------------------------- | ------------------------------------------------------ | ------------- | -------------- |
| `icd9cm-2007-elenco-sistematico` | versione italiana 2007 della ICD-9-CM (DM 18/12/2008)  | 01/01/2009    | 16293          |
| `dm-2020-10-28-covid19`          | DM 28/10/2020, integrazioni per la COVID-19, modifiche | 02/02/2021    | 16317          |

Estratte dal manuale da Simone, con un controllo esterno e le correzioni della simulazione del controllo; restano **da controllare** (le controlla la Dr.ssa Rocca). Che cosa è diverso dal PDF e che cosa controllare: `docs/icd9cm.md`.

| File (in `lea/`)               | Atto                                                             | In vigore dal | Voci in vigore |
| ------------------------------ | ---------------------------------------------------------------- | ------------- | -------------- |
| `allegato-8-malattie-croniche` | DPCM LEA, allegato 8: codici delle malattie croniche (D190)      | 30/10/2026    | 247            |
| `allegato-3-presidi`           | DPCM LEA, allegato 3: presidi per diabete e malattie rare (D218) | 19/03/2017    | 30             |

Estratta in automatico dal PDF della pagina del Ministero (versione del 29/9/2026) e **da controllare** (sotto, «Esenzioni del DPCM LEA»).

| File (in `ppip/`)          | Atto                                                                | In vigore dal | Voci |
| -------------------------- | ------------------------------------------------------------------- | ------------- | ---- |
| `acn-2022-2024-allegato-6` | ACN della medicina generale 2022-2024, allegato 6 (serie nazionale) | 15/01/2026    | 16   |
| `air-piemonte-2024`        | AIR del Piemonte 2024, art. 35, comma 4 (serie regionale)           | 01/01/2025    | 1    |

Trascritte qui dalle pagine 146 e 147 del supplemento della Gazzetta (lettura ottica, controllata a vista voce per voce) e dal PDF della delibera; restano **da controllare**. Il catalogo di un giorno unisce le serie in vigore nella regione e nell'ASL dell'archivio (`ambito`); a parità di codice vale la serie più recente, e a parità di data l'atto più vicino: ASL, poi regione, poi Italia (D213, D232). Così un accordo aziendale si aggiunge come serie nuova, con il suo ambito. Colonne: `codice`, `sezione`, `descrizione`, `autorizzazione` (sì/no), `compenso` (euro, con la virgola), `note`. Che cosa è diverso dagli atti e che cosa controllare: `docs/ppip.md`.

### Esenzioni del DPCM LEA (D190)

Che cosa c'è nella trascrizione dell'allegato 8:

- i 66 codici della prima parte, uno per condizione (013, 0A31, 0031…), con la descrizione della condizione; 0A02, 0B02 e 0C02, scritti insieme nell'elenco, sono tre codici;
- i 181 codici della tabella di corrispondenza, uno per malattia ICD9-CM (013.250, 0031.402…), descritti «condizione: malattia» quando le due sono diverse. Le celle che nel PDF vanno a capo, sopra e sotto la riga del codice, sono ricomposte;
- HIV-2 (p. 6) non è un codice a parte: è 020.042 con il codice aggiuntivo 079.53;
- il testo è come stampato (anche «cretinina» nella condizione 061), tranne gli spazi dopo una parentesi aperta e il punto e virgola alla fine delle malattie in elenco.

Che cosa controllare: un campione di codici e descrizioni contro il PDF, in particolare le righe ricomposte (colonna `origine`: «prima parte, su più righe»; le malattie di 006, 016, 052, 061 e 068); la data di inizio, oggi il 30/10/2026, da cui in Piemonte valgono le esenzioni 068, 069 e 070.

**Un catalogo parziale non rende «inesistenti» le altre esenzioni.** Il catalogo dice che un codice non esiste solo per le famiglie di codici che contiene: con le sole malattie croniche, un'esenzione per reddito (E…) o per gravidanza (M…) non è inesistente, è non nota, e R9 non la blocca per questo (la blocca solo se non è registrata per il paziente o è scaduta). Le famiglie: i codici che cominciano con una cifra (malattie croniche), quelli con R e una lettera (malattie rare), gli altri per le lettere iniziali.

Che cosa resta fuori, e perché:

- **le prestazioni di ogni esenzione** (terza parte dell'allegato 8): per R17 vale l'elenco regionale, che il SAR usa per bloccare (D.D. 1167/2022, con l'elenco sostituito dall'allegato C della D.D. 1452/2023; perché non si importa: D196). Nella parte nazionale, inoltre, la «visita di controllo» non ha un codice (lo sceglie il medico nel nomenclatore), alcune prestazioni valgono solo in certi casi («limitatamente a…») e alcune condizioni non hanno un elenco («le prestazioni appropriate»): trascritte così, R17 bloccherebbe ricette giuste;
- **l'allegato 10** (tutela della maternità): elenca le prestazioni per periodo, senza i codici di esenzione da riportare in ricetta;
- **l'allegato 4D** (note e condizioni di erogabilità): serve con l'allegato 4, il nomenclatore, che dice a quali prestazioni si applica ogni nota.

**Allegato 7, malattie rare (D195).** Trascritto anche questo, da controllare: 370 codici (116 gruppi e 254 malattie) nella serie `lea-esenzioni-malattie-rare`, dal 30/10/2026. Il PDF si legge cella per cella: nome della malattia o del gruppo, esempi di malattie afferenti, sinonimi, malattie del gruppo con un codice proprio («… (codice RN1200)»), sezione e sottosezione. Dal testo impaginato, invece, nomi ed esempi si mescolavano (98 nomi su 370 erano sbagliati nella prima prova). Con i due allegati il catalogo copre le famiglie delle croniche e delle rare. Che cosa controllare: un campione di codici e nomi contro il PDF, i gruppi con molte righe (per esempio RCG071, RCG078, RNG262) e la riga di RNG262, dove le lettere spaziate «D I S G E N E S I A …» sono ricomposte.

**Elenco esenzioni–prestazioni per R17 (D196).** Il SAR blocca le prestazioni non associate all'esenzione dal 28/06/2022 (D.D. 1167/2022). Il suo elenco è stato sostituito dall'allegato C della D.D. 1452/2023, in vigore dal 20/07/2023: 9871 righe, 48 esenzioni. È però precedente al nuovo nomenclatore, in vigore dal 30/12/2024: dei 1170 codici di prestazione distinti, solo 437 (37%) esistono nel catalogo regionale 2026, pari al 78% delle righe. Gli atti successivi letti (D.D. 868/2024, 990/2024, 444/2025, 590/2026, 710/2026) aggiornano il catalogo, non l'elenco. Per questo non si importa: usato per bloccare, fermerebbe ricette giuste. R17 resta «non verificabile» finché la Regione o il CSI Piemonte non danno l'elenco in uso nel SAR.

### Presidi del DPCM LEA (D218)

L'allegato 3 del DPCM 12/1/2017 è il nomenclatore dei presidi per persone affette da patologia diabetica e da malattie rare (art. 13). I decreti del 2026 non lo toccano (D216), quindi si trascrive dal supplemento ordinario n. 15 alla GU n. 65 del 18/3/2017, pagine 52 e 53. Il DPCM vale dal giorno dopo la pubblicazione, 19/3/2017.

Che cosa c'è nella trascrizione (`lea/allegato-3-presidi`), 30 righe:

- 18 presidi (`tipo` = `presidio`), ognuno con il suo codice e il titolo del gruppo dell'allegato («Lancette pungidito», «Aghi»…);
- le 12 malattie rare che danno diritto a questi presidi (`tipo` = `malattia_rara`, gruppo «Malattie rare»), con il loro codice di esenzione;
- il testo come stampato, compresa la parentesi non chiusa di RCG074. «Penna pungidito» ha nel PDF due spazi, qui uno;
- il codice come lo scrive l'allegato. Lo stesso codice può valere per più presidi (W0101060201 per quattro). L'apparecchio per la glicemia ha due codici nella stessa cella, scritti «W0201060102 / Z12040115». L'allegato chiama la colonna «Codice», senza dire di quale classificazione: qui si chiama così.

Come si è controllata la trascrizione: ogni cella si ritrova nel testo del PDF e ogni codice sta sulla riga della sua descrizione nel testo impaginato; le due pagine sono state guardate anche come immagine. Che cosa controllare: un confronto a vista delle 30 righe con le pagine 52 e 53, che sono poche.

Nel programma, quando la trascrizione è controllata e importata (A8): nella prescrizione dei presidi per diabetici si sceglie la voce dal nomenclatore, e prodotto e codice si riempiono da soli; sotto, l'elenco delle malattie rare dell'art. 13. Si può sempre scrivere a mano. L'allegato 2 (ausili monouso, con le modifiche del DM 3/8/2026) si aggiunge come serie dello stesso tipo quando arriva il file di Simone.

### Atti che modificano una tabella (D157)

La Regione non ripubblica il catalogo intero. Pubblica le voci che finiscono e quelle che cominciano. Esempio, la D.D. 710/2026:

- l'allegato A elenca le voci prescrivibili fino al 29/10/2026;
- l'allegato B elenca la radioterapia prescrivibile fino al 12/01/2027;
- l'allegato C elenca le voci dal 30/10/2026, nuove o al posto di altre: per esempio 45.30.1 diventa 45.30.1A.

Si trascrivono solo queste voci, con `"solo_modifiche": true` nella scheda (e la `serie` che modificano) e una prima colonna `operazione`:

```csv
operazione;codice_regionale;codice_nomenclatore;descrizione;branca;tariffa;note
toglie;45.30.1;;;Gastroenterologia;;
aggiunge;45.30.1A;45.30.1;ASPORTAZIONE O DEMOLIZIONE DI LESIONE DEL DUODENO IN CORSO DI EGDS POLIPECTOMIA;Gastroenterologia;220,10;
```

- **Ricostruzione.** All'importazione la versione intera si ricostruisce dalla versione della serie in vigore il giorno prima dell'atto. Prima si tolgono le voci tolte, poi si aggiungono le nuove. Una voce aggiunta con la chiave di una voce presente la sostituisce. Il risultato è una versione come le altre, immutabile, che vale dalla data dell'atto (A5).
- **Chiave delle voci.**
  - Prestazioni: codice del catalogo e branca. Se la branca manca, valgono tutte le righe del codice.
  - Esenzioni: codice.
  - Esenzioni e prestazioni: le due colonne.
  - DPC: principio attivo e ATC.

  Maiuscole, accenti e spazi non contano: nel PDF «Gastroenterologia» va a capo dentro la cella e diventa «Gastroentero logia».

- **Un atto per data.** Se le voci cominciano o finiscono in date diverse, servono atti diversi. Per la D.D. 710/2026: A e C dal 30/10/2026 in un atto, B dal 13/01/2027 in un altro. Gli atti si applicano in ordine di data, dopo le versioni intere.
- **Controlli.**
  - Senza una versione prima dell'atto: «manca la versione su cui l'atto è scritto».
  - Una voce da togliere che la base non ha: «righe non valide», e l'atto non si applica. Vuol dire che la base non è quella su cui l'atto è scritto.

Colonne dei CSV trascritti:

| Tipo                    | Colonne                                                                 | Note                                                                                           |
| ----------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `farmaci_dpc`           | `principio_attivo;atc;nota_aifa;piano_terapeutico`                      | `piano_terapeutico`: `sì` o `no`                                                               |
| `prestazioni`           | `codice_regionale;codice_nomenclatore;descrizione;branca;tariffa;note`  | tariffa scritta all'italiana (`20,66`)                                                         |
| `esenzioni`             | `codice;descrizione`                                                    | il catalogo completo, non solo le patologie                                                    |
| `esenzioni_prestazioni` | `esenzione;prestazione`                                                 | una riga per ogni prestazione associata                                                        |
| `diagnosi`              | `codice;descrizione;codice_padre;termini_inclusi;note;capitolo;sezione` | il padre è il codice senza l'ultima cifra; le altre colonne (pagina, origine) non si importano |

## Controlli all'importazione

| Controllo                                                                                             | Esito                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Il file in `correnti/` ha l'impronta scritta da `sync/` in `stato.json`                               | altrimenti **errore**, non si importa                                                                      |
| La mappatura ha una colonna per ogni campo obbligatorio                                               | altrimenti «da completare», con l'intestazione vera                                                        |
| Il file ha tutte le colonne della mappatura                                                           | altrimenti «colonne mancanti», con quali                                                                   |
| Ogni valore ha la forma attesa (AIC 9 cifre, codice catastale, ATC, numeri)                           | altrimenti «righe non valide», con riga, campo e motivo; `--accetta-scarti` importa le righe valide (D61)  |
| Diagnosi: ogni codice una volta, il padre è il codice senza l'ultima cifra e c'è (anche dopo un atto) | altrimenti «righe non valide», con la voce e il motivo; `--accetta-scarti` toglie le voci sbagliate (D186) |
| Stessa serie e stessa impronta già importate                                                          | «già importato»: un secondo giro non cambia nulla                                                          |
| Una versione nuova in attesa di verifica in `sync/`                                                   | segnalata; resta in uso quella precedente                                                                  |
| Comuni con un codice catastale che inizia con X                                                       | avviso: è la lettera dei luoghi inventati (D12, D64)                                                       |

Le forme dei codici: AIC di 9 cifre (tutti i 160.101 dell'anagrafica AIFA letta il 18/11/2026; la lista di trasparenza li scrive invece senza lo zero iniziale, a 8 cifre, e per questo non è ancora mappata); codice catastale con una lettera e tre cifre (DM 23/12/1976 e file ISTAT); codice ISTAT di 6 cifre e sigla di due lettere (file ISTAT); ATC con la struttura a livelli lettera, due cifre, lettera, lettera, due cifre (struttura dell'OMS; tutti gli ATC dell'anagrafica AIFA la rispettano).

## Versioni e date (A5, A6)

- Ogni importazione è una versione **immutabile** (`reference_dataset` e tabelle `ref_*`, con divieto di modifica, cancellazione e svuotamento nel database).
- Data d'inizio: per i file di `sync/` il giorno del download; per le trascrizioni la data dell'atto.
- **A5.** Alla data di una ricetta, per ogni serie vale la versione con la data d'inizio più recente non successiva; a parità di data, l'ultima importata. Esempio provato: il 29/10/2026 vale il catalogo precedente, dal 30/10/2026 quello nuovo.
- **A6.** `GET /api/banche-dati` e ogni ricerca restituiscono `versioni`: tipo, titolo, data d'inizio e su che cosa si basa, data del download, righe, atto, ultimo controllo della fonte (`checkedAt`). `stale` dice se la versione è più vecchia del previsto e `staleReasons` perché (D156, sotto). Non blocca nulla: il controllo finale resta del SAC.

## Aggiornamento continuo (D156)

Banche dati e tabelle di codici si aggiornano da sole ogni notte, e quando serve anche subito. Sono le stesse per tutti gli studi del servizio: le aggiorna chi gestisce il servizio, una volta per tutti, e gli studi non devono fare nulla (D191). Un solo giro fa tutto: `sync/` scarica dalle fonti solo ciò che è cambiato (A1), l'importazione controlla e mette in uso le versioni nuove (A3, A5), il giro resta nel registro (`reference_update_run`).

Il giro si avvia in tre modi:

- **ogni notte**, all'ora di `BANCHE_DATI_AGGIORNAMENTO` (per esempio `03:30`, ora dello studio). L'orologio tiene conto del cambio dell'ora. Se il servizio era spento all'ora prevista, il giro perso parte un minuto dopo l'avvio;
- **con il comando** `pnpm banche-dati:aggiorna` sul server, di chi gestisce il servizio, anche da un'attività pianificata;
- **con il pulsante «Aggiorna adesso»**, solo per l'amministratore dello studio (`admin.reference_data`), in Strumenti › Banche dati, per non aspettare la notte. Il giro è lo stesso e vale per tutti gli studi del servizio, e la pagina lo dice (D194).

In Strumenti › Banche dati tutti gli utenti vedono quando parte il prossimo giro, com'è andato l'ultimo e che cosa aspetta un controllo.

Le regole del giro:

- **Uno alla volta.** Un secondo giro trova il primo in corso e non parte. Un giro rimasto «in corso» per più di 6 ore si chiude come interrotto. Alla chiusura del servizio il download si ferma e il giro resta interrotto.
- **Cadenza dei controlli.** Tutte le fonti, ogni notte (A1): le richieste condizionate rendono leggero un controllo che non trova nulla di nuovo.
- **Che cosa dice l'esito.** Le regole sono quelle di `sync/` e del comando d'importazione:
  - `ok`;
  - `da_verificare`: una versione nuova trattenuta, un PDF da trascrivere, un file sparito dalla pagina;
  - `errore`: una fonte che non risponde, un file non valido, un'impronta diversa;
  - `interrotto`.
- **Che cosa resta di ogni giro.**
  - Il rapporto JSON di `sync/` (`ultimo-rapporto.json`), il rapporto dell'importazione e le cose da controllare.
  - Per ogni serie in uso: l'ultimo controllo riuscito della sua fonte, se il controllo di quel giro è fallito, e se una versione più nuova aspetta qualcuno.

**Più vecchia del previsto** (A6), con il motivo accanto alla data della versione:

- l'ultimo aggiornamento non è riuscito a controllare la sua fonte;
- l'aggiornamento di ogni notte manca, cioè nessun giro è partito dopo l'ultima ora prevista;
- una versione più nuova aspetta la verifica in `sync/` (A3), oppure il file nuovo non è entrato in uso (colonne, righe non valide);
- per le trascrizioni: il PDF trascritto è cambiato alla fonte, oppure la stessa fonte ha documenti nuovi da trascrivere. È il caso del catalogo regionale quando la Regione pubblica una determina nuova;
- la versione supera la soglia d'età della sua fonte (`vecchiaDopoGiorni`). C'è solo dove la fonte dichiara una cadenza regolare. Oggi è il caso dell'ISTAT, che aggiorna l'elenco dei comuni «almeno ogni sei mesi»: 184 giorni più una notte, 185. AIFA pubblica l'anagrafica ogni giorno, ma il contenuto può restare uguale, quindi una soglia d'età darebbe avvisi falsi: vale il controllo di ogni notte. Le altre fonti non hanno una cadenza regolare.

Senza giri registrati e senza soglia, `stale` è `null`: non si sa, e non si avvisa.

**Configurazione** (variabili d'ambiente del servizio, `.env.example`):

| Variabile                   | Che cosa                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `BANCHE_DATI_DIR`           | cartella dei dati di `sync/`; senza, il servizio non aggiorna nulla (sviluppo e prove)      |
| `BANCHE_DATI_TRASCRIZIONI`  | cartella delle trascrizioni dei PDF                                                         |
| `BANCHE_DATI_FONTI`         | `pubbliche` (`sync/fonti.json`, per difetto), `esempio` (sito d'esempio) o un file di fonti |
| `BANCHE_DATI_AGGIORNAMENTO` | ora dell'aggiornamento di ogni notte, `HH:MM`; senza, solo comando e pulsante               |
| `SYNC_CONTATTO`             | email nello User-Agent di `sync/`, perché i gestori dei siti sappiano chi scarica           |

In sviluppo e nelle prove non c'è `BANCHE_DATI_DIR`, quindi il servizio non chiama nessun sito (regola 7). Le prove usano il sito d'esempio servito in locale.

## Che cosa ne ricavano le regole

Solo fatti che hanno una fonte; l'assenza da un elenco non diventa mai un «no» (D59).

| Fatto                                         | Da dove                                                                                                                   | Regola  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| A carico del SSN                              | il farmaco è nell'elenco di classe A in vigore                                                                            | R8      |
| Nota AIFA                                     | DPC (le liste di classe non hanno la colonna, e la «Nota» della lista di trasparenza è un'annotazione in parole, D202)    | R7      |
| Piano terapeutico obbligatorio                | DPC, solo se dice `sì`                                                                                                    | R5      |
| Esenzione esistente                           | catalogo delle esenzioni                                                                                                  | R9      |
| Prestazioni di un'esenzione                   | elenco esenzione → prestazioni                                                                                            | R17     |
| Prescrivibile dal medico di medicina generale | **non noto**: serve una fonte strutturata                                                                                 | R8      |
| Regime di fornitura                           | anagrafica (`FORNITURA`): letto, non ancora usato dalle regole                                                            | —       |
| Confezione sospesa                            | anagrafica in vigore alla data (`STATO_AMMINISTRATIVO` «Sospesa»): variazioni in terapia e ricerca (D205), ricetta (D210) | R22     |
| Registro o piano AIFA                         | elenco dei registri attivi, per ATC (D206): mostrato nei dati del farmaco, non usato dalle regole                         | —       |
| Unità per confezione                          | **non noto**                                                                                                              | R4, R11 |
| Antibiotico iniettabile o infusione           | **non noto**                                                                                                              | R3      |
| Farmaco carente                               | elenco AIFA dei carenti in vigore alla data: la carenza cominciata più di recente, se no la prima prevista (D202)         | R21     |

Con un fatto non noto le regole si comportano come senza banca dati (D42): non bloccano e lo dicono.

## Rotte

Servono una sessione; non sono dati dei pazienti, quindi niente registro degli accessi alla cartella. Parametro facoltativo `data=AAAA-MM-GG` per consultare le banche dati a una data (A5).

| Rotta                                 | Risposta                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/banche-dati`                | versioni in uso                                                                                                          |
| `GET /api/farmaci?q=`                 | farmaci per nome, principio attivo, AIC o ATC, con versioni                                                              |
| `GET /api/farmaci/:aic`               | il farmaco e gli equivalenti del suo gruppo, dalle liste di classe e dalla lista di trasparenza (D202)                   |
| `GET /api/prestazioni?q=`             | prestazioni per descrizione, branca, codice regionale o nazionale                                                        |
| `GET /api/esenzioni?q=`               | esenzioni per codice o descrizione                                                                                       |
| `GET /api/comuni/:codice`             | comune per codice catastale                                                                                              |
| `GET /api/diagnosi?q=`                | diagnosi ICD-9-CM per parole o codice, con i padri, se è una categoria, quante voci in tutto e le versioni (D186)        |
| `GET /api/diagnosi/:codice`           | la voce di un codice (con o senza punto); `disponibile: false` se nessun catalogo è in uso                               |
| `GET /api/presidi/nomenclatore`       | presidi del nomenclatore con il codice e malattie rare che danno diritto a quelli dell'allegato 3, in vigore oggi (D218) |
| `GET /api/banche-dati/aggiornamenti`  | ora e prossimo aggiornamento, giro in corso, ultimo giro con le cose da controllare, ultimi dieci giri                   |
| `POST /api/banche-dati/aggiornamenti` | avvia subito un giro (solo l'amministratore dello studio); 409 se uno è in corso o se il servizio non è configurato      |

Le banche dati pubbliche non sono dati del medico: non entrano nella sua esportazione.

## Comandi

```sh
pnpm banche-dati:importa -- --dati ~/dati-pubblici --trascrizioni ~/trascrizioni
pnpm banche-dati:importa -- --esempio      # sync sul sito d'esempio, poi importazione (dati dimostrativi)
pnpm banche-dati:aggiorna -- --dati ~/dati-pubblici --trascrizioni ~/trascrizioni   # giro completo (D156)
pnpm banche-dati:aggiorna -- --esempio     # giro completo sul sito d'esempio
```

`banche-dati:aggiorna` prende la cartella, le trascrizioni e le fonti anche dalle variabili del servizio (`BANCHE_DATI_DIR`, `BANCHE_DATI_TRASCRIZIONI`, `BANCHE_DATI_FONTI`): un'attività pianificata del server lo può lanciare senza opzioni.

Codici d'uscita come `sync/`: `0` tutto a posto, `1` almeno un errore, `2` qualcosa da completare o verificare.

## Esempi e prove

- `fixtures/banche-dati/sito/`: sito d'esempio con le stesse fonti di `sync/fonti.json` (`fonti-prova.json`). I file AIFA sono estratti dei file veri, con le intestazioni vere: righe copiate senza cambiare un byte (D148; fonte AIFA, licenza CC BY 4.0). Valgono le mappature del repository: le mappature di prova non ci sono più.
- Gli estratti coprono i casi dei file veri: anagrafica in utf-8 con `\n`, liste di classe in cp1252 con `\r\n` e il simbolo dell'euro, l'intestazione della classe H che va a capo, due prezzi della classe H che non sono numeri, un farmaco (paracetamolo) fuori dalle liste di classe.
- `fixtures/banche-dati/trascrizioni/`: trascrizioni d'esempio, con le impronte vere dei PDF d'esempio. La riga DPC (dulaglutide, nota 100, piano terapeutico) è quella dell'elenco della Regione Piemonte del 9/7/2026; catalogo ed esenzioni sono inventati.
- `fixtures/banche-dati/genera.py`: rigenera gli esempi (serve `openpyxl`).
- Le prove (`apps/api/test/banche-dati.test.ts`) servono il sito in locale, lanciano `sync/banche_dati.py` vero e importano il suo output (D63).

## Che cosa non è stato provato

- L'aggiornamento di ogni notte sulle fonti vere: provato solo sul sito d'esempio, con un orologio finto per l'ora e per i due cambi dell'ora. Il primo giro sui siti veri va fatto da un computer dello studio (requisiti, «Ambiente di test»).
- Due istanze del servizio insieme: un giro solo alla volta è garantito dal database (vincolo sul giro in corso), provato con due avvii nello stesso servizio.
- I moduli dei certificati non sono ancora tra le fonti controllate: gli atti dei modelli ufficiali entreranno in `sync/fonti.json` con la tappa 13.

- L'importazione nel database dei file AIFA interi: le mappature sono state controllate sui file interi del 18/11/2026 (forme di AIC, ATC e prezzi), ma `sync/` sul sito vero e l'importazione completa non sono stati lanciati da qui. Il file ISTAT completo non si raggiunge dal cloud.
- Le intestazioni ISTAT vengono da un'estrazione testuale, non dai byte del file: da confermare al primo giro.
- Un XLSX scritto da Excel: l'esempio lo scrive `openpyxl`, che usa testi in linea. I testi condivisi, tipici di Excel, sono provati con un file costruito nella prova.
- I tempi d'importazione del file ISTAT completo e dell'anagrafica AIFA, che supera i 50 MB: l'importazione procede a blocchi di 1000 righe, ma non è stata misurata su file così grandi.
