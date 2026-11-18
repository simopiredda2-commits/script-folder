# Materiali per il repository

Da estrarre nella radice del repository: i percorsi sono già quelli giusti. Poi lo zip si cancella.

- `docs/requisiti.md`: i requisiti funzionali, copia del documento su claude.ai (revisione 45, 18/11/2026). È la fonte principale.
- `docs/prototipi/`: le schermate disegnate su claude.ai. Solo riferimento di layout: vedi il `LEGGIMI.md` della cartella.
- `sync/`: lo script Python che scarica le banche dati pubbliche (AIFA, Regione Piemonte, ISTAT, NSIS), con le sue prove (`python3 test_banche_dati.py`: 5 prove verdi il 18/11/2026). Provato solo su un server finto: dal cloud i siti istituzionali non sono raggiungibili.
- `packages/brand/assets/script/`: le 20 varianti ufficiali del marchio di SCRIPT, copiate identiche dalla cartella del marchio. Le impronte sono in `SHA256SUMS` (`sha256sum -c SHA256SUMS` dentro la cartella).

Nessun dato reale: i nomi dei pazienti nei prototipi sono stati rigenerati il 18/11/2026 e sono tutti inventati.
