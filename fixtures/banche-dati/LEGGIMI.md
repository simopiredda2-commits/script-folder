# Banche dati d'esempio

File per provare l'importazione delle banche dati pubbliche senza raggiungere siti reali (vedi `docs/banche-dati.md`).

- `sito/`: un sito finto con le stesse fonti di `sync/fonti.json`; le prove lo servono in locale e ci lanciano sopra `sync/banche_dati.py` vero.
- `fonti-prova.json`: le fonti di `sync/` puntate al sito finto (`__BASE__` diventa l'indirizzo del server).
- `trascrizioni/`: trascrizioni d'esempio dei PDF, con le impronte dei PDF del sito finto.
- `genera.py`: rigenera tutto (`python3 -I fixtures/banche-dati/genera.py`, serve `openpyxl`).

Che cosa è vero:

- **AIFA**: intestazioni e righe copiate senza cambiare un byte dai file AIFA letti il 18/11/2026 (anagrafica delle confezioni; liste di classe A e H del 30/6/2026). Fonte: AIFA, dati aperti con licenza CC BY 4.0 (https://www.aifa.gov.it/open-data). Amlodipina, metformina e atorvastatina con un equivalente di marca, dulaglutide, ceftriaxone in classe H, paracetamolo fuori dalle liste di classe, e due prezzi della classe H che non sono numeri. Valgono le mappature del repository (`packages/reference/data/mappature.json`).
- **DPC**: la riga di DULAGLUTIDE della trascrizione è quella dell'elenco della Regione Piemonte aggiornato al 9/7/2026; il PDF del sito d'esempio è un estratto di prova.
- **ISTAT**: le intestazioni e le due righe di Agliè e Airasca, lette il 18/11/2026 dal file aggiornato al 21/02/2026.

Inventato: catalogo delle prestazioni, esenzioni, atti di prova, persone che trascrivono. I prezzi e le classi sono quelli dei file del 30/6/2026 e non si aggiornano: servono a provare il programma, non a prescrivere. Nessun dato di pazienti.
