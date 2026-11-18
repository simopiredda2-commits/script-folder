#!/usr/bin/env python3
"""Prove di banche_dati su un server finto in locale. Uso: python3 -m unittest -v test_banche_dati"""
import http.server
import io
import json
import shutil
import tempfile
import threading
import unittest
import urllib.parse
import zipfile
from pathlib import Path

import banche_dati as ps

PERCORSI: dict[str, dict] = {}


class Finto(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        r = PERCORSI.get(urllib.parse.urlparse(self.path).path)
        if r is None:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"non trovato")
            return
        etag = r.get("etag")
        if etag and self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        corpo = r["corpo"]
        self.send_response(r.get("stato", 200))
        for k, v in r.get("intestazioni", {}).items():
            self.send_header(k, v)
        if etag:
            self.send_header("ETag", etag)
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def log_message(self, *args):
        pass


def csv_righe(n, data="15/6/2026"):
    righe = [f"Principio attivo;AIC;X=in lista di trasparenza Aifa {data}"]
    righe += [f"Farmaco {i};{100000000 + i:09d};X" for i in range(n)]
    return ("\n".join(righe) + "\n").encode("cp1252")


def xlsx_finto():
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("xl/workbook.xml", "<workbook/>")
    return b.getvalue()


def pagina(*link):
    return ("<html><body>" + "".join(f'<a href="{h}">{t}</a>' for h, t in link) + "</body></html>").encode()


class ProvaChiavi(unittest.TestCase):
    def test_date_tolte(self):
        casi = {
            "Classe-A_per_principio-attivo_30-6-2026.csv": "Classe-A_per_principio-attivo.csv",
            "lista_farmaci_valutati_inserimento_classe_Cnn_06.11.2026.csv": "lista_farmaci_valutati_inserimento_classe_Cnn.csv",
            "Strutture_registri_regioni_2026-06-26.csv": "Strutture_registri_regioni.csv",
            "Liste_sostanze_attive_settembre_2022.csv": "Liste_sostanze_attive.csv",
            "Lista-farmaci-orfani-2025.csv": "Lista-farmaci-orfani.csv",
            "Farmaci_PHT_DPC_9_luglio_2026.pdf": "Farmaci_PHT_DPC.pdf",
            "3.ELENCO_SISTEMATICO_ICD-10-IM_V.GAMMA_2.1_VALIDITA_DA_16022026.xlsx":
                "3.ELENCO_SISTEMATICO_ICD-10-IM_V.GAMMA_2.1_VALIDITA_DA.xlsx",
            "confezioni_fornitura.csv": "confezioni_fornitura.csv",
        }
        for nome, atteso in casi.items():
            self.assertEqual(ps.chiave_dataset(nome), atteso, nome)

    def test_cartella_numerica(self):
        nome, cartella = ps.nome_da_url("https://x.it/documents/20142/825643/Lista_farmaci_equivalenti.csv/ab-12?t=1")
        self.assertEqual((nome, cartella), ("Lista_farmaci_equivalenti.csv", "825643"))
        self.assertEqual(ps.nome_da_url("https://x.it/web/media/57684/download"), (None, None))

    def test_intestazione_con_data_non_cambia(self):
        a = {"intestazione": ["AIC", "X=in lista di trasparenza Aifa 15/6/2026"], "righe": 100}
        b = {"intestazione": ["AIC", "X=in lista di trasparenza Aifa 15/7/2026"], "righe": 104, "righe_irregolari": 0}
        self.assertEqual(ps.confronta(a, b, 0.2, ".csv"), ([], False))


