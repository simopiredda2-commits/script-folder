# Formati della distinta delle prestazioni aggiuntive

`ppip-formati.json` dice come si scrive in CSV la distinta mensile delle prestazioni aggiuntive (PPIP, D212): quali colonne, in che ordine, con quale intestazione, con le date e i decimali in che forma.

- **`acn-allegato-6`**: i campi che chiede l'allegato 6 dell'ACN della medicina generale 2022-2024, comma 4 (data di effettuazione, nome, cognome, indirizzo e codice fiscale dell'assistito, per ogni prestazione), più codice, prestazione, quantità, luogo, autorizzazione e compenso.
- **Formato dell'ASL**: quando Regione e ASL diranno come vogliono la distinta, si aggiunge qui un formato nuovo con il suo `id`, senza cambiare il codice. I campi che si possono usare sono quelli di `DistintaRow` in `apps/api/src/ppip/service.ts`; una prova controlla che ogni colonna usi un campo che esiste.
- `formatoData`: `gg/mm/aaaa` oppure `aaaa-mm-gg`. `decimali`: `virgola` (fogli di calcolo in italiano) oppure `punto`.
