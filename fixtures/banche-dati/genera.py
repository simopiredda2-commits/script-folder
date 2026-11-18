"""Genera i file d'esempio delle banche dati pubbliche (sito finto e trascrizioni).

Si lancia a mano dalla radice del repository, solo quando gli esempi vanno cambiati:

    python3 -I fixtures/banche-dati/genera.py

Serve openpyxl, solo per scrivere l'XLSX: è un produttore di file Excel diverso dal lettore del
servizio, così la prova non legge file scritti dallo stesso codice che li legge.

Tutto è inventato, tranne le intestazioni del file ISTAT dei comuni e le due righe di Agliè e
Airasca, lette il 18/11/2026 dal file ISTAT aggiornato al 21/02/2026.
"""

import hashlib
import json
from pathlib import Path

from openpyxl import Workbook

QUI = Path(__file__).resolve().parent
SITO = QUI / "sito"
TRASCRIZIONI = QUI / "trascrizioni"


def scrivi(percorso: Path, dati: bytes) -> None:
    percorso.parent.mkdir(parents=True, exist_ok=True)
    percorso.write_bytes(dati)


def pdf_di_prova(titolo: str) -> bytes:
    """Un PDF di una pagina con una riga di testo; i riferimenti incrociati sono calcolati."""
    testo = f"BT /F1 14 Tf 72 760 Td ({titolo}) Tj ET".encode("latin-1")
    oggetti = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(testo)).encode() + b" >>\nstream\n" + testo + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    posizioni = []
    for i, corpo in enumerate(oggetti, start=1):
        posizioni.append(len(out))
        out += f"{i} 0 obj\n".encode() + corpo + b"\nendobj\n"
    inizio_xref = len(out)
    out += f"xref\n0 {len(oggetti) + 1}\n0000000000 65535 f \n".encode()
    for p in posizioni:
        out += f"{p:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(oggetti) + 1} /Root 1 0 R >>\nstartxref\n{inizio_xref}\n%%EOF\n".encode()
    return bytes(out)


# --------------------------------------------------------------------------- ISTAT

INTESTAZIONE_ISTAT = [
    "Codice Regione",
    "Codice dell'Unità territoriale sovracomunale  (valida a fini statistici)",
    "Codice Provincia (Storico)(1)",
    "Progressivo del Comune (2)",
    "Codice Comune formato alfanumerico",
    "Denominazione (Italiana e straniera)",
    "Denominazione in italiano",
    "Denominazione altra lingua",
    "Codice Ripartizione Geografica",
    "Ripartizione geografica",
    "Denominazione Regione",
    "Denominazione dell'Unità territoriale sovracomunale  (valida a fini statistici)",
    "Tipologia di Unità territoriale sovracomunale",
    "Flag Comune capoluogo di Provincia/Città metropolitana/libero consorzio",
    "Sigla automobilistica",
    "Codice Comune formato numerico",
    "Codice Comune numerico con 107 Province (dal 2017 al 2025)",
    "Codice Comune numerico con 110 Province (dal 2010 al 2016)",
    "Codice Comune numerico con 107 Province (dal 2006 al 2009)",
    "Codice Comune numerico con 103 Province (dal 1995 al 2005)",
    "Codice Catastale del Comune",
    "Codice NUTS1 2021",
    "Codice NUTS2 2021 (3)",
    "Codice NUTS3 2021",
    "Codice NUTS1 2024",
    "Codice NUTS2 2024 (3)",
    "Codice NUTS3 2024",
]


def riga_istat(progressivo: str, nome: str, numerico: int, catastale: str) -> list:
    return [
        "01", "201", "001", progressivo, f"001{progressivo}", nome, nome, None, 1, "Nord-ovest",
        "Piemonte", "Torino", 3, 0, "TO", numerico, numerico, numerico, numerico, numerico,
        catastale, "ITC", "ITC1", "ITC11", "ITC", "ITC1", "ITC11",
    ]


def genera_istat() -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "CODICI al 21_02_2026"
    ws.append(INTESTAZIONE_ISTAT)
    ws.append(riga_istat("001", "Agliè", 1001, "A074"))
    ws.append(riga_istat("002", "Airasca", 1002, "A109"))
    percorso = SITO / "istat" / "Elenco-comuni-italiani.xlsx"
    percorso.parent.mkdir(parents=True, exist_ok=True)
    wb.save(percorso)


