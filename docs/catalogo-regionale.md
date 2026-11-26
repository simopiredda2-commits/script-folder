# Catalogo regionale in vigore: trascrizione da controllare (D159)

**Stato: da controllare.** Il programma non usa il catalogo finché le tre schede di `packages/regions/piemonte/data/trascrizioni/piemonte_catalogo/` (nel pacchetto regionale, D295) non dicono chi l'ha controllato (`controllato_da`). Fino ad allora ogni importazione lo segnala come «trascrizione da controllare» (A8).

## Da dove viene

- **D.D. 20 settembre 2026, n. 590/A1400B/2026** (BU Regione Piemonte n. 38 del 24/09/2026), allegato A: il catalogo intero. Vale per le ricette prescritte dal 21/09/2026 (punto 3 della determina). 194 pagine, 5116 righe, 26 branche.
- **D.D. 30 ottobre 2026, n. 710/A1400B/2026** (BU n. 44 del 5/11/2026): allegato A, 27 voci prescrivibili fino al 29/10/2026; allegato C, 69 voci dal 30/10/2026; allegato B, 56 voci di radioterapia prescrivibili fino al 12/01/2027.
- I PDF li ha mandati Simone il 18/11/2026; impronte in `docs/provenienze.md`. I PDF restano fuori dal repository.
- **D.G.R. 2 novembre 2026, n. 40-3255** (BU n. 44 del 5/11/2026, supplemento ordinario n. 2), letta il 25/11/2026 (D264). Recepisce i decreti dei LEA del 2026 e riapprova come allegati A, B e C gli stessi elenchi della D.D. 710. Corregge i pacchetti di brachiterapia del trattamento breve, da «< 2 sedute» a «≤ 2 sedute»: la trascrizione ha già «<=2». L'allegato D fissa le regole dei pacchetti di radioterapia dal 2/11/2026, senza cambiare codici né tariffe. Codici e tariffe sono stati confrontati con la trascrizione: sono uguali, tranne la tariffa di 92.2C.5 (punto 6 di «Che cosa controllare»).
  - Il testo della delibera è stato letto con uno strumento di lettura dei PDF: le tabelle hanno errori di lettura evidenti (per esempio «>20 sedute» diventa «20 sedute»), e le righe 92.2B.4 e 92.2B.5 si perdono al cambio di pagina. Il PDF (`dgr_03255_1050_02112026.pdf`) non si scarica da qui: la connessione con regione.piemonte.it si chiude a metà.
  - La delibera elenca anche la storia del catalogo: D.D. 180/2024 del 13/3/2024, poi D.D. 990/2024, D.D. 444/2025 del 29/7/2025 e D.D. 590/2026. La D.D. 444/2025 non serve: la D.D. 590 ripubblica il catalogo intero (D159).
- Il PDF dell'allegato A è stampato da un file Excel della Regione: in testa a ogni pagina c'è «Allegato A_Catalogo Ambulatoriale_092026_ALL.xlsx». Con quel file il confronto si fa da programma, riga per riga.

## I tre file

| File                            | In vigore dal | Contenuto                                            | Voci in vigore |
| ------------------------------- | ------------- | ---------------------------------------------------- | -------------- |
| `dd590-2026-allegato-a.csv`     | 21/09/2026    | catalogo intero                                      | 5107           |
| `dd710-2026-dal-2026-10-30.csv` | 30/10/2026    | 27 voci tolte (allegato A), 69 aggiunte (allegato C) | 5149           |
| `dd710-2026-dal-2027-01-13.csv` | 13/01/2027    | 56 voci tolte (allegato B)                           | 5093           |

