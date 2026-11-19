# sync – banche dati pubbliche

Lo script scarica le banche dati pubbliche che servono all'ambiente di test della cartella clinica e le tiene aggiornate. Va lanciato una volta a mano e poi ogni notte in automatico.

È il prototipo del requisito "le banche dati si aggiornano da sole ogni giorno". Usa solo la libreria standard di Python (3.9 o più recente) e non contiene dati di pazienti.

## Cosa scarica

| Fonte | Cosa | Stato al 17/11/2026 |
|---|---|---|
| `aifa_liste` | AIFA: anagrafica dei farmaci, classe A e H, liste di trasparenza, carenze, registri e piani (18 CSV) | verificata |
| `aifa_note_pt` | AIFA: piani terapeutici che sostituiscono alcune note (PDF) | verificata |
| `piemonte_dpc` | Regione Piemonte: farmaci PHT in distribuzione per conto (PDF) | verificata |
| `piemonte_catalogo` | Regione Piemonte: catalogo delle prestazioni, D.D. 710/2026 (PDF) | da confermare al primo giro |
| `piemonte_esenzioni_prestazioni` | Regione Piemonte: esenzioni e prestazioni associate, D.D. 1167/2022 (PDF) | verificata |
| `piemonte_bur_osserva` | Bollettino regionale: segnala gli atti nuovi su catalogo, esenzioni, DPC e ricette, senza scaricarli | da confermare al primo giro |
| `salute_nsis_class` | Ministero della Salute: ICD-10-IM, CIPI e tabelle di transcodifica da ICD-9-CM | da confermare al primo giro |
| `istat_comuni` | ISTAT: elenco dei comuni (link permanente) | verificata |

"Da confermare" vuol dire che ho trovato la pagina ma non ho potuto controllare i link: dal mio ambiente i siti ufficiali sono bloccati. Se un indirizzo non torna, il rapporto lo segna come errore e lo correggiamo in `fonti.json`.

Restano fuori, perché non sono file da scaricare:
- la banca dati Farmadati, che è a licenza;
- AURA, SAR/SAC, Fascicolo sanitario e INPS, che sono servizi con credenziali;
- le esenzioni e l'ICD-9-CM, per cui non ho trovato un file strutturato ufficiale.

I dettagli sono in `fonti.json`, alla voce `non_scaricabili`.

## Primo giro

```sh
cd sync
python3 banche_dati.py --prova                                   # elenca i file, non scarica nulla
python3 banche_dati.py --dest ~/dati-pubblici --contatto tua@email.it
```

`--contatto` mette la tua email nello User-Agent, così i gestori dei siti sanno chi scarica. Lo script lascia 1,5 secondi fra una richiesta e l'altra.

Sul Mac, se compare un errore di certificato con il Python scaricato da python.org, esegui una volta *Install Certificates.command* nella cartella Applicazioni › Python 3.x. Non disattivare la verifica.

## Cosa produce

```
dati-pubblici/
  correnti/<fonte>/<file>             la versione in uso, che ha passato i controlli
  archivio/<fonte>/<data>/<file>      ogni versione diversa, mai sovrascritta
  stato.json                          per ogni file: origine, impronta SHA-256, righe, colonne,
                                      ultimo controllo riuscito alla fonte (controllato_il)
  registro.jsonl                      una riga per ogni download: da dove, quando, impronta, esito
  rapporti/<data_ora>.md              il rapporto di ogni giro
  rapporti/<data_ora>.json            lo stesso rapporto per il programma che importa
  ultimo-rapporto.md                  copia dell'ultimo rapporto
  ultimo-rapporto.json                copia dell'ultimo rapporto in JSON
```

Il rapporto in JSON ha l'identificativo del giro (`giro`), l'inizio e la fine, le fonti elaborate e una riga per ogni file con il suo esito: `invariato`, `nuovo`, `aggiornato`, `da_verificare`, `errore`, `registrato`. Le ore hanno i millisecondi, così due giri vicini restano distinguibili. Il programma lo legge dopo ogni giro (`pnpm banche-dati:aggiorna`, D156).

I nomi in `correnti/` non hanno date: `Classe-A_per_principio-attivo_30-6-2026.csv` diventa `3815901_Classe-A_per_principio-attivo.csv`. Il numero davanti è la cartella AIFA di origine, e serve a distinguere file con lo stesso nome. Così l'applicazione legge sempre lo stesso percorso.

## I controlli

Un file nuovo entra in `correnti/` solo se:
- è davvero del tipo atteso, e non per esempio una pagina di errore travestita da CSV;
- è scaricato per intero;
- il numero di righe non cambia più del 20% rispetto alla versione in uso;
- le colonne sono le stesse. Le date dentro i nomi delle colonne vengono ignorate.

Se un controllo non passa, il file resta in `archivio/`, la versione precedente resta in uso e il rapporto lo segna **da verificare**. Dopo averlo guardato, puoi metterlo in uso con:

```sh
python3 banche_dati.py --dest ~/dati-pubblici --accetta aifa_liste/825643_Lista_farmaci_equivalenti.csv
```

Il rapporto segnala anche:
- un file che sparisce dalla pagina ufficiale;
- una pagina che non ha più file da scaricare;
- un atto nuovo sul Bollettino regionale.

I PDF vanno comunque estratti e controllati prima di usarne i dati.

Codici di uscita: `0` tutto a posto, `1` almeno un errore, `2` file da verificare a mano. Servono per farsi avvisare da cron o dal sistema di monitoraggio.

## Ogni notte

Sul Mac con launchd, salva questo file come `~/Library/LaunchAgents/it.script.banche-dati.plist`, sostituendo `TUO_UTENTE`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>it.script.banche-dati</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/Users/TUO_UTENTE/PERCORSO_DEL_REPOSITORY/sync/banche_dati.py</string>
    <string>--dest</string><string>/Users/TUO_UTENTE/dati-pubblici</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>10</integer></dict>
  <key>StandardOutPath</key><string>/Users/TUO_UTENTE/dati-pubblici/sync.log</string>
  <key>StandardErrorPath</key><string>/Users/TUO_UTENTE/dati-pubblici/sync.log</string>
</dict>
</plist>
```

Poi attivalo con:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/it.script.banche-dati.plist
```

Se a quell'ora il Mac dorme, il giro parte al risveglio. Tieni le cartelle fuori da Documenti e Scrivania: macOS può negare l'accesso ai processi lanciati in automatico.

Su un server Linux con cron:

```
10 3 * * * /usr/bin/python3 /opt/banche-dati/sync/banche_dati.py --dest /var/lib/dati-pubblici >> /var/log/banche-dati.log 2>&1
```

## Prove

```sh
python3 -m unittest -v test_banche_dati
```

Le prove girano su un server finto in locale e coprono:
- il primo download;
- il giro senza cambiamenti;
- un file con un nome nuovo;
- un file oltre la soglia;
- l'accettazione a mano;
- un file sparito dalla pagina;
- una pagina di errore al posto del CSV;
- un archivio guasto;
- gli atti nuovi sul Bollettino.

## Avvertenze

- **Uso dei dati.** Servono solo per l'ambiente di test. In produzione le regole sui farmaci useranno la banca dati a licenza e i servizi regionali, e il controllo finale delle ricette resta del SAC.
- **Anagrafica AIFA.** AIFA avverte che i dati dell'anagrafica sono provvisori e hanno finalità solo descrittive.
- **Licenza AIFA.** I dati AIFA sono rilasciati con licenza CC BY 4.0, che chiede di citare la fonte.
- **Dati personali.** Non mettere dati di pazienti in queste cartelle.
