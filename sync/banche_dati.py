#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
banche_dati.py: scarica e tiene aggiornate le banche dati pubbliche per l'ambiente di test della cartella clinica.

Uso
    python3 banche_dati.py --contatto tua@email.it
    python3 banche_dati.py --dest ~/dati-pubblici --solo aifa_liste,istat_comuni
    python3 banche_dati.py --prova                  # elenca cosa scaricherebbe, senza scaricare
    python3 banche_dati.py --accetta FONTE/CHIAVE   # mette in uso un file rimasto "da verificare"

È pensato per girare ogni notte con cron, launchd o systemd. Usa solo la libreria standard
e serve Python 3.9 o più recente.

Cosa fa con ogni fonte di fonti.json:
  1. trova i file: i link della pagina ufficiale che rispettano il filtro, oppure l'indirizzo diretto;
  2. li scarica con una richiesta condizionata (ETag / Last-Modified), quindi solo se sono cambiati;
  3. calcola l'impronta SHA-256: un file identico all'ultima versione non viene salvato di nuovo;
  4. controlla il file (formato reale, righe, colonne) e lo confronta con la versione precedente;
  5. se i controlli passano, il file diventa la versione corrente; se no resta in uso la precedente
     e il rapporto lo segna "da verificare";
  6. annota tutto nel registro (registro.jsonl) e scrive il rapporto (rapporti/).

Codici di uscita: 0 tutto a posto · 1 almeno un errore · 2 nessun errore, ma file da verificare a mano.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import html.parser
import io
import json
import os
import re
import shutil
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

VERSIONE = "0.1.0"

ESTENSIONI = (".csv", ".xlsx", ".xls", ".ods", ".zip", ".pdf", ".json", ".xml", ".txt")
TIPI_CONTENUTO = {
    "application/pdf": ".pdf",
    "text/csv": ".csv",
    "application/csv": ".csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.oasis.opendocument.spreadsheet": ".ods",
    "application/zip": ".zip",
    "application/json": ".json",
    "application/xml": ".xml",
    "text/xml": ".xml",
    "text/plain": ".txt",
}

# Le date nei nomi dei file e nelle intestazioni cambiano a ogni pubblicazione: per riconoscere
# che "Classe-A_30-6-2026.csv" e "Classe-A_31-12-2026.csv" sono lo stesso dataset le togliamo.
_MESI = "gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre"
_SEP = r"[_\-. ]"
_DATE_RE = [
    re.compile(rf"{_SEP}?\d{{4}}[\-._]\d{{1,2}}[\-._]\d{{1,2}}"),               # 2026-06-26
    re.compile(rf"{_SEP}?\d{{1,2}}{_SEP}?(?:{_MESI}){_SEP}?\d{{4}}", re.I),     # 9_luglio_2026
    re.compile(rf"{_SEP}?(?:{_MESI}){_SEP}?\d{{4}}", re.I),                     # settembre_2022
    re.compile(rf"{_SEP}?\d{{1,2}}[\-._/]\d{{1,2}}[\-._/]\d{{2,4}}"),           # 30-6-2026, 15/6/2026
]
_ANNO_FINALE_RE = re.compile(rf"{_SEP}?(?:19|20)\d{{2}}$")                     # orfani-2025


class ErroreFonte(Exception):
    """Errore che riguarda una sola fonte o un solo file: gli altri continuano."""


# --------------------------------------------------------------------------- nomi e chiavi

def _togli_date(testo: str) -> str:
    out = testo
    for rx in _DATE_RE:
        out = rx.sub("", out)

    def compatta(m: re.Match) -> str:  # 16022026 oppure 20260216
        s = m.group(0)
        for formato in ("%d%m%Y", "%Y%m%d"):
            try:
                dt.datetime.strptime(s, formato)
                return ""
            except ValueError:
                pass
        return s

    return re.sub(r"(?<!\d)\d{8}(?!\d)", compatta, out)


def chiave_dataset(nome_file: str, cartella: str | None = None) -> str:
    """Nome stabile del dataset: il nome del file senza date, più l'eventuale cartella numerica."""
    radice, est = os.path.splitext(nome_file)
    radice = _ANNO_FINALE_RE.sub("", _togli_date(radice))
    radice = re.sub(r"[_\-. ]{2,}", "_", radice).strip("_-. ") or "file"
    chiave = nome_sicuro(f"{radice}{est.lower()}")
    return f"{cartella}_{chiave}" if cartella else chiave


