"""Dati AIFA per la dimostrazione (D256, D261): liste di classe A e H e anagrafica intera.

Legge i file scaricati da AIFA (dati aperti, licenza CC BY 4.0) e scrive in DESTINAZIONE:

- le liste di classe A e di classe H per principio attivo, intere e senza cambiare un byte;
- l'anagrafica delle confezioni intera, senza cambiare un byte: anche classe C, farmaci senza
  obbligo di prescrizione e confezioni non rimborsate (D261; fino alla D257 c'erano solo le righe
  dei codici AIC delle due liste);
- SHA256SUMS con le impronte dei contenuti (non compressi), che sono quelle dei file d'origine.

Ogni file si scrive compresso con gzip, con la data a zero: lo stesso ingresso dà gli stessi byte.
Solo libreria standard. Da lanciare con `python3 -I`, i file scaricati come argomenti:

    python3 -I apps/demo/scripts/estrai-aifa.py CLASSE_A.csv CLASSE_H.csv ANAGRAFICA.csv DESTINAZIONE
"""

import csv
import gzip
import hashlib
import io
import os
import sys


def aic_column(header: list[str], name: str) -> int:
    """La colonna del codice AIC, con gli spazi e gli a capo dell'intestazione ridotti."""
    for i, h in enumerate(header):
        if " ".join(h.split()) == name:
            return i
    raise SystemExit(f"colonna {name!r} non trovata")


def class_codes(raw: bytes, column: str) -> set[str]:
    rows = csv.reader(io.StringIO(raw.decode("cp1252")), delimiter=";")
    header = next(rows)
    i = aic_column(header, column)
    return {r[i].strip() for r in rows if len(r) > i and r[i].strip()}


def write_gz(path: str, data: bytes) -> None:
    with open(path, "wb") as out:
        with gzip.GzipFile(fileobj=out, mode="wb", compresslevel=9, mtime=0, filename="") as gz:
            gz.write(data)


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    a_path, h_path, ana_path, dest = sys.argv[1:]
    a_raw, h_raw, ana_raw = (open(p, "rb").read() for p in (a_path, h_path, ana_path))
    listed = class_codes(a_raw, "AIC") | class_codes(h_raw, "Codice AIC")

    lines = ana_raw.split(b"\n")
    rows = [line for line in lines[1:] if line.strip()]
    # Ogni riga dell'anagrafica comincia con il codice AIC fra virgolette: "000367045";...
    in_lists = sum(1 for line in rows if line[1:10].decode("ascii", "replace") in listed)

    os.makedirs(dest, exist_ok=True)
    outputs = {
        os.path.basename(a_path): a_raw,
        os.path.basename(h_path): h_raw,
        "confezioni_fornitura.csv": ana_raw,
    }
    sums = []
    for name, data in outputs.items():
        write_gz(os.path.join(dest, name + ".gz"), data)
        sums.append(f"{hashlib.sha256(data).hexdigest()}  {name}")
    with open(os.path.join(dest, "SHA256SUMS"), "w", encoding="utf-8") as out:
        out.write("\n".join(sums) + "\n")
    print(
        f"confezioni nell'anagrafica: {len(rows)}; con un codice AIC nelle liste A e H: {in_lists};"
        f" fuori dalle liste: {len(rows) - in_lists}"
    )


if __name__ == "__main__":
    main()