Colonne: codice del catalogo, codice del nomenclatore (DM), descrizione del catalogo, branca, tariffa indicativa di fascia A, linee guida, inclusioni ed esclusioni, e dal 25/11/2026 ciclo e numero di sedute (D276: `ciclo` «sì» dove il PDF stampa «S», `sedute` il numero più alto di sedute del ciclo). Le altre colonne dell'allegato non entrano: prescrivibile ed erogabile (servono solo a togliere le voci non prescrivibili), LEA nazionale o regionale, branca e descrizione del nomenclatore, codici delle note. Le note del nomenclatore si prendono dagli allegati 4 e 4D del DPCM LEA (`docs/banche-dati.md`, «Note del nomenclatore»); LEA potrà servire più avanti alle esenzioni.

## Che cosa è diverso dal PDF

1. **Tolte le 2 voci non prescrivibili** (colonna «Prestazione Prescrivibile» = N, pagina 166): 90418.1 TIREOTROPINA [TSH] TEST REFLEX + ABTPO, 90418.2 TIREOTROPINA [TSH] TEST REFLEX + ABTPO+ABTG. Secondo la loro nota sostituiscono 90.41.8 quando il laboratorio la completa (DGR 21-9688 del 30/09/2008): non le prescrive il medico.
2. **7 righe ripetute identiche**, una volta sola: G101.P018 (p. 83), G101.P232 (p. 95), G101.P556 (p. 109), G101.P696 (p. 115), G101.P810 (p. 119), G101.P932 (p. 123), 8901.68 (p. 152). Sono ripetute anche nella D.D. 990/2024.
3. **26 descrizioni e 16 note tagliate nel PDF**, completate con il testo della stessa voce (codice e branca) nella D.D. 990/2024. Nel PDF il testo si ferma al bordo della cella, per esempio «VISITA ORTOPEDICA MANO DI» (8901.55, p. 148). In tutte le altre voci le descrizioni della D.D. 590 e della D.D. 990 sono uguali. Elenco sotto.
4. **Parole spezzate dal trattino a fine riga** («PACE-» / «MAKER»): 253 casi. Dal PDF non si vede se dopo il trattino c'era uno spazio. Si è scelto come è scritta la stessa parola dentro una riga, nei tre atti: 240 senza spazio, 13 con lo spazio (per esempio «CROMATOGRAFICHE- IMMUNOSOPPRESSORI», come le altre voci della stessa famiglia). In 77 casi non c'è nessuna prova e si è scelto senza spazio, come nella grande maggioranza dei trattini dentro le righe (2306 senza spazio, 72 con lo spazio).
5. Nella D.D. 710 le branche che vanno a capo nella cella («Gastroentero logia») sono scritte come nel catalogo («Gastroenterologia»).

## Che cosa controllare

1. Le correzioni del punto 3, nella tabella sotto: il testo completo dev'essere quello della voce nel PDF della D.D. 590, se si legge per intero altrove (per esempio nel file Excel), oppure quello della D.D. 990/2024 alla pagina indicata.
2. Le 40 righe del campione, scelte a caso: codice, descrizione, branca e tariffa uguali al PDF, alla pagina dell'allegato A indicata.
3. Tutte le 69 righe «aggiunge» di `dd710-2026-dal-2026-10-30.csv`, con le pagine 21–23 del PDF della D.D. 710. Tre righe sembrano strane ma sono così nell'atto: 91.20.8 (la descrizione finisce con la virgola, la nota comincia con il punto), 90324 («LUTEOTROPINA (LH) e E FOLLITROPINA (FSH)»), 92.2A.1 («Radioterapia - Piano di cura cat. A», con le minuscole come tutte le voci nuove di radioterapia).
4. Il numero delle righe «toglie»: 27 nell'allegato A, 56 nell'allegato B.
5. Le 8 voci con un finale strano, nella tabella «Finali da guardare nel PDF»: sono uguali nella D.D. 990/2024, quindi il confronto non aiuta. Nel PDF si vede se il testo è proprio così o se la cella è tagliata in tutti e due gli atti.
6. La tariffa di 92.2C.5 (Radioterapia - Trattamento lungo cat. C >20 sedute): nella trascrizione 11.261,50, come nel PDF della D.D. 710; nel testo della D.G.R. 40-3255 letto da qui 11.281,50. Quel testo ha altri errori di lettura, quindi la differenza può venire solo dalla lettura: si guarda la tariffa nell'allegato C della delibera.
7. Le 52 voci a ciclo (`ciclo` «sì»), con il numero di sedute, contro le colonne «Prestazione Ciclo» e «Numero Sedute» del PDF della D.D. 590 (D276). Le 24 voci con un codice del nomenclatore hanno lo stesso numero del ciclo nell'allegato 4 del DPCM LEA; le altre 28 no, perché il loro codice nel nomenclatore non c'è.