def nome_sicuro(nome: str) -> str:
    nome = os.path.basename(nome.replace("\\", "/"))
    nome = re.sub(r"[^A-Za-z0-9._-]+", "_", nome).strip("._") or "file"
    return nome[:150]


def nome_da_url(url: str) -> tuple[str | None, str | None]:
    """Nome del file nel percorso e cartella numerica che lo precede (stile /documents/20142/825643/x.csv)."""
    segmenti = [urllib.parse.unquote(s) for s in urllib.parse.urlparse(url).path.split("/") if s]
    for i in range(len(segmenti) - 1, -1, -1):
        if segmenti[i].lower().endswith(ESTENSIONI):
            cartella = segmenti[i - 1] if i > 0 and segmenti[i - 1].isdigit() else None
            return segmenti[i], cartella
    return None, None


def nome_da_disposition(cd: str | None) -> str | None:
    if not cd:
        return None
    m = re.search(r"filename\*\s*=\s*[\w-]+''([^;]+)", cd, re.I)
    if m:
        return urllib.parse.unquote(m.group(1).strip().strip('"'))
    m = re.search(r'filename\s*=\s*"([^"]+)"', cd, re.I) or re.search(r"filename\s*=\s*([^;]+)", cd, re.I)
    return m.group(1).strip() if m else None


def _norma_cella(c: str) -> str:
    return " ".join(_togli_date(c).lower().split())


# --------------------------------------------------------------------------- rete

class Rete:
    def __init__(self, agente: str, timeout: float, pausa: float, tentativi: int = 3):
        self.agente, self.timeout, self.pausa, self.tentativi = agente, timeout, pausa, tentativi
        self._ultima = 0.0

    def apri(self, url: str, intestazioni: dict | None = None):
        attesa = self.pausa - (time.monotonic() - self._ultima)
        if attesa > 0:  # pausa di cortesia fra una richiesta e l'altra
            time.sleep(attesa)
        h = {"User-Agent": self.agente, "Accept": "*/*", "Accept-Language": "it-IT,it;q=0.9"}
        h.update(intestazioni or {})
        ultimo = None
        for tentativo in range(1, self.tentativi + 1):
            self._ultima = time.monotonic()
            try:
                return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=self.timeout)
            except urllib.error.HTTPError as e:
                if e.code == 304:
                    return e
                if e.code in (429, 500, 502, 503, 504) and tentativo < self.tentativi:
                    ultimo = e
                    time.sleep(self.pausa * 2 * tentativo)
                    continue
                raise ErroreFonte(f"il server ha risposto {e.code} ({e.reason})") from e
            except urllib.error.URLError as e:
                if isinstance(e.reason, ssl.SSLCertVerificationError):
                    raise ErroreFonte(
                        "certificato del sito non verificato. Su macOS, con il Python scaricato da "
                        "python.org, esegui una volta 'Install Certificates.command' nella cartella "
                        "Applicazioni/Python 3.x. Non disattivare la verifica."
                    ) from e
                ultimo = e
            except (TimeoutError, ConnectionError, OSError) as e:
                ultimo = e
            if tentativo < self.tentativi:
                time.sleep(self.pausa * 2 * tentativo)
        raise ErroreFonte(f"nessuna risposta dopo {self.tentativi} tentativi: {ultimo}")


def leggi_pagina(rete: Rete, url: str, max_byte: int = 10_000_000) -> tuple[str, str]:
    with rete.apri(url) as r:
        dati = r.read(max_byte + 1)
        if len(dati) > max_byte:
            raise ErroreFonte("pagina troppo grande")
        charset = r.headers.get_content_charset() or "utf-8"
        finale = r.geturl()
    try:
        return dati.decode(charset, errors="replace"), finale
    except LookupError:
        return dati.decode("utf-8", errors="replace"), finale


