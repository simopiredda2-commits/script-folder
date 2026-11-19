# Importazione da altri programmi (tappa 15, D173)

Documento per la revisione della tappa 15. Richiesta di Simone del 19/11/2026: «devi poter direzionare i dati che riceverai dal file importato (che potrà essere proveniente da altri applicativi in vari formati) ai vari menu (storia clinica, patologie, farmaci prescritti e/o in terapia, pannello amministrazione del paziente …). Se qualcosa tra questi menu … non era prevista … devi ovviamente prevederla».

L'importazione sta in **Strumenti › Importazione** ed è del **medico titolare**, sul suo archivio: i dati sono suoi (regola 4, D21). Il programma d'origine non si nomina e non si analizza (regola 2, D142, D147): il medico costruisce la mappatura sul suo file, nel suo studio.

## I passi

1. **Scegli il file.** Il tipo si riconosce dal contenuto, non dal nome. Il programma mostra codifica, separatore, fogli e se lo stesso file è già stato importato.
2. **Dove vanno i dati.** Per ogni foglio: la riga d'intestazione (o nessuna, e le colonne si chiamano per lettera) e una o più destinazioni. Si può anche smistare per valore di una colonna, per esempio una colonna «Tipo» che dice se la riga è un problema, un'allergia o una nota di diario.
3. **Colonne e campi.** Per ogni campo una colonna (con i suggerimenti dai nomi delle intestazioni) oppure un valore uguale per tutte le righe, con le trasformazioni: date, sì/no, decimali, tabelle di corrispondenza dei valori. Niente espressioni scritte dall'utente. Una data con l'ora e il fuso (per esempio «2026-05-11T23:30:00Z») vale per il giorno italiano; senza fuso, per il giorno scritto.
4. **Anteprima.** Le prime righe di ogni destinazione, trasformate e controllate, con gli errori.
5. **Prova senza scrivere.** Tutto come se si importasse, in una transazione annullata: il rapporto è quello vero.
6. **Importa.** Solo dopo la prova con la stessa mappatura; se nel frattempo qualcosa è cambiato, il programma lo dice e non scrive.
7. **Esito.** Il rapporto riga per riga si scarica in CSV.