Controllato tutto, chi ha controllato scrive nome e cognome in `controllato_da` nelle tre schede (`.json`). Dal giro successivo il catalogo entra in uso, con il nome di chi l'ha controllato in ogni versione.

## Descrizioni e note completate con la D.D. 990/2024

| Codice    | Branca                   | Pagina 590 | Campo       | Nel PDF finisce con               | Testo completo                                                                                                            |
| --------- | ------------------------ | ---------- | ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 92.03.4   | Medicina Nucleare        | 11         | descrizione | «…TA. INCLUSO: POSIZIONAMENTO DI» | STUDIO DEL REFLUSSO VESCICO-URETERALE. MEDIANTE CISTOSCINTIGRAFIA MINZIONALE DIRETTA. INCLUSO: POSIZIONAMENTO DI CATETERE |
| 92.05.7A  | Medicina Nucleare        | 12         | descrizione | «…ITRONI [PET TC] MIOCARDICA CON» | TOMOGRAFIA AD EMISSIONE DI POSITRONI [PET TC] MIOCARDICA CON FDG                                                          |
| 92.18.C   | Medicina Nucleare        | 13         | descrizione | «…RONI [PET-TC] GLOBALE CORPOREA» | TOMOGRAFIA AD EMISSIONE DI POSITRONI [PET-TC] GLOBALE CORPOREA CON FDG                                                    |
| 8901.148  | Diagnostica Per Immagini | 32         | descrizione | «…A - INTERVENTISTICA SPINALE DI» | VISITA NEURORADIOLOGICA - INTERVENTISTICA SPINALE DI CONTROLLO                                                            |
| 92.05.7A  | Diagnostica Per Immagini | 33         | descrizione | «…ITRONI [PET TC] MIOCARDICA CON» | TOMOGRAFIA AD EMISSIONE DI POSITRONI [PET TC] MIOCARDICA CON FDG                                                          |
| 92.18.C   | Diagnostica Per Immagini | 34         | descrizione | «…RONI [PET-TC] GLOBALE CORPOREA» | TOMOGRAFIA AD EMISSIONE DI POSITRONI [PET-TC] GLOBALE CORPOREA CON FDG                                                    |
| 90.65.3   | Laboratorio              | 52         | descrizione | «…LUTINOGENI E AGGLUTININE) E RH» | GRUPPO SANGUIGNO ABO (AGGLUTINOGENI E AGGLUTININE) E RH (D)                                                               |
| 90674N.0  | Laboratorio              | 52         | descrizione | «…ERO/30 CELLULE A ANTIGENICITA'» | IDENTIFICAZIONE DI SPECIFICITA' ANTI HLA CONTRO PANNELLO LINFOCITARIO - (1 SIERO/30 CELLULE A ANTIGENICITA' NOTA)         |
| 90681.414 | Laboratorio              | 63         | descrizione | «…ERGOLOGICHE: M211 TRICHOPHYTON» | IGE SPECIFICHE ALLERGOLOGICHE: M211 TRICHOPHYTON MENT.VAR.INTERDIGITALE                                                   |
| 90.68.9   | Laboratorio              | 66         | descrizione | «…ANNELLI DI 4 ALLERGENI A VARIE» | TEST DI INIBIZIONE DELLE IGE SPECIFICHE CON ALLERGENE SPECIFICO. PANNELLI DI 4 ALLERGENI A VARIE DILUIZIONI               |
| 91024.0   | Laboratorio              | 73         | descrizione | «…A MICROSCOPICA (ZIEHL-NEELSEN,» | MICOBATTERI IN URINE RICERCA MICROSCOPICA (ZIEHL-NEELSEN, KINYIUN)                                                        |
| 91024.1   | Laboratorio              | 73         | descrizione | «…A MICROSCOPICA (ZIEHL-NEELSEN,» | MICOBATTERI ESCRETATO RICERCA MICROSCOPICA (ZIEHL-NEELSEN, KINYIUN)                                                       |
| 91131.0   | Laboratorio              | 75         | descrizione | «…EDIANTE F.C.) - ANTI ENTAMOEBA» | VIRUS ANTICORPI (TITOLAZIONE MEDIANTE F.C.) - ANTI ENTAMOEBA HISTOLITICA IGG                                              |
| 91131.1   | Laboratorio              | 75         | descrizione | «…EDIANTE F.C.) - ANTI ENTAMOEBA» | VIRUS ANTICORPI (TITOLAZIONE MEDIANTE F.C.) - ANTI ENTAMOEBA HISTOLITICA IGM                                              |
| 91131.7   | Laboratorio              | 75         | descrizione | «…NTE F.C.) - ANTI PARAINFLUENZA» | VIRUS ANTICORPI (TITOLAZIONE MEDIANTE F.C.) - ANTI PARAINFLUENZA IGG                                                      |
| 91131.6   | Laboratorio              | 75         | descrizione | «…ANTE F.C.) -ANTI PARAINFLUENZA» | VIRUS ANTICORPI (TITOLAZIONE MEDIANTE F.C.) -ANTI PARAINFLUENZA IGM                                                       |
| 91.25.D   | Laboratorio              | 77         | descrizione | «…E RICERCA DIRETTA IN MATERIALI» | VIRUS RESPIRATORIO SINCIZIALE RICERCA DIRETTA IN MATERIALI BIOLOGICI                                                      |
| 91.5R.Q   | Laboratorio              | 81         | descrizione | «…ENZIMI LISOSOMIALI. SINGOLO»    | ENZIMI LISOSOMIALI. SINGOLO DOSAGGIO.                                                                                     |
| 38.95.4   | Nefrologia               | 132        | descrizione | «…ERMANENTE CON TUNNELLIZZAZIONE» | SOSTITUZIONE O RIMOZIONE DI CATETERE VENOSO FEMORALE PERMANENTE CON TUNNELLIZZAZIONE PER DIALISI RENALE                   |
| 8901.133A | Neurochirurgia           | 135        | descrizione | «…CA DI CONTROLLO ONCOLOGICA DEL» | VISITA NEUROCHIRURGICA DI CONTROLLO ONCOLOGICA DEL BASICRANIO                                                             |
| 23.43.6   | Odontostomatologia       | 143        | descrizione | «…NCOLO DI RIPOSIZIONAMENTO O DI» | APPLICAZIONE DI PLACCA INTEROCCLUSALE DI SVINCOLO DI RIPOSIZIONAMENTO O DI STABILIZZAZIONE                                |
| 8901.55   | Ortopedia                | 148        | descrizione | «…VISITA ORTOPEDICA MANO DI»      | VISITA ORTOPEDICA MANO DI CONTROLLO                                                                                       |
| 89.38.8   | Pneumologia              | 156        | descrizione | «…DELLA VENTILAZIONE CON GAS NON» | TEST DI DISTRIBUZIONE DELLA VENTILAZIONE CON GAS NON RADIOATTIVI                                                          |
| 93.01.A   | Altre                    | 164        | descrizione | «… SOGGETTI CON GRAVE DISABILITA» | VALUTAZ. FUNZIONI FONO ARTICOLATORIE E DELLA DEGLUTIZIONE IN SOGGETTI CON GRAVE DISABILITA MOTORIA INFANTILE              |
| G103.P507 | Laboratorio              | 174        | descrizione | «…LA DIAGNOSI-IPERALDOSTERONISMI» | ANALISI MUTAZIONALE DI MALATTIA CHE NECESSITA DI MASSIMO 3 GENI PER LA DIAGNOSI-IPERALDOSTERONISMI PRIMITIVI              |
| G201.C009 | Laboratorio              | 189        | descrizione | «…UINEI DI PORTATORI DI ANOMALIA» | ANALISI CITOGENETICA POSTNATALE, ANALISI DEL CARIOTIPO-CONSANGUINEI DI PORTATORI DI ANOMALIA CROMOSOMICA                  |
| 88.94.Q.1 | Diagnostica Per Immagini | 30         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894H.0   | Diagnostica Per Immagini | 30         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894H.1   | Diagnostica Per Immagini | 30         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894J.0   | Diagnostica Per Immagini | 30         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894J.1   | Diagnostica Per Immagini | 30         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894K.0   | Diagnostica Per Immagini | 30         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894K.1   | Diagnostica Per Immagini | 30         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894M.0   | Diagnostica Per Immagini | 30         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894M.1   | Diagnostica Per Immagini | 30         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894N.0   | Diagnostica Per Immagini | 30         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894N.1   | Diagnostica Per Immagini | 30         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 88.94.P   | Diagnostica Per Immagini | 30         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894T.0   | Diagnostica Per Immagini | 31         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894T.1   | Diagnostica Per Immagini | 31         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894V.0   | Diagnostica Per Immagini | 31         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |
| 8894V.1   | Diagnostica Per Immagini | 31         | note        | «…ture vascolari. ESCLUSO: angio» | INCLUSO: parti molli, prima valutazione delle strutture vascolari. ESCLUSO: angio rm                                      |