class _Link(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.link: list[tuple[str, str]] = []
        self._href: str | None = None
        self._testo: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            if self._href is not None:
                self.chiudi()
            href = dict(attrs).get("href")
            if href:
                self._href, self._testo = href.strip(), []

    def handle_data(self, data):
        if self._href is not None:
            self._testo.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            self.chiudi()

    def chiudi(self):
        self.link.append((self._href, " ".join("".join(self._testo).split())))
        self._href, self._testo = None, []


def estrai_link(testo_html: str, base: str) -> list[tuple[str, str]]:
    p = _Link()
    p.feed(testo_html)
    p.close()
    if p._href is not None:
        p.chiudi()
    visti, out = set(), []
    for href, testo in p.link:
        if href.startswith(("#", "mailto:", "javascript:", "tel:")):
            continue
        assoluto, _ = urllib.parse.urldefrag(urllib.parse.urljoin(base, href))
        if urllib.parse.urlparse(assoluto).scheme not in ("http", "https") or assoluto in visti:
            continue
        visti.add(assoluto)
        out.append((assoluto, testo))
    return out


def scarica(rete: Rete, url: str, cartella_tmp: Path, precedente: dict | None, max_byte: int, forza: bool):
    """Scarica in un file temporaneo. Restituisce (metadati, percorso) o (metadati, None) se invariato (304)."""
    intest = {}
    if precedente and not forza and precedente.get("url") == url:
        if precedente.get("etag"):
            intest["If-None-Match"] = precedente["etag"]
        if precedente.get("last_modified"):
            intest["If-Modified-Since"] = precedente["last_modified"]
    r = rete.apri(url, intest)
    try:
        codice = r.getcode()
        meta = {
            "url": url,
            "url_finale": r.geturl(),
            "stato_http": codice,
            "etag": r.headers.get("ETag"),
            "last_modified": r.headers.get("Last-Modified"),
            "content_type": r.headers.get("Content-Type"),
            "content_disposition": r.headers.get("Content-Disposition"),
        }
        if codice == 304:
            return meta, None
        h, n = hashlib.sha256(), 0
        fd, tmp = tempfile.mkstemp(dir=cartella_tmp, suffix=".part")
        try:
            with os.fdopen(fd, "wb") as f:
                while True:
                    blocco = r.read(1 << 16)
                    if not blocco:
                        break
                    n += len(blocco)
                    if n > max_byte:
                        raise ErroreFonte(f"file oltre il limite di {max_byte // 1_000_000} MB")
                    h.update(blocco)
                    f.write(blocco)
            atteso = r.headers.get("Content-Length")
            if atteso and atteso.isdigit() and int(atteso) != n:
                raise ErroreFonte(f"download incompleto: {n} byte su {atteso}")
        except BaseException:
            os.unlink(tmp)
            raise
        meta.update(byte=n, sha256=h.hexdigest())
        return meta, Path(tmp)
    finally:
        r.close()


# --------------------------------------------------------------------------- controlli sul file

def ispeziona(percorso: Path, est: str) -> dict:
    with open(percorso, "rb") as f:
        testa = f.read(4096)
    t = testa.lstrip().lower()
    if est != ".xml" and (t.startswith(b"<!doctype html") or t.startswith(b"<html") or b"<html" in t[:512]):
        return {"ok": False, "problema": "il server ha restituito una pagina web al posto del file"}
    if est == ".pdf":
        ok = testa.startswith(b"%PDF")
        return {"ok": ok, "problema": None if ok else "non è un PDF"}
    if est in (".xlsx", ".zip", ".ods"):
        try:
            with zipfile.ZipFile(percorso) as z:
                guasto = z.testzip()
        except zipfile.BadZipFile:
            return {"ok": False, "problema": "non è un archivio ZIP/XLSX valido"}
        return {"ok": guasto is None, "problema": f"archivio danneggiato ({guasto})" if guasto else None}
    if est == ".xls":
        ok = testa.startswith(b"\xD0\xCF\x11\xE0")
        return {"ok": ok, "problema": None if ok else "non è un file Excel .xls valido"}
    if est in (".csv", ".txt"):
        return ispeziona_csv(percorso)
    if est == ".json":
        try:
            json.loads(percorso.read_bytes().decode("utf-8-sig"))
        except (ValueError, UnicodeDecodeError) as e:
            return {"ok": False, "problema": f"JSON non valido: {e}"}
    return {"ok": True, "problema": None}


def ispeziona_csv(percorso: Path) -> dict:
    grezzo = percorso.read_bytes()
    for codifica in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            testo = grezzo.decode(codifica)
            break
        except UnicodeDecodeError:
            continue
    prima = next((r for r in testo.splitlines() if r.strip()), "")
    separatore = max(";,\t|", key=prima.count) if prima else ";"
    if not prima or prima.count(separatore) == 0:
        return {"ok": False, "problema": "nessun separatore riconosciuto nella prima riga"}
    intest, righe, irregolari = None, 0, 0
    try:  # una riga alla volta: l'anagrafica AIFA può pesare decine di MB
        for r in csv.reader(io.StringIO(testo), delimiter=separatore):
            if intest is None:
                if sum(1 for c in r if c.strip()) >= 2:
                    intest = [c.strip() for c in r]
                continue
            if not any(c.strip() for c in r):
                continue
            righe += 1
            if len(r) != len(intest):
                irregolari += 1
    except csv.Error as e:
        return {"ok": False, "problema": f"CSV non leggibile: {e}"}
    if intest is None:
        return {"ok": False, "problema": "nessuna intestazione trovata"}
    return {
        "ok": righe > 0,
        "problema": None if righe else "il file non contiene righe di dati",
        "codifica": codifica,
        "separatore": separatore,
        "righe": righe,
        "colonne": len(intest),
        "intestazione": intest,
        "righe_irregolari": irregolari,
    }


def confronta(prec: dict | None, nuovo: dict, soglia: float, est: str) -> tuple[list[str], bool]:
    note, verificare = [], False
    righe = nuovo.get("righe")
    if righe and nuovo.get("righe_irregolari", 0) / righe > 0.01:
        note.append(f"{nuovo['righe_irregolari']} righe hanno un numero di colonne diverso dall'intestazione")
        verificare = True
    if not prec:
        return note, verificare
    if prec.get("intestazione") is not None and nuovo.get("intestazione") is not None:
        a = [_norma_cella(c) for c in prec["intestazione"]]
        b = [_norma_cella(c) for c in nuovo["intestazione"]]
        if a != b:
            tolte, aggiunte = [c for c in a if c not in b], [c for c in b if c not in a]
            dettagli = []
            if tolte:
                dettagli.append("tolte: " + ", ".join(tolte))
            if aggiunte:
                dettagli.append("aggiunte: " + ", ".join(aggiunte))
            note.append("colonne cambiate (" + ("; ".join(dettagli) or "ordine diverso") + ")")
            verificare = True
    if prec.get("righe") and righe is not None:
        variazione = (righe - prec["righe"]) / prec["righe"]
        if abs(variazione) > soglia:
            note.append(f"righe {prec['righe']} → {righe} ({variazione:+.0%}), oltre la soglia del {soglia:.0%}")
            verificare = True
    if est in (".xlsx", ".xls", ".ods", ".zip") and prec.get("byte") and nuovo.get("byte"):
        variazione = (nuovo["byte"] - prec["byte"]) / prec["byte"]
        if abs(variazione) > max(soglia, 0.5):
            note.append(f"dimensione {prec['byte']} → {nuovo['byte']} byte ({variazione:+.0%})")
            verificare = True
    return note, verificare


# --------------------------------------------------------------------------- stato su disco

def ora() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def leggi_json(p: Path, predefinito):
    if not p.exists():
        return predefinito
    return json.loads(p.read_text("utf-8"))


def scrivi_json(p: Path, dati) -> None:
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(dati, ensure_ascii=False, indent=2), "utf-8")
    os.replace(tmp, p)