Sotto la procedura ci sono la **storia delle importazioni** (con l'annullamento) e i **profili d'importazione**, cioè le mappature salvate per riusarle.

## Formati

| Formato                                | Come si legge                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSV e TSV                              | Codifica UTF-8 (con o senza BOM), Windows-1252 o Latin-1; separatore contato fuori dalle virgolette su più righe, oppure scelto a mano, oppure dalla riga «sep=». Virgolette non chiuse e righe con un numero di campi diverso dall'intestazione: errore con il numero di riga. |
| XLSX                                   | Tutti i fogli, con i tipi di cella e le date. Indice dello ZIP letto dal programma, con il numero di voci e le dimensioni controllati prima di decomprimere e il CRC dopo; ZIP64, parti cifrate e compressioni sconosciute rifiutate.                                           |
| JSON                                   | Un elenco di oggetti, o un oggetto con elenchi; oggetti annidati di un livello come «esterna.interna»; chiavi pericolose scartate.                                                                                                                                              |
| La nostra esportazione completa (JSON) | Impronte di ogni tabella verificate (un file cambiato non entra), mappatura già proposta: serve a trasferire un archivio fra studi che usano il programma.                                                                                                                      |
| ODS, XLS, ZIP qualsiasi                | Non letti: «salva come XLSX o CSV».                                                                                                                                                                                                                                             |
| PDF e immagini                         | Non sono dati da smistare: si allegano come referto.                                                                                                                                                                                                                            |

Non letti, per ora: il CSV in ZIP della nostra esportazione, il Profilo Sanitario Sintetico in CDA2, HL7 FHIR (la specifica non si è potuta leggere da questa sessione).

## Destinazioni

Ogni riga passa dagli **stessi controlli dell'inserimento a mano**. Il paziente si trova dal codice fiscale, nell'archivio del titolare.

| Destinazione                                         | Menu                                                                    | Campi obbligatori                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Pazienti: anagrafica e dati amministrativi           | Pannello amministrativo del paziente                                    | Codice fiscale, cognome, nome, sesso, data di nascita                    |
| Esenzioni                                            | Pannello amministrativo › Esenzioni                                     | Codice fiscale, codice dell'esenzione, valida dal                        |
| Scelta del medico                                    | Pannello amministrativo › Scelta del medico                             | Codice fiscale, data della scelta                                        |
| Nucleo familiare                                     | Pannello amministrativo › Nucleo familiare                              | Codice fiscale, nucleo (codice o nome nel file)                          |
| Problemi e diagnosi                                  | Patologie › Problemi e diagnosi                                         | Codice fiscale, data della voce, descrizione                             |
| Allergie e reazioni avverse                          | Cartella › Allergie (anche in testata)                                  | Codice fiscale, data della voce, sostanza o agente                       |
| Diario clinico                                       | Storia clinica › Diario                                                 | Codice fiscale, data della voce, tipo di contatto, testo                 |
| Anamnesi                                             | Storia clinica › Anamnesi                                               | Codice fiscale, data della voce, sezione, testo                          |
| Stili di vita e fattori di rischio                   | Storia clinica › Stili di vita                                          | Codice fiscale, data della voce, fattore, valore                         |
| Esame obiettivo e valutazioni                        | Storia clinica › Esame obiettivo                                        | Codice fiscale, data della voce, testo                                   |
| Capacità motoria                                     | Storia clinica › Capacità motoria                                       | Codice fiscale, data della voce, capacità motoria                        |
| Parametri e misure                                   | Cartella › Parametri                                                    | Codice fiscale, data della voce (e almeno un parametro)                  |
| Vaccinazioni                                         | Storia clinica › Vaccinazioni                                           | Codice fiscale, data di somministrazione, vaccino                        |
| Esami di laboratorio                                 | Cartella › Esami                                                        | Codice fiscale, data, analita, valore                                    |
| Farmaci in terapia                                   | Farmaci › Terapie (in corso, concluse o sospese)                        | Codice fiscale, farmaco, tipo di terapia, inizio, confezioni per ricetta |
| Farmaci e prestazioni prescritti con altri programmi | Farmaci prescritti · Visite ed esami prescritti (storico, sola lettura) | Codice fiscale, data della ricetta, farmaco o prestazione                |

- **Paziente già in cartella:** si completano solo i campi vuoti; le differenze sono avvisi con il nome del campo, senza valori; lo stato non cambia.
- **Paziente di un altro archivio dello studio:** la riga si scarta con un messaggio senza dati, e nel registro di quel paziente resta un accesso negato.
- **Voce senza data:** non entra. Non prende la data dell'importazione, perché la condivisione nell'AFT usa la data clinica (D161).
- **Ricette fatte con altri programmi:** finiscono in uno storico a sola lettura. Non si firmano, non si inviano e non si annullano verso il SAR.
- **Scelta del medico** (D174): è sempre del titolare che importa, perché il programma conosce solo i medici dello studio. Una scelta che vale in un periodo già coperto da un'altra scelta in cartella si scarta, con il motivo e senza date; la cessazione vuole il motivo, come nel pannello.
- **Nucleo familiare** (D174): le righe con lo stesso valore nella colonna del nucleo vanno nello stesso nucleo, anche in importazioni diverse (maiuscole e minuscole non contano). L'etichetta è quella del file, se c'è, altrimenti il valore stesso; si cambia poi dal pannello. Un paziente che è già in un altro nucleo resta nel suo e la riga si scarta.
- **Non ancora destinazioni** (scritte nel rapporto se servono): piani terapeutici, consensi, deleghe, referti con allegati, presidi.

## Doppioni, provenienza, annullamento

- Ogni riga scritta ha la sua **provenienza** (`import_origin`): la chiave d'origine è un'impronta SHA-256 del codice fiscale e dei campi naturali, o dell'identificativo d'origine, mai dati in chiaro. Alla seconda importazione dello stesso file le righe risultano «già presenti».
- Un'importazione si **annulla** con un motivo: le voci cliniche e le ricette passate si annullano come quelle scritte a mano, nulla si cancella. Non si annulla se una voce è stata modificata dopo, o se l'importazione ha scritto pazienti, esenzioni, scelte del medico, nuclei familiari o terapie (manca ancora il loro stato «annullato»).

## Sicurezza

- **Tetti** come costanti nominate (`apps/api/src/import/limits.ts`): 16 MiB per file, 100.000 righe e 200 colonne per foglio, 1.000.000 di celle, 50.000 caratteri per cella, 50 fogli, 2.000 voci ZIP, 256 MiB decompressi, 20 secondi di lettura. Sono scelte d'ingegneria, da rivedere con file veri.
- **Il file non si conserva.** Le tabelle lette restano in memoria per un'ora (al più 3 file per utente e 64 MiB in tutto il servizio), poi si dimenticano. Nel database ci sono solo nome, impronta e dimensione del file.
- **Registro:** prova, importazione e letture, con l'id e i conteggi, mai contenuti; una riga per ogni paziente toccato.
- **Regola 1:** in prova si importano solo pazienti inventati, con la X in dodicesima posizione del codice fiscale (D12, D170).

## Come provarlo

`apps/api/test/importazione.test.ts`, `importazione-lettori.test.ts`, `importazione-esportazione.test.ts`, `importazione-pannello.test.ts`, `packages/domain/test/import-destinations.test.ts`; la prova nel browser «importazione a passi»; in Strumenti › Importazione, come titolare, con un CSV di pazienti inventati.

## Domande per la fermata

Con l'opzione consigliata. Fino alla risposta vale la scelta di oggi.

1. **Chi importa.** Consigliata: solo il titolare, sul suo archivio (oggi così).
2. **Programma d'origine e licenza.** Consigliata: nessun profilo per altri programmi nel repository. La Dr.ssa Rocca costruisce il suo profilo sul suo file, nello studio, e l'avvocato dà il parere sull'art. 7 della licenza prima del primo uso.
3. **Voci importate e condivisione.** Consigliata: fuori dal Profilo e dall'AFT finché il medico non le rivede. Oggi entrano subito: manca uno stato «da rivedere».
4. **Ricette passate e regole (R6, R11).** Consigliata: contano e il messaggio lo dice. Oggi non contano.
5. **Campi facoltativi non validi.** Consigliata: si scarta il campo e si tiene la riga. Oggi si scarta la riga intera.
6. **Pazienti senza codice fiscale** (STP, ENI): oggi non si importano.

## Che cosa non è stato provato

- File veri di altri programmi (per regola, solo file inventati).
- Archivi grandi: la scrittura è riga per riga, in una richiesta sola, senza lavoro in background.
- Più istanze del servizio: il file sta nella memoria dell'istanza che l'ha ricevuto.
- La specifica ECMA-376: date e formati degli XLSX presi da openpyxl.
