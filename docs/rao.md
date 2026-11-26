# Tabelle RAO: trascrizione da controllare (D285)

**Stato: da controllare.** Nel programma vero le tabelle entrano quando le schede di `packages/reference/data/rao/` dicono chi le ha controllate (`controllato_da`). Fino ad allora si vedono solo nell'ambiente di prova e nella dimostrazione, con «trascrizione da controllare» accanto (come il catalogo regionale, D159 e D260).

Le RAO (Raggruppamenti di attesa omogenei) legano, per ogni prestazione, le condizioni cliniche alla classe di priorità. Nella ricetta specialistica del primo accesso il medico sceglie la condizione del paziente e il programma mette la classe della tabella; il medico la può cambiare. Senza la sua scelta la classe resta vuota. La domanda è della Dr.ssa Rocca; la scelta di Simone è in `docs/decisioni.md`, D285.

## Da dove viene

| File                       | Atto                                                                                                                                                | Tabelle              | Indicazioni |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------- |
| `agenas-manuale-2020.json` | AGENAS, «Manuale RAO», luglio 2020, «in sostituzione dell'allegato C» del PNGLA 2019-2021: è il PDF pubblicato oggi nella pagina AGENAS del manuale | 77 (109 prestazioni) | 1379        |
| `piemonte-dd973-2019.json` | Regione Piemonte, D.D. 24/12/2019, n. 973, allegato A (BU n. 7 del 13/2/2020): cardiologia                                                          | 3                    | 45          |
| `piemonte-dd259-2019.json` | Regione Piemonte, D.D. 10/4/2019, n. 259, allegato A: gastroenterologia                                                                             | 3                    | 49          |

Indirizzi, byte e impronte dei PDF sono in `docs/provenienze.md`, «RAO». I PDF restano fuori dal repository (D92).

- Le due determine «devono essere adottate da tutti i soggetti che hanno titolo ad emettere prescrizioni per conto del Servizio Sanitario Regionale». Per le loro prestazioni valgono al posto del manuale, solo per gli studi in Piemonte.
- Il piano nazionale delle liste d'attesa in vigore, 2026-2028 (decreto del 26/6/2026, GU n. 195 del 24/8/2026), rimanda al manuale di AGENAS. Il suo allegato A, al punto 5, dice che cosa deve fare la cartella per il metodo RAO:
  - aiutare a scegliere le indicazioni cliniche: fatto;
  - collegare l'indicazione scelta al quesito diagnostico: fatto, con il testo della condizione nel quesito vuoto;
  - tenerne traccia nel flusso della ricetta dematerializzata: non si può ancora, vedi «Che cosa non c'è».
- La nota della Direzione Sanità del 24/4/2024 dice che l'ASL, nei percorsi di tutela, verifica anche l'appropriatezza della prescrizione rispetto al modello RAO.

## Come è stata fatta la trascrizione

- Le celle delle tabelle si leggono dal PDF con uno strumento (pdfplumber); il testo è quello del documento. Le righe di una cella sono unite da uno spazio.
- Il controllo a vista sulle pagine è stato fatto sulle tabelle con la numerazione strana, sulla visita cardiologica del manuale (028, pagine 74-76) e su tutte le tabelle regionali.
- Il testo fuori dalle tabelle del manuale è stato cercato pagina per pagina: c'è una sola nota, sotto la tabella 053 (pagina 138), ed è nella tabella.

## Che cosa è diverso dal PDF

1. **Caratteri**: il punto elenco del carattere Symbol è scritto «•», il trattino U+2010 «-». Nella D.D. 259 il PDF scrive il trattino come «-», trattino morbido e «-» (per esempio «5-­-7 giorni»): sulla pagina è un trattino solo, e così è scritto.
2. **Classi spezzate dal cambio di pagina** (manuale, tabella 033, classi B e D): una riga sola, con la numerazione che continua.
3. **Voci con un elenco sotto** (determine: «Recente insorgenza, di:», «Sintomi d’allarme:», «In pazienti asintomatici con:»): una voce sola, con le parti separate da «; ».
4. **Righe dalle note** (D.D. 973, visita degli adulti): nella tabella la classe U è «Livello di priorita’ non previsto». Le note sotto la tabella danno i criteri «U PS» (invio al pronto soccorso) e «U 48 ore», che chiamano criteri «per la visita in classe U entro 72 ore». Sono righe della tabella, segnate «dalle note».
5. **«9- altro (10%)»** (D.D. 973, età pediatrica, classe P): sul PDF è sotto «13. In pazienti asintomatici con:», con i numeri dell'elenco interno. Qui è una voce a sé, come «Altro» nelle altre classi.

La numerazione stampata resta com'è, anche quando è strana:

- nella tabella 007 del manuale, classe D, ci sono due «1.»;
- nella 035, classe D, comincia da 5;
- nelle determine continua da una tabella all'altra.

Il programma riconosce ogni indicazione dalla sua posizione, non dal numero.

## Il legame con il catalogo

Una tabella vale per una voce del catalogo quando il codice del nomenclatore della voce è uno dei codici della tabella. Dove lo stesso codice vale per discipline diverse, serve in più l'inizio della descrizione:

| Tabella        | Codice           | La descrizione comincia con                         |
| -------------- | ---------------- | --------------------------------------------------- |
| 028 e D.D. 973 | 89.7A.3          | PRIMA VISITA CARDIOLOGICA (non la cardiochirurgica) |
| 035            | 89.7             | PRIMA VISITA GERIATRICA                             |
| 044            | 89.7             | PRIMA VISITA REUMATOLOGICA                          |
| 038            | 89.13            | PRIMA VISITA NEUROLOGICA (non la neurochirurgica)   |
| 036            | 89.26.1, 89.26.3 | PRIMA VISITA GINECOLOGICA, PRIMA VISITA OSTETRIC    |