# --------------------------------------------------------------------------- AIFA (intestazioni di prova)

INTESTAZIONE_CLASSE = "AIC di prova;Principio attivo di prova;Prezzo di prova al 15/6/2026;Gruppo di equivalenza di prova;Nota di prova"


def genera_aifa() -> None:
    pagina = """<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Liste di prova</title></head>
<body><h1>Liste dei farmaci (pagina di prova)</h1><ul>
<li><a href="/aifa/farmaci/confezioni_fornitura.csv">Anagrafica di prova</a></li>
<li><a href="/aifa/documents/20142/3815901/Classe-A_per_principio-attivo_30-6-2026.csv">Classe A di prova</a></li>
<li><a href="/aifa/documents/20142/3815901/Classe-H_per_principio-attivo_30-6-2026.csv">Classe H di prova</a></li>
</ul></body></html>
"""
    scrivi(SITO / "aifa" / "liste-dei-farmaci.html", pagina.encode("utf-8"))
    # Anagrafica in cp1252, come i file che sync deve saper leggere; «più» non è utf-8 valido.
    anagrafica = "\r\n".join([
        "AIC di prova;Denominazione di prova;Confezione di prova;Principio attivo di prova;ATC di prova;Forma di prova;Fornitura di prova",
        "900000011;PROVALINA;28 compresse 5 mg;principio di prova;Z99ZZ01;compressa;regime di prova",
        "900000023;PROVALINA;14 compresse 5 mg;principio di prova;Z99ZZ01;compressa;regime di prova",
        "900000035;TESTAMICINA;1 flaconcino;sostanza di prova;Z98ZZ02;polvere per soluzione iniettabile;regime di prova",
        "900000047;ESEMPINA;20 compresse (più forti);esempio attivo;Z97ZZ03;compressa;regime di prova",
        '900000059;"PROVALINA ""FORTE""";10 bustine;principio di prova;Z99ZZ01;granulato;regime di prova',
    ]) + "\r\n"
    scrivi(SITO / "aifa" / "farmaci" / "confezioni_fornitura.csv", anagrafica.encode("cp1252"))
    classe_a = "\n".join([
        INTESTAZIONE_CLASSE,
        "900000011;principio di prova;5,20;GP-01;",
        "900000023;principio di prova;3,10;GP-01;",
        "900000059;principio di prova;4,00;GP-01;",
    ]) + "\n"
    cartella = SITO / "aifa" / "documents" / "20142" / "3815901"
    scrivi(cartella / "Classe-A_per_principio-attivo_30-6-2026.csv", b"\xef\xbb\xbf" + classe_a.encode("utf-8"))
    classe_h = "\n".join([INTESTAZIONE_CLASSE, "900000035;sostanza di prova;120,00;;"]) + "\n"
    scrivi(cartella / "Classe-H_per_principio-attivo_30-6-2026.csv", classe_h.encode("utf-8"))


# --------------------------------------------------------------------------- Regione Piemonte (PDF di prova)

def pagina_con_link(titolo: str, href: str) -> bytes:
    return (f'<!doctype html><html lang="it"><head><meta charset="utf-8"><title>{titolo}</title></head>'
            f'<body><h1>{titolo}</h1><p><a href="{href}">Scarica il documento di prova</a></p></body></html>\n').encode("utf-8")


def genera_piemonte() -> dict[str, str]:
    pdf = {
        "farmaci_pht_dpc.pdf": pdf_di_prova("Elenco di prova dei farmaci PHT in DPC"),
        "catalogo_prova_allegato_c.pdf": pdf_di_prova("Catalogo di prova delle prestazioni"),
        "esenzioni_prestazioni_prova.pdf": pdf_di_prova("Esenzioni e prestazioni di prova"),
    }
    scrivi(SITO / "piemonte" / "dpc.html", pagina_con_link("DPC di prova", "/piemonte/media/57684/download"))
    scrivi(SITO / "piemonte" / "media" / "57684" / "download.pdf", pdf["farmaci_pht_dpc.pdf"])
    scrivi(SITO / "piemonte" / "catalogo.html", pagina_con_link("Catalogo di prova", "/piemonte/attach/catalogo_prova_allegato_c.pdf"))
    scrivi(SITO / "piemonte" / "attach" / "catalogo_prova_allegato_c.pdf", pdf["catalogo_prova_allegato_c.pdf"])
    scrivi(SITO / "piemonte" / "esenzioni_prestazioni_prova.pdf", pdf["esenzioni_prestazioni_prova.pdf"])
    return {k: hashlib.sha256(v).hexdigest() for k, v in pdf.items()}