def copia_atomica(da: Path, a: Path) -> None:
    a.parent.mkdir(parents=True, exist_ok=True)
    tmp = a.with_name(a.name + ".tmp")
    shutil.copy2(da, tmp)
    os.replace(tmp, a)


class Contesto:
    def __init__(self, dest: Path, rete: Rete | None, max_byte: int, forza: bool):
        self.dest, self.rete, self.max_byte, self.forza = dest, rete, max_byte, forza
        self.oggi = dt.date.today().isoformat()
        self.stato = leggi_json(dest / "stato.json", {"versione": 1, "file": {}})
        self.osservati = leggi_json(dest / "osservati.json", {})
        self.tmp = dest / ".tmp"
        self.tmp.mkdir(parents=True, exist_ok=True)
        self.righe_rapporto: list[dict] = []

    def indice_url(self) -> dict[str, str]:
        return {v["url"]: k for k, v in self.stato["file"].items() if v.get("url")}

    def registra(self, voce: dict) -> None:
        with open(self.dest / "registro.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"quando": ora(), **voce}, ensure_ascii=False) + "\n")

    def salva(self) -> None:
        scrivi_json(self.dest / "stato.json", self.stato)
        scrivi_json(self.dest / "osservati.json", self.osservati)

    def esito(self, fonte: dict, nome: str, esito: str, note: list[str] | str | None = None, righe=None):
        if isinstance(note, str):
            note = [note]
        self.righe_rapporto.append(
            {"fonte": fonte["id"], "nome": nome, "esito": esito, "note": note or [], "righe": righe}
        )
        simbolo = {"invariato": "·", "nuovo": "+", "aggiornato": "↑", "da_verificare": "?", "errore": "✗",
                   "registrato": "·"}.get(esito, " ")
        testo_note = f": {'; '.join(note)}" if note else ""
        print(f"  {simbolo} {nome}: {esito.replace('_', ' ')}{testo_note}")


# --------------------------------------------------------------------------- elaborazione

def elabora_file(ctx: Contesto, fonte: dict, url: str, visti: set[str]) -> None:
    indice = ctx.indice_url()
    nome_url, cartella = nome_da_url(url)
    chiave_fissa = fonte.get("chiave")
    prec_url = ctx.stato["file"].get(indice.get(url, ""))
    try:
        meta, tmp = scarica(ctx.rete, url, ctx.tmp, prec_url, ctx.max_byte, ctx.forza)
    except ErroreFonte as e:
        if url in indice:
            visti.add(indice[url])
        ctx.registra({"fonte": fonte["id"], "url": url, "esito": "errore", "problema": str(e)})
        ctx.esito(fonte, nome_url or url, "errore", str(e))
        return

    if tmp is None:  # 304: invariato
        if url not in indice:
            ctx.esito(fonte, nome_url or url, "errore", "risposta 304 senza una versione precedente")
            return
        k = indice[url]
        visti.add(k)
        ctx.esito(fonte, ctx.stato["file"][k]["chiave"], "invariato")
        return

    nome_orig = nome_da_disposition(meta["content_disposition"]) or nome_url
    if not nome_orig:
        tipo = (meta["content_type"] or "").split(";")[0].strip().lower()
        nome_orig = fonte["id"] + TIPI_CONTENUTO.get(tipo, ".bin")
    if chiave_fissa and not nome_orig.lower().endswith(os.path.splitext(chiave_fissa)[1].lower()):
        nome_orig = chiave_fissa  # il server non dice il nome: vale quello atteso, e il controllo usa il suo tipo
    est = os.path.splitext(nome_orig)[1].lower()
    chiave = chiave_fissa or chiave_dataset(nome_orig, cartella)
    k = f"{fonte['id']}/{chiave}"
    visti.add(k)
    prec = ctx.stato["file"].get(k)

    if prec and prec.get("sha256") == meta["sha256"]:
        tmp.unlink()
        prec.update(url=url, etag=meta["etag"], last_modified=meta["last_modified"], controllato_il=ora())
        ctx.esito(fonte, chiave, "invariato")
        return
    attesa = (prec or {}).get("in_attesa")
    if attesa and attesa.get("sha256") == meta["sha256"]:
        tmp.unlink()
        ctx.esito(fonte, chiave, "da_verificare", ["ancora in attesa di verifica"] + attesa.get("note", []))
        return

    archivio = ctx.dest / "archivio" / fonte["id"] / ctx.oggi / nome_sicuro(nome_orig)
    archivio.parent.mkdir(parents=True, exist_ok=True)
    n = 2
    while archivio.exists():
        archivio = archivio.with_name(f"{Path(nome_sicuro(nome_orig)).stem}_{n}{est}")
        n += 1
    shutil.move(str(tmp), archivio)

    controllo = ispeziona(archivio, est)
    voce = {
        "fonte": fonte["id"], "chiave": chiave, **meta,
        "archivio": str(archivio.relative_to(ctx.dest)),
        "controllo": {x: y for x, y in controllo.items() if x != "intestazione"},
    }
    if not controllo["ok"]:
        ctx.registra({**voce, "esito": "errore"})
        ctx.esito(fonte, chiave, "errore", controllo["problema"])
        return

    note, verificare = confronta(prec, {**controllo, "byte": meta["byte"]}, fonte.get("soglia_righe", 0.2), est)
    if est == ".pdf":
        note.append("PDF: i dati vanno estratti e controllati prima dell'uso")
    dati = {
        "fonte": fonte["id"], "chiave": chiave, "url": url, "nome_originale": nome_orig,
        "sha256": meta["sha256"], "byte": meta["byte"], "etag": meta["etag"],
        "last_modified": meta["last_modified"], "scaricato_il": ora(), "archivio": voce["archivio"],
        "righe": controllo.get("righe"), "colonne": controllo.get("colonne"),
        "intestazione": controllo.get("intestazione"),
    }
    if verificare:
        voce_stato = ctx.stato["file"].setdefault(k, {"fonte": fonte["id"], "chiave": chiave})
        voce_stato["in_attesa"] = {**dati, "note": note}
        ctx.registra({**voce, "esito": "da_verificare", "note": note})
        ctx.esito(fonte, chiave, "da_verificare", note, controllo.get("righe"))
        return

    corrente = ctx.dest / "correnti" / fonte["id"] / chiave
    copia_atomica(archivio, corrente)
    dati["corrente"] = str(corrente.relative_to(ctx.dest))
    ctx.stato["file"][k] = dati
    esito = "aggiornato" if prec and prec.get("sha256") else "nuovo"
    ctx.registra({**voce, "esito": esito, "note": note})
    ctx.esito(fonte, chiave, esito, note, controllo.get("righe"))


def elabora_fonte(ctx: Contesto, fonte: dict) -> None:
    print(f"\n{fonte['ente']} · {fonte['titolo']} ({fonte['id']})")
    url = fonte["url"].format(anno=dt.date.today().year)
    if fonte["tipo"] == "file":
        visti: set[str] = set()
        elabora_file(ctx, fonte, url, visti)
        return
    try:
        testo, finale = leggi_pagina(ctx.rete, url)
    except ErroreFonte as e:
        ctx.esito(fonte, url, "errore", f"pagina non raggiungibile: {e}")
        return
    link = estrai_link(testo, finale)

    if fonte["tipo"] == "osserva":
        parole = [p.lower() for p in fonte["parole"]]
        trovati = [(u, t) for u, t in link if any(p in f"{t} {u}".lower() for p in parole)]
        gia = ctx.osservati.setdefault(fonte["id"], {"inizio": None, "link": {}})
        prima_volta = gia["inizio"] is None
        gia["inizio"] = gia["inizio"] or ctx.oggi
        nuovi = [(u, t) for u, t in trovati if u not in gia["link"]]
        for u, t in nuovi:
            gia["link"][u] = {"titolo": t, "visto_il": ctx.oggi}
        if prima_volta:
            quanti = "1 atto registrato" if len(nuovi) == 1 else f"{len(nuovi)} atti registrati"
            ctx.esito(fonte, url, "registrato", f"{quanti} come punto di partenza")
        elif nuovi:
            ctx.esito(fonte, url, "da_verificare", [f"nuovo: {t or u} — {u}" for u, t in nuovi])
        else:
            ctx.esito(fonte, url, "invariato")
        return

    filtro = re.compile(fonte["filtro"], re.I)
    candidati = [u for u, _ in link if filtro.search(u)]
    if not candidati:
        ctx.esito(fonte, url, "errore", "nessun file trovato nella pagina: forse la pagina è cambiata")
        return
    limite = fonte.get("max_file", 60)
    if len(candidati) > limite:
        ctx.esito(fonte, url, "errore", f"{len(candidati)} file trovati, oltre il limite di {limite}: controllare il filtro")
        return
    if fonte.get("chiave") and len(candidati) > 1:
        ctx.esito(fonte, url, "errore", f"attesi 1 file con chiave fissa, trovati {len(candidati)}")
        return
    visti: set[str] = set()
    for u in candidati:
        elabora_file(ctx, fonte, u, visti)
    for k, v in ctx.stato["file"].items():
        if v.get("fonte") == fonte["id"] and k not in visti and v.get("sha256"):
            ctx.esito(fonte, v["chiave"], "da_verificare",
                      "non è più nella pagina: resta in uso l'ultima versione, controllare se è stato ritirato")


def accetta(ctx: Contesto, chiavi: list[str]) -> int:
    codice = 0
    for k in chiavi:
        voce = ctx.stato["file"].get(k)
        attesa = (voce or {}).get("in_attesa")
        if not attesa:
            print(f"✗ {k}: nessun file in attesa di verifica")
            codice = 1
            continue
        corrente = ctx.dest / "correnti" / voce["fonte"] / voce["chiave"]
        copia_atomica(ctx.dest / attesa["archivio"], corrente)
        nuovo = {x: y for x, y in attesa.items() if x != "note"}
        nuovo["corrente"] = str(corrente.relative_to(ctx.dest))
        ctx.stato["file"][k] = nuovo
        ctx.registra({"fonte": voce["fonte"], "chiave": voce["chiave"], "esito": "accettato a mano",
                      "archivio": attesa["archivio"], "sha256": attesa["sha256"]})
        print(f"✓ {k}: ora è in uso la versione del {attesa['scaricato_il'][:10]}")
    ctx.salva()
    return codice


def scrivi_rapporto(ctx: Contesto, fonti: list[dict]) -> Path:
    conta: dict[str, int] = {}
    for r in ctx.righe_rapporto:
        conta[r["esito"]] = conta.get(r["esito"], 0) + 1
    ordine = ["invariato", "nuovo", "aggiornato", "da_verificare", "errore", "registrato"]
    riepilogo = " · ".join(f"{conta[e]} {e.replace('_', ' ')}" for e in ordine if conta.get(e))
    righe = [
        "# Aggiornamento delle banche dati",
        "",
        f"Eseguito il {dt.datetime.now().strftime('%d/%m/%Y alle %H:%M')} · banche_dati {VERSIONE}",
        "",
        f"**Riepilogo:** {riepilogo or 'nessuna fonte elaborata'}",
        "",
    ]
    per_id = {f["id"]: f for f in fonti}
    for fid in dict.fromkeys(r["fonte"] for r in ctx.righe_rapporto):
        f = per_id[fid]
        righe += [f"## {f['ente']} · {f['titolo']}", "",
                  f"Fonte: {f['url'].format(anno=dt.date.today().year)} · "
                  f"Licenza: {f.get('licenza', 'da verificare')}", "",
                  "| File | Esito | Righe | Note |", "|---|---|---|---|"]
        for r in (x for x in ctx.righe_rapporto if x["fonte"] == fid):
            note = "<br>".join(n.replace("|", "\\|") for n in r["note"])
            righe.append(f"| {r['nome']} | {r['esito'].replace('_', ' ')} | {r['righe'] or ''} | {note} |")
        righe.append("")
    cartella = ctx.dest / "rapporti"
    cartella.mkdir(exist_ok=True)
    p = cartella / f"{dt.datetime.now().strftime('%Y-%m-%d_%H%M%S')}.md"
    p.write_text("\n".join(righe), "utf-8")
    shutil.copy2(p, ctx.dest / "ultimo-rapporto.md")
    return p


def prendi_lucchetto(dest: Path) -> Path:
    p = dest / ".in-corso"
    try:
        fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        if time.time() - p.stat().st_mtime < 6 * 3600:
            raise SystemExit("Un altro aggiornamento è in corso (file .in-corso). Riprova più tardi.")
        p.unlink()
        fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    return p


def carica_fonti(percorso: Path) -> list[dict]:
    fonti = json.loads(percorso.read_text("utf-8"))["fonti"]
    ids = set()
    for f in fonti:
        if not re.fullmatch(r"[a-z0-9_]+", f.get("id", "")) or f["id"] in ids:
            raise SystemExit(f"fonti.json: id mancante, non valido o ripetuto: {f.get('id')!r}")
        if f.get("tipo") not in ("pagina", "file", "osserva") or not f.get("url"):
            raise SystemExit(f"fonti.json: tipo o url non validi per {f['id']}")
        if f["tipo"] == "pagina" and not f.get("filtro"):
            raise SystemExit(f"fonti.json: manca il filtro per {f['id']}")
        if f["tipo"] == "osserva" and not f.get("parole"):
            raise SystemExit(f"fonti.json: mancano le parole per {f['id']}")
        ids.add(f["id"])
    return fonti


def main(argv: list[str] | None = None) -> int:
    if sys.version_info < (3, 9):
        raise SystemExit("Serve Python 3.9 o più recente.")
    ap = argparse.ArgumentParser(description="Scarica e aggiorna le banche dati pubbliche per l'ambiente di test della cartella clinica.")
    ap.add_argument("--dest", default="dati-pubblici", help="cartella dei dati (predefinita: ./dati-pubblici)")
    ap.add_argument("--fonti", default=str(Path(__file__).with_name("fonti.json")), help="elenco delle fonti")
    ap.add_argument("--solo", help="solo queste fonti, id separati da virgola")
    ap.add_argument("--prova", action="store_true", help="elenca i file che scaricherebbe, senza scaricarli")
    ap.add_argument("--accetta", action="append", metavar="FONTE/CHIAVE",
                    help="mette in uso un file rimasto da verificare, dopo averlo controllato")
    ap.add_argument("--contatto", default=os.environ.get("SYNC_CONTATTO", ""),
                    help="email da mettere nello User-Agent, così i gestori dei siti sanno chi scarica")
    ap.add_argument("--forza", action="store_true", help="ignora ETag e Last-Modified e riscarica tutto")
    ap.add_argument("--pausa", type=float, default=1.5, help="secondi fra una richiesta e l'altra (predefinito 1,5)")
    ap.add_argument("--timeout", type=float, default=120, help="secondi di attesa per ogni richiesta")
    ap.add_argument("--max-mb", type=int, default=500, help="dimensione massima di un file")
    args = ap.parse_args(argv)

    dest = Path(args.dest).expanduser().resolve()
    dest.mkdir(parents=True, exist_ok=True)
    fonti = carica_fonti(Path(args.fonti).expanduser())
    if args.solo:
        scelte = {s.strip() for s in args.solo.split(",") if s.strip()}
        ignote = scelte - {f["id"] for f in fonti}
        if ignote:
            raise SystemExit(f"Fonti sconosciute: {', '.join(sorted(ignote))}")
        fonti = [f for f in fonti if f["id"] in scelte]

    agente = f"BancheDatiSync/{VERSIONE} (ambiente di test{'; ' + args.contatto if args.contatto else ''})"
    rete = Rete(agente, args.timeout, args.pausa)
    lucchetto = prendi_lucchetto(dest)
    try:
        ctx = Contesto(dest, rete, args.max_mb * 1_000_000, args.forza)
        if args.accetta:
            return accetta(ctx, args.accetta)
        if args.prova:
            for f in fonti:
                url = f["url"].format(anno=dt.date.today().year)
                print(f"\n{f['ente']} · {f['titolo']} ({f['id']}) · {f['tipo']}")
                if f["tipo"] == "file":
                    print(f"  {url}")
                    continue
                try:
                    testo, finale = leggi_pagina(rete, url)
                except ErroreFonte as e:
                    print(f"  ✗ pagina non raggiungibile: {e}")
                    continue
                link = estrai_link(testo, finale)
                if f["tipo"] == "osserva":
                    parole = [p.lower() for p in f["parole"]]
                    trovati = [u for u, t in link if any(p in f"{t} {u}".lower() for p in parole)]
                    print(f"  {len(trovati)} link con le parole cercate")
                    continue
                filtro = re.compile(f["filtro"], re.I)
                for u in (u for u, _ in link if filtro.search(u)):
                    print(f"  {u}")
            return 0

        print(f"Aggiornamento banche dati in {dest}")
        for f in fonti:
            try:
                elabora_fonte(ctx, f)
            finally:
                ctx.salva()
        p = scrivi_rapporto(ctx, fonti)
        esiti = {r["esito"] for r in ctx.righe_rapporto}
        print(f"\nRapporto: {p}")
        return 1 if "errore" in esiti else 2 if "da_verificare" in esiti else 0
    finally:
        shutil.rmtree(dest / ".tmp", ignore_errors=True)
        lucchetto.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