I codici sono quelli dell'allegato 4 del DPCM LEA di oggi (PDF del Ministero del 29/9/2026), letti prestazione per prestazione. Otto codici stampati nel manuale oggi sono di un'altra prestazione o non ci sono: il legame va al codice giusto e la tabella lo dice in `nota_legame`.

| Tabella | Prestazione                                      | Codice nel manuale | Che cos'è oggi quel codice                 | Codice di oggi |
| ------- | ------------------------------------------------ | ------------------ | ------------------------------------------ | -------------- |
| 033     | Prima visita di medicina fisica e riabilitazione | 89.7B.3            | prima visita di medicina nucleare          | 89.7B.2        |
| 037     | Prima visita nefrologica                         | 89.7B.5            | prima visita odontostomatologica           | 89.7B.4        |
| 040     | Prima visita oncologica                          | 89.7B.7            | prima visita ortopedica                    | 89.7B.6        |
| 041     | Prima visita ortopedica                          | 89.7B.8            | prima visita otorinolaringoiatrica         | 89.7B.7        |
| 042     | Prima visita otorinolaringoiatrica               | 89.7B.9            | prima visita pneumologica                  | 89.7B.8        |
| 043     | Prima visita pneumologica                        | 89.7C.1            | prima visita di radioterapia               | 89.7B.9        |
| 045     | Prima visita urologica/andrologica               | 89.7C.3            | prima visita di radiologia interventistica | 89.7C.2        |
| 056     | Rx morfometria vertebrale dorsale                | 87.23.64           | non c'è                                    | 87.23.6        |

Altri casi:

- La testata della tabella 019 (elettromiografia) stampa anche «ESOFAGOGASTRODUODENOSCOPIA [EGDS] CON BIOPSIA IN SEDE MULTIPLA - Codice 45.16.2». È un errore del documento: l'EGDS ha la sua tabella, la 020, e la 019 non è legata al 45.16.2.
- Le determine stampano i codici del nomenclatore regionale del 2013 (89.7, 88.72.6) accanto a quelli del DPCM del 2017. Il legame va ai codici di oggi, con la tabella di corrispondenza delle stesse determine.
- Due tabelle per lo stesso codice (026 e 027 per 89.7A.1; 031 e 032 per 89.7A.8): si vedono tutte e due e il medico sceglie.

Una prova controlla che ogni codice del legame sia nel catalogo regionale trascritto (D.D. 590/2026 con le modifiche della D.D. 710/2026), e che ogni inizio di descrizione trovi almeno una voce.

## Che cosa controllare

1. Un campione di tabelle del manuale contro le pagine del PDF (classi, attese, testi), in particolare le tabelle su più pagine: 030, 031, 039, 042.
2. Tutte le tabelle delle due determine, contro le pagine 6-9 dei loro PDF.
3. Gli otto codici corretti, nella tabella qui sopra, contro l'allegato 4.
4. I cinque inizi di descrizione: che prendano le voci giuste del catalogo e lascino fuori le altre.

Controllato tutto, chi ha controllato scrive nome e cognome in `controllato_da` nelle tre schede.

## Nel programma

- **Dove**: nella ricetta specialistica SSN del primo accesso, quando una prestazione in ricetta ha una tabella. Il campo «Condizione clinica (RAO)» sta sopra la classe di priorità.
- **L'elenco**:
  - le condizioni sono raggruppate per classe, con l'attesa scritta nella tabella; prima gli adulti, poi l'età pediatrica;
  - le righe d'emergenza («invio al pronto soccorso») e le note della tabella sono in un riquadro a parte, come promemoria: non danno una classe.
- **La scelta**:
  - il programma mette la classe della condizione. Se il quesito è vuoto, o è il testo della condizione scelta prima, ci scrive il testo della condizione;
  - con «Altro» il quesito resta del medico, che descrive le condizioni cliniche, come chiede la nota del manuale;
  - se poi il medico cambia la classe, la pagina lo dice, con il simbolo e la parola.
- **La classe di priorità**: non ha più un valore per difetto, prima era «P». Senza una classe, R14 ferma l'invio della ricetta del primo accesso, come prima.
- **Che cosa tiene la ricetta**: la chiave della condizione, la classe della tabella, il testo e la fonte, com'erano alla scelta. Il servizio controlla che la condizione sia di una prestazione della ricetta, della specialistica del primo accesso, e non una riga d'emergenza. Lo storico delle ricette la mostra; «Rinnova» la ripropone, se la tabella c'è ancora.
- **Ambiente**: le tabelle che nessuno ha controllato si usano solo nell'ambiente di prova e nella dimostrazione.

## Che cosa non c'è

- **La condizione nel messaggio al SAR**: le specifiche del SAR (V06) e del Sistema TS non hanno un campo per la condizione RAO. Il piano 2026-2028 chiede di tenerne traccia «nel flusso della ricetta dematerializzata»: è una domanda per il CSI. Oggi la condizione arriva all'erogatore solo nel quesito, quando il medico lo lascia scrivere al programma.
- **Le attese**: si mostrano come le scrive la tabella. Le determine del 2019 danno 180 giorni alla classe P e 30 alla D della prima visita cardiologica; il manuale di AGENAS 120 e 30; per la prima visita gastroenterologica la D.D. 259 dà 60 giorni alla D. Quale attesa vale oggi in Piemonte è una domanda per la Regione.
- **Le RAO per i ricoveri** (allegato C del piano 2026-2028): non riguardano la ricetta del medico di famiglia.
- **Altre prestazioni con criteri regionali**: le D.D. 43/2008 e 375/2009, che le determine del 2019 modificano, non sono state trovate. Se avevano criteri per altre prestazioni, qui non ci sono.
