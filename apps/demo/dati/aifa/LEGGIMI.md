# Farmaci AIFA per la dimostrazione

Dati aperti di AIFA, solo per la dimostrazione nel browser (D256, D261). Il programma vero li prende da `sync/`, con gli stessi file.

- `Classe-A_per_principio-attivo_30-6-2026.csv.gz` e `Classe-H_per_principio-attivo_30-6-2026.csv.gz`: le liste intere di AIFA del 30/6/2026, lette il 18/11/2026, senza cambiare un byte.
- `confezioni_fornitura.csv.gz`: l'anagrafica intera delle confezioni di AIFA, letta il 20/11/2026, senza cambiare un byte (D261). Sono 160.100 confezioni: 160.067 «Autorizzata» e 33 «Sospesa». 13.053 hanno un codice AIC in una delle due liste; le altre 147.047 nelle liste non ci sono: 68.474 con obbligo di prescrizione, 78.568 senza (di cui 2.532 da banco e 74.301 omeopatici), 5 senza regime scritto. Fino alla D257 c'erano solo le 13.053 confezioni delle due liste.
- `SHA256SUMS`: impronte dei contenuti non compressi, che sono quelle dei file d'origine. Le impronte sono anche in `docs/provenienze.md`.

Fonte: AIFA, dati aperti con licenza CC BY 4.0 (https://www.aifa.gov.it/open-data): liste dei farmaci (https://www.aifa.gov.it/liste-dei-farmaci) e anagrafica delle confezioni (https://drive.aifa.gov.it/farmaci/confezioni_fornitura.csv). I prezzi e le classi sono quelli del 30/6/2026 e non si aggiornano: servono a provare il programma, non a prescrivere.

Si rifanno con:

    python3 -I apps/demo/scripts/estrai-aifa.py CLASSE_A.csv CLASSE_H.csv ANAGRAFICA.csv apps/demo/dati/aifa
