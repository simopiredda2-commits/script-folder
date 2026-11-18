# Regole di prescrizione

Da verificare con la Dr.ssa Rocca e con un consulente alla seconda fermata. Fonte: «Regole di prescrizione» in `docs/requisiti.md`. Sono **controlli formali** (regola 3): nessun suggerimento diagnostico o terapeutico.

## Come funzionano

- Ogni regola è un **dato versionato** in `packages/rules/data/`: identificativo, testo, fonte, valori, comportamento, data di efficacia. Il codice (`packages/rules/src/rules.ts`) legge i valori da lì; una regola di lint vieta di scrivere numeri nel codice delle regole.
- Si usa la versione **in vigore alla data della ricetta**; a parità di data vale quella con il numero più alto. Una norma nuova si aggiunge con un file nuovo, con la sua data: le ricette già fatte restano controllate con la versione di allora. La versione .2 (R11 informativo) sostituisce la .1 dallo stesso giorno; la .1 resta per verificare i controlli fatti con lei.
- Prima dell'invio il servizio controlla la ricetta (`POST /api/ricette/:id/controlla` per vedere i problemi senza inviare).
  - Le regole che vengono da una **norma bloccano** l'invio.
  - Il contatore delle confezioni (R11) **informa** soltanto: scelta di Simone alla seconda fermata, nella versione 2026-11-18.2 delle regole. Un motivo scritto dal medico resta comunque registrato.
  - Le **note AIFA** vanno confermate dal medico.
- Ogni problema porta la **fonte** della sua regola e, quando blocca, il **rimedio**: che cosa fare per procedere. Per R15 e R16 l'avviso spiega perché il canale o il recapito non sono ammessi e come sbloccare (scelta della seconda fermata).
- Ogni controllo fatto prima di un invio resta registrato e non si modifica: versione delle regole, problemi trovati, motivi dati, note confermate. La ricetta inviata porta la versione delle regole.
- Quando un dato manca (soprattutto la banca dati farmaci, che arriva alla tappa 5), la regola **non indovina**. O resta al limite prudente (R2 al posto di R3 e R4) o dice che non è verificabile.

## Le regole

Tabella generata dai dati: `pnpm --filter @mmg/rules docs:regole`. Una prova controlla che sia allineata.

<!-- regole:inizio -->

**Versione 2026-11-18.1**, in vigore dal 2026-11-18. Valori da: docs/requisiti.md, sezione «Regole di prescrizione», revisione 45 del 18/11/2026. Validata: no.

