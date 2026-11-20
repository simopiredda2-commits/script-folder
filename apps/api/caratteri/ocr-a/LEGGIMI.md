# Carattere OCR-A del promemoria

`OCRA.ttf` è il carattere OCR-A usato per l'NRE e il codice fiscale in chiaro sotto i codici a barre del promemoria della ricetta (DM 2/11/2011, allegato 2; D97, D211).

- **Da dove viene**: pacchetto Debian `fonts-ocr-a`, versione 1.0-10 (`fonts-ocr-a_1.0-10_all.deb`, SHA-256 `5096ab0f836e4d7f059988269e50e189a2b81f65386dd7ddbb5cdfccaa96ff06`), scaricato il 20/11/2026 dai mirror di Debian; il file è `usr/share/fonts/truetype/ocr-a/OCRA.ttf`, copiato senza cambiarlo.
- **Autore**: John Sauter, progetto «ocr-a-font» su SourceForge. Secondo le sue note, il carattere è ricavato dalle definizioni MetaFont di Tor Lillqvist e Richard B. Wales e confrontato con la norma ANSI X3.17-1977.
- **Licenza**: pubblico dominio, come dice il file `copyright` del pacchetto Debian. Il lavoro di confezionamento di Debian (GPL 3) non è nel repository.
- **Impronta**: in `SHA256SUMS`; una prova la controlla.
- **Uso**: il servizio lo incorpora nel PDF del promemoria, con i soli caratteri usati. Nessun carattere si scarica da fuori (regola 8).
- **Non verificato**: la corrispondenza con la forma chiesta dal decreto («OCR-A, ECMA, tipo 1») e la lettura con un lettore ottico. Si controllano con una stampa vera.