# --------------------------------------------------------------------------- trascrizioni

def trascrizione(nome: str, righe: list[str], scheda: dict) -> None:
    scrivi(TRASCRIZIONI / f"{nome}.csv", ("\n".join(righe) + "\n").encode("utf-8"))
    base = {"trascritto_da": "Persona di prova", "trascritto_il": "2026-11-18",
            "controllato_da": "Seconda persona di prova"}
    (TRASCRIZIONI / f"{nome}.json").write_text(
        json.dumps({**scheda, **base}, ensure_ascii=False, indent=2) + "\n", "utf-8")


def genera_trascrizioni(impronte: dict[str, str]) -> None:
    trascrizione("piemonte_dpc/farmaci_pht_dpc", [
        "principio_attivo;atc;nota_aifa;piano_terapeutico",
        "esempio attivo;Z97ZZ03;13;sì",
    ], {"tipo": "farmaci_dpc", "fonte": "piemonte_dpc", "chiave": "farmaci_pht_dpc.pdf",
        "sha256_origine": impronte["farmaci_pht_dpc.pdf"], "atto": "Elenco di prova dei farmaci PHT in DPC",
        "in_vigore_dal": "2026-07-09"})
    trascrizione("piemonte_catalogo/catalogo-precedente", [
        "codice_regionale;codice_nomenclatore;descrizione;branca;tariffa;note",
        "89.7;89.7;Visita di prova (catalogo precedente);Branca di prova;;",
    ], {"tipo": "prestazioni", "serie": "catalogo-piemonte", "fonte": None, "chiave": None,
        "sha256_origine": None, "atto": "Catalogo di prova precedente", "in_vigore_dal": "2024-12-30"})
    trascrizione("piemonte_catalogo/catalogo_prova_allegato_c", [
        "codice_regionale;codice_nomenclatore;descrizione;branca;tariffa;note",
        "89.7;89.7;Visita di prova;Branca di prova;20,66;",
        "PROVA.02;;Esame di prova;Laboratorio di prova;;Nota di prova",
    ], {"tipo": "prestazioni", "serie": "catalogo-piemonte", "fonte": "piemonte_catalogo",
        "chiave": "catalogo_prova_allegato_c.pdf", "sha256_origine": impronte["catalogo_prova_allegato_c.pdf"],
        "atto": "Catalogo di prova delle prestazioni", "in_vigore_dal": "2026-10-30"})
    trascrizione("esenzioni/catalogo-esenzioni", [
        "codice;descrizione",
        "DEMO;Esenzione dimostrativa",
        "T01;Esenzione di prova per patologia",
        "T02;Altra esenzione di prova",
    ], {"tipo": "esenzioni", "fonte": None, "chiave": None, "sha256_origine": None,
        "atto": "Elenco di prova delle esenzioni", "in_vigore_dal": "2026-01-01"})
    trascrizione("piemonte_esenzioni_prestazioni/esenzioni_prestazioni_prova", [
        "esenzione;prestazione",
        "T01;89.7",
    ], {"tipo": "esenzioni_prestazioni", "fonte": "piemonte_esenzioni_prestazioni",
        "chiave": "esenzioni_prestazioni_prova.pdf", "sha256_origine": impronte["esenzioni_prestazioni_prova.pdf"],
        "atto": "Esenzioni e prestazioni di prova", "in_vigore_dal": "2026-01-01"})


if __name__ == "__main__":
    genera_istat()
    genera_aifa()
    genera_trascrizioni(genera_piemonte())
    print(f"File d'esempio scritti in {SITO} e {TRASCRIZIONI}")