## Finali da guardare nel PDF

Una parentesi aperta, un trattino o una virgola in fondo. Non sono nell'elenco i nomi scritti al contrario, come «CHARCOT-MARIE-TOOTH …, MALATTIA DI» o «WAGR SINDROME DI», né le lettere di un tipo, come «VITAMINA E».

| Codice     | Branca                           | Pagina 590 | Campo       | Finale                                                                    |
| ---------- | -------------------------------- | ---------- | ----------- | ------------------------------------------------------------------------- |
| 87.62.2    | Diagnostica Per Immagini         | 17         | note        | «…OCIABILE A: rx dell'esofago, stomaco e duodeno con doppio MDC (87.62.3» |
| 90105N.0   | Laboratorio                      | 41         | note        | «…. INCLUSO: bilirubina diretta ed indiretta. NON ASSOCIABILE A 90.10.07» |
| 91392N.4   | Laboratorio                      | 77         | descrizione | «…FINO A 5 VETRINI E/O COLORAZIONI): CITOLOGIA - BRUSHING BRONCHIALE - E» |
| 8907.4     | Nefrologia                       | 134        | note        | «…- inserimento paziente con compromissione renale avanzata in dialisi -» |
| 95.21      | Oculistica                       | 143        | descrizione | «…ELETTRORETINOGRAFIA (ERG, FLASH-PATTERN) -»                             |
| 93116.1    | Medicina Fisica E Riabilitazione | 170        | note        | «…ativi miglioramenti, idroterapia con vasca a farfalla o piscina, ecc).» |
| 93117.1    | Medicina Fisica E Riabilitazione | 170        | note        | «…ativi miglioramenti, idroterapia con vasca a farfalla o piscina, ecc).» |
| 9160N.G017 | Laboratorio                      | 172        | descrizione | «…R (17) T (X;17)- SARCOMA ALVEOLARE PARTI MOLLI FIBROSARCOMA CONGENITO,» |