| ID | Regola | Fonte | Valori | Comportamento | Da completare |
| --- | --- | --- | --- | --- | --- |
| R1 | La ricetta SSN vale 30 giorni | [Tabella AIFA di classificazione dei medicinali](https://www.aifa.gov.it/documents/20142/0/tabella_classificazione_medicinali.pdf) | validityDays = 30 | Informa | — |
| R2 | Di regola al massimo 2 confezioni per ricetta | [Tabella AIFA di classificazione dei medicinali](https://www.aifa.gov.it/documents/20142/0/tabella_classificazione_medicinali.pdf) | maxPacks = 2 | Blocca | — |
| R3 | Fino a 6 confezioni per antibiotici iniettabili e soluzioni per infusione | [Tabella AIFA di classificazione dei medicinali](https://www.aifa.gov.it/documents/20142/0/tabella_classificazione_medicinali.pdf) | maxPacks = 6 | Blocca | Forma farmaceutica dalla banca dati farmaci: finché manca, il limite resta quello di R2 |
| R4 | Fino a 6 confezioni per patologie croniche in trattamento da almeno 6 mesi, per non più di 180 giorni di terapia | [Tabella AIFA di classificazione dei medicinali](https://www.aifa.gov.it/documents/20142/0/tabella_classificazione_medicinali.pdf) | maxPacks = 6; minTreatmentMonths = 6; maxTherapyDays = 180 | Blocca | Condizioni esatte da verificare sul testo di legge e sulle regole del Piemonte (requisiti); Unità per confezione dalla banca dati farmaci: finché manca, i giorni di terapia non si calcolano e il limite resta quello di R2 |
| R5 | Farmaco con piano terapeutico obbligatorio | Determina AIFA del farmaco; [Note AIFA](https://www.aifa.gov.it/it/note-aifa); [Regione Piemonte, farmaci PHT in DPC (piani ancora cartacei, es. Nota 85)](https://www.regione.piemonte.it/web/node/964) | expiryWarningDays = 30 | Blocca | Obbligo di piano per farmaco dalla banca dati farmaci: finché manca, la regola si applica solo ai farmaci con un piano registrato in cartella |
| R6 | Quantità entro quanto indicato nel piano terapeutico | Piano terapeutico dello specialista | — | Blocca | Posologia e durata del piano: oggi si controllano solo le confezioni autorizzate |
| R7 | Nota AIFA: il numero della nota in ricetta dichiara che ricorrono le condizioni di rimborsabilità | [Note AIFA](https://www.aifa.gov.it/it/note-aifa) | — | Blocca | Nota collegata al farmaco dalla banca dati farmaci: finché manca, vale la nota scritta nella riga della ricetta |
| R8 | Classe e regime di fornitura | Classificazione AIFA, dalla banca dati | — | Blocca | Classe e regime di fornitura dalla banca dati farmaci: finché mancano, la regola segnala che non è verificabile |
| R9 | Esenzione valida | Anagrafe regionale AURA e catalogo esenzioni | — | Blocca | Catalogo delle esenzioni (tappa 5): finché manca, si controlla solo l'esenzione registrata in cartella e la sua validità |
| R10 | Controlli formali del Sistema TS, ripetuti in locale prima dell'invio | [Sistema TS, Specifiche tecniche ricetta dematerializzata, prescrizione (5/12/2024)](https://sistemats1.sanita.finanze.it/portale/documents/20182/81804/20241205_Specifiche%20tecniche%20ricetta%20dematerializzata%20-%20prescrizione/7cfbbd34-e929-d051-d5b2-629232f3d79e); Documento dei controlli del Sistema TS sulla prescrizione | — | Blocca | Elenco completo dei controlli dal documento ufficiale del Sistema TS: oggi ci sono solo codice fiscale, righe e quantità |
| R11 | Contatore delle confezioni: avviso se la nuova ricetta arriva troppo presto rispetto alla copertura delle precedenti | Buona pratica, da validare con la Dr.ssa Rocca e con il consulente regolatorio (MDR) | coverageThreshold = 0.8 | Avvisa, serve un motivo | Soglia dell'80%: proposta dei requisiti, da decidere con la Dr.ssa Rocca; Unità per confezione dalla banca dati farmaci: finché mancano, il contatore non si calcola |
| R12 | Dose rispetto all'RCP, interazioni, linee guida cliniche | Dati clinici con licenza e percorso di dispositivo medico (requisiti, Vincoli legali) | — | Fuori perimetro | — |
| R13 | In ricetta il principio attivo; il marchio vincola il farmacista solo con la clausola di non sostituibilità e una sintetica motivazione | DL 95/2012, art. 15, comma 11-bis | — | Blocca | — |
| R14 | Ricetta specialistica: tipo di accesso sempre; classe di priorità per il primo accesso; quesito diagnostico | PNGLA e indicazioni regionali | — | Blocca | — |
| R15 | Promemoria cartaceo oppure, su richiesta del paziente, canale alternativo con recapito e scelta registrata | DM MEF 25/03/2020 e norme successive | — | Blocca | — |
| R16 | Ricetta o NRE a una persona diversa dal paziente solo se è un delegato registrato | Privacy (GDPR) e deleghe in cartella; da validare con il consulente privacy | — | Blocca | — |
| R17 | Esenzione per patologia su ricetta specialistica: ogni prestazione deve essere tra quelle associate a quell'esenzione | DPCM LEA, allegato 8-bis, e atti regionali; [Regione Piemonte, D.D. 1167/2022 (controllo bloccante del SAR dal 28/06/2022)](https://www.regione.piemonte.it/governo/bollettino/abbonati/2022/28/attach/dda1410001167_10100.pdf) | — | Blocca | Elenco regionale esenzioni–prestazioni (tappa 5): finché manca, la regola segnala che non è verificabile |

**Versione 2026-11-18.2**, in vigore dal 2026-11-18. Valori da: docs/requisiti.md, sezione «Regole di prescrizione», revisione 45 del 18/11/2026; R11 solo informativo per scelta di Simone alla seconda fermata (18/11/2026). Validata: no.

| ID | Regola | Fonte | Valori | Comportamento | Da completare |
| --- | --- | --- | --- | --- | --- |
| R1 | La ricetta SSN vale 30 giorni | [Tabella AIFA di classificazione dei medicinali](https://www.aifa.gov.it/documents/20142/0/tabella_classificazione_medicinali.pdf) | validityDays = 30 | Informa | — |
| R2 | Di regola al massimo 2 confezioni per ricetta | [Tabella AIFA di classificazione dei medicinali](https://www.aifa.gov.it/documents/20142/0/tabella_classificazione_medicinali.pdf) | maxPacks = 2 | Blocca | — |
| R3 | Fino a 6 confezioni per antibiotici iniettabili e soluzioni per infusione | [Tabella AIFA di classificazione dei medicinali](https://www.aifa.gov.it/documents/20142/0/tabella_classificazione_medicinali.pdf) | maxPacks = 6 | Blocca | Forma farmaceutica dalla banca dati farmaci: finché manca, il limite resta quello di R2 |
| R4 | Fino a 6 confezioni per patologie croniche in trattamento da almeno 6 mesi, per non più di 180 giorni di terapia | [Tabella AIFA di classificazione dei medicinali](https://www.aifa.gov.it/documents/20142/0/tabella_classificazione_medicinali.pdf) | maxPacks = 6; minTreatmentMonths = 6; maxTherapyDays = 180 | Blocca | Condizioni esatte da verificare sul testo di legge e sulle regole del Piemonte (requisiti); Unità per confezione dalla banca dati farmaci: finché manca, i giorni di terapia non si calcolano e il limite resta quello di R2 |
| R5 | Farmaco con piano terapeutico obbligatorio | Determina AIFA del farmaco; [Note AIFA](https://www.aifa.gov.it/it/note-aifa); [Regione Piemonte, farmaci PHT in DPC (piani ancora cartacei, es. Nota 85)](https://www.regione.piemonte.it/web/node/964) | expiryWarningDays = 30 | Blocca | Obbligo di piano per farmaco dalla banca dati farmaci: finché manca, la regola si applica solo ai farmaci con un piano registrato in cartella |
| R6 | Quantità entro quanto indicato nel piano terapeutico | Piano terapeutico dello specialista | — | Blocca | Posologia e durata del piano: oggi si controllano solo le confezioni autorizzate |
| R7 | Nota AIFA: il numero della nota in ricetta dichiara che ricorrono le condizioni di rimborsabilità | [Note AIFA](https://www.aifa.gov.it/it/note-aifa) | — | Blocca | Nota collegata al farmaco dalla banca dati farmaci: finché manca, vale la nota scritta nella riga della ricetta |
| R8 | Classe e regime di fornitura | Classificazione AIFA, dalla banca dati | — | Blocca | Classe e regime di fornitura dalla banca dati farmaci: finché mancano, la regola segnala che non è verificabile |
| R9 | Esenzione valida | Anagrafe regionale AURA e catalogo esenzioni | — | Blocca | Catalogo delle esenzioni (tappa 5): finché manca, si controlla solo l'esenzione registrata in cartella e la sua validità |
| R10 | Controlli formali del Sistema TS, ripetuti in locale prima dell'invio | [Sistema TS, Specifiche tecniche ricetta dematerializzata, prescrizione (5/12/2024)](https://sistemats1.sanita.finanze.it/portale/documents/20182/81804/20241205_Specifiche%20tecniche%20ricetta%20dematerializzata%20-%20prescrizione/7cfbbd34-e929-d051-d5b2-629232f3d79e); Documento dei controlli del Sistema TS sulla prescrizione | — | Blocca | Elenco completo dei controlli dal documento ufficiale del Sistema TS: oggi ci sono solo codice fiscale, righe e quantità |
| R11 | Contatore delle confezioni: informa se la nuova ricetta arriva prima della copertura delle precedenti | Buona pratica, da validare con la Dr.ssa Rocca e con il consulente regolatorio (MDR) | coverageThreshold = 0.8 | Informa | Soglia dell'80%: proposta dei requisiti, da confermare con la Dr.ssa Rocca; Unità per confezione dalla banca dati farmaci: finché mancano, il contatore non si calcola |
| R12 | Dose rispetto all'RCP, interazioni, linee guida cliniche | Dati clinici con licenza e percorso di dispositivo medico (requisiti, Vincoli legali) | — | Fuori perimetro | — |
| R13 | In ricetta il principio attivo; il marchio vincola il farmacista solo con la clausola di non sostituibilità e una sintetica motivazione | DL 95/2012, art. 15, comma 11-bis | — | Blocca | — |
| R14 | Ricetta specialistica: tipo di accesso sempre; classe di priorità per il primo accesso; quesito diagnostico | PNGLA e indicazioni regionali | — | Blocca | — |
| R15 | Promemoria cartaceo oppure, su richiesta del paziente, canale alternativo con recapito e scelta registrata | DM MEF 25/03/2020 e norme successive | — | Blocca | — |
| R16 | Ricetta o NRE a una persona diversa dal paziente solo se è un delegato registrato | Privacy (GDPR) e deleghe in cartella; da validare con il consulente privacy | — | Blocca | — |
| R17 | Esenzione per patologia su ricetta specialistica: ogni prestazione deve essere tra quelle associate a quell'esenzione | DPCM LEA, allegato 8-bis, e atti regionali; [Regione Piemonte, D.D. 1167/2022 (controllo bloccante del SAR dal 28/06/2022)](https://www.regione.piemonte.it/governo/bollettino/abbonati/2022/28/attach/dda1410001167_10100.pdf) | — | Blocca | Elenco regionale esenzioni–prestazioni (tappa 5): finché manca, la regola segnala che non è verificabile |

<!-- regole:fine -->

## Scelte da guardare

- **R1**: «vale 30 giorni» contato includendo il giorno di compilazione (come l'esempio del contatore R11): compilata il 18/11, vale fino al 17/12 compreso. Da confermare.
- **R2–R4**: il limite vale per ricetta (somma delle righe). R4 alza il limite a 6 solo se, per **ogni** riga, risultano dai dati: terapia cronica, opzione «Multiprescrizione», esenzione valida in ricetta, trattamento da almeno 6 mesi, non più di 180 giorni di terapia. Se il blocco scatta, il messaggio dice che cosa manca.
- **R5**: senza la banca dati, si applica ai farmaci con un piano collegato alla terapia o registrato in cartella.
- **R13**: blocca la non sostituibilità senza motivazione e una riga senza principio attivo (la ricetta «riporta sempre il principio attivo»).
- **R16**: il recapito si confronta senza maiuscole e spazi; vale un delegato con delega attiva alla data.
- **R12** resta fuori, come dicono i requisiti: nessun giudizio su dosi, interazioni, allergie.
