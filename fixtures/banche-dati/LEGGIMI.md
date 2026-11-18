# Banche dati d'esempio

File per provare l'importazione delle banche dati pubbliche senza raggiungere siti reali (vedi `docs/banche-dati.md`).

- `sito/`: un sito finto con le stesse fonti di `sync/fonti.json`; le prove lo servono in locale e ci lanciano sopra `sync/banche_dati.py` vero.
- `fonti-prova.json`: le fonti di `sync/` puntate al sito finto (`__BASE__` diventa l'indirizzo del server).
- `trascrizioni/`: trascrizioni d'esempio dei PDF, con le impronte dei PDF del sito finto.
- `mappature-prova.json`: mappature per le intestazioni **di prova** dei CSV AIFA d'esempio. Non sono le intestazioni AIFA.
- `genera.py`: rigenera tutto (`python3 -I fixtures/banche-dati/genera.py`, serve `openpyxl`).

Tutto è inventato (farmaci, prezzi, codici, prestazioni, esenzioni, atti, persone), tranne le intestazioni del file ISTAT dei comuni e le due righe di Agliè e Airasca, lette il 18/11/2026 dal file ISTAT aggiornato al 21/02/2026. Nessun dato di pazienti.