## Campione da confrontare con il PDF

| Pagina | Codice    | Nomenclatore | Branca                           | Tariffa | Descrizione                                                                                                                                                            |
| ------ | --------- | ------------ | -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | 89.7A.1   | 89.7A.1      | Anestesia/Analgesia              | 26,00   | PRIMA VISITA ANESTESIOLOGICA/ALGOLOGICA                                                                                                                                |
| 7      | 86.71     | 86.71        | Chirurgia Plastica               | 340,25  | ALLESTIMENTO E PREPARAZIONE DI LEMBI PEDUNCOLATI                                                                                                                       |
| 10     | 91.90.8   | 91.90.8      | Dermatologia/Allergologia        | 13,00   | PRICK BY PRICK CON ALLERGENI FRESCHI                                                                                                                                   |
| 12     | 92.15.4   | 92.15.4      | Medicina Nucleare                | 189,45  | SCINTIGRAFIA POLMONARE CON INDICATORE POSITIVO DI NEOPLASIA                                                                                                            |
| 14     | 38.97.1   | 38.97.1      | Diagnostica Per Immagini         | 282,00  | INSERZIONE DI CATETERE VENOSO CENTRALE CON ACCESSO CHIRURGICO. INCLUSO RADIOGRAFIA DI CONTROLLO                                                                        |
| 14     | 54.22     | 54.22        | Diagnostica Per Immagini         | 30,20   | BIOPSIA DELLA PARETE ADDOMINALE O DELL' OMBELICO                                                                                                                       |
| 19     | 88282.1   | 88.28.2      | Diagnostica Per Immagini         | 17,80   | RX DEL PIEDE (COMPRESE LE DITA) DX SOTTO CARICO                                                                                                                        |
| 21     | 8838Y.1   | 88.38.Y      | Diagnostica Per Immagini         | 149,10  | TC DI GOMITO E AVAMBRACCIO DX SENZA E CON MDC                                                                                                                          |
| 29     | 88.93.4   | 88.93.4      | Diagnostica Per Immagini         | 133,20  | RM DEL RACHIDE LOMBOSACRALE.                                                                                                                                           |
| 35     | 86.04     | 86.04        | Endocrinologia                   | 42,75   | INCISIONE CON DRENAGGIO DELLA CUTE E DEL TESSUTO SOTTOCUTANEO                                                                                                          |
| 35     | 88714.2   | 88.71.4      | Endocrinologia                   | 28,40   | ECOGRAFIA TIROIDE - PARATIROIDI                                                                                                                                        |
| 40     | 90073.3   | 90.07.3      | Laboratorio                      | 12,00   | AMINOACIDI TOTALI [P]                                                                                                                                                  |
| 42     | 9017B.7   | 90.17.B      | Laboratorio                      | 10,45   | FARMACI CON METODI CROMATOGRAFICI - OXCARBAZEPINA                                                                                                                      |
| 46     | 90.34.6   | 90.34.6      | Laboratorio                      | 11,30   | OMOCISTEINA                                                                                                                                                            |
| 49     | 90435.2   | 90.43.5      | Laboratorio                      | 1,05    | URATO [DU]                                                                                                                                                             |
| 51     | 90.61.2   | 90.61.2      | Laboratorio                      | 12,80   | CRIOGLOBULINE TIPIZZAZIONE                                                                                                                                             |
| 52     | 90.66.7   | 90.66.7      | Laboratorio                      | 7,75    | HB - EMOGLOBINE. DOSAGGIO FRAZIONI (HBA2, HBF, HB ANOMALE)                                                                                                             |
| 60     | 90681.299 | 90.68.1      | Laboratorio                      | 8,95    | IGE SPECIFICHE ALLERGOLOGICHE: G12 SEGALE SECALE CEREALE                                                                                                               |
| 61     | 90681.337 | 90.68.1      | Laboratorio                      | 8,95    | IGE SPECIFICHE ALLERGOLOGICHE: I203 TIGNOLA GRIGIA DELLA FARINA EPHESTIA KUEHNIELLA                                                                                    |
| 63     | 90681.395 | 90.68.1      | Laboratorio                      | 8,95    | IGE SPECIFICHE ALLERGOLOGICHE: K87 ALFA-AMILASI                                                                                                                        |
| 64     | 90681.431 | 90.68.1      | Laboratorio                      | 8,95    | IGE SPECIFICHE ALLERGOLOGICHE: M70 PITYROSPORUM ORBICULARE                                                                                                             |
| 74     | 91.10.9   | 91.10.9      | Laboratorio                      | 10,10   | TRIPANOSOMI NEL SANGUE RICERCA MICROSCOPICA (CON COLORAZIONE SPECIFICHE), DOPO CONCENTRAZIONE O ARRICCHIMENTO                                                          |
| 83     | G101.P024 | G1.01        | Laboratorio                      | 450,00  | ANALISI MUTAZIONALE DI MALATTIA CHE NECESSITA DI UN SOLO GENE PER LA DIAGNOSI - ADRENOMIELONEUROPATIA                                                                  |
| 94     | G101.P209 | G1.01        | Laboratorio                      | 450,00  | ANALISI MUTAZIONALE DI MALATTIA CHE NECESSITA DI UN SOLO GENE PER LA DIAGNOSI - CONVULSIONI SENSIBILI AL PIRIDOSSALE FOSFATO                                           |
| 110    | G101.P605 | G1.01        | Laboratorio                      | 450,00  | ANALISI MUTAZIONALE DI MALATTIA CHE NECESSITA DI UN SOLO GENE PER LA DIAGNOSI - LISSENCEFALIA X-LINKED CON GENITALI AMBIGUI - SINDROME DEGLI SPASMI INFANTILI X-LINKED |
| 111    | G101.P622 | G1.01        | Laboratorio                      | 450,00  | ANALISI MUTAZIONALE DI MALATTIA CHE NECESSITA DI UN SOLO GENE PER LA DIAGNOSI - CHARCOT-MARIE-TOOTH AUTOSOMICO RECESSIVA TIPO 2B (AR-CMT2B), MALATTIA DI               |
| 121    | G101.P861 | G1.01        | Laboratorio                      | 450,00  | ANALISI MUTAZIONALE DI MALATTIA CHE NECESSITA DI UN SOLO GENE PER LA DIAGNOSI - SINDROME DA DEPLEZIONE DEL DNA MITOCONDRIALE, FORMA EPATOCEREBRALE DA DEFICIT DI DGUOK |
| 129    | 93018.1   | 93.01.8A     | Medicina Fisica E Riabilitazione | 23,00   | COUNSELLING FISIOTERAPICO- MINORE DISABILITA'                                                                                                                          |
| 131    | 93.72.6   | 93.72.6      | Medicina Fisica E Riabilitazione | 7,00    | RIEDUCAZIONE COGNITIVA IN GRUPPO                                                                                                                                       |
| 147    | 82.00.1   | 82.00.1      | Ortopedia                        | 900,00  | ALTRI INTERVENTI SU MANO POLSO COMPRESI RIMOZIONE DI DISPOSITIVI IMPIANTATI                                                                                            |
| 148    | 83.98     | 83.98        | Ortopedia                        | 6,95    | INIEZIONE DI SOSTANZE TERAPEUTICHE AD AZIONE LOCALE ALL'INTERNO DI ALTRI TESSUTI MOLLI. INCLUSO FARMACO                                                                |
| 148    | 897.13    | 89.7B.7      | Ortopedia                        | 26,00   | PRIMA VISITA ORTOPEDICA                                                                                                                                                |
| 154    | 29.19.1   | 29.19.1      | Otorinolaringoiatria             | 70,20   | VIDEOENDOSCOPIA DELLE VIE AEREE E DIGESTIVE SUPERIORI (VADS)                                                                                                           |
| 154    | 8901.73   | 89.01.H      | Otorinolaringoiatria             | 17,90   | VISITA AUDIOLOGICA DI CONTROLLO                                                                                                                                        |
| 156    | 89.37.2   | 89.37.2      | Pneumologia                      | 39,40   | SPIROMETRIA GLOBALE [CON TECNICA DI DILUIZIONE, PLETISMOGRAFIA O ALTRA METODICA]                                                                                       |
| 162    | 8901.143  | 89.01        | Altre                            | 17,90   | VISITA CENTRO EMOSTASI E TROMBOSI DI CONTROLLO                                                                                                                         |
| 166    | 89.07     | 89.07        | Medicina Fisica E Riabilitazione | 47,00   | VISITA MULTIDISCIPLINARE. INCLUSO EVENTUALE STESURA DI PROGETTO RIABILITATIVO INDIVIDUALE MULTIDISCIPLINARE                                                            |
| 175    | G103.P854 | G1.03        | Laboratorio                      | 800,00  | ANALISI MUTAZIONALE DI MALATTIA CHE NECESSITA DI MASSIMO 3 GENI PER LA DIAGNOSI-SINDROME BRANCHIO-OTO-RENALE (BOR)                                                     |
| 176    | G104.P030 | G1.04        | Laboratorio                      | 800,00  | ANALISI MUTAZIONALE DI MALATTIA CHE NECESSITA DI MASSIMO 4 GENI PER LA DIAGNOSI-ALBINISMO OCULOCUTANEO                                                                 |
| 191    | G203.C021 | G2.03        | Laboratorio                      | 220,00  | ANALISI CITOGENETICA PRENATALE.ANALISI DEL CARIOTIPO.- RISCHIO DI MALATTIE MENDELIANE DA INSTABILITÀ CROMOSOMICA                                                       |

