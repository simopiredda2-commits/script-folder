# Farmaci di classe A e H per la dimostrazione

Estratti dei dati aperti di AIFA, solo per la dimostrazione nel browser (D256). Il programma vero li prende da `sync/`, con l'anagrafica intera.

- `Classe-A_per_principio-attivo_30-6-2026.csv.gz` e `Classe-H_per_principio-attivo_30-6-2026.csv.gz`: le liste intere di AIFA del 30/6/2026, lette il 18/11/2026, senza cambiare un byte.
- `confezioni_fornitura.csv.gz`: le righe dell'anagrafica delle confezioni di AIFA letta il 20/11/2026 i cui codici AIC stanno in una delle due liste (13.053 righe), ognuna senza cambiare un byte, con l'intestazione. Altri 200 codici delle liste del 30/6 non sono più nell'anagrafica del 20/11.
- `SHA256SUMS`: impronte dei contenuti non compressi e dell'anagrafica intera d'origine. Le impronte dei file d'origine sono anche in `docs/provenienze.md`.

Fonte: AIFA, dati aperti con licenza CC BY 4.0 (https://www.aifa.gov.it/open-data): liste dei farmaci (https://www.aifa.gov.it/liste-dei-farmaci) e anagrafica delle confezioni (https://drive.aifa.gov.it/farmaci/confezioni_fornitura.csv). I prezzi e le classi sono quelli del 30/6/2026 e non si aggiornano: servono a provare il programma, non a prescrivere.

Da tenere a mente: classe C, farmaci senza obbligo di prescrizione e confezioni non rimborsate non ci sono; sono da integrare (D256).

Si rifanno con:

    python3 -I apps/demo/scripts/estrai-aifa.py CLASSE_A.csv CLASSE_H.csv ANAGRAFICA.csv apps/demo/dati/aifa