class ProvaGiri(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Finto)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        self.cartella = Path(tempfile.mkdtemp())
        self.dest = self.cartella / "dati"
        self.fonti = self.cartella / "fonti.json"
        self.fonti.write_text(json.dumps({"fonti": [
            {"id": "t_pagina", "ente": "Prova", "titolo": "Pagina", "tipo": "pagina",
             "url": self.base + "/lista.html", "filtro": r"\.csv(?:$|[/?#])|/media/\d+/download"},
            {"id": "t_file", "ente": "Prova", "titolo": "File", "tipo": "file",
             "url": self.base + "/istat/Elenco-comuni-italiani.xlsx"},
            {"id": "t_osserva", "ente": "Prova", "titolo": "Bollettino", "tipo": "osserva",
             "url": self.base + "/bur.html", "parole": ["catalogo regionale", "esenzion"]},
        ]}), "utf-8")
        PERCORSI.clear()

    def tearDown(self):
        shutil.rmtree(self.cartella)

    def giro(self, *extra):
        return ps.main(["--dest", str(self.dest), "--fonti", str(self.fonti), "--pausa", "0", "--timeout", "5", *extra])

    def corrente(self, chiave):
        return (self.dest / "correnti" / "t_pagina" / chiave).read_bytes()

    def test_ciclo_completo(self):
        PERCORSI.update({
            "/lista.html": {"corpo": pagina(
                ("files/Classe-A_30-6-2026.csv", "Download"),
                ("/documents/20142/825643/Lista_farmaci_equivalenti.csv/ab-12?t=1", "Download"),
                ("/web/media/57684/download", "Farmaci PHT DPC"),
                ("/files/rotto.csv", "Download"),
                ("/files/manca.csv", "Download"),
                ("/info.html", "Chi siamo"))},
            "/files/Classe-A_30-6-2026.csv": {"corpo": csv_righe(100), "etag": '"a1"'},
            "/documents/20142/825643/Lista_farmaci_equivalenti.csv/ab-12": {"corpo": csv_righe(100)},
            "/web/media/57684/download": {"corpo": b"%PDF-1.7 finto",
                                          "intestazioni": {"Content-Disposition": 'attachment; filename="Farmaci_PHT_DPC_9_luglio_2026.pdf"'}},
            "/files/rotto.csv": {"corpo": b"<!DOCTYPE html><html>errore</html>"},
            "/istat/Elenco-comuni-italiani.xlsx": {"corpo": xlsx_finto()},
            "/bur.html": {"corpo": pagina(("/a1.pdf", "D.D. 710 Catalogo regionale delle prestazioni"))},
        })
        # 1) primo giro: tutto nuovo, due errori (pagina web al posto del CSV, 404)
        self.assertEqual(self.giro(), 1)
        stato = json.loads((self.dest / "stato.json").read_text())["file"]
        self.assertIn("t_pagina/Classe-A.csv", stato)
        self.assertIn("t_pagina/825643_Lista_farmaci_equivalenti.csv", stato)
        self.assertIn("t_pagina/Farmaci_PHT_DPC.pdf", stato)
        self.assertIn("t_file/Elenco-comuni-italiani.xlsx", stato)
        self.assertEqual(stato["t_pagina/Classe-A.csv"]["righe"], 100)
        self.assertTrue((self.dest / "ultimo-rapporto.md").exists())
        # lo stesso rapporto in JSON, per il programma che importa
        rj = json.loads((self.dest / "ultimo-rapporto.json").read_text())
        self.assertEqual(rj["fonti"], ["t_pagina", "t_file", "t_osserva"])
        self.assertLessEqual(rj["iniziato_il"], rj["finito_il"])
        esiti = {(r["fonte"], r["nome"]): r["esito"] for r in rj["righe"]}
        self.assertEqual(esiti[("t_pagina", "Classe-A.csv")], "nuovo")
        self.assertEqual(esiti[("t_pagina", "rotto.csv")], "errore")
        self.assertEqual(len(list((self.dest / "rapporti").glob("*.json"))), 1)
        registro = (self.dest / "registro.jsonl").read_text().splitlines()
        self.assertTrue(any('"esito": "errore"' in r and "pagina web" in r for r in registro))

        # 2) secondo giro senza cambiamenti (tolti i link rotti): tutto invariato, niente archiviato di nuovo
        PERCORSI["/lista.html"]["corpo"] = pagina(
            ("files/Classe-A_30-6-2026.csv", "Download"),
            ("/documents/20142/825643/Lista_farmaci_equivalenti.csv/ab-12?t=1", "Download"),
            ("/web/media/57684/download", "Farmaci PHT DPC"))
        prima = sorted(p.name for p in (self.dest / "archivio").rglob("*") if p.is_file())
        self.assertEqual(self.giro(), 0)
        dopo = sorted(p.name for p in (self.dest / "archivio").rglob("*") if p.is_file())
        self.assertEqual(prima, dopo)
        rj = json.loads((self.dest / "ultimo-rapporto.json").read_text())
        self.assertTrue(all(r["esito"] in ("invariato", "registrato") for r in rj["righe"]), rj["righe"])
        # ogni file controllato in questo giro, anche quelli fermi (304 compreso), ha l'ora del controllo
        stato = json.loads((self.dest / "stato.json").read_text())["file"]
        for k in ("t_pagina/Classe-A.csv", "t_pagina/825643_Lista_farmaci_equivalenti.csv", "t_file/Elenco-comuni-italiani.xlsx"):
            self.assertGreaterEqual(stato[k]["controllato_il"], rj["iniziato_il"], k)

        # 3) nuova pubblicazione: Classe A con nuovo nome e +5% righe (va in uso);
        #    lista equivalenti +70% righe (resta da verificare, in uso la vecchia)
        PERCORSI["/lista.html"]["corpo"] = pagina(
            ("files/Classe-A_31-12-2026.csv", "Download"),
            ("/documents/20142/825643/Lista_farmaci_equivalenti.csv/ab-12?t=2", "Download"),
            ("/web/media/57684/download", "Farmaci PHT DPC"))
        PERCORSI["/files/Classe-A_31-12-2026.csv"] = {"corpo": csv_righe(105, "15/12/2026")}
        PERCORSI["/documents/20142/825643/Lista_farmaci_equivalenti.csv/ab-12"] = {"corpo": csv_righe(170)}
        giro_prima = json.loads((self.dest / "ultimo-rapporto.json").read_text())["giro"]
        self.assertEqual(self.giro(), 2)
        self.assertEqual(self.corrente("Classe-A.csv"), csv_righe(105, "15/12/2026"))
        self.assertEqual(self.corrente("825643_Lista_farmaci_equivalenti.csv"), csv_righe(100))
        stato = json.loads((self.dest / "stato.json").read_text())["file"]
        self.assertIsNotNone(stato["t_pagina/825643_Lista_farmaci_equivalenti.csv"].get("in_attesa"))
        # la fonte è stata controllata anche se la versione nuova aspetta la verifica
        rj = json.loads((self.dest / "ultimo-rapporto.json").read_text())
        self.assertGreaterEqual(stato["t_pagina/825643_Lista_farmaci_equivalenti.csv"]["controllato_il"], rj["iniziato_il"])
        self.assertNotEqual(rj["giro"], giro_prima)
        rapporto = (self.dest / "ultimo-rapporto.md").read_text()
        self.assertIn("oltre la soglia", rapporto)

        # 4) dopo il controllo a mano, si accetta la nuova lista
        self.assertEqual(self.giro("--accetta", "t_pagina/825643_Lista_farmaci_equivalenti.csv"), 0)
        self.assertEqual(self.corrente("825643_Lista_farmaci_equivalenti.csv"), csv_righe(170))

        # 5) il PDF sparisce dalla pagina: segnalato, la versione in uso resta
        PERCORSI["/lista.html"]["corpo"] = pagina(
            ("files/Classe-A_31-12-2026.csv", "Download"),
            ("/documents/20142/825643/Lista_farmaci_equivalenti.csv/ab-12?t=2", "Download"))
        PERCORSI["/bur.html"]["corpo"] = pagina(
            ("/a1.pdf", "D.D. 710 Catalogo regionale delle prestazioni"),
            ("/a2.pdf", "Nuove esenzioni per patologia"))
        self.assertEqual(self.giro(), 2)
        rapporto = (self.dest / "ultimo-rapporto.md").read_text()
        self.assertIn("non è più nella pagina", rapporto)
        self.assertIn("Nuove esenzioni per patologia", rapporto)
        self.assertTrue((self.dest / "correnti" / "t_pagina" / "Farmaci_PHT_DPC.pdf").exists())

    def test_pagina_senza_file(self):
        PERCORSI.update({
            "/lista.html": {"corpo": pagina(("/info.html", "Chi siamo"))},
            "/istat/Elenco-comuni-italiani.xlsx": {"corpo": b"PK\x03\x04 non e' un vero zip"},
            "/bur.html": {"corpo": pagina()},
        })
        self.assertEqual(self.giro(), 1)
        rapporto = (self.dest / "ultimo-rapporto.md").read_text()
        self.assertIn("nessun file trovato", rapporto)
        self.assertIn("non è un archivio ZIP/XLSX valido", rapporto)
        # il primo atto che compare dopo un primo giro vuoto va segnalato, non assorbito come punto di partenza
        PERCORSI["/bur.html"]["corpo"] = pagina(("/a3.pdf", "Aggiornamento del catalogo regionale"))
        self.giro()
        self.assertIn("nuovo: Aggiornamento del catalogo regionale", (self.dest / "ultimo-rapporto.md").read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