## Note cambiate dalla D.D. 990/2024 alla D.D. 590/2026

Per informazione. Tra le voci che i due cataloghi hanno in comune, sono le sole note diverse; le descrizioni sono tutte uguali.

- 34.23 (Diagnostica Per Immagini, p. 14): «(vuota)» → «Da intendersi anche biopsia del polmone».
- 88.01.9 (Diagnostica Per Immagini, p. 18): «INCLUSO: eventuale studio dell'addome extraintestinale e colonscopia virtuale. NON ASSOCIABILE A: TC dell' addome superiore (88.01.1) e TC dell' addome superiore senza e con MDC (88.01.2), TC dell' addome inferiore (88.01.3), TC dell' addome inferiore senza e con MDC (88.01.4), TC dell' addome completo (88.01.5), TC dell' addome completo senza e con MDC (88.01.6)» → «INCLUSO: eventuale studio dell'addome extraintestinale e colonscopia virtuale e mezzo di contrasto. NON ASSOCIABILE A: TC dell' addome superiore (88.01.1) e TC dell' addome superiore senza e con MDC (88.01.2), TC dell' addome inferiore (88.01.3), TC dell' addome inferiore senza e con MDC (88.01.4), TC dell' addome completo (88.01.5), TC dell' addome completo senza e con MDC (88.01.6)».
- 93.39.9 (Medicina Fisica E Riabilitazione, p. 131): «PRECISAZIONI: Trattamento medio di 10 minuti per distretto» → «Ultrasuone terapia per seduta PRECISAZIONI: Trattamento medio di 10 minuti per distretto.».
- 34.23 (Pneumologia, p. 155): «(vuota)» → «Da intendersi anche biopsia del polmone».

## Come è stata fatta

Estrazione automatica delle tabelle dei PDF (pdfplumber), poi i passi sopra; i programmi sono fuori dal repository, come i PDF. Le prove `packages/reference/test/catalogo-regionale.test.ts` e `apps/api/test/catalogo-regionale.test.ts` controllano i file: righe, branche, chiavi uniche, le voci citate qui, le modifiche della D.D. 710 applicate per data.
